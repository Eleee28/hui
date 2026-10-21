/**
 * One Pi Durable harness per gateway process.
 *
 * Durable owns conversations, runs, queues and crash recovery in a single
 * SQLite store under HUI's configuration directory. PI keeps owning agent
 * configuration, skills, context files, extensions, models and credentials; HUI
 * reads them through PI's SDK, exactly as the PI worker does. The store has one
 * owner at a time, so a lock file refuses a second gateway instead of sharing
 * the database.
 */
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { CompactionTask, createRegistry, defineExtension, GenerationTask, Harness, hook, UsageDoc, type Conversation, type ConversationId, type DocumentReader, type EnvTarget, type Extension, type HarnessSettings, type HookApi, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { SettingsManager, type ModelRuntime, type ResourceLoader, type Skill } from "@earendil-works/pi-coding-agent";
import { recordDiagnosticEvent } from "../observability.ts";
import { CONFIG_DIR } from "../paths.ts";
import { resolvePiAgentDir } from "../pi/paths.ts";
import { readHuiSettings } from "../hui-settings.ts";
import { createSessionModelRuntime } from "./hui-models.ts";
import { withFastMode } from "./model-controls.ts";
import { DurablePrompt, type PromptSettings } from "./durable-prompt.ts";
import { huiDurableTools, type DurableToolInvoker } from "./durable-tools.ts";
import type { Contribution, DurableExtensions, ExtensionHost } from "./durable-extensions.ts";
import { OptChatManager, type OptChatTuning } from "./durable-optchat.ts";
import type { BotChat, OfferedTool, ToolOrigin } from "./durable-offer.ts";
import { invokeAgentTool } from "../agent-tools/bridge.ts";

/** The tools of `extension` the model may call: not the ones only other tools call, such as codemode's `models.*`. */
export const modelCallable = (extension: Extension): ToolRegistration[] =>
  (extension.tools ?? []).filter((tool) => tool.callers?.includes("model") ?? true);
/** Durable APIs take a cancellation context; HUI's own calls are not scoped. */
export const durableContext = BACKGROUND_CONTEXT;
/** Longest interrupted runs wait for their sessions to load their PI extensions again before they resume anyway. */
const RESUME_WAIT_MS = 30_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// PI's `configureHttpDispatcher` is deliberately not installed: it replaces
// `globalThis.fetch` for the whole process, and the harness shares the gateway
// with every other HUI subsystem. Provider requests use Node's fetch, whose
// 5-minute body timeout matches PI's default HTTP idle timeout.

/** Harness policy read at every use, so PI settings edits apply to the next turn. `extensions` is the default
 * selection: each session's PI extensions are installed beside it and only that session's conversation adds them. */
function harnessSettings(settings: SettingsManager, extensions: readonly Extension[]): HarnessSettings {
  return {
    extensions,
    get stream() {
      const provider = settings.getProviderRetrySettings();
      const idle = settings.getHttpIdleTimeoutMs();
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      };
    },
    get compaction() { return settings.getCompactionSettings(); },
    get retry() { return settings.getRetrySettings(); },
    get steeringMode() { return settings.getSteeringMode(); },
    get followUpMode() { return settings.getFollowUpMode(); },
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** One owner per store: Durable has no cross-process locking of its own. */
function acquireStoreLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try { if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        throw new Error(pid === process.pid
          ? "The Durable session store is already open in this process."
          : `The Durable session store is already open in another HUI gateway (pid ${pid}).`);
      }
      try { unlinkSync(path); } catch { /* raced with another cleanup */ }
    }
  }
  throw new Error("The Durable session store could not be locked.");
}

/** HUI's provider identity (docs/api.md): a PI provider header may interpolate
 * `${PI_CLIENT_SESSION_ID}`. A PI worker has it in its environment; Durable
 * requests run in the gateway, so each carries its own in the request `env`. */
