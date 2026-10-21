/**
 * OptChat memory for Pi Durable conversations (docs/optchat.md).
 *
 * A conversation whose `hui.optchat` document is enabled keeps an OptChat memory
 * (`server/optchat/`) in `<store>/optchat/<conversation>/`, and every request of
 * its runs starts fresh: Durable's system messages (prompt sections and tools),
 * then the run's first input with the memory's view in front of it, then the
 * run's own steps. Durable stays the authority: its entries are projected into
 * the OptChat log (idempotently, after a restart too), its compactions are
 * declined, and nothing here writes a Durable entry. Every other conversation is
 * untouched: each hook, section and tool reads the document first, and the tools
 * are offered only by an extension enabled conversations select.
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { clampThinkingLevel, Type, type Message, type Models, type ModelThinkingLevel, type Usage, type UserMessage } from "@earendil-works/pi-ai";
import {
  AgentDoc, AssistantEntry, CompactionTask, defineDoc, defineExtension, defineTool, GenerationTask, hook, LiveDoc, section, ToolResultEntry, UserEntry,
  type CommitPublication, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Extension, type Harness,
  type HookApi, type SubmissionId, type ToolExecutionResult, type Tx,
} from "@earendil-works/pi-durable";
import { BLOCK_LINES, blockCuts, blockMarks, markCache, markedPrefix } from "../optchat/cache.ts";
import { createLimiter, type Limiter, type SummaryReply, type SummaryRequest } from "../optchat/compactor.ts";
import { OptChatMemory, OPTCHAT_DEFAULTS, type OptChatStatus } from "../optchat/memory.ts";
import { masterPrompt, viewDoc } from "../optchat/prompts.ts";
import { LineFile, readLines, syncDirectory, type Kind } from "../optchat/store.ts";
import { recordDiagnosticEvent } from "../observability.ts";
import { callRecordLines, parseCallRecord } from "../calls-format.ts";
import { CallEntry } from "./turn-origins.ts";

/** A conversation's OptChat choice. `name` is the agent's display name in the prompts; `model` ("provider/id") and
 * `thinking` pick the compactor's model, by default the conversation's own model at medium thinking. */
export type OptChatState = { enabled: boolean; name: string; model?: string; thinking?: string };

/** Absent or `enabled: false`: the conversation is plain Durable. A fork starts without it. */
export const OptChatDoc = defineDoc<OptChatState>({
  kind: "hui.optchat", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ enabled: false, name: "" }),
});

/** The global extension (hooks and the prompt section), in every conversation's default selection. */
export const OPTCHAT_EXTENSION = "hui-optchat";
/** zoom and date, selected only by enabled conversations: other conversations are never offered them. */
export const OPTCHAT_TOOLS_EXTENSION = "hui-optchat-tools";

/** A change to the document: a given field replaces the stored one, `null` clears it, `undefined` keeps it. */
export type OptChatChange = {
  readonly enabled?: boolean;
  readonly name?: string;
  readonly model?: string | null;
  readonly thinking?: ModelThinkingLevel | null;
};

/** Spec constants a test may change. */
export type OptChatTuning = {
  readonly node?: number;
  readonly view?: number;
  readonly context?: number;
  readonly jobs?: number;
  readonly tries?: number;
  readonly retryMs?: number;
  readonly cap?: number;
  /** Lines per text block of a view or compaction context sent to Anthropic. */
  readonly blockLines?: number;
};

const context = BACKGROUND_CONTEXT;
/** Entries per store read while catching the log up. */
const PAGE = 200;
/** Frozen views kept in `runs.jsonl` before it starts over: only the current run can still need its own. */
const RUNS_KEPT = 64;
const THINKING = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ZOOM = "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.";
const DATE = "The date and time of message id.";
const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const agentName = (state: OptChatState) => state.name.trim() || "OptChat";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTx = (target: Tx | Conversation): target is Tx => typeof (target as Partial<Tx>).doc === "function";
/** A document draft's value as plain JSON, for comparisons. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

function modelRef(value: string | undefined): { provider: string; modelId: string } | undefined {
  const slash = value?.indexOf("/") ?? -1;
  return value && slash > 0 && slash < value.length - 1 ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1) } : undefined;
}

/** The prompt section of an enabled conversation: byte-identical across calls (no date, no state). */
export const systemSection = (name: string): string => `${masterPrompt(name)}\n\n${viewDoc(name)}`;

