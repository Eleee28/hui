/**
 * Durable adapter: every HUI session is one Pi Durable conversation in the
 * gateway's harness (see `durable-host.ts`). Durable owns the agent loop,
 * transcript, queue and crash recovery; this adapter translates its committed
 * state and events into HUI's runtime contract. Nothing here retries or
 * replays work after a restart: the harness resumes interrupted runs itself.
 * The session's PI extensions (`durable-extensions.ts`) see its prompts and
 * events through it.
 */
import { createHash } from "node:crypto";
import type { ImageContent, Message, ModelThinkingLevel, TextContent } from "@earendil-works/pi-ai";
import {
  CompactionEntry, InboxDoc, LiveDoc, ResetEntry, SystemEntry, UserEntry, watchEvents,
  type AgentEvent, type AgentState, type CompactionResult, type Conversation, type ConversationId, type Cursor,
  type EntryId, type EntryRecord, type Harness, type SubmissionRecord, type TaskId, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, type CodemodeNestedCall } from "@earendil-works/pi-durable/codemode";
// The estimators Durable's own compaction uses, so the meter matches its thresholds.
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { SettingsManager, type Skill } from "@earendil-works/pi-coding-agent";
import { botTurnOrigin, type BotTurnOrigin } from "./turn-origins.ts";
import { resolveCommandReference } from "./command-references.ts";
import type { RuntimeInspection } from "./types.ts";
import { durableContext as context, durableHost, modelCallable, type DurableHost } from "./durable-host.ts";
import { CallEntry } from "./turn-origins.ts";
import { skillBlock, type BotChat, type OfferedTool, type ToolOrigin } from "./durable-offer.ts";
import { QuestionBox, type QuestionDraft } from "./question-box.ts";
import { DurableExtensions, ExtensionMessageEntry, isCustomInput, type CustomMessage, type ExtensionSession } from "./durable-extensions.ts";
import { filterConfiguredModels } from "./pi-models.ts";
import { fitThinking, modelControls, piThinking } from "./model-controls.ts";
import {
  fileFromMessages, imageFromMessages, latestRunUsage, promptPayload, restoreAttachmentNames, toolOutput, transcriptFrom,
} from "./pi.ts";
import { RuntimeTimings } from "./transcript-metrics.ts";
import { disabledSkillNotice } from "./skill-policy-extension.mjs";
import type {
  AgentRuntime, CompactionReason, PromptAttachment, RuntimeCommand, RuntimeEvent, RuntimeModel, RuntimeQuestion,
  RuntimePromptOptions, RuntimePromptResult, RuntimeQuestionResponse, RuntimeQueue, RuntimeRewindOptions, RuntimeRewindTarget, RuntimeSession, RuntimeUsage, StartOptions,
  TranscriptEntry,
} from "./types.ts";
import { RuntimeUnreachableError } from "./types.ts";

export const DURABLE_VERSION = "1.2.0";
const REFERENCE_PREFIX = "durable:";
/** Entries per store read; a read yields to the event loop between pages. */
const HISTORY_PAGE = 200;
/** How Durable wraps a summary for the model (`harness/compaction.js`). */
export const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const SUMMARY_SUFFIX = "\n</summary>";
/** The kind of Durable's compaction task, as `task_failed` reports it. */
const COMPACTION_TASK = "pi.compaction";
/** Longest a Stop waits for Durable to report that its run and compactions ended. */
const QUIET_TIMEOUT_MS = 30_000;

type SnapshotEvent = Extract<AgentEvent, { type: "snapshot" }>;
/** One stored entry, and the messages the transcript shows for it. */
type Row = { readonly entry: EntryRecord; readonly shown: readonly unknown[] };
type CompactionOutcome = { outcome: "done" | "failed" | "cancelled"; message?: string; result?: CompactionResult };
type CompactionStart = Extract<RuntimeEvent, { type: "compaction_start" }>;
/** One running compaction, of the kind Durable gave it (`createCompaction`). */
type Compaction = { readonly reason: CompactionReason; readonly blocking: boolean; readonly background: boolean };
/** How input reaches the conversation: `reject` starts a run, the others queue into one. */
type Delivery = "reject" | "steer" | "followUp";
type Sending = { readonly attachments?: readonly PromptAttachment[]; readonly images?: readonly ImageContent[]; readonly source: "rpc" | "extension"; readonly expand: boolean; readonly requestId?: string };
/** One call of a running codemode script, as `@earendil-works/pi-durable/codemode` lists it in its result's
 * `details.calls` once the script ends: `models.*` calls by that name, arguments and errors cut for display. */