const CLIENT_SESSION_ENV = "PI_CLIENT_SESSION_ID";
/** pi-ai model calls whose third argument is the request options. */
const REQUEST_CALLS = new Set<PropertyKey>(["stream", "streamSimple", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred"]);
type ProviderResponse = { status: number; headers: Record<string, string> };
type RequestCallbacks = {
  onPayload?: (payload: unknown, model: unknown) => unknown;
  onResponse?: (response: ProviderResponse, model: unknown) => void | Promise<void>;
};
type RequestOptions = ({ readonly signal?: AbortSignal; readonly env?: Readonly<Record<string, string>>; readonly maxTokens?: number; readonly reasoning?: string } & RequestCallbacks) | undefined;

/** Model reads go to the runtime current at each use, so provider changes
 * made in Settings reach running conversations at their next request. Every
 * request also resolves provider configuration with `requestEnv`'s values and
 * runs the provider callbacks of its session's PI extensions. */
class CurrentModels {
  target: Models | undefined;
  readonly view: Models;

  constructor(requestEnv: (options: RequestOptions) => Record<string, string>, callbacks: (options: RequestOptions) => RequestCallbacks) {
    this.view = new Proxy({} as Models, {
      get: (_unused, key) => {
        const target = this.target;
        if (!target) throw new Error("Durable models are not loaded yet.");
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        const call = value as (...args: unknown[]) => unknown;
        if (!REQUEST_CALLS.has(key)) return call.bind(target);
        return (...args: unknown[]) => {
          const given = args[2] as RequestOptions;
          const { maxTokens: _cap, ...uncapped } = given ?? {};
          // Durable caps only its summary request, at 0.8 × reserveTokens, and adaptive and effort-based models spend
          // their thinking from that cap: at high levels the summary stops on `length` and the compaction fails
          // (earendil-works/pi#9075). A request that reasons gets the model's output cap, which pi-ai still fits into
          // the free context window, as an ordinary turn does.
          const options = given?.reasoning ? uncapped : given;
          // Only Durable's own requests are attributed, and they bring no callbacks of their own.
          args[2] = { ...callbacks(options), ...options, env: { ...requestEnv(options), ...options?.env } };
          return call.apply(target, args);
        };
      },
    });
  }
}

export type DurableHostOptions = {
  /** Directory holding `harness.sqlite` and its lock. */
  dir: string;
  /** PI agent directory: settings, skills, models.json, auth. */
  agentDir: string;
  readSettings?: () => Promise<PromptSettings>;
  /** In-process HUI agent tool handler; defaults to the gateway's bridge handler. */
  invokeTool?: DurableToolInvoker;
  /** HUI session for a conversation nobody has reopened since a restart. */
  lookupCaller?: (conversationId: ConversationId) => Promise<string | undefined>;
  /** Resume interrupted runs when the store opens (default). `hui doctor` opens it without running any work. */
  resume?: boolean;
  /** OptChat constants a test changes (docs/optchat.md). */
  optchat?: OptChatTuning;
  /**
   * HUI's utility model (Settings → Models), the memory compactor's model where a memory names none: a bot's utility
   * model defaults to it (HUI-18). Defaults to HUI's settings unless `readSettings` is given.
   */
  utilityModel?: () => Promise<string | undefined>;
  /**
   * HUI tools that act on another machine, which this host's sessions reach through a bridge that refuses them: a
   * worker host passes `GATEWAY_ONLY_TOOLS`, the gateway none. A bot's chat here isn't offered them, so its model never
   * calls them, `request_access` can't ask for them and the operator's catalog doesn't list them. Other sessions here
   * are offered them as before, and the bridge refuses them.
   */
  gatewayOnlyTools?: readonly string[];
};

/** A bot's chat, as its conversation's document says; what else it holds is the bots' business. */
export type DurableBotState = { readonly bot: string };

/** Bots, as the Durable core reaches them: `createDurableBots` builds them, and a host that never runs bot work
 * configures `null`, where no conversation is a bot's. */
export type DurableBots = {
  /** The `bots`, `bot_access` and `soul` sections, the tools only bots' chats select and `message_bot` alone for
   * sessions; `invoke` calls HUI's agent tools as the conversation's HUI session. */
  extensions(invoke: (conversationId: ConversationId, action: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>): { section: Extension; tools: Extension; tag: Extension };
  /** The bot document of a bot's chat; undefined for every other conversation. */
  state(reader: DocumentReader, conversationId: ConversationId): Promise<DurableBotState | undefined>;
  /** Whether a bot's chat may call the HUI tool `action`, whatever it was offered. */
  mayCall(state: DurableBotState, action: string): boolean;
  /** The bot's own skill folder on this host; undefined on a host that keeps no bots' homes. */
  skillsDir(state: DurableBotState): string | undefined;
  /** The skills of `skills` a bot's chat has: all but the ones the operator turned off. */
  skills<T extends { readonly name: string; readonly filePath: string }>(skills: readonly T[], state: DurableBotState): T[];
  /** A bot's chat's offer: the tools the operator can turn off, described, and the ones its chat goes without. */
  planOffer<T extends { readonly name: string; readonly tool: ToolRegistration; readonly origin: ToolOrigin }>(
    offer: readonly T[], state: DurableBotState, context: { memory: readonly string[]; skills: readonly Skill[] },
  ): { offer: OfferedTool[]; removed: T[] };
  /** What the bots' tools add to HUI's active-tool section. */
  promptContributions: Readonly<Record<string, Contribution>>;
  /** The `skills` section of a bot's chat that loads its skills with `load_skill`; undefined while PI's own lists them. */
  skillsPrompt(skills: readonly Skill[], selectedTools: readonly string[]): string | undefined;
};

/** Registry fallback: the HUI session whose resume reference names this conversation. */
export async function registryCaller(conversationId: ConversationId): Promise<string | undefined> {
  const { readRegistry } = await import("../sessions/sessions.ts");
  const reference = `durable:${conversationId}`;
  // A worker's `durable:N` names a conversation in that worker's own store.
  return (await readRegistry()).find((record) => record.piSessionFile === reference && !record.worker)?.id;
}

export class DurableHost implements ExtensionHost {
  readonly dir: string;
  readonly agentDir: string;
  readonly prompt: DurablePrompt;
  readonly settings: () => Promise<PromptSettings>;
  /** HUI tools a bot's chat here is never offered: they act on another machine (`DurableHostOptions.gatewayOnlyTools`). */
  readonly gatewayOnlyTools: readonly string[];
  /** OptChat memories of the conversations that enable it; a no-op for every other conversation. */
  readonly optchat: OptChatManager;
  #invokeTool: DurableToolInvoker;
  #lookupCaller: (conversationId: ConversationId) => Promise<string | undefined>;
  #tools: Extension;
  /** Bots on this host (`configureDurableBots`); undefined until configured, while the store refuses to open. */
  #bots: DurableBots | null | undefined;
  /** The bots' sections (a session's `bots`, the rest inert outside bots' chats), the tools only bots'
   * chats select, and `message_bot` alone for sessions (`DurableBots.extensions`). */
  #botExtensions: { section: Extension; tools: Extension; tag: Extension } | undefined;
  /** The store failed, was released and is about to open again: the gateway reattaches the sessions it ended. */
  storeFailed: (() => Promise<void>) | undefined;
  #openedAt = 0;
  /** Set while a failed store waits to open again; any close ends that wait. */
  #reopening: symbol | undefined;
  /** Store failures in a row, each within a minute of the store opening again. */
  #failures = 0;
  /** Live sessions that answer for their conversation: a bot's own tools ask the operator through them. */
  #chats = new Set<BotChat & { conversation(): Conversation }>();
  /** Access requests waiting for a conversation's chat to open again (`whenChat`), and the chats that can take them. */
  #chatWaiters = new Set<{ conversationId: ConversationId; resolve(chat: BotChat): void }>();
  #readyChats = new WeakSet<BotChat>();
  #models = new CurrentModels((options) => this.#requestEnv(options), (options) => this.#requestCallbacks(options));
  #registry: Registry = createRegistry();
  /** PI's `codemode` tool and its prompt section, selected by default; Settings → Tools → Codemode off removes it.
   * Each script runs in a worker thread of its own, which closing the store stops by aborting the call. */
  readonly codemode = createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }) });
  /** Each live session's PI extensions, by HUI session. */
  #extensions = new Map<string, DurableExtensions>();
  /** HUI sessions whose requests ask for fast mode (`withFastMode`). */
  #fast = new Set<string>();
  /** HUI sessions on Ultra, whose prompt asks the agent to plan, delegate and verify. */
  #ultra = new Set<string>();
  /** Each attributed request's identity, by its task invocation's abort signal. */
  #requestIdentities = new WeakMap<AbortSignal, string>();
  /** Each attributed request's HUI session, for its PI extensions' provider callbacks. */
  #requestSessions = new WeakMap<AbortSignal, string>();
  /** One identity per HUI session for this gateway run, as one PI worker each would have. */
  #clientSessions = new Map<string, string>();
  /** For a request no hook attributed, such as a summary resumed after a restart. */
  #unattributedClientSession = randomUUID();
  /** Attributes generation and compaction requests to their conversation's HUI session. */
  #identity = defineExtension({
    name: "hui-request-identity",
    hooks: [
      hook(GenerationTask, { beforeRequest: (_request, api) => this.#attribute(api) }),
      hook(CompactionTask, { beforeCompact: (_compaction, api) => this.#attribute(api) }),
    ],
  });
  #envs = new Map<string, NodeExecutionEnv>();
  /** Durable conversation → HUI session, the only caller identity HUI tools accept. */
  #callers = new Map<ConversationId, string>();
  /** The current open, settled or not; a close takes it. */
  #opening: Promise<Harness> | undefined;
  /** The latest close, until it has released the store. */
  #closing: Promise<void> | undefined;
  #harness: Harness | undefined;
  #release: (() => void) | undefined;
  #resume: boolean;
  /**
   * Reopens the sessions of the conversations whose work resumes once the store opens. Their runs resume after it
   * settles (at most `RESUME_WAIT_MS`), so each finds its session's PI extensions installed: a tool call they make
   * otherwise finds no tool. Absent, they resume at once.
   */
  beforeResume: ((conversations: readonly ConversationId[]) => Promise<unknown>) | undefined;
  #resumed = deferred();

  constructor(options: DurableHostOptions) {
    this.dir = options.dir;
    this.agentDir = options.agentDir;
    this.#resume = options.resume !== false;
    this.settings = options.readSettings ?? readHuiSettings;
    this.gatewayOnlyTools = options.gatewayOnlyTools ?? [];
    this.optchat = new OptChatManager({
      dir: options.dir, models: () => this.models,
      // A bot's utility model defaults to Settings' (HUI-18): memory summaries are quick work.
      ...(options.utilityModel ? { utilityModel: options.utilityModel }
        : options.readSettings ? {} : { utilityModel: async () => (await readHuiSettings()).models.utility || undefined }),
      ...(options.optchat ? { tuning: options.optchat } : {}),
    });
    this.prompt = new DurablePrompt(options.agentDir, this.settings);
    this.prompt.extras = (conversationId) => {
      const extensions = this.#extensionsOf(conversationId);
      if (!extensions) return undefined;
      const run = extensions.runPrompt();
      return { contributions: extensions.contributions(), ...(run ? { run } : {}) };
    };
    this.#invokeTool = options.invokeTool ?? invokeAgentTool;
    this.#lookupCaller = options.lookupCaller ?? registryCaller;
    const invoke = (conversationId: ConversationId, action: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      this.#invokeAs(conversationId, action, params, signal);
    this.#tools = huiDurableTools({ invoke });
    // A bot's chat lists only the skills the operator left on, its own among them.
    this.prompt.botSkillsFor = async (conversationId) => {
      const bots = this.#bots;
      const state = await this.botStateFor(conversationId);
      return bots && state ? { skills: (skills) => bots.skills(skills, state), section: (skills, selectedTools) => bots.skillsPrompt(skills, selectedTools) } : undefined;
    };
    this.prompt.skillDirsFor = (conversationId) => this.skillDirsFor(conversationId);
    this.prompt.ultraFor = (conversationId) => this.#ultra.has(this.#callers.get(conversationId) ?? "");
  }

  /** Sets the bots this host runs, once, before its store opens: `null` on a host that never runs bot work. */
  configureDurableBots(bots: DurableBots | null): void {
    this.#bots = bots;
    this.#botExtensions = bots?.extensions((conversationId, action, params, signal) => this.#invokeAs(conversationId, action, params, signal));
    this.prompt.botContributions = bots?.promptContributions ?? {};
  }

  /** HUI's agent-tool handler, called as the HUI session bound to the conversation. A bot's chat may not call a HUI tool
   * the operator turned off, whatever it was offered: the bridge checks the bot's document itself. `signal` is the tool
   * call's own abort (Stop), which the handler sees as a PI child's dropped call. A call from a bot's chat carries who
   * brought each input of its run, as the live chat here saw them (`runOrigins`): the gateway's gated tools judge the
   * run by all of them. Without a live chat here, or when its store can't be read, it carries none, and they judge the
   * message that started the run alone. */
  async #invokeAs(conversationId: ConversationId, action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const bot = await this.botStateFor(conversationId);
    if (bot && this.#bots?.mayCall(bot, action) === false) {
      throw new Error(`The operator turned off ${action} in this bot's chat. Ask for it with request_access if the job needs it.`);
    }
    const callerSessionId = this.#callers.get(conversationId) ?? await this.#lookupCaller(conversationId);
    if (!callerSessionId) throw new Error("HUI agent tools are unavailable for this conversation.");
    this.#callers.set(conversationId, callerSessionId);
    const runOrigins = bot ? await this.chatFor(conversationId)?.runOrigins().catch(() => undefined) : undefined;
    return this.#invokeTool({ callerSessionId, action, params, ...(signal ? { signal } : {}), ...(runOrigins ? { runOrigins } : {}) });
  }

  /** Names of the HUI-owned tools, for inspection labels. */
  get huiToolNames(): readonly string[] {
    return [...this.#tools.tools ?? [], ...this.#botExtensions?.tools.tools ?? []].map((tool) => tool.name);
  }

  /** Tools only bots' chats are offered. */
  get botTools(): readonly ToolRegistration[] { return this.#botExtensions?.tools.tools ?? []; }

  /** `message_bot` alone, which a session selects (`DurableSession.applyTools`). */
  get botTag(): Extension | undefined { return this.#botExtensions?.tag; }

  /** The bots configured on this host, which a bot's chat plans its offer with (`DurableSession.applyTools`). */
  get bots(): DurableBots | null | undefined { return this.#bots; }

  /** The extension carrying `message_bot` and a bot's own tools when the conversation is a bot's chat; its session
   * selects it. */
  async botToolsFor(conversationId: ConversationId): Promise<Extension | undefined> {
    return await this.botStateFor(conversationId) ? this.#botExtensions?.tools : undefined;
  }

  /** The bot document of a bot's chat; undefined for every other conversation, or before the store opens. */
  async botStateFor(conversationId: ConversationId): Promise<DurableBotState | undefined> {
    const harness = this.#harness;
    return harness && this.#bots ? this.#bots.state(harness, conversationId) : undefined;
  }

  /** A bot's own skill folder (`skills/` in its home on this host, `bots/skills.ts`), which only its chat loads, once it exists
   * (PI's loader warns about a missing one); none for every other conversation, or on a host that keeps no bots' homes. */
  async skillDirsFor(conversationId: ConversationId): Promise<readonly string[]> {
    const bot = await this.botStateFor(conversationId);
    const dir = bot ? this.#bots?.skillsDir(bot) : undefined;
    return dir && await stat(dir).then((info) => info.isDirectory(), () => false) ? [dir] : [];
  }

  /** A live session answers for its conversation while it is open. */
  trackChat(chat: BotChat & { conversation(): Conversation }): void { this.#chats.add(chat); }

  /** A tracked chat has offered its tools (`applyTools`): it knows what the operator turned off, so an access request
   * waiting for it (`whenChat`) can ask there now. */
  chatReady(chat: BotChat & { conversation(): Conversation }): void {
    if (!this.#chats.has(chat)) return;
    this.#readyChats.add(chat);
    for (const waiter of [...this.#chatWaiters]) {
      if (waiter.conversationId === chat.conversation().id) waiter.resolve(chat);
    }
  }
  untrackChat(chat: BotChat & { conversation(): Conversation }): void { this.#chats.delete(chat); }
  /** Every open session offers its tools again, from its next request: a Settings change decides them (Codemode). */
  async applyTools(): Promise<void> {
    await Promise.all([...this.#chats].map((chat) => chat.applyTools().catch((error: unknown) => recordDiagnosticEvent({
      area: "runtime", level: "warning", action: "durable_apply_tools_failed", summary: "A Durable session kept its previous tools",
      detail: error instanceof Error ? error.message : String(error),
    }))));
  }

  /** The live session following the conversation now; a rewind moves a session to its fork. */
  chatFor(conversationId: ConversationId): BotChat | undefined {
    for (const chat of this.#chats) if (chat.conversation().id === conversationId) return chat;
    return undefined;
  }

  /** The conversation's live session once one is open and has offered its tools; rejects once `signal` aborts. */
  whenChat(conversationId: ConversationId, signal?: AbortSignal): Promise<BotChat> {
    const open = this.chatFor(conversationId);
    if (open && this.#readyChats.has(open)) return Promise.resolve(open);
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.#chatWaiters.delete(waiter);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Stopped waiting for the chat."));
      };
      const waiter = {
        conversationId,
        resolve: (chat: BotChat) => { this.#chatWaiters.delete(waiter); signal?.removeEventListener("abort", stop); resolve(chat); },
      };
      if (signal?.aborted) return stop();
      signal?.addEventListener("abort", stop, { once: true });
      this.#chatWaiters.add(waiter);
    });
  }

  /** HUI tool registrations by name, for per-conversation tool selection. */
  toolsNamed(names: readonly string[]): ToolRegistration[] {
    return (this.#tools.tools ?? []).filter((tool) => names.includes(tool.name)) as ToolRegistration[];
  }

  /** Settles once the open store schedules work. */
  get resumed(): Promise<void> { return this.#resumed.promise; }
  get models(): Models { return this.#models.view; }
  /** PI's model runtime, current at each use, for extensions' `ctx.modelRegistry`. */
  get modelRuntime(): ModelRuntime { return this.#models.view as unknown as ModelRuntime; }
  get isOpen(): boolean { return this.#harness !== undefined; }

  /** Whether the open store has work to do: queued input or a task that can
   * run. A background compaction, or a task this build cannot run, is not. */
  async busy(): Promise<boolean> {
    if (!this.#harness) return false;
    const { tasks, submissions } = await this.#harness.inspect(durableContext);
    return submissions.length > 0 || tasks.some((task) => !task.record.background && task.state.kind !== "blocked");
  }

  get codingTools(): readonly ToolRegistration[] { return CodingTools.tools ?? []; }
  get huiTools(): readonly ToolRegistration[] { return this.#tools.tools ?? []; }

  install(extension: Extension): void { this.#registry.install(extension); }
  /** Removes `extension` itself; a replacement installed under its name since stays. */
  uninstall(extension: Extension): void {
    if (this.#registry.snapshot().extension(extension.name) === extension) this.#registry.uninstall(extension);
  }
  resources(cwd: string): Promise<ResourceLoader> { return this.prompt.loader(cwd); }
  promptOptions(cwd: string, selectedTools: readonly string[], contributions: Record<string, Contribution>) {
    return this.prompt.options(cwd, selectedTools, contributions);
  }
  lastPrompt(conversation: Conversation): string { return this.prompt.lastPrompt(conversation.id); }

  /** Tracks a session's PI extensions while it is live, so its requests reach them. */
  attachExtensions(huiSessionId: string, extensions: DurableExtensions): void {
    this.#extensions.set(huiSessionId, extensions);
  }

  detachExtensions(huiSessionId: string, extensions: DurableExtensions): void {
    if (this.#extensions.get(huiSessionId) === extensions) this.#extensions.delete(huiSessionId);
  }

  isFast(huiSessionId: string): boolean { return this.#fast.has(huiSessionId); }

  setFast(huiSessionId: string, on: boolean): void {
    if (on) this.#fast.add(huiSessionId);
    else this.#fast.delete(huiSessionId);
  }

  setUltra(huiSessionId: string, on: boolean): void {
    if (on) this.#ultra.add(huiSessionId);
    else this.#ultra.delete(huiSessionId);
  }

  #extensionsOf(conversationId: ConversationId): DurableExtensions | undefined {
    const caller = this.#callers.get(conversationId);
    return caller === undefined ? undefined : this.#extensions.get(caller);
  }

  /** Opens the store once and resumes every interrupted run in it. A close
   * still running finishes first, so the store is released before it reopens. */
  open(): Promise<Harness> {
    if (!this.#opening) {
      const closing = this.#closing;
      const opening: Promise<Harness> = (closing ? closing.catch(() => undefined).then(() => this.#open()) : this.#open())
        .catch((error: unknown) => {
          if (this.#opening === opening) this.#opening = undefined;
          throw error;
        });
      this.#opening = opening;
    }
    return this.#opening;
  }

  async #open(): Promise<Harness> {
    if (this.#bots === undefined) throw new Error("The Durable host opened before its bots were configured (configureDurableBots).");
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.#release = acquireStoreLock(join(this.dir, "harness.lock"));
    try {
      const settings = SettingsManager.create(this.agentDir, this.agentDir);
      this.#models.target = await createSessionModelRuntime(this.agentDir);
      // OptChat's hooks come before every session's PI extensions: its compaction decline is the first decision, and its
      // request is what their context handlers see. OptChat's tools and bots' tools are installed but not in the default
      // selection: only an OptChat conversation, or a bot's chat, adds them.
      // Codemode is in the default selection, last, so a conversation stores nothing while Settings keep it on.
      const bots = this.#botExtensions;
      const base = [CodingTools, this.#tools, this.prompt.extension, this.#identity, this.optchat.extension, ...(bots ? [bots.section] : []), this.codemode];
      for (const extension of [...base, this.optchat.toolsExtension, ...(bots ? [bots.tools, bots.tag] : [])]) this.#registry.install(extension);
      const harness = await Harness.open(await openNodeSqliteStorage(join(this.dir, "harness.sqlite")), {
        models: this.#models.view,
        registry: this.#registry,
        settings: harnessSettings(settings, base),
        env: (target) => this.#env(target),
        onReport: (error) => recordDiagnosticEvent({
          area: "runtime", level: "warning", action: "durable_report",
          summary: "Durable harness reported a recoverable failure",
          detail: error instanceof Error ? error.message : String(error),
        }),
      }, durableContext);
      this.optchat.attach(harness, { follow: this.#resume });
      this.#harness = harness;
      this.#openedAt = Date.now();
      // Since Durable 1.2.0 a storage error closes the whole harness: its sessions end (`DurableSession.onExit`), and once
      // the store is released the next `open()` reopens it and resumes their runs.
      void harness.closed.then((end) => { if (end.reason === "failed") void this.#failed(harness, end.error); });
      // Unfinished generations and tool calls continue even before any browser
      // reopens their session. Without it, nothing is scheduled: the store is
      // only read and written in commits.
      if (this.#resume) void this.#resumeWhenReady(harness);
      return harness;
    } catch (error) {
      this.#release?.();
      this.#release = undefined;
      throw error;
    }
  }

  /** The store failed: it is released, then opened again (`#reopen`). */
  async #failed(harness: Harness, error: unknown): Promise<void> {
    if (this.#harness !== harness) return;
    this.#failures = Date.now() - this.#openedAt < 60_000 ? this.#failures + 1 : 1;
    recordDiagnosticEvent({
      area: "runtime", level: "error", action: "durable_store_failed", summary: "The Durable store failed; it was released to open again",
      detail: error instanceof Error ? error.message : String(error),
    });
    await this.close().catch(() => undefined);
    const reopening = this.#reopening = Symbol("reopen");
    await this.#reopen(reopening);
  }

  /** Opens the released store again after a pause that doubles with each failure in a row (up to a minute), so a store
   * that keeps failing is not reopened in a tight loop. `storeFailed` comes first, so the sessions it ended reattach and
   * the runs it resumes find their extensions. A store that does not open is tried again, after a longer pause. */
  async #reopen(reopening: symbol): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 1_000 * 2 ** (this.#failures - 1))).unref());
      // A close since (the gateway stopping) ends it.
      if (this.#reopening !== reopening) return;
      try {
        await this.storeFailed?.();
        await this.open();
        return;
      } catch (error) {
        this.#failures += 1;
        recordDiagnosticEvent({
          area: "runtime", level: "warning", action: "durable_reopen_failed", summary: "The Durable store did not open again; HUI tries again",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #resumeWhenReady(harness: Harness): Promise<void> {
    try {
      const reopen = this.beforeResume;
      const conversations = reopen ? [...new Set((await harness.inspect(durableContext)).tasks.map((task) => task.record.conversationId))] : [];
      if (reopen && conversations.length) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([reopen(conversations), new Promise((resolve) => { timer = setTimeout(resolve, RESUME_WAIT_MS); })]).finally(() => clearTimeout(timer));
      }
    } catch (error) {
      recordDiagnosticEvent({
        area: "runtime", level: "warning", action: "durable_resume_prepare_failed",
        summary: "Durable resumed interrupted runs before their sessions reopened",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.#harness !== harness) return;
    harness.resume();
    this.#resumed.resolve();
  }

  #env({ cwd }: EnvTarget): NodeExecutionEnv {
    const directory = cwd ?? this.agentDir;
    let env = this.#envs.get(directory);
    if (!env) {
      env = new NodeExecutionEnv({ cwd: directory });
      this.#envs.set(directory, env);
    }
    return env;
  }

  /** A hook's task runtime is also where its request takes `signal`, so the
   * signal names the HUI session in `#requestEnv`. Durable task phases share one
   * runtime per invocation: a summary request follows its `beforeCompact`. */
  async #attribute(api: HookApi): Promise<undefined> {
    const signal = (api as HookApi & { readonly signal?: AbortSignal }).signal;
    if (!signal) return undefined;
    const conversationId = api.conversationId;
    const caller = this.#callers.get(conversationId) ?? await this.#lookupCaller(conversationId).catch(() => undefined);
    if (caller) {
      this.#callers.set(conversationId, caller);
      this.#requestSessions.set(signal, caller);
    }
    this.#requestIdentities.set(signal, this.#clientSession(caller ?? `conversation:${conversationId}`));
    return undefined;
  }

  /** `before_provider_request` and `after_provider_response` of the request's session; fast mode, when the session
   * asks for it, and an OptChat turn's cache marks go on the payload those handlers leave. */
  #requestCallbacks(options: RequestOptions): RequestCallbacks {
    const caller = options?.signal ? this.#requestSessions.get(options.signal) : undefined;
    const callbacks = (caller === undefined ? undefined : this.#extensions.get(caller)?.requestCallbacks()) ?? {};
    const fast = caller !== undefined && this.#fast.has(caller);
    const marks = options?.signal ? this.optchat.payloadHook(options.signal) : undefined;
    if (!marks && !fast) return callbacks;
    return {
      ...callbacks,
      onPayload: async (payload, model) => {
        const replaced = await callbacks.onPayload?.(payload);
        let next = replaced === undefined ? payload : replaced;
        if (fast) next = withFastMode(next, model as { api: string; id: string });
        return marks?.(next, model) ?? next;
      },
    };
  }

  #clientSession(key: string): string {
    let id = this.#clientSessions.get(key);
    if (!id) {
      id = randomUUID();
      this.#clientSessions.set(key, id);
    }
    return id;
  }

  /** A nonblank gateway value is kept, as for PI workers; otherwise the
   * request's HUI session identity. The gateway environment never changes. */
  #requestEnv(options: RequestOptions): Record<string, string> {
    if (process.env[CLIENT_SESSION_ENV]?.trim()) return {};
    const attributed = options?.signal ? this.#requestIdentities.get(options.signal) : undefined;
    return { [CLIENT_SESSION_ENV]: attributed ?? this.#unattributedClientSession };
  }

  /** Re-read HUI and PI provider configuration for the next model request. */
  async refreshModels(): Promise<void> {
    this.#models.target = await createSessionModelRuntime(this.agentDir);
  }

  bindCaller(conversationId: ConversationId, huiSessionId: string | undefined): void {
    if (huiSessionId) this.#callers.set(conversationId, huiSessionId);
  }

  /** A fork answers to the same HUI session as the conversation it came from. */
  bindCallerLike(source: ConversationId, target: ConversationId): void {
    const caller = this.#callers.get(source);
    if (caller) this.#callers.set(target, caller);
  }

  /** Spend Durable recorded for one conversation, per model; undefined when
   * this process does not own the store. */
  async conversationUsage(conversationId: ConversationId): Promise<{ models?: Record<string, Record<string, unknown>> } | undefined> {
    const harness = this.#harness;
    if (!harness) return undefined;
    return harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(UsageDoc, conversationId))) as { models?: Record<string, Record<string, unknown>> }, durableContext);
  }

  /** Closing records no outcome: running work resumes when the store reopens.
   * It settles once the store is released. An open in progress finishes
   * first, and a close called meanwhile shares the one already running. */
  close(): Promise<void> {
    this.#reopening = undefined;
    const opening = this.#opening;
    this.#opening = undefined;
    if (!opening) return this.#closing ?? Promise.resolve();
    const closing: Promise<void> = this.#close(opening).finally(() => {
      if (this.#closing === closing) this.#closing = undefined;
    });
    this.#closing = closing;
    return closing;
  }

  async #close(opening: Promise<Harness>): Promise<void> {
    const harness = await opening.catch(() => undefined);
    this.#harness = undefined;
    try {
      await harness?.close(durableContext);
      const envs = [...this.#envs.values()];
      this.#envs.clear();
      for (const env of envs) await env.cleanup(durableContext);
    } finally {
      // Its files are covered by the store lock: closed before the lock is released.
      await this.optchat.close().catch(() => undefined);
      this.#release?.();
      this.#release = undefined;
      this.#callers.clear();
      this.#resumed = deferred();
    }
  }
}

export const DURABLE_DIR = process.env["HUI_DURABLE_DIR"] || join(CONFIG_DIR, "durable");

let defaultHost: DurableHost | undefined;

/** The gateway's store: HUI's configuration directory and PI's agent directory. */
export function durableHost(): DurableHost {
  defaultHost ??= new DurableHost({ dir: DURABLE_DIR, agentDir: resolvePiAgentDir() });
  return defaultHost;
}