/** Selects or drops the tools extension in the stored agent, keeping every other choice. */
async function selectTools(tx: Tx, conversationId: ConversationId, on: boolean): Promise<void> {
  const agent = await tx.doc(AgentDoc, conversationId);
  const stored = agent.extensions;
  if (Array.isArray(stored)) {
    // An exact selection must hold the hooks too, or nothing would read the memory.
    const kept = stored.filter((name) => name !== OPTCHAT_TOOLS_EXTENSION && (!on || name !== OPTCHAT_EXTENSION));
    const next = on ? [...kept, OPTCHAT_EXTENSION, OPTCHAT_TOOLS_EXTENSION] : kept;
    if (!isDeepStrictEqual(next, plain(stored))) agent.extensions = next;
    return;
  }
  const add = (stored?.add ?? []).filter((name) => name !== OPTCHAT_TOOLS_EXTENSION);
  const remove = (stored?.remove ?? []).filter((name) => !on || (name !== OPTCHAT_EXTENSION && name !== OPTCHAT_TOOLS_EXTENSION));
  if (on) add.push(OPTCHAT_TOOLS_EXTENSION);
  const next = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
  if (isDeepStrictEqual(next, plain(stored ?? {}))) return;
  if (add.length || remove.length) agent.extensions = next;
  else delete agent.extensions;
}

async function applyChange(tx: Tx, conversationId: ConversationId, change: OptChatChange): Promise<void> {
  const state = await tx.doc(OptChatDoc, conversationId);
  const enabled = change.enabled ?? state.enabled;
  const name = (change.name ?? state.name).trim();
  const model = change.model === undefined ? state.model : change.model ?? undefined;
  const thinking = change.thinking === undefined ? state.thinking : change.thinking ?? undefined;
  if (enabled && !name) throw new Error("OptChat needs the agent's name.");
  if (model !== undefined && !modelRef(model)) throw new Error(`OptChat's compactor model must be provider/id, not "${model}".`);
  if (thinking !== undefined && !THINKING.has(thinking)) throw new Error(`Unknown thinking level for OptChat's compactor: ${thinking}`);
  state.enabled = enabled;
  state.name = name;
  if (model === undefined) delete state.model;
  else state.model = model;
  if (thinking === undefined) delete state.thinking;
  else state.thinking = thinking;
  await selectTools(tx, conversationId, enabled);
}

/**
 * Turns OptChat on or off for a conversation, or changes its name or compactor model, together with the agent's
 * tool selection. With a transaction it joins that commit, so a creator enables a conversation in the commit that
 * creates it (`createConversation({ init: (tx, id) => configureOptChat(tx, id, ...) })`); with a conversation it
 * commits on its own. A run in progress picks the change up at its next request.
 */
export function configureOptChat(tx: Tx, conversationId: ConversationId, change: OptChatChange): Promise<void>;
export function configureOptChat(conversation: Conversation, change: OptChatChange, context?: Context): Promise<void>;
export async function configureOptChat(target: Tx | Conversation, ...args: [ConversationId, OptChatChange] | [OptChatChange, Context?]): Promise<void> {
  if (isTx(target)) {
    const [conversationId, change] = args as [ConversationId, OptChatChange];
    return applyChange(target, conversationId, change);
  }
  const [change, commitContext] = args as [OptChatChange, Context?];
  await target.commit((tx) => applyChange(tx, target.id, change), commitContext ?? context);
}

/** `configureOptChat` with `enabled: true`: what creating a bot does. */
export function enableOptChat(tx: Tx, conversationId: ConversationId, options: Omit<OptChatChange, "enabled"> & { readonly name: string }): Promise<void>;
export function enableOptChat(conversation: Conversation, options: Omit<OptChatChange, "enabled"> & { readonly name: string }, context?: Context): Promise<void>;
export function enableOptChat(target: Tx | Conversation, ...args: [ConversationId, OptChatChange] | [OptChatChange, Context?]): Promise<void> {
  if (isTx(target)) {
    const [conversationId, options] = args as [ConversationId, OptChatChange];
    return configureOptChat(target, conversationId, { ...options, enabled: true });
  }
  const [options, commitContext] = args as [OptChatChange, Context?];
  return configureOptChat(target, { ...options, enabled: true }, commitContext);
}

// ── Projection: Durable entries → OptChat log ────────────────────────────────

export type ProjectedLine = { readonly kind: Exclude<Kind, "note">; readonly text: string };

const contentText = (content: string | readonly { type: string; text?: string }[]) => typeof content === "string"
  ? content
  : content.map((part) => part.type === "text" ? part.text ?? "" : "[image]").join("\n");

/**
 * The log lines of one entry: a user message, an answer's text (talk) and each of its tool calls (tool: name and JSON
 * input), a tool result (echo, `error: ` when it failed), a call's record (`hui.call`: its transcript as user, its
 * summary as talk, both marked `[call]`). Thoughts are never logged, nor answers Durable keeps out of the context
 * (error, aborted, deferred), nor system, reset and compaction entries.
 */