type CodemodeCall = Omit<CodemodeNestedCall, "id">;
const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 3)}...` : text;
const startedCall = (name: string, args: unknown): CodemodeCall => ({
  name: name.replace(/^pi\.codemode\./u, ""), args: cut(args === undefined ? "" : JSON.stringify(args) ?? "", 200), status: "running",
});
/** Without how it ended, the call was cut off: it left with its script or its run. */
const endedCall = (call: CodemodeCall, end?: { isError: boolean; durationMs?: number; error?: string }): CodemodeCall => end ? {
  ...call, status: end.isError ? "error" : "ok",
  ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs }),
  ...(end.isError && end.error ? { error: cut(end.error, 500) } : {}),
} : { ...call, status: "cancelled" };

/**
 * Durable's kinds of compaction: one a generation owns is `blocking`, and its run waits for the summary; a manual one
 * runs beside the conversation, and Stop cancels it; a threshold one Durable starts by itself runs in the background
 * and survives Stop. Only a blocking one holds anything, and only its own run: Durable admits input throughout.
 */
function compactionOf(status: { reason: CompactionReason; blocking: boolean }): Compaction {
  return { reason: status.reason, blocking: status.blocking, background: !status.blocking && status.reason !== "manual" };
}

function startOf(compaction: Compaction): CompactionStart {
  return {
    type: "compaction_start",
    reason: compaction.reason,
    ...(compaction.blocking ? {} : { blocking: false as const }),
    ...(compaction.background ? { background: true as const } : {}),
  };
}

/** A Durable resume reference as HUI's registry stores it. */
export function durableReference(id: ConversationId): string {
  return `${REFERENCE_PREFIX}${String(id)}`;
}

/** Durable IDs are branded integers; a reference carries one in decimal. */
export function durableConversationId(reference: string | undefined): ConversationId | undefined {
  if (!reference?.startsWith(REFERENCE_PREFIX)) return undefined;
  const value = reference.slice(REFERENCE_PREFIX.length);
  const id = Number(value);
  return /^\d+$/u.test(value) && Number.isSafeInteger(id) ? id as unknown as ConversationId : undefined;
}

const internal = async <T>(path: string): Promise<T> =>
  await import(new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href) as T;
const { expandPromptTemplate } = await internal<{ expandPromptTemplate(text: string, templates: unknown[]): string }>("./core/prompt-templates.js");

/** PI's `/skill:name args` expansion for the skills this conversation may use, plus a block for each later `$name`
 * word that names one of them. Text that does not start with a skill goes through `expandTemplate`. */
export function expandSkill(text: string, skills: readonly { name: string; filePath: string; baseDir: string }[], expandTemplate = (body: string) => body): string {
  const named = new Set<(typeof skills)[number]>();
  const add = (name: string) => {
    const skill = skills.find((candidate) => candidate.name === name);
    if (skill) named.add(skill);
    return skill;
  };
  const leading = /^\/skill:(\S+)\s*/u.exec(text);
  const body = leading && add(leading[1]!) ? text.slice(leading[0].length) : expandTemplate(text);
  for (const [, name] of text.matchAll(/(?<!\S)\$(?:skill:)?([\w-]+)/gu)) add(name!);
  return named.size ? [...[...named].map(skillBlock), body.trim()].filter(Boolean).join("\n\n") : body;
}

export function modelRef(value: string | undefined): { provider: string; modelId: string } | undefined {
  const separator = value?.indexOf("/") ?? -1;
  return value && separator > 0 ? { provider: value.slice(0, separator), modelId: value.slice(separator + 1) } : undefined;
}

export function textOf(message: Message | undefined): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? [String((part as { text?: unknown }).text ?? "")] : []).join("\n")
    : "";
}

/** A compaction entry's summary, without the wrapper the model reads it in. */
function compactionSummary(entry: EntryRecord): string {
  const text = textOf(entry.model?.[0]);
  return text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)
    ? text.slice(SUMMARY_PREFIX.length, text.length - SUMMARY_SUFFIX.length)
    : text;
}

/** Durable leaves aborted and failed answers out of the model context; the transcript still shows them. */
function inContext(message: Message): boolean {
  const stopReason = (message as { stopReason?: string }).stopReason;
  return message.role !== "assistant" || (stopReason !== "aborted" && stopReason !== "error");
}

const role = (message: unknown): unknown => (message as { role?: unknown } | null)?.role;

/** A point a fork can carry on from: a prompt, or an answer that ends its turn. An answer asking for tools, or a tool
 * result, would leave the copy waiting on a turn that never finishes there. */
function forkable(message: unknown): boolean {
  if (role(message) === "user") return true;
  if (role(message) !== "assistant") return false;
  const content = (message as { content?: unknown }).content;
  return !Array.isArray(content) || !content.some((part) => (part as { type?: unknown } | null)?.type === "toolCall");
}

/** The text of an input someone sent the conversation (an entry Durable placed for a submission); undefined for any
 * other entry, and for an extension's custom message, which isn't anyone's input. */
function inputText(entry: EntryRecord): string | undefined {
  if (!UserEntry.is(entry)) return undefined;
  const message = entry.model?.find((each) => each.role === "user");
  return message && !isCustomInput(message) ? textOf(message) : undefined;
}

/** Each origin once, in the order they first came. */
function distinct(origins: readonly BotTurnOrigin[]): BotTurnOrigin[] {
  const seen = new Set<string>();
  return origins.filter((origin) => {
    const key = JSON.stringify(origin);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The run going now, as the stream shows it batch by batch (one batch per commit). */
type RunFollow = {
  /** Durable runs one: several chained ones too, since a follow-up starts the next in the commit that ends the last,
   * and the conversation never goes idle in between. */
  going: boolean;
  /** Who brought each input the stream showed it take: its first message, then each steer and follow-up. */
  origins: BotTurnOrigin[];
  /** The newest entry the stream reported; what came after is read from the store. */
  reported: EntryId | undefined;
};

/** PI's default thinking level for a new conversation without an explicit one. */
export function defaultThinking(host: DurableHost, cwd: string): string | undefined {
  return SettingsManager.create(cwd, host.agentDir).getDefaultThinkingLevel();
}

/** The model a new conversation starts on: the requested one, PI's default, or the first available. */
export async function initialModel(host: DurableHost, cwd: string, requested: string | undefined) {
  const explicit = modelRef(requested);
  if (explicit) {
    if (!host.models.getModel(explicit.provider, explicit.modelId)) throw new Error(`Unknown model: ${requested}`);
    return explicit;
  }
  const settings = SettingsManager.create(cwd, host.agentDir);
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  if (provider && id && host.models.getModel(provider, id)) return { provider, modelId: id };
  const first = (await host.models.getAvailable())[0];
  return first ? { provider: first.provider, modelId: first.id } : undefined;
}

export class DurableSession implements RuntimeSession, ExtensionSession, BotChat {
  readonly #host: DurableHost;
  readonly #harness: Harness;
  readonly #cwd: string;
  #conversation: Conversation;
  #listeners = new Set<(event: RuntimeEvent) => void>();
  #stop: (() => Promise<void>) | undefined;
  /** Fork-aware history, oldest first: what store reads returned, plus entries streamed since. */
  #history: Row[] = [];
  #ids = new Set<EntryId>();
  /** Newest entry a store read returned; the next read starts after it. */
  #readThrough: EntryId | undefined;
  /** What the transcript shows and the context size, rebuilt when the history changes. */
  #shown: unknown[] | undefined;
  #contextSize: number | undefined;
  /** Durable compactions running now, by task. */
  #compactions = new Map<TaskId, Compaction>();
  /** Manual compactions `compact()` started that the stream has not listed yet. */
  #requested = new Set<TaskId>();
  /** The start last reported, until the next end: an unchanged leading compaction is not reported twice. */
  #lastStart: CompactionStart | undefined;
  /** Compactions whose ends are not reported: a reset made them stale (Durable drops their summaries), or their
   * receipt already reported them. */
  #superseded = new Set<TaskId>();
  /** Callers waiting for this view to see work end, each with the state it waits for. */
  #waiters = new Set<{ done: () => boolean; resolve: () => void }>();
  #timings = new RuntimeTimings();
  #agent: AgentState = {};
  #queue: RuntimeQueue = { steering: [], followUp: [] };
  #toolOutput = new Map<string, string>();
  /** The calls each running codemode script made so far, by its call ID, as its result's `details.calls` will list them. */
  #nestedCalls = new Map<string, Map<string, CodemodeCall>>();
  /** Scripts whose calls changed in the event batch being handled: their card gets the list once, after it. */
  #changedCalls = new Set<string>();
  /** Text each block of the in-flight answer has streamed, per content index: Durable sends a first partial, a
   * short answer or a replaced block whole, and the live view gets what it adds. */
  #streamedText = new Map<number, string>();
  /** A run is going: from the submit of its input to its end. */
  #streaming = false;
  /** Prompts passing their extension handlers before anything is submitted. */
  #starting = 0;
  /** Runs an extension's custom message is starting: HUI sees them busy, as it sees a prompt it sent as pending. */
  #customStarts = 0;
  /** Runs that ended whose extensions' end-of-run handlers still run. */
  #settling = 0;
  #disposed = false;
  /** `rows()`, until the history changes. */
  #rows: readonly EntryRecord[] | undefined;
  /** The session's PI extensions; absent when its PI setup has none. */
  #extensions: DurableExtensions | undefined;
  #extensionFailure: string | undefined;
  #huiSessionId: string | undefined;
  /** The level last chosen: a switch to a model without it lowers it for that model only. */
  #chosenThinking: string | undefined;
  /** What the session asks the operator itself: a bot's access requests. */
  #questions = new QuestionBox((question) => this.#emit({ type: "question", question }));
  /** The tools the operator can turn off in a bot's chat, as the latest `applyTools` found them; empty for every other
   * conversation. */
  #botOffer: readonly OfferedTool[] = [];
  /** A bot's chat keeps its bot's PI levels: no Ultra (`applyTools` learns it). */
  #botChat = false;
  /** The message that started the latest run this view started; who started the turn (`runInput`). */
  #runInput: string | undefined;
  /** Concurrent retries of one tracked input share its extension handlers as well as its admission. */
  #trackedStarts = new Map<string, Promise<void>>();
  #trackedStarting = new Set<string>();
  #cancelledTracked = new Set<string>();
  /** Every input of the run going now (`runOrigins`); unset until this view follows the conversation. */
  #run: RunFollow | undefined;
  readonly resumesInterruptedRuns = true;

  constructor(host: DurableHost, harness: Harness, conversation: Conversation, cwd: string, chosenThinking?: string) {
    this.#host = host;
    this.#harness = harness;
    this.#conversation = conversation;
    this.#cwd = cwd;
    this.#chosenThinking = chosenThinking;
  }

  get sessionId(): string { return String(this.#conversation.id); }
  get sessionFile(): string { return durableReference(this.#conversation.id); }
  /** HUI's view: a run is over once its extensions' end-of-run handlers ran, as in PI. */
  get isStreaming(): boolean { return this.#streaming || this.#settling > 0 || this.#customStarts > 0; }
  /** The extensions' view: from the submit of a run's input to its end. */
  get running(): boolean { return this.#streaming; }
  get starting(): boolean { return this.#starting > 0 && !this.#streaming; }
  whenStarted(): Promise<void> { return this.#until(() => !this.starting, Number.POSITIVE_INFINITY); }
  get cwd(): string { return this.#cwd; }
  conversation(): Conversation { return this.#conversation; }

  /** Loads the HUI session's PI extensions and offers the conversation their tools; `startExtensions` starts them. A
   * setup that fails to load leaves the session without extensions, and says why in its inspection. */
  async loadExtensions(huiSessionId: string): Promise<void> {
    this.#huiSessionId = huiSessionId;
    this.#host.trackChat(this);
    this.#extensionFailure = undefined;
    try {
      const settings = await this.#host.settings();
      this.#extensions = await DurableExtensions.load({
        host: this.#host, session: this, huiSessionId,
        disabledPluginIds: new Set(settings.disabledPlugins.map((plugin) => plugin.id)),
      });
    } catch (error) {
      this.#extensionFailure = `PI extensions did not load: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (this.#extensions) this.#host.attachExtensions(huiSessionId, this.#extensions);
    await this.applyTools();
  }

  /** `session_start`, once the history is read, so extensions restore their state from it. */
  async startExtensions(reason: "startup" | "reload"): Promise<void> {
    await this.#extensions?.start(reason);
  }

  /** Offers the conversation its extensions and the tools they keep active, OptChat's zoom and date when the
   * conversation has OptChat, `message_bot` and a bot's own tools when it is a bot's chat (`message_bot` alone for any
   * other conversation), and drops the browser when Settings turns it off. A bot's chat goes without the tools the operator turned off, without its own tools while
   * it has no use for them (`bots/durable-access.ts`), and without the HUI tools that act on another machine than this
   * host's (`gatewayOnlyTools`, on a worker), which it is never offered. Codemode, in the default selection, goes with
   * Settings → Tools → Codemode off, or a bot's chat that has it turned off. Applies per conversation, at start and on
   * every change. */
  async applyTools(): Promise<void> {
    const { browser, codemode } = await this.#host.settings();
    const browserEnabled = browser.enabled !== false;
    const bots = this.#host.bots;
    const bot = await this.#host.botStateFor(this.#conversation.id);
    // A session tags bots; a bot's chat has message_bot among its own tools.
    const tag = bot ? undefined : this.#host.botTag;
    this.#botChat = bot !== undefined;
    const inactive = new Map([
      ...(browserEnabled ? [] : this.#host.toolsNamed(["browser"])),
      ...(bot ? this.#host.toolsNamed(this.#host.gatewayOnlyTools) : []),
      ...(this.#extensions?.inactiveTools() ?? []),
    ].map((tool) => [tool.name, tool]));
    // After the session's extensions, so OptChat's zoom and date win over same-named extension tools where OptChat is
    // on, and only there. Each is selected per conversation; every other conversation's selection stays as it was.
    const optchat = await this.#host.optchat.toolsFor(this.#conversation.id);
    const botTools = bot ? await this.#host.botToolsFor(this.#conversation.id) : undefined;
    const added = [...(this.#extensions ? [this.#extensions.extension] : []), ...(optchat ? [optchat] : []), ...(botTools ? [botTools] : []), ...(tag ? [tag] : [])];
    let withCodemode = codemode.enabled;
    const remove = [...inactive.values()];
    this.#botOffer = [];
    if (bot && bots) {
      // What a session here is offered, in Durable's order: the coding tools, HUI's, the extensions' and the added ones.
      const offered = this.#composed([
        [this.#host.codingTools, () => ({ kind: "coding" })],
        [this.#host.huiTools, () => ({ kind: "hui" })],
        [withCodemode ? modelCallable(this.#host.codemode) : [], () => ({ kind: "coding" })],
        [this.#extensions?.extension.tools ?? [], (tool) => ({ kind: "extension", ...this.#extensions!.describe(tool.name) })],
        [optchat?.tools ?? [], () => ({ kind: "hui" })],
        [botTools?.tools ?? [], () => ({ kind: "bot" })],
      ]).filter(({ name }) => !inactive.has(name));
      const plan = bots.planOffer(offered, bot, { memory: (optchat?.tools ?? []).map((tool) => tool.name), skills: await this.availableSkills() });
      this.#botOffer = plan.offer;
      // Removed by name, so a tool that appears later is on until the operator turns it off.
      remove.push(...plan.removed.map(({ tool }) => tool));
      // Without its tool, the chat goes without codemode's prompt section too.
      if (plan.removed.some(({ name }) => name === CODEMODE_TOOL_NAME)) withCodemode = false;
    }
    const extensions = { ...(added.length ? { add: added } : {}), ...(withCodemode ? {} : { remove: [this.#host.codemode] }) };
    await this.#conversation.configure({
      // A view with no HUI session (a probe) leaves the selection of the session that owns the conversation alone.
      ...(this.#huiSessionId === undefined ? {} : { extensions: Object.keys(extensions).length ? extensions : null }),
      tools: remove.length ? { remove } : null,
    }, context);
    this.#host.chatReady(this);
  }

  /** Tools composed as Durable composes the selected extensions: by name, in order, a later one replacing an earlier
   * one of the same name in its place. Each keeps where it comes from. */
  #composed(sources: readonly (readonly [readonly ToolRegistration[], (tool: ToolRegistration) => ToolOrigin])[]): { name: string; tool: ToolRegistration; origin: ToolOrigin }[] {
    const composed = new Map<string, { name: string; tool: ToolRegistration; origin: ToolOrigin }>();
    for (const [tools, origin] of sources) for (const tool of tools) composed.set(tool.name, { name: tool.name, tool, origin: origin(tool) });
    return [...composed.values()];
  }

  botOffer(): readonly OfferedTool[] {
    return this.#botOffer;
  }

  async availableSkills(): Promise<readonly Skill[]> {
    return (await this.#loader()).getSkills().skills;
  }

  /** PI's resources for this conversation: its directory's, and for a bot's chat its own skills too. */
  async #loader() {
    return this.#host.prompt.loader(this.#cwd, await this.#host.skillDirsFor(this.#conversation.id));
  }

  /** Asks the operator in this chat (a bot's access request); resolves with the answer, or undefined once dismissed. */
  ask(question: QuestionDraft, signal?: AbortSignal): Promise<RuntimeQuestionResponse | undefined> {
    return this.#questions.ask(question, signal);
  }

  /** The message that started the run going now: the one this view started, or, for a run that resumed after a restart,
   * the latest user message in the history. */
  runInput(): string | undefined {
    if (this.#runInput !== undefined) return this.#runInput;
    const rows = this.rows();
    for (let index = rows.length - 1; index >= 0; index--) {
      const message = [...rows[index]!.model ?? []].reverse().find((each) => each.role === "user" && !isCustomInput(each));
      if (message) return textOf(message);
    }
    return undefined;
  }

  /** The newest message in the history since the latest reset, read from the store rather than this view, so a tool sees
   * the one its model answers: a follow-up placed into the running turn after the message that started it. */
  async latestInput(): Promise<string | undefined> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.#conversation.entries({}, HISTORY_PAGE, cursor, context);
      for (const entry of page.items) {
        const message = [...entry.model ?? []].reverse().find((each) => each.role === "user" && !isCustomInput(each));
        if (message) return textOf(message);
        if (ResetEntry.is(entry)) return undefined;
      }
      cursor = page.next;
    } while (cursor);
    return undefined;
  }

  /**
   * Who brought each input of the run going now, each once, oldest first: the message that started it and every one it
   * took since, the steers placed after a tool round and the follow-ups Durable answers in the runs it chains until the
   * conversation goes idle, which ends the run. A bot's gated tools refuse when any came from an origin they refuse. The
   * stream reports them; those committed since its latest batch are read from the store, so a tool call never misses
   * the one its model answers. A view that started following during the run (after a restart) knows only those since;
   * the message that started it is still `runInput`, and the gateway's `runPrompt`.
   */
  async runOrigins(): Promise<readonly BotTurnOrigin[]> {
    const run = this.#run;
    if (!run) return [];
    const origins = [...run.origins];
    const after = run.reported;
    const fresh: BotTurnOrigin[] = [];
    let cursor: Cursor | undefined;
    scan: do {
      const page = await this.#conversation.entries(after === undefined ? {} : { minEntryId: after }, HISTORY_PAGE, cursor, context);
      for (const entry of page.items) {
        if (after !== undefined && entry.id <= after) break scan;
        const text = inputText(entry);
        if (text !== undefined) fresh.push(botTurnOrigin(text));
      }
      cursor = page.next;
    } while (cursor);
    return distinct([...origins, ...fresh.reverse()]);
  }

  /** Follows the run going now through one batch of the stream: each input it takes, and its end once a commit leaves
   * the conversation idle. */
  #follow(events: readonly AgentEvent[]): void {
    const run = this.#run;
    if (!run) return;
    const saw = (entry: EntryRecord) => {
      if (run.reported !== undefined && entry.id <= run.reported) return;
      run.reported = entry.id;
      const text = inputText(entry);
      if (text !== undefined) run.origins.push(botTurnOrigin(text));
    };
    for (const event of events) {
      if (event.type === "run_start") run.going = true;
      else if (event.type === "run_end") run.going = false;
      else if (event.type === "message_end" || event.type === "entry_appended") saw(event.entry);
      else if (event.type === "tool_execution_end" && event.entry) saw(event.entry);
      else if (event.type === "snapshot") {
        // The stream fell behind: what it skipped and the run still has is in the newest view.
        run.going = event.run !== undefined;
        for (const entry of [...event.entries].sort((a, b) => a.id - b.id)) saw(entry);
      }
    }
    if (!run.going) run.origins = [];
  }

  /** The skills this conversation may use: those of its directory, less the ones the operator turned off in a bot's
   * chat. */
  async #skills(loader: { getSkills(): { skills: Skill[] } }): Promise<readonly Skill[]> {
    const all = loader.getSkills().skills;
    const bots = this.#host.bots;
    const bot = await this.#host.botStateFor(this.#conversation.id);
    return bot && bots ? bots.skills(all, bot) : all;
  }

  /** Entries since the latest reset, oldest first: what the extensions' PI session view holds. */
  rows(): readonly EntryRecord[] {
    this.#rows ??= this.#history.slice(this.#resetIndex()).map((row) => row.entry);
    return this.#rows;
  }

  pendingCount(): number {
    return this.#queue.steering.length + this.#queue.followUp.length;
  }

  emitRuntime(event: RuntimeEvent): void {
    this.#emit(event);
  }

  /** Attach to the conversation's committed state, read its history, then follow every commit. */
  async attach(): Promise<void> {
    const stream = await watchEvents(this.#harness, this.#conversation.id, context);
    this.#history = [];
    this.#ids.clear();
    this.#readThrough = undefined;
    this.#changed();
    // A fresh view: at startup, or of the conversation a rewind forked. Earlier tasks belong to another conversation.
    this.#requested.clear();
    this.#superseded.clear();
    this.#lastStart = undefined;
    this.#compactions = new Map(stream.snapshot.compactions.map((status) => [status.taskId, compactionOf(status)]));
    this.#syncSnapshot(stream.snapshot);
    // A run already going started before this view: only the inputs it takes from now on can be told.
    const newest = stream.snapshot.entries.reduce<EntryId | undefined>((max, entry) => max === undefined || entry.id > max ? entry.id : max, undefined);
    this.#run = { going: stream.snapshot.run !== undefined, origins: [], reported: newest };
    await this.#read();
    await this.#refreshQueue();
    stream.start(async (events) => {
      this.#follow(events);
      for (const event of events) await this.#onEvent(event);
      this.#emitChangedCalls();
      // Extensions' failures are theirs: they must never stop this view from following the conversation.
      try {
        if (!this.#disposed) this.#extensions?.flush();
      } catch (error) {
        this.#emit({ type: "notice", level: "warning", message: `PI extensions missed an event: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
    this.#stop = async () => { await stream.stop(); };
  }

  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #syncSnapshot(snapshot: SnapshotEvent): void {
    this.#agent = snapshot.agent;
    this.#streaming = snapshot.run !== undefined;
    for (const slot of snapshot.tools) {
      this.#toolOutput.set(slot.callId, slot.output ?? "");
      if (slot.name === CODEMODE_TOOL_NAME && !this.#nestedCalls.has(slot.callId)) this.#nestedCalls.set(slot.callId, new Map());
    }
    for (const slot of snapshot.nestedTools) {
      const started = startedCall(slot.name, slot.arguments);
      this.#nestedCalls.get(slot.parentCallId)?.set(slot.callId, slot.status === "done" ? endedCall(started, slot.summary) : started);
    }
  }

  /** A codemode script's call started or ended: its card shows the script's calls so far. Calls of other tools' nested
   * calls, and of a script this view never saw start, have no card. */
  #nestedCall(parent: string, id: string, call: (current?: CodemodeCall) => CodemodeCall): void {
    const calls = this.#nestedCalls.get(parent);
    if (!calls) return;
    calls.set(id, call(calls.get(id)));
    this.#changedCalls.add(parent);
  }

  #emitChangedCalls(): void {
    for (const parent of this.#changedCalls) {
      const calls = this.#nestedCalls.get(parent);
      if (calls) this.#emit({ type: "tool_update", id: parent, name: CODEMODE_TOOL_NAME, details: { calls: [...calls.values()] } });
    }
    this.#changedCalls.clear();
  }

  /** The history the store holds past `#readThrough` (all of it the first time), read newest first in pages that
   * yield between them, so even a long history never holds the gateway's event loop for long. */
  async #read(): Promise<void> {
    const after = this.#readThrough;
    const fresh: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.#conversation.entries(after === undefined ? {} : { minEntryId: after }, HISTORY_PAGE, cursor, context);
      fresh.push(...page.items);
      cursor = page.next;
      if (cursor) await new Promise<void>((resolve) => setImmediate(resolve));
    } while (cursor);
    for (const entry of fresh.reverse()) {
      if (after !== undefined && entry.id <= after) continue;
      this.#add(entry);
      if (this.#readThrough === undefined || entry.id > this.#readThrough) this.#readThrough = entry.id;
    }
  }

  /** Adds one entry where its ID places it; streamed entries and later reads overlap. */
  #add(entry: EntryRecord): void {
    if (this.#ids.has(entry.id)) return;
    this.#ids.add(entry.id);
    let index = this.#history.length;
    while (index > 0 && this.#history[index - 1]!.entry.id > entry.id) index--;
    // An extension's custom message is context only; PI sessions do not show it either. A call's record shows as one
    // card, without an entry id: no turn ran for it, so nothing rewinds to it.
    const shown = SystemEntry.is(entry) || ExtensionMessageEntry.is(entry) || isCustomInput(entry.model?.[0]) ? []
      : CompactionEntry.is(entry) ? [{ role: "compaction", summary: compactionSummary(entry), tokensBefore: this.#contextTokens(index) }]
      : CallEntry.is(entry) ? [{ role: "call", record: entry.data }]
      : (entry.model ?? []).map((message) => ({ ...message, entryId: String(entry.id) }));
    this.#history.splice(index, 0, { entry, shown });
    this.#changed();
  }

  #changed(): void {
    this.#shown = undefined;
    this.#contextSize = undefined;
    this.#rows = undefined;
  }

  /** Where the history since the latest reset (`/clear`) starts. */
  #resetIndex(): number {
    for (let index = this.#history.length - 1; index >= 0; index--) {
      if (ResetEntry.is(this.#history[index]!.entry)) return index;
    }
    return 0;
  }

  /** The transcript's messages: the history since the latest reset, each message with its entry ID, and every
   * compaction as a marker where Durable placed its summary. Compaction never hides history; a reset does. */
  #visible(): unknown[] {
    this.#shown ??= this.#history.slice(this.#resetIndex()).flatMap((row) => row.shown);
    return this.#shown;
  }

  /**
   * Durable's own size estimate (its `estimateContext`) of the context ending before history row `end`: the usage of
   * the newest request answered after the head marker, plus estimates of every message after it; without one,
   * estimates of the whole context, system prompt entries included. The head marker is the newest compaction or
   * reset; its context starts at the entry it heads, and later entries' context edits omit or replace earlier ones
   * (Durable re-baselines its system entries that way).
   */
  #contextTokens(end: number): number {
    let head: EntryRecord | undefined;
    for (let index = end - 1; index >= 0 && !head; index--) {
      if (this.#history[index]!.entry.head !== undefined) head = this.#history[index]!.entry;
    }
    const edits = new Map<EntryId, readonly Message[]>();
    let tokens = 0;
    for (let index = end - 1; index >= 0; index--) {
      const entry = this.#history[index]!.entry;
      if (head?.head !== undefined && entry.id < head.head) break;
      if (entry !== head && entry.head !== undefined) continue;
      // Walking back, the first edit seen for an entry is its latest one.
      for (const edit of entry.edits ?? []) {
        if (!edits.has(edit.target)) edits.set(edit.target, edit.action === "replace" ? edit.messages : []);
      }
      const messages = edits.get(entry.id) ?? entry.model ?? [];
      for (let position = messages.length - 1; position >= 0; position--) {
        const message = messages[position]!;
        if (!inContext(message)) continue;
        const usage = message.role === "assistant" ? message.usage : undefined;
        if (usage && (!head || entry.id > head.id) && calculateContextTokens(usage) > 0) return tokens + calculateContextTokens(usage);
        tokens += estimateMessageTokens(message);
      }
    }
    return tokens;
  }

  async #refreshQueue(): Promise<void> {
    const items = await this.#harness.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, this.#conversation.id) as unknown as { items?: readonly { mode: string; content?: unknown }[] };
      return JSON.parse(JSON.stringify(inbox.items ?? [])) as { mode: string; content?: unknown }[];
    }, context);
    const text = (content: unknown) => restoreAttachmentNames(
      typeof content === "string" ? content : textOf({ role: "user", content } as Message),
    ).text;
    this.#queue = {
      steering: items.filter((item) => item.mode === "steer").map((item) => text(item.content)),
      followUp: items.filter((item) => item.mode === "followUp").map((item) => text(item.content)),
    };
  }

  async #onEvent(event: AgentEvent): Promise<void> {
    await this.#handle(event);
    if (!this.#disposed) this.#extensions?.observe(event);
  }

  async #handle(event: AgentEvent): Promise<void> {
    if (this.#disposed) return;
    switch (event.type) {
      case "snapshot":
        // The stream fell more than 100 commits behind and restarted from a snapshot.
        await this.#resync(event);
        return;
      case "run_start":
        this.#streaming = true;
        return;
      case "turn_start":
      case "turn_end":
        this.#emit({ type: event.type });
        return;
      case "message_start":
        this.#streamedText.clear();
        if (event.message.role === "assistant") event.message.content.forEach((block, index) => this.#streamBlock(index, block));
        return;
      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta" && change.delta) {
            this.#streamedText.set(change.contentIndex, (this.#streamedText.get(change.contentIndex) ?? "") + change.delta);
            this.#emit({ type: "text", delta: change.delta });
          } else if (change.type === "thinking_delta" && change.delta) this.#emit({ type: "thinking", delta: change.delta });
          else if (change.type === "text_start" || change.type === "block") this.#streamBlock(change.contentIndex, change.block);
          else if (change.type === "message") change.message.content.forEach((block, index) => this.#streamBlock(index, block));
        }
        return;
      case "message_end":
      case "entry_appended":
        if (event.type === "message_end") this.#streamedText.clear();
        this.#add(event.entry);
        // A call's record, written while no run streams: the chat shows it now rather than at the next settle.
        if (event.type === "entry_appended" && CallEntry.is(event.entry) && !this.#streaming) this.#emit({ type: "history" });
        return;
      case "tool_execution_start":
        if (event.parentToolCallId) {
          this.#nestedCall(event.parentToolCallId, event.toolCallId, () => startedCall(event.toolName, event.args));
          return;
        }
        this.#toolOutput.set(event.toolCallId, "");
        if (event.toolName === CODEMODE_TOOL_NAME) this.#nestedCalls.set(event.toolCallId, new Map());
        this.#emit({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
        return;
      case "tool_execution_update": {
        // A script's call shows only its row; its output went to the script.
        if (event.parentToolCallId) return;
        let output = this.#toolOutput.get(event.toolCallId) ?? "";
        if (event.output && "set" in event.output) output = event.output.set;
        else if (event.output) output = output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
        this.#toolOutput.set(event.toolCallId, output);
        this.#emit({
          type: "tool_update", id: event.toolCallId, name: event.toolName, output,
          ...(event.details !== undefined ? { details: event.details } : {}),
        });
        return;
      }
      case "tool_execution_end": {
        if (event.parentToolCallId) {
          const { result } = event;
          this.#nestedCall(event.parentToolCallId, event.toolCallId, (current = startedCall(event.toolName, undefined)) => endedCall(current, result && {
            isError: result.isError, durationMs: result.durationMs,
            error: result.diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.message).join("\n"),
          }));
          return;
        }
        // Its result lists the calls; a live list still pending would replace that list.
        this.#nestedCalls.delete(event.toolCallId);
        this.#changedCalls.delete(event.toolCallId);
        if (event.entry) this.#add(event.entry);
        const result = event.entry?.model?.[0] as (Message & { isError?: boolean; details?: unknown }) | undefined;
        this.#toolOutput.delete(event.toolCallId);
        this.#emit({
          type: "tool_end", id: event.toolCallId, name: event.toolName,
          output: toolOutput(result?.content) ?? "",
          ...(result?.details !== undefined ? { details: result.details } : {}),
          failed: result?.isError === true,
        });
        return;
      }
      case "inbox_update":
        await this.#refreshQueue();
        this.#emit({ type: "queue_update", queue: this.pendingQueue() });
        return;
      case "agent_changed":
        this.#agent = event.agent;
        return;
      case "auto_retry_start":
        this.#emit({ type: "notice", level: "warning", message: `Retrying after a provider error (attempt ${event.attempt}): ${event.errorMessage}`, recovery: true });
        return;
      case "task_failed":
        // A failed compaction's divider shows its reason instead.
        if (event.kind !== COMPACTION_TASK) this.#emit({ type: "notice", level: "error", message: event.message });
        return;
      case "compaction_start":
        this.#requested.delete(event.taskId);
        if (this.#superseded.has(event.taskId) || this.#compactions.has(event.taskId)) return;
        this.#compactions.set(event.taskId, compactionOf(event));
        this.#announce();
        return;
      case "compaction_end":
        await this.#compactionEnded(event.taskId, event.reason);
        return;
      case "run_end":
        await this.#settle();
        return;
      default:
        return;
    }
  }

  /** Streams what a text block adds to what it showed. A block that no longer extends it is left to the history
   * refresh that ends the run (streamed text cannot be taken back). */
  #streamBlock(index: number, block: { type: string; text?: unknown }): void {
    if (block.type !== "text" || typeof block.text !== "string") return;
    const before = this.#streamedText.get(index) ?? "";
    if (!block.text.startsWith(before)) return;
    if (block.text.length > before.length) this.#emit({ type: "text", delta: block.text.slice(before.length) });
    this.#streamedText.set(index, block.text);
  }

  /** After a run, or a compaction outside one: read what the store committed, then report the settle. */
  async #settle(): Promise<void> {
    let historyRefreshed = true;
    try {
      await this.#read();
    } catch (error) {
      historyRefreshed = false;
      this.#emit({ type: "error", message: error instanceof Error ? error.message : "Durable history refresh failed." });
    }
    this.#streaming = false;
    this.#notifyQuiet();
    const ended = this.#extensions?.settled();
    if (!ended) {
      this.#emit({ type: "settled", historyRefreshed });
      return;
    }
    // As in PI, the run is over once its extensions' end-of-run handlers ran; they run beside the stream, so one may wait
    // for a run it starts. One that never finishes holds the settle only so long.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), QUIET_TIMEOUT_MS); });
    this.#settling += 1;
    void Promise.race([ended, late]).then((outcome) => {
      clearTimeout(timer);
      this.#settling -= 1;
      this.#notifyQuiet();
      if (this.#disposed) return;
      if (outcome === "late") this.#emit({ type: "notice", level: "warning", message: "An extension is still handling the end of the run." });
      this.#emit({ type: "settled", historyRefreshed });
    });
  }

  /** Reports a compaction's outcome. Durable places a summary at once on an idle conversation, otherwise at the next
   * boundary of the run, which settles with it; the history is read first, so it holds a summary placed at once. */
  async #compactionEnded(taskId: TaskId, reason: CompactionReason): Promise<void> {
    const blocking = this.#compactions.get(taskId)?.blocking === true;
    this.#compactions.delete(taskId);
    this.#requested.delete(taskId);
    if (this.#superseded.delete(taskId)) return;
    await this.#reportEnd(taskId, reason, blocking);
  }

  async #reportEnd(taskId: TaskId, reason: CompactionReason, blocking: boolean): Promise<void> {
    const { result: _summary, ...result } = await this.#compactionOutcome(taskId, reason);
    if (result.outcome === "done") await this.#read().catch(() => {});
    this.#ended({ type: "compaction_end", reason, ...result, willRetry: blocking && result.outcome === "done" });
    this.#notifyQuiet();
  }

  /** Every compaction end the session reports also reaches its extensions. */
  #ended(event: Extract<RuntimeEvent, { type: "compaction_end" }>): void {
    this.#lastStart = undefined;
    this.#emit(event);
    this.#announce();
  }

  /** Reports the compaction the session shows, unless it is the one reported last: `compact()` reports a manual one
   * before Durable lists it, and a blocking one outranks it. */
  #announce(): void {
    const leading = this.#leading();
    if (!leading) return;
    const start = startOf(leading);
    const last = this.#lastStart;
    if (last && last.reason === start.reason && last.blocking === start.blocking && last.background === start.background) return;
    this.#lastStart = start;
    this.#emit(start);
  }

  /** The compaction the session shows while several run: one its run waits for, then a manual one, then background. */
  #leading(): Compaction | undefined {
    const rank = (compaction: Compaction) => compaction.blocking ? 2 : compaction.background ? 0 : 1;
    let shown: Compaction | undefined;
    for (const compaction of this.#compactions.values()) {
      if (!shown || rank(compaction) > rank(shown)) shown = compaction;
    }
    return shown;
  }

  /** The compaction task's receipt: a summary, nothing old enough to summarize, a cancel or a failure. */
  async #compactionOutcome(taskId: TaskId, reason: CompactionReason): Promise<CompactionOutcome> {
    await this.#host.resumed;
    let outcome;
    try {
      outcome = (await this.#harness.waitForTask(taskId as unknown as TaskId<CompactionResult>, context)).state.outcome;
    } catch (error) {
      return { outcome: "failed", message: error instanceof Error ? error.message : "Durable lost track of this compaction." };
    }
    if (outcome.status === "completed") {
      if (outcome.result?.entryId !== undefined || outcome.result?.submissionId !== undefined) return { outcome: "done", result: outcome.result };
      // Durable found nothing old enough to summarize; only a requested compaction reports that, in PI's words.
      return reason === "manual" ? { outcome: "failed", message: "Nothing to compact (session too small)" } : { outcome: "done" };
    }
    if (outcome.status === "aborted") return { outcome: "cancelled" };
    if (outcome.status === "failed") return { outcome: "failed", message: outcome.error.message };
    const detail = (outcome as { reason?: unknown }).reason;
    return { outcome: "failed", message: typeof detail === "string" && detail ? detail : "Durable could not finish the compaction." };
  }

  /** A fresh snapshot after the stream fell behind: adopt it, report the compactions that started or ended in the
   * gap, and read the history it skipped. */
  async #resync(snapshot: SnapshotEvent): Promise<void> {
    const running = this.#streaming;
    this.#syncSnapshot(snapshot);
    const live = new Set<TaskId>(snapshot.compactions.map((status) => status.taskId));
    let started = false;
    for (const status of snapshot.compactions) {
      this.#requested.delete(status.taskId);
      if (this.#compactions.has(status.taskId) || this.#superseded.has(status.taskId)) continue;
      this.#compactions.set(status.taskId, compactionOf(status));
      started = true;
    }
    if (started) this.#announce();
    for (const [taskId, { reason }] of [...this.#compactions]) {
      if (!live.has(taskId)) await this.#compactionEnded(taskId, reason);
    }
    for (const taskId of [...this.#superseded]) {
      if (!live.has(taskId)) this.#superseded.delete(taskId);
    }
    if (running && !this.#streaming) await this.#settle();
    else await this.#read().catch(() => {});
  }

  /** A run or a starting prompt, or a compaction of Durable's ordinary scope (blocking or manual, which Stop cancels),
   * is live in this view. */
  #busy(): boolean {
    return this.#streaming || this.#starting > 0 || [...this.#compactions.values()].some((compaction) => !compaction.background);
  }

  #notifyQuiet(): void {
    for (const waiter of [...this.#waiters]) if (waiter.done()) waiter.resolve();
  }

  /** Resolves once `done` holds in this view, or after `timeoutMs`. */
  #until(done: () => boolean, timeoutMs = QUIET_TIMEOUT_MS): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { done, resolve: () => { clearTimeout(timer); this.#waiters.delete(waiter); resolve(); } };
      const timer = Number.isFinite(timeoutMs) ? setTimeout(waiter.resolve, timeoutMs) : undefined;
      this.#waiters.add(waiter);
    });
  }

  /** An extension's `ctx.waitForIdle()`: until the run and the compactions it waits on are over. */
  waitForIdle(): Promise<void> {
    return this.#until(() => !this.#busy(), Number.POSITIVE_INFINITY);
  }

  /** HUI's `$name` alias for a skill or extension command, as `/name`. */
  async #alias(text: string): Promise<string> {
    return /^\$[^\s]+(?:\s|$)/u.test(text) ? resolveCommandReference(text, await this.listCommands()) : text;
  }

  async #refusedSkill(text: string): Promise<string | undefined> {
    if (!/^(?:\/skill:|\$)\S/u.test(text)) return undefined;
    const disabled = (await this.#host.settings()).disabledSkills;
    const disabledPaths = new Set(disabled.map((entry) => entry.path));
    const usable = new Set((await this.#skills(await this.#loader())).filter((skill) => !disabledPaths.has(skill.filePath)).map((skill) => skill.name));
    return disabledSkillNotice(text, disabled.filter((entry) => !usable.has(entry.name)));
  }

  async #expand(text: string): Promise<string> {
    const loader = await this.#loader();
    const skills = /^\/skill:|(?<!\S)\$/u.test(text) ? await this.#skills(loader) : [];
    return expandSkill(text, skills, (body) => expandPromptTemplate(body, loader.getPrompts().prompts));
  }

  /**
   * PI's order for input: `input` handlers, then skill and template expansion, then, for input that starts a run,
   * `before_agent_start`, whose custom messages are written just before it. False when an extension handled the input
   * or aborted the run before it started, so nothing was submitted.
   */
  async #send(text: string, whenBusy: Delivery, sending: Sending): Promise<boolean> {
    const extensions = this.#extensions;
    const attachments = sending.attachments ?? [];
    let images: readonly ImageContent[] = [
      ...(sending.images ?? []),
      ...attachments.flatMap((item) => item.kind === "image" ? [{ type: "image" as const, data: item.dataBase64, mimeType: item.mimeType }] : []),
    ];
    const refused = sending.expand ? await this.#refusedSkill(text) : undefined;
    if (refused) {
      this.#emit({ type: "notice", level: "warning", message: refused });
      return false;
    }
    if (extensions) {
      const input = await extensions.input(text, images, sending.source, whenBusy === "reject" ? undefined : whenBusy);
      if (!input) return false;
      ({ text, images } = input);
    }
    if (sending.expand) text = await this.#expand(text);
    if (extensions && whenBusy === "reject") {
      const start = await extensions.beforeAgentStart({ messageType: "user", prompt: text, images });
      if (start.aborted) return false;
      // PI sends them after the prompt; Durable admits input in a commit of its own, so they go just before it.
      if (start.messages.length) await extensions.writeMessages(start.messages, true);
    }
    await extensions?.writesAdmitted();
    await this.#host.resumed;
    if (extensions?.startAborted) return false;
    // The message names every attachment; the images themselves are the ones the handlers left.
    const payload = promptPayload(text, attachments);
    await this.#submit([{ type: "text", text: payload.message }, ...images], whenBusy, sending.requestId);
    return true;
  }

  /** A run is going from the moment its input is submitted. */
  async #submit(content: readonly (TextContent | ImageContent)[], whenBusy: Delivery, requestId?: string): Promise<void> {
    // Durable submission resumes the whole store, not just this conversation.
    await this.#host.resumed;
    if (requestId && this.#cancelledTracked.has(requestId)) throw new DOMException("The tracked input was cancelled before admission.", "AbortError");
    if (whenBusy === "reject") this.#streaming = true;
    try {
      await this.#conversation.submit({ type: "input", whenBusy, content: [...content], ...(requestId === undefined ? {} : { requestId }) }, context);
    } catch (error) {
      if (whenBusy === "reject") this.#streaming = false;
      throw error;
    }
  }

  /**
   * Starts a run with `text`. While its handlers run the session is starting, not running, as in PI. One that never
   * starts (handled or aborted) settles at once, unless another prompt or run is underway. Resolves once the input is
   * submitted, or when a handler first asks the user something: the start then goes on, and reports its own failure.
   */
  async #start(text: string, sending: Sending): Promise<void> {
    this.#starting += 1;
    if (sending.requestId) this.#trackedStarting.add(sending.requestId);
    // As HUI records a run's prompt: a routine's or another bot's marker leads it.
    this.#runInput = text;
    const start = () => this.#send(text, "reject", sending).then((sent) => {
      if (!sent && !this.#streaming && this.#starting === 1) this.#emit({ type: "settled" });
    }).finally(() => {
      this.#starting -= 1;
      if (sending.requestId) this.#trackedStarting.delete(sending.requestId);
      this.#notifyQuiet();
    });
    if (!this.#extensions) return start();
    const { done, released } = this.#extensions.whileAsking(start);
    // Tracked callers wait for a durable admission, not merely for a question that released the ordinary composer.
    // BotService observes cancellation before dispatch, so a question cannot prevent cancelling this start.
    if (sending.requestId) {
      void released.catch(() => {});
      return done;
    }
    await released;
    // Before release a failure rejects the prompt; after a question releases it, report the failure as an event.
    void done.catch((error: unknown) => {
      this.#emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      this.#emit({ type: "settled" });
    });
  }

  async prompt(text: string, attachments: readonly PromptAttachment[] = [], options?: RuntimePromptOptions): Promise<void> {
    await this.#trackedStart(options, async () => {
      text = await this.#alias(text);
      if (this.#extensions?.isCommand(text)) {
        await this.#command(text);
        return;
      }
      await this.#start(text, { attachments, source: "rpc", expand: true, ...options });
    });
  }

  /** Look up the caller's exact admission, including after the host and this view were reopened. */
  #trackedSubmission(requestId: string): Promise<SubmissionRecord | undefined> {
    return this.#harness.commit((tx) => tx.submissionByRequest(this.#conversation.id, requestId), context);
  }

  async #trackedStart(options: RuntimePromptOptions | undefined, send: () => Promise<void>): Promise<void> {
    if (!options) return send();
    const pending = this.#trackedStarts.get(options.requestId);
    if (pending) return pending;
    const started = (async () => {
      // Checking before aliases and extension handlers prevents a duplicate request from replaying their side effects.
      if (await this.#trackedSubmission(options.requestId)) return;
      if (this.#cancelledTracked.has(options.requestId)) throw new DOMException("The tracked input was cancelled before admission.", "AbortError");
      await send();
    })();
    this.#trackedStarts.set(options.requestId, started);
    try { await started; }
    finally { if (this.#trackedStarts.get(options.requestId) === started) this.#trackedStarts.delete(options.requestId); }
  }

  async waitForTrackedPrompt(requestId: string): Promise<RuntimePromptResult> {
    const record = await this.#trackedSubmission(requestId);
    if (!record || record.type !== "input") throw new Error("The routine's accepted input could not be found. Check its chat before running it again.");
    const submission = await this.#harness.submission(record.id, context);
    if (!submission) throw new Error("The routine's input receipt is unavailable. Check its chat before running it again.");
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.type !== "input") {
      const detail = settled.status === "unanswered" ? [settled.reason, typeof settled.detail === "string" ? settled.detail : undefined].filter(Boolean).join(": ") : "no answer was recorded";
      throw new Error(`The routine's input was not answered: ${detail}. Check its chat before running it again.`);
    }
    const answer = await this.#harness.commit((tx) => tx.entry(settled.answer), context);
    const summary = answer?.model?.filter((message) => message.role === "assistant").map(textOf).join("\n").trim();
    return summary ? { summary } : {};
  }

  async cancelTrackedPrompt(requestId: string): Promise<void> {
    const record = await this.#trackedSubmission(requestId);
    if (!record) {
      this.#cancelledTracked.add(requestId);
      if (this.#trackedStarting.has(requestId)) {
        this.#extensions?.abortStart();
        this.#extensions?.aborted();
      }
      return;
    }
    if (record.type !== "input") return;
    for (;;) {
      const withdrawn = await this.#harness.abortSubmission(record.id, context, this.#conversation.id);
      if (withdrawn !== "already_placed") return;
      // Capture only the task owning this exact input. If it settles before abortTask, aborting that terminal task is
      // a no-op; Conversation.abort could instead stop an unrelated turn that started in the meantime.
      const task = await this.#harness.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, this.#conversation.id);
        return live.run?.inputs.includes(record.id) ? live.run.taskId : undefined;
      }, context);
      if (task === undefined) return;
      await this.#harness.abortTask(task, context);
      await this.#harness.waitForTask(task, context);
      // A tool round may have transferred this input to its next generation before the abort was admitted. Recheck
      // the same receipt and target that task, not whichever unrelated run the conversation may now be answering.
      const current = await this.#trackedSubmission(requestId);
      if (current?.status !== "placed") return;
    }
  }

  /** An extension command runs in the gateway; one that starts no run settles once it ends. A prompt it sent settles
   * by itself. */
  async #command(text: string): Promise<void> {
    const { finished } = await this.#extensions!.runCommand(text);
    void finished.then(() => { if (!this.#streaming && this.#starting === 0 && !this.#disposed) this.#emit({ type: "settled" }); });
  }

  async #queueInput(text: string, attachments: readonly PromptAttachment[], whenBusy: "steer" | "followUp", options?: RuntimePromptOptions): Promise<void> {
    text = await this.#alias(text);
    if (this.#extensions?.isCommand(text)) throw new Error(`Extension command "${text.split(/\s/u)[0]}" cannot be queued. Send it when the session is idle.`);
    // Steering a run that is still starting (an extension's custom message) waits until there is a run to steer.
    while (this.starting) await this.whenStarted();
    await this.#send(text, whenBusy, { attachments, source: "rpc", expand: true, ...options });
  }

  async steer(text: string, attachments: readonly PromptAttachment[] = []): Promise<void> {
    await this.#queueInput(text, attachments, "steer");
  }

  async followUp(text: string, attachments: readonly PromptAttachment[] = [], options?: RuntimePromptOptions): Promise<void> {
    await this.#trackedStart(options, () => this.#queueInput(text, attachments, "followUp", options));
  }

  /** `pi.sendUserMessage`: input from an extension, with no command or template expansion, as in PI. */
  async sendUserMessage(text: string, images: readonly ImageContent[], deliverAs?: "steer" | "followUp"): Promise<void> {
    // As in PI 1.2.0, a run that is starting counts as busy: the message goes into it once it has started.
    if (this.starting && !deliverAs) throw new Error("The session is already working. Send the message with deliverAs \"steer\" or \"followUp\".");
    while (this.starting) await this.whenStarted();
    if (!this.#streaming) return this.#start(text, { images, source: "extension", expand: false });
    if (!deliverAs) throw new Error("The session is already working. Send the message with deliverAs \"steer\" or \"followUp\".");
    await this.#send(text, deliverAs, { images, source: "extension", expand: false });
  }

  /** A custom message that starts or steers a turn: input that bypasses extension handlers. Its text part keeps the
   * custom type, so the transcript hides it as PI sessions do and extensions see it as custom. */
  async submitInput(message: CustomMessage, whenBusy: Delivery): Promise<void> {
    const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : [...message.content];
    const index = parts.findIndex((part) => part.type === "text");
    // Providers refuse an empty text part: one with only images is labelled.
    const text = index === -1 ? { type: "text" as const, text: `[${message.customType}]` } : parts.splice(index, 1)[0] as TextContent;
    const tagged: TextContent & Pick<CustomMessage, "customType" | "display"> = { ...text, customType: message.customType, display: message.display };
    const extensions = this.#extensions;
    if (whenBusy !== "reject" || !extensions) return this.#submit([tagged, ...parts], whenBusy);
    // As in PI 1.2.0, a run it starts goes through `before_agent_start` too, whose messages are written just before it.
    this.#starting += 1;
    this.#customStarts += 1;
    try {
      const start = await extensions.beforeAgentStart({ messageType: "custom", message });
      if (start.aborted) return;
      if (start.messages.length) await extensions.writeMessages(start.messages, true);
      await extensions.writesAdmitted();
      if (extensions.startAborted) return;
      await this.#submit([tagged, ...parts], whenBusy);
    } finally {
      this.#starting -= 1;
      this.#customStarts -= 1;
      this.#notifyQuiet();
    }
  }

  /** Starts a manual compaction, which Durable runs beside the conversation: input is admitted meanwhile and the
   * summary is placed at the next boundary. Its start is reported before Durable lists it, so the gateway never holds
   * a prompt for it; the outcome arrives as `compaction_end`. */
  async compact(instructions?: string): Promise<void> {
    await this.#startCompaction(instructions).catch(() => undefined);
  }

  /** An extension's `ctx.compact()`: the summary entry its own compaction placed. A run defers the summary to its next
   * boundary, so this waits for that write; a summary Durable drops as stale, or one left on a conversation a rewind
   * replaced, fails. */
  async compactEntry(instructions?: string): Promise<EntryId> {
    const conversation = this.#conversation;
    const taskId = await this.#startCompaction(instructions);
    const { outcome, message, result } = await this.#compactionOutcome(taskId as unknown as TaskId, "manual");
    if (outcome !== "done") throw new Error(message ?? "Compaction cancelled");
    let entry = result?.entryId;
    if (entry === undefined && result?.submissionId !== undefined) {
      const write = await (await this.#harness.submission(result.submissionId, context))?.wait(context);
      if (write?.status !== "done") throw new Error(`The compaction summary was not placed${write ? `: ${write.reason}` : ""}`);
      entry = write.entry;
    }
    if (entry === undefined || this.#conversation !== conversation) throw new Error("Compaction cancelled");
    await this.#read();
    return entry;
  }

  /** Starts a manual compaction and reports its start; a failure to start is reported as its end, then thrown. */
  async #startCompaction(instructions?: string): Promise<TaskId<CompactionResult>> {
    this.#lastStart = { type: "compaction_start", reason: "manual", blocking: false };
    this.#emit(this.#lastStart);
    await this.#host.resumed;
    let taskId: TaskId<CompactionResult>;
    try {
      taskId = await this.#conversation.compact(instructions?.trim() || undefined, context);
    } catch (error) {
      this.#ended({ type: "compaction_end", reason: "manual", outcome: "failed", willRetry: false, message: error instanceof Error ? error.message : "Durable could not start the compaction." });
      throw error;
    }
    const id = taskId as unknown as TaskId;
    if (!this.#compactions.has(id)) this.#requested.add(id);
    // The stream normally lists it and reports its end. If the stream fell behind and a snapshot replaced the commits
    // that did, the receipt reports the end instead; its listing and end are then ignored if they still arrive.
    void this.#harness.waitForTask(taskId, context).then(async () => {
      if (!this.#requested.delete(id)) return;
      this.#superseded.add(id);
      await this.#reportEnd(id, "manual", false);
    }, () => undefined);
    return taskId;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    // A compaction already running (one Durable resumed after a restart, or started before this view attached) is
    // reported to each new subscriber, so the session shows it.
    const shown = this.#leading();
    if (shown) listener(startOf(shown));
    return () => { this.#listeners.delete(listener); };
  }

  currentModel(): RuntimeModel | undefined {
    const ref = this.#agent.model;
    if (!ref) return undefined;
    const model = this.#host.models.getModel(ref.provider, ref.modelId);
    return {
      provider: ref.provider, id: ref.modelId, name: model?.name ?? ref.modelId,
      ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model?.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model ? this.#controls(model) : {}),
    };
  }

  /** Context use as Durable measures it against its compaction thresholds, plus the latest run's spend. */
  currentUsage(): RuntimeUsage | undefined {
    const window = this.currentModel()?.contextWindow;
    if (!window) return undefined;
    const tokens = this.#history.length ? this.#contextSize ??= this.#contextTokens(this.#history.length) : null;
    return {
      contextTokens: tokens,
      contextWindow: window,
      percent: tokens === null ? null : Math.min(100, (tokens / window) * 100),
      ...latestRunUsage(this.#visible()),
    };
  }

  async listModels(): Promise<readonly RuntimeModel[]> {
    const catalog = (await this.#host.models.getAvailable()).map((model) => ({
      provider: model.provider, id: model.id, name: model.name,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...this.#controls(model),
    }));
    return filterConfiguredModels(catalog, this.#host.agentDir);
  }

  async listCommands(): Promise<readonly RuntimeCommand[]> {
    const loader = await this.#loader();
    return [
      ...(this.#extensions?.commands() ?? []),
      ...(await this.#skills(loader)).map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" as const })),
      ...loader.getPrompts().prompts.map((prompt) => ({ name: prompt.name, description: prompt.description ?? "", source: "prompt" as const })),
    ];
  }

  async setModel(provider: string, id: string): Promise<void> {
    const model = this.#host.models.getModel(provider, id);
    if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
    const thinking = fitThinking(model, this.#chosenThinking ?? this.#agent.thinkingLevel ?? "off");
    const previous = this.currentModel();
    await this.#conversation.configure({ model: { provider, modelId: id }, thinkingLevel: thinking }, context);
    this.#agent = { ...this.#agent, model: { provider, modelId: id }, thinkingLevel: thinking };
    this.#extensions?.modelSelected(previous);
  }

  /** HUI's level: `ultra` while it is chosen, otherwise the one the model is sent. */
  currentThinking(): string | undefined {
    return this.#chosenThinking === "ultra" ? "ultra" : this.#agent.thinkingLevel;
  }

  /** The level the model is sent, which PI extensions see. */
  modelThinking(): string | undefined {
    return this.#agent.thinkingLevel;
  }

  async setThinking(level: string): Promise<void> {
    if (level === "ultra" && this.#botChat) throw new Error("A bot's chat has no Ultra; choose Maximum.");
    const previous = this.#agent.thinkingLevel;
    const ref = this.#agent.model;
    const model = ref ? this.#host.models.getModel(ref.provider, ref.modelId) : undefined;
    const sent = model ? fitThinking(model, level) : piThinking(level) as ModelThinkingLevel;
    await this.#conversation.configure({ thinkingLevel: sent }, context);
    this.#agent = { ...this.#agent, thinkingLevel: sent };
    this.#chosenThinking = level;
    if (this.#huiSessionId) this.#host.setUltra(this.#huiSessionId, level === "ultra");
    this.#extensions?.thinkingSelected(previous, sent);
  }

  /** A model's controls here: PI's levels, then HUI's `ultra`, which only Durable's prompt carries (not a bot's chat). */
  #controls(model: Parameters<typeof modelControls>[0]): ReturnType<typeof modelControls> {
    const controls = modelControls(model);
    return this.#botChat ? controls : { ...controls, thinkingLevels: [...controls.thinkingLevels, "ultra"] };
  }

  currentFast(): boolean {
    return this.#huiSessionId !== undefined && this.#host.isFast(this.#huiSessionId);
  }

  /** Kept per HUI session by the host, which adds it to that session's requests. */
  async setFast(on: boolean): Promise<void> {
    if (this.#huiSessionId === undefined) throw new Error("Fast mode needs a HUI session.");
    this.#host.setFast(this.#huiSessionId, on);
  }

  pendingQueue(): RuntimeQueue {
    return { steering: [...this.#queue.steering], followUp: [...this.#queue.followUp] };
  }

  /** Questions the session's extensions are waiting on, and its own. */
  pendingQuestions(): readonly RuntimeQuestion[] {
    return [...this.#extensions?.pendingQuestions() ?? [], ...this.#questions.pending()];
  }

  async respondQuestion(id: string, response: RuntimeQuestionResponse): Promise<void> {
    if (this.#questions.has(id)) return this.#questions.respond(id, response);
    if (!this.#extensions) throw new Error(`Unknown question: ${id}`);
    this.#extensions.respondQuestion(id, response);
  }

  async cancelQuestion(id: string): Promise<void> {
    if (this.#questions.has(id)) return this.#questions.cancel(id);
    if (!this.#extensions) throw new Error(`Unknown question: ${id}`);
    this.#extensions.cancelQuestion(id);
  }

  /** Durable's Stop (`Conversation.abort`): withdraws queued input and cancels the run and every compaction of its
   * ordinary scope, blocking and manual ones; background compactions keep running. Resolves once this view has seen
   * that work end and the run's end-of-run handlers finish, as PI's Stop does: HUI treats a resolved Stop as idle. */
  async abort(): Promise<void> {
    this.#extensions?.aborted();
    if (this.#starting > 0) this.#extensions?.abortStart();
    await this.#host.resumed;
    await this.#conversation.abort(context);
    await this.#until(() => !this.#busy());
    await this.#until(() => this.#settling === 0);
  }

  /** Cancels the manual compactions running beside the conversation, and only them (Durable's `abortTask`), and
   * resolves once this view has seen them end. Background ones are Durable's own and keep running. */
  async cancelCompaction(): Promise<void> {
    // Including one `compact()` started that the stream has not listed yet.
    const manual = [...this.#compactions].flatMap(([taskId, compaction]) => compaction.blocking || compaction.background ? [] : [taskId]);
    const tasks = [...new Set([...manual, ...this.#requested])];
    // A task that finished meanwhile is already terminal; its end is reported as usual.
    await Promise.all(tasks.map((taskId) => this.#harness.abortTask(taskId, context).catch(() => undefined)));
    await this.#until(() => tasks.every((taskId) => !this.#compactions.has(taskId) && !this.#requested.has(taskId)));
  }

  /** A fresh context; the earlier entries stay in the store. A compaction running beside the conversation carries on,
   * but the reset makes its summary stale and Durable drops it, so its end is not reported. */
  async clear(): Promise<void> {
    if (this.#streaming) throw new Error("Wait for the current run to finish before clearing the session.");
    await this.#host.resumed;
    await this.#conversation.reset(undefined, context);
    for (const taskId of this.#compactions.keys()) this.#superseded.add(taskId);
    this.#compactions.clear();
    this.#lastStart = undefined;
    await this.#read();
    // A cleared PI session is a new one, with new extension instances.
    await this.#extensions?.restart("new");
  }

  async reload(): Promise<void> {
    this.#host.prompt.reload(this.#cwd);
    await this.#loader();
    if (this.#extensions) {
      await this.#extensions.restart("reload");
    } else if (this.#huiSessionId) {
      await this.loadExtensions(this.#huiSessionId);
      await this.startExtensions("reload");
    }
  }

  /** Durable history is append-only, so a rewind forks the conversation at that point and continues in the fork; the
   * abandoned branch stays stored. The fork holds the history up to that point and nothing placed after it, a later
   * summary included, so the model reads the original turns again and Durable compacts the fork when it needs to. A
   * compaction still running beside the conversation finishes on the abandoned branch. */
  async rewind(target: RuntimeRewindTarget, options?: RuntimeRewindOptions): Promise<void> {
    if (this.#streaming) throw new Error("Wait for the current run to finish before rewinding.");
    await this.#read();
    const visible = this.#history.slice(this.#resetIndex());
    const row = typeof target === "string"
      ? visible.find((candidate) => String(candidate.entry.id) === target && !CompactionEntry.is(candidate.entry) && candidate.shown.length > 0)
      // Counted as the browser and PI's worker count: user messages since the latest reset, from the end.
      : visible.filter((candidate) => candidate.shown.some((message) => role(message) === "user")).at(-1 - target.userFromEnd);
    if (!row) throw new Error("That rewind point is no longer available.");
    const index = this.#history.indexOf(row);
    const isUser = role(row.shown[0]) === "user";
    // Drop this prompt's context, not independent messages an idle extension or command wrote before it.
    let before = index;
    while (before > 0) {
      const previous = this.#history[before - 1]!.entry;
      if (!ExtensionMessageEntry.is(previous) || !previous.data.forPrompt) break;
      before--;
    }
    const at = options?.excludeUserMessage === true && isUser ? this.#history[before - 1]?.entry.id : row.entry.id;
    const optchat = await this.#host.optchat.enabled(this.#conversation.id);
    const next = at
      ? await this.#conversation.fork(at, { ownership: { kind: "ownerless" } }, context)
      : await this.#harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
          ...(this.#agent.model ? { model: this.#agent.model } : {}),
          ...(this.#agent.thinkingLevel ? { thinkingLevel: this.#agent.thinkingLevel } : {}),
          cwd: this.#cwd,
        } }, context);
    await this.#stop?.();
    this.#host.bindCallerLike(this.#conversation.id, next.id);
    this.#conversation = next;
    this.#toolOutput.clear();
    this.#nestedCalls.clear();
    this.#changedCalls.clear();
    await this.attach();
    // A fork keeps its parent's agent; a conversation started over needs the session's extensions and tools again, and
    // a fork of an OptChat conversation, which starts without OptChat, gives up its tools.
    if (!at || optchat) await this.applyTools();
    this.#extensions?.rewound();
  }

  /** A fork into another session: the history up to one entry (the latest point a fork can carry on from when absent)
   * copied into a new conversation of the same harness. This conversation is not touched and may keep running. The
   * copy keeps the agent (model, thinking, tools) as of that entry and, like a rewind's fork, starts without OptChat.
   * `cwd` moves the copy's agent to another directory, such as a worktree made for it. */
  async fork(entryId?: string, options?: { cwd?: string }): Promise<string> {
    await this.#read();
    const visible = this.#history.slice(this.#resetIndex())
      .filter((candidate) => !CompactionEntry.is(candidate.entry) && candidate.shown.length > 0);
    const isPoint = (candidate: Row) => candidate.shown.every(forkable);
    // A remote worker's relay sends an absent entry as null.
    const row = !entryId ? visible.filter(isPoint).at(-1) : visible.find((candidate) => String(candidate.entry.id) === entryId);
    if (!row) throw new Error(!entryId ? "There is nothing to fork yet." : "That fork point is no longer available.");
    if (!isPoint(row)) throw new Error("A fork starts from a prompt or a finished reply, not one still waiting on its tools.");
    const next = await this.#conversation.fork(row.entry.id, {
      ownership: { kind: "ownerless" },
      ...(options?.cwd ? { agent: { cwd: options.cwd } } : {}),
    }, context);
    return durableReference(next.id);
  }

  async attachmentImage(message: number, image: number): Promise<{ mimeType: string; data: Buffer } | undefined> {
    return imageFromMessages(this.#visible(), message, image);
  }

  attachmentFile(message: number, file: number): string | undefined {
    return fileFromMessages(this.#visible(), message, file);
  }

  transcript(): TranscriptEntry[] {
    return transcriptFrom(this.#visible(), this.#timings);
  }

  async inspect(): Promise<RuntimeInspection> {
    const agent = await this.#conversation.agent(context);
    const huiTools = new Set(this.#host.huiToolNames);
    const tools = agent.tools.map((tool) => ({
      name: tool.name, description: tool.description,
      source: huiTools.has(tool.name) ? "HUI" : this.#extensions?.sourceOf(tool.name) ?? "Durable",
      active: true, parameters: tool.parameters,
    }));
    const prompt = await this.#host.prompt.render(this.#cwd, agent.tools.map((tool) => tool.name), this.#conversation.id);
    const data = {
      status: "live" as const, backend: "durable", version: DURABLE_VERSION, tools, prompt,
      promptPhase: this.#streaming ? "current-turn" as const : "initialized" as const,
      promptSource: (await this.#loader()).getSystemPromptSource() ? "SYSTEM.md override" : "hui-v4",
      diagnostics: [...(this.#extensionFailure ? [this.#extensionFailure] : []), ...(this.#extensions?.diagnostics ?? [])],
    };
    return { ...data, revision: createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16) };
  }

  /** A storage error closed the harness this view follows. The conversation is still in the store: once the host has
   * released it, a session that attaches again (the gateway reattaches it) reopens the store and carries on. */
  onExit(listener: (unreachable?: RuntimeUnreachableError) => void): () => void {
    let listening = true;
    void this.#harness.closed.then((end) => {
      if (!listening || this.#disposed || end.reason !== "failed") return;
      listener(new RuntimeUnreachableError("HUI's Durable store failed; HUI is reopening it.", true));
      this.dispose();
    });
    return () => { listening = false; };
  }

  /** Detaches this view, and shuts its extensions down. The conversation keeps running in the harness. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#host.untrackChat(this);
    this.#questions.close();
    this.#listeners.clear();
    for (const waiter of [...this.#waiters]) waiter.resolve();
    void this.#stop?.().catch(() => {});
    if (this.#huiSessionId && this.#extensions) this.#host.detachExtensions(this.#huiSessionId, this.#extensions);
    void this.#extensions?.dispose().catch(() => {});
  }
}

export async function startDurable(options: StartOptions, host: DurableHost = durableHost()): Promise<DurableSession> {
  const harness = await host.open();
  await host.refreshModels();
  const existing = durableConversationId(options.sessionFile);
  let conversation: Conversation | undefined;
  if (existing) {
    conversation = await harness.conversation(existing, context);
    if (!conversation) throw new Error("That Durable conversation no longer exists in this gateway's store.");
  } else {
    const model = await initialModel(host, options.cwd, options.model);
    const known = model ? host.models.getModel(model.provider, model.modelId) : undefined;
    const requestedThinking = options.thinking ?? defaultThinking(host, options.cwd);
    const thinking = requestedThinking && known ? fitThinking(known, requestedThinking) : undefined;
    conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: {
      cwd: options.cwd,
      ...(model ? { model } : {}),
      ...(thinking ? { thinkingLevel: thinking } : {}),
    } }, context);
  }
  host.bindCaller(conversation.id, options.huiSessionId);
  if (options.huiSessionId) host.setUltra(options.huiSessionId, options.thinking === "ultra");
  await host.prompt.loader(options.cwd);
  // The session's chosen level (its record's), which the model may have lowered.
  const session = new DurableSession(host, harness, conversation, options.cwd, options.thinking);
  try {
    // PI extensions are a HUI session's own; without one (a probe), only the conversation's tools apply.
    if (options.huiSessionId) await session.loadExtensions(options.huiSessionId);
    else await session.applyTools();
    await session.attach();
    await session.startExtensions("startup");
  } catch (error) {
    session.dispose();
    throw error;
  }
  return session;
}

export const durableRuntime = {
  id: "durable",
  start: (options: StartOptions) => startDurable(options),
} satisfies AgentRuntime;