export function projectEntry(entry: EntryRecord): ProjectedLine[] {
  // A call with the bot: its transcript (both sides, the helper's answers, the hand-offs), then its summary.
  if (CallEntry.is(entry)) {
    const record = parseCallRecord(entry.data);
    if (!record?.lines.length) return [];
    const { transcript, summary } = callRecordLines(record);
    return [{ kind: "user", text: transcript }, ...(summary ? [{ kind: "talk" as const, text: summary }] : [])];
  }
  const message = entry.model?.[0];
  if (!message) return [];
  if (UserEntry.is(entry) && message.role === "user") return [{ kind: "user", text: contentText(message.content) }];
  if (AssistantEntry.is(entry) && message.role === "assistant") {
    if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") return [];
    const talk = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
    return [
      ...(talk.trim() ? [{ kind: "talk" as const, text: talk }] : []),
      ...message.content.flatMap((part) => part.type === "toolCall" ? [{ kind: "tool" as const, text: `${part.name} ${JSON.stringify(part.arguments)}` }] : []),
    ];
  }
  if (ToolResultEntry.is(entry) && message.role === "toolResult") {
    return [{ kind: "echo", text: `${message.isError ? "error: " : ""}${contentText(message.content)}` }];
  }
  return [];
}

type Source = { readonly entry: number; readonly part: number };
const sourceOf = (src: unknown): Source | undefined =>
  isRecord(src) && typeof src["entry"] === "number" && typeof src["part"] === "number" ? { entry: src["entry"], part: src["part"] } : undefined;

/** The log index of the first line projected from `entry`: lines follow entry order, so a binary search finds it. */
function firstLine(memory: OptChatMemory, entry: number): number | undefined {
  let low = 0;
  let high = memory.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sourceOf(memory.message(middle)?.src)?.entry ?? -1) < entry) low = middle + 1;
    else high = middle;
  }
  return sourceOf(memory.message(low)?.src)?.entry === entry ? low : undefined;
}

// ── The fresh-turn request ───────────────────────────────────────────────────

/**
 * OptChat's request (spec 7) from Durable's: every system message before the run's first input, in order (they carry
 * the prompt sections and the tool declarations), then that input with the view as its first text block, then every
 * later message of the run verbatim. The input is found by its timestamp; failing that (`matched: false`), the first
 * user message after the last answer or tool result stands in. Undefined when neither exists.
 */
export function freshTurn(messages: readonly Message[], input: UserMessage | undefined, view: string): { messages: Message[]; matched: boolean } | undefined {
  const candidates = input ? messages.flatMap((message, index) => message.role === "user" && message.timestamp === input.timestamp ? [index] : []) : [];
  let split = candidates.find((index) => isDeepStrictEqual(messages[index]!.content, input!.content)) ?? candidates[0] ?? -1;
  const matched = split !== -1;
  if (!matched) {
    let last = -1;
    messages.forEach((message, index) => { if (message.role === "assistant" || message.role === "toolResult") last = index; });
    split = messages.findIndex((message, index) => index > last && message.role === "user");
  }
  const first = messages[split];
  if (first?.role !== "user") return undefined;
  const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
  return {
    matched,
    messages: [
      ...messages.slice(0, split).filter((message) => message.role === "system"),
      { ...first, content: [{ type: "text", text: view }, ...content] },
      ...messages.slice(split + 1),
    ],
  };
}

/** `freshTurn` for a conversation's request, with a diagnostic whenever the input was not found by its timestamp. */
export function freshTurnRequest(conversationId: ConversationId, messages: readonly Message[], input: UserMessage | undefined, view: string): Message[] | undefined {
  const turn = freshTurn(messages, input, view);
  if (!turn?.matched) {
    recordDiagnosticEvent({
      area: "runtime", level: "warning", action: "optchat_request_split",
      summary: turn
        ? `OptChat placed conversation ${conversationId}'s view on the first user message after the last answer: the run's input was not found by its timestamp`
        : `OptChat found no user message to place conversation ${conversationId}'s view on; the request went as Durable built it`,
    });
  }
  return turn?.messages;
}

// ── Prompt caching ───────────────────────────────────────────────────────────

/**
 * Where an OptChat request's view or context is cut and which blocks get a cache mark (`server/optchat/cache.ts`):
 * its last whole block, and the one ending `previous`, the prefix the request before it marked, while still shared.
 */
type Marking = { readonly block: string; readonly cuts: readonly number[]; readonly marks: readonly number[] };

function marking(block: string, lines: number, previous: string | undefined): Marking {
  const cuts = blockCuts(block, lines);
  return { block, cuts, marks: blockMarks(block, cuts, previous) };
}

// ── Frozen views ─────────────────────────────────────────────────────────────

/** The view a run's requests carry: frozen at its first request, so a crash rerun sends the same bytes. */
type Frozen = { readonly run: number; readonly entry: number; readonly t0: number; readonly parts: readonly (readonly [number, number])[] };
const isFrozen = (value: unknown): value is Frozen => isRecord(value) && typeof value["run"] === "number" && typeof value["entry"] === "number"
  && typeof value["t0"] === "number" && Array.isArray(value["parts"])
  && value["parts"].every((part) => Array.isArray(part) && part.length === 2 && part.every((n) => Number.isSafeInteger(n) && n >= 0));

/** `runs.jsonl`: one frozen view per run, one write and an fsync each, the first record of a run wins. */
class RunLog {
  readonly #path: string;
  #file: LineFile;
  #runs: Map<number, Frozen>;

  private constructor(path: string, file: LineFile, runs: Map<number, Frozen>) {
    this.#path = path;
    this.#file = file;
    this.#runs = runs;
  }

  static async open(path: string, report: (problem: string) => void): Promise<RunLog> {
    const { values, terminated } = await readLines(path, report);
    const runs = new Map<number, Frozen>();
    for (const value of values) {
      if (!isFrozen(value)) { report(`${path}: skipped a malformed frozen view`); continue; }
      if (!runs.has(value.run)) runs.set(value.run, value);
    }
    return new RunLog(path, new LineFile(path, terminated), runs);
  }

  get(run: number): Frozen | undefined { return this.#runs.get(run); }

  /** The run frozen just before `run`: the turn before it, whose cache mark `run`'s requests look for. */
  before(run: number): Frozen | undefined {
    let previous: Frozen | undefined;
    for (const [key, frozen] of this.#runs) {
      if (key === run) return previous;
      previous = frozen;
    }
    return undefined;
  }

  async freeze(frozen: Frozen): Promise<Frozen> {
    const first = this.#runs.get(frozen.run);
    if (first) return first;
    if (this.#runs.size >= RUNS_KEPT) {
      // A new run starts only after the previous one ended, so no record but the last (where its cache mark sat) and
      // the new one can be needed again.
      const last = [...this.#runs.values()].at(-1);
      await this.#file.close();
      const temp = `${this.#path}.tmp`;
      await rm(temp, { force: true });
      const file = new LineFile(temp);
      if (last) await file.append(last);
      await file.append(frozen);
      await file.close();
      await rename(temp, this.#path);
      await syncDirectory(dirname(this.#path));
      this.#file = new LineFile(this.#path);
      this.#runs = new Map(last ? [[last.run, last]] : []);
    } else {
      await this.#file.append(frozen);
    }
    this.#runs.set(frozen.run, frozen);
    return frozen;
  }

  close(): Promise<void> { return this.#file.close(); }
}

// ── The manager ──────────────────────────────────────────────────────────────

type Memory = {
  readonly id: ConversationId;
  readonly memory: OptChatMemory;
  readonly conversation: Conversation;
  readonly runs: RunLog;
  /** The current run's input entry and message. */
  readonly inputs: Map<number, { readonly entry: EntryId; readonly message: UserMessage }>;
  /** Projection passes run one at a time; `queued` is the next one, not started yet. */
  projecting: Promise<void>;
  queued: Promise<void> | undefined;
};

/** The prefix of a compaction context the memory's latest Anthropic compactor request marked. */
type ContextMark = { prefix: string | undefined };

export type OptChatManagerOptions = {
  /** The Durable store's directory: memories live in `optchat/<conversation>/` inside it. */
  readonly dir: string;
  /** Model access for the compactor, current at each call. */
  readonly models: () => Models;
  /** HUI's utility model (Settings → Models), the compactor's model when the document names none. */
  readonly utilityModel?: () => Promise<string | undefined>;
  readonly tuning?: OptChatTuning;
};

/**
 * The gateway's OptChat memories: one per enabled conversation, opened on first use and kept current in the
 * background, so summaries are built between turns. Reached as `DurableHost.optchat`; closed by `DurableHost.close()`.
 * Every query answers `undefined` for a conversation without OptChat or while this process does not own the store.
 */
export class OptChatManager {
  readonly extension: Extension;
  readonly toolsExtension: Extension;
  readonly #dir: string;
  readonly #models: () => Models;
  readonly #utilityModel: (() => Promise<string | undefined>) | undefined;
  readonly #tuning: OptChatTuning;
  readonly #blockLines: number;
  /** One compactor limit for every memory of the gateway. */
  readonly #limiter: Limiter;
  #harness: Harness | undefined;
  #unsubscribe: (() => void) | undefined;
  #memories = new Map<ConversationId, Promise<Memory>>();
  #listeners = new Map<ConversationId, Set<(status: OptChatStatus) => void>>();
  /** The cache marking of each in-flight turn request's frozen view, by its task invocation's signal. */
  #views = new WeakMap<AbortSignal, Marking>();
  #pending = new Set<ConversationId>();
  #closing = false;

  constructor(options: OptChatManagerOptions) {
    this.#dir = options.dir;
    this.#models = options.models;
    this.#utilityModel = options.utilityModel;
    this.#tuning = options.tuning ?? {};
    this.#blockLines = this.#tuning.blockLines ?? BLOCK_LINES;
    this.#limiter = createLimiter(this.#tuning.jobs ?? OPTCHAT_DEFAULTS.jobs);
    this.extension = defineExtension({
      name: OPTCHAT_EXTENSION,
      sections: [section("optchat", async (input, renderContext) => {
        const state = await input.read.snapshot(OptChatDoc, input.conversationId, renderContext);
        return state?.enabled ? systemSection(agentName(state)) : undefined;
      }, { tag: false })],
      hooks: [
        hook(GenerationTask, { beforeRequest: (request, api, hookContext) => this.#beforeRequest(request, api, hookContext) }),
        // OptChat is the memory; a Durable summary would replace history the next turn never sends anyway.
        hook(CompactionTask, {
          beforeCompact: async (_compaction, api, hookContext) => (await api.snapshot(OptChatDoc, api.conversationId, hookContext))?.enabled ? { decline: true as const } : undefined,
        }),
      ],
    });
    this.toolsExtension = defineExtension({
      name: OPTCHAT_TOOLS_EXTENSION,
      tools: [
        defineTool({
          name: "zoom", description: ZOOM, parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }), replay: "safe",
          execute: async ({ id, n }, api) => this.#answer(api.conversationId, (memory) => memory.zoom(id, n)),
        }),
        defineTool({
          name: "date", description: DATE, parameters: Type.Object({ id: Type.Integer() }), replay: "safe",
          execute: async ({ id }, api) => this.#answer(api.conversationId, (memory) => memory.date(id)),
        }),
      ],
    });
  }

  /**
   * Binds the open store. A gateway (`follow`) follows its commits and reopens the memories of enabled conversations,
   * so summaries are built between turns; a store opened only to be read or migrated (`hui doctor`) starts nothing.
   */
  attach(harness: Harness, options: { readonly follow: boolean } = { follow: true }): void {
    this.#closing = false;
    this.#harness = harness;
    if (!options.follow) return;
    this.#unsubscribe = harness.subscribeCommits((publication) => this.#observe(publication));
    void this.#reopen();
  }

  async enabled(conversationId: ConversationId): Promise<boolean> {
    return (await this.#harness?.snapshot(OptChatDoc, conversationId, context))?.enabled === true;
  }

  /** The extension carrying zoom and date when the conversation has OptChat; its session selects it. */
  async toolsFor(conversationId: ConversationId): Promise<Extension | undefined> {
    return await this.enabled(conversationId) ? this.toolsExtension : undefined;
  }

  async status(conversationId: ConversationId): Promise<OptChatStatus | undefined> {
    return (await this.#memory(conversationId))?.memory.status();
  }

  /** The current view, as the next turn would start from it once every line is summarized. */
  async view(conversationId: ConversationId): Promise<string | undefined> {
    return (await this.#current(conversationId))?.memory.view();
  }

  async zoom(conversationId: ConversationId, id: number, n: number): Promise<string | undefined> {
    return (await this.#current(conversationId))?.memory.zoom(id, n);
  }

  async date(conversationId: ConversationId, id: number): Promise<string | undefined> {
    return (await this.#current(conversationId))?.memory.date(id);
  }

  /** The browse page: view, every message and each tree level. */
  async html(conversationId: ConversationId): Promise<string | undefined> {
    return (await this.#current(conversationId))?.memory.html();
  }

  /** `listener` gets the memory's status now (once it is open) and after every change. Returns the unsubscribe. */
  subscribe(conversationId: ConversationId, listener: (status: OptChatStatus) => void): () => void {
    let listeners = this.#listeners.get(conversationId);
    if (!listeners) this.#listeners.set(conversationId, listeners = new Set());
    const set = listeners;
    set.add(listener);
    void this.#memory(conversationId).then((handle) => { if (handle && set.has(listener)) listener(handle.memory.status()); }, () => undefined);
    return () => {
      set.delete(listener);
      if (!set.size && this.#listeners.get(conversationId) === set) this.#listeners.delete(conversationId);
    };
  }

  /** The cache marks of an OptChat request's payload, for the request whose task invocation has `signal`. */
  payloadHook(signal: AbortSignal): ((payload: unknown, model: unknown) => unknown) | undefined {
    const turn = this.#views.get(signal);
    return turn?.marks.length ? (payload, model) => markCache(payload, model, turn.block, turn.cuts, turn.marks) : undefined;
  }

  /** Stops following the store and closes every memory once its pending writes land. */
  async close(): Promise<void> {
    this.#closing = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#harness = undefined;
    const opening = [...this.#memories.values()];
    this.#memories.clear();
    for (const result of await Promise.allSettled(opening)) {
      if (result.status === "fulfilled") await this.#closeMemory(result.value);
    }
  }

  /**
   * Deletes the memory files of a conversation whose OptChat is off (a deleted bot's chat): closes its memory if it is
   * open, then removes `optchat/<id>`. A conversation still enabled is refused, since its memory would open again.
   */
  async purge(conversationId: ConversationId): Promise<void> {
    const harness = this.#harness;
    if (harness && (await harness.snapshot(OptChatDoc, conversationId, context))?.enabled) {
      throw new Error(`OptChat is still on for conversation ${conversationId}; turn it off before deleting its memory.`);
    }
    const opening = this.#memories.get(conversationId);
    this.#memories.delete(conversationId);
    const handle = await opening?.catch(() => undefined);
    if (handle) await this.#closeMemory(handle);
    await rm(join(this.#dir, "optchat", String(conversationId)), { recursive: true, force: true });
  }

  async #closeMemory(handle: Memory): Promise<void> {
    await handle.queued?.catch(() => undefined);
    await handle.projecting.catch(() => undefined);
    await handle.memory.close();
    await handle.runs.close();
  }

  #report(action: string, summary: string, error?: unknown): void {
    if (this.#closing) return;
    recordDiagnosticEvent({ area: "runtime", level: "warning", action, summary, ...(error === undefined ? {} : { detail: errorText(error) }) });
  }

  /** The open memory of an enabled conversation, opened on first use. */
  async #memory(conversationId: ConversationId, known?: OptChatState): Promise<Memory | undefined> {
    const harness = this.#harness;
    if (!harness) return undefined;
    const state = known ?? await harness.snapshot(OptChatDoc, conversationId, context);
    if (!state?.enabled) return undefined;
    let opening = this.#memories.get(conversationId);
    if (!opening) {
      const started = this.#open(harness, conversationId, state);
      opening = started;
      this.#memories.set(conversationId, started);
      started.catch(() => { if (this.#memories.get(conversationId) === started) this.#memories.delete(conversationId); });
    }
    const handle = await opening;
    handle.memory.rename(agentName(state));
    return handle;
  }

  /** The memory with its log caught up to every committed entry. */
  async #current(conversationId: ConversationId): Promise<Memory | undefined> {
    const handle = await this.#memory(conversationId);
    if (handle) await this.#catchUp(handle);
    return handle;
  }

  async #open(harness: Harness, conversationId: ConversationId, state: OptChatState): Promise<Memory> {
    const conversation = await harness.conversation(conversationId, context);
    if (!conversation) throw new Error(`Durable conversation ${conversationId} does not exist.`);
    const dir = join(this.#dir, "optchat", String(conversationId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const report = (problem: string, error?: unknown) => this.#report("optchat_memory", problem, error);
    const contextMark: ContextMark = { prefix: undefined };
    const memory = await OptChatMemory.open(dir, {
      ...this.#tuning, name: agentName(state), limiter: this.#limiter, report,
      summarize: (request, signal) => this.#summarize(conversationId, request, signal, contextMark),
    });
    let runs: RunLog;
    try {
      runs = await RunLog.open(join(dir, "runs.jsonl"), report);
    } catch (error) {
      await memory.close();
      throw error;
    }
    const handle: Memory = { id: conversationId, memory, conversation, runs, inputs: new Map(), projecting: Promise.resolve(), queued: undefined };
    memory.onChange(() => {
      for (const listener of [...this.#listeners.get(conversationId) ?? []]) {
        try { listener(memory.status()); } catch { /* a listener's failure is its own */ }
      }
    });
    void this.#catchUp(handle).catch((error: unknown) => this.#report("optchat_projection_failed", `OptChat memory ${conversationId} did not catch up`, error));
    return handle;
  }

  /** Reopens, in the background, the memories a previous run of the gateway kept. */
  async #reopen(): Promise<void> {
    let names: string[];
    try { names = await readdir(join(this.#dir, "optchat")); } catch { return; }
    for (const name of names) {
      if (!/^\d+$/u.test(name)) continue;
      await this.#memory(Number(name) as unknown as ConversationId).catch((error: unknown) => this.#report("optchat_reopen_failed", `OptChat memory ${name} did not open`, error));
    }
  }

  /** Commit observers must not block or call the Session: note what changed and catch up after the commit. */
  #observe(publication: CommitPublication): void {
    for (const change of publication.changes) {
      const conversationId = change.type === "entry" ? change.value.conversationId
        : change.type === "document" && change.record.kind === OptChatDoc.definition.kind ? change.conversationId : undefined;
      if (conversationId === undefined || (change.type === "entry" && !this.#memories.has(conversationId))) continue;
      if (!this.#pending.size) setImmediate(() => this.#flush());
      this.#pending.add(conversationId);
    }
  }

  #flush(): void {
    const changed = [...this.#pending];
    this.#pending.clear();
    for (const conversationId of changed) {
      void this.#refresh(conversationId).catch((error: unknown) => this.#report("optchat_refresh_failed", `OptChat memory ${conversationId} did not catch up`, error));
    }
  }

  /** Opens, renames and catches up an enabled conversation's memory; closes a disabled one's. */
  async #refresh(conversationId: ConversationId): Promise<void> {
    const handle = await this.#memory(conversationId);
    if (handle) {
      await this.#catchUp(handle);
      return;
    }
    const opening = this.#memories.get(conversationId);
    if (!opening || !this.#harness) return;
    this.#memories.delete(conversationId);
    const closed = await opening.catch(() => undefined);
    if (closed) await this.#closeMemory(closed);
  }

  #catchUp(handle: Memory): Promise<void> {
    if (handle.queued) return handle.queued;
    const run = handle.projecting.then(() => {
      handle.queued = undefined;
      return this.#project(handle);
    });
    handle.queued = run;
    // The chain outlives a failed pass; whoever waits on this one hears of its failure.
    handle.projecting = run.catch(() => undefined);
    return run;
  }

  /** Appends what the store holds past the last projected line: entries read newest first, appended oldest first. */
  async #project(handle: Memory): Promise<void> {
    const { memory, conversation } = handle;
    let last: Source | undefined;
    for (let i = memory.length - 1; i >= 0 && !last; i--) last = sourceOf(memory.message(i)?.src);
    const fresh: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries(last ? { minEntryId: last.entry as EntryId } : {}, PAGE, cursor, context);
      fresh.push(...page.items);
      cursor = page.next;
    } while (cursor);
    for (const entry of fresh.reverse()) {
      if (last && entry.id < last.entry) continue;
      const lines = projectEntry(entry);
      for (let part = 0; part < lines.length; part++) {
        if (last && entry.id === last.entry && part <= last.part) continue;
        await memory.append(lines[part]!.kind, lines[part]!.text, { entry: entry.id, part });
      }
    }
  }

  /**
   * Durable's request for a generation of an enabled conversation becomes a fresh turn (spec 7). Its run (keyed by
   * its first input submission, stable across the run's generations) gets its view frozen at its first request, once
   * every line before the run's input is summarized: a later step, a retry or a crash rerun sends the same view.
   */
  async #beforeRequest(request: { readonly messages: readonly Message[] }, api: HookApi, hookContext: Context): Promise<{ readonly messages: readonly Message[] } | undefined> {
    const state = await api.snapshot(OptChatDoc, api.conversationId, hookContext);
    if (!state?.enabled) return undefined;
    const run = (await api.snapshot(LiveDoc, api.conversationId, hookContext))?.run?.inputs[0];
    if (run === undefined) return undefined;
    const handle = await this.#memory(api.conversationId, state);
    if (!handle) return undefined;
    const input = await this.#input(handle, run, hookContext);
    if (!input) return undefined;
    await this.#catchUp(handle);
    const signal = (api as HookApi & { readonly signal?: AbortSignal }).signal;
    const frozen = handle.runs.get(run) ?? await this.#freeze(handle, run, input.entry, hookContext.abortSignal ?? signal);
    const view = handle.memory.renderParts(frozen.parts);
    const messages = freshTurnRequest(api.conversationId, request.messages, input.message, view);
    if (!messages) return undefined;
    if (signal) this.#views.set(signal, marking(view, this.#blockLines, this.#previousMark(handle, run)));
    return { messages };
  }

  /** The prefix the turn before `run` marked: its frozen view up to its last whole block. Node texts never change. */
  #previousMark(handle: Memory, run: SubmissionId): string | undefined {
    const previous = handle.runs.before(run);
    if (!previous) return undefined;
    const view = handle.memory.renderParts(previous.parts);
    return markedPrefix(view, blockCuts(view, this.#blockLines));
  }

  async #input(handle: Memory, run: SubmissionId, hookContext: Context): Promise<{ readonly entry: EntryId; readonly message: UserMessage } | undefined> {
    const known = handle.inputs.get(run);
    if (known) return known;
    const record = await (await this.#harness?.submission(run, hookContext))?.status(hookContext);
    const entry = record?.entry;
    if (entry === undefined) return undefined;
    const message = (await handle.conversation.entries({ minEntryId: entry, maxEntryId: entry }, 1, undefined, hookContext)).items[0]?.model?.[0];
    if (message?.role !== "user") return undefined;
    handle.inputs.clear();
    const input = { entry, message };
    handle.inputs.set(run, input);
    return input;
  }

  async #freeze(handle: Memory, run: SubmissionId, entry: EntryId, signal: AbortSignal | undefined): Promise<Frozen> {
    const t0 = firstLine(handle.memory, entry);
    if (t0 === undefined) throw new Error(`OptChat has not logged entry ${entry} of conversation ${handle.id}.`);
    // The turn waits until every line before its input is a summary (spec 6); the memory's status says so meanwhile.
    if (!await handle.memory.settle(t0, signal)) {
      signal?.throwIfAborted();
      throw new Error("The OptChat memory closed while a turn waited for it.");
    }
    return handle.runs.freeze({ run, entry, t0, parts: handle.memory.parts(t0).map(([l, i]) => [l, i] as const) });
  }

  async #answer(conversationId: ConversationId, ask: (memory: OptChatMemory) => string): Promise<ToolExecutionResult> {
    const handle = await this.#current(conversationId);
    if (!handle) return { output: [{ type: "text", text: "OptChat memory is not enabled in this conversation." }], isError: true };
    return { output: [{ type: "text", text: ask(handle.memory) }] };
  }

  /**
   * One compactor call through the gateway's models: the document's model, else HUI's utility model, else the
   * conversation's own. Without a model of its own, a failing utility model hands over to the conversation's.
   */
  async #summarize(conversationId: ConversationId, request: SummaryRequest, signal: AbortSignal, contextMark: ContextMark): Promise<SummaryReply> {
    const harness = this.#harness;
    if (!harness) throw new Error("The Durable store is closed.");
    const state = await harness.snapshot(OptChatDoc, conversationId, context);
    const own = modelRef(state?.model);
    const conversationModel = (await harness.snapshot(AgentDoc, conversationId, context))?.model;
    const utility = own ? undefined : modelRef(await this.#utilityModel?.().catch(() => undefined));
    const refs = own ? [own] : [utility, conversationModel].filter((ref): ref is { provider: string; modelId: string } => Boolean(ref));
    if (!refs.length) throw new Error("The conversation has no model for OptChat's compactor.");
    let failure: unknown;
    for (const ref of refs) {
      try {
        return await this.#summarizeWith(ref, state, request, signal, contextMark);
      } catch (error) {
        if (signal.aborted) throw error;
        failure = error;
      }
    }
    throw failure;
  }

  async #summarizeWith(ref: { provider: string; modelId: string }, state: OptChatState | undefined, request: SummaryRequest, signal: AbortSignal, contextMark: ContextMark): Promise<SummaryReply> {
    const models = this.#models();
    const model = models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Unknown model for OptChat's compactor: ${ref.provider}/${ref.modelId}`);
    const thinking = clampThinkingLevel(model, (state?.thinking ?? "medium") as ModelThinkingLevel);
    const first = request.messages[0];
    const block = first?.role === "user" ? first.content[0] : undefined;
    const reply = await models.completeSimple(model, {
      systemPrompt: request.system,
      messages: request.messages.map((message): Message => message.role === "user"
        ? { role: "user", content: message.content.map((text) => ({ type: "text" as const, text })), timestamp: 0 }
        : { role: "assistant", content: [{ type: "text", text: message.content }], api: model.api, provider: model.provider, model: model.id, usage: NO_USAGE, stopReason: "stop", timestamp: 0 }),
    }, {
      signal,
      ...(thinking === "off" ? {} : { reasoning: thinking }),
      // Compactions share the compaction view's start: cache it in blocks, like a turn's view.
      ...(block === undefined ? {} : { onPayload: (payload: unknown, target: unknown) => this.#markContext(payload, target, block, contextMark) }),
    });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || `The compactor's model stopped: ${reply.stopReason}`);
    const { usage } = reply;
    return {
      text: reply.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
      usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost.total },
    };
  }

  /** A compactor request's cache marks: its context's last whole block, and the latest marked prefix while shared. */
  #markContext(payload: unknown, model: unknown, block: string, contextMark: ContextMark): unknown {
    const { cuts, marks } = marking(block, this.#blockLines, contextMark.prefix);
    const marked = markCache(payload, model, block, cuts, marks);
    if (marked !== undefined) contextMark.prefix = markedPrefix(block, cuts);
    return marked;
  }
}
