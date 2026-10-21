/**
 * The sessions running inside this server process.
 *
 * A session is two things: a record HUI owns, and the runtime that drives it. pi
 * takes 4.5–5.7 seconds to boot, so the two are deliberately decoupled — the
 * runtime starts in the background and the record is answerable at once, with
 * `starting` telling the UI why nothing is happening yet.
 *
 * Exactly one runtime exists per id, so opening a session twice (a second tab,
 * a reload) reuses the one already running. A runtime that dies marks its
 * session `error` and ends its streams; it never takes the server down. One
 * hosted elsewhere that only became unreachable is `reconnecting` (HUI retries
 * by itself) or `disconnected` (it waits for a reconnect); its streams stay open.
 */
import { remoteRuntime } from "../runtimes/remote.ts";
import { CONTINUE_PROMPT } from "../agent-tools/subagent-completion.ts";
import { interruptedRunPrompt } from "./interrupted-run.ts";
import type { SessionRecord } from "./sessions.ts";
import type { TaskSuggestion } from "../api/task-suggestions.ts";
import type { Watcher } from "../api/watchers.ts";
import type { SecretQuestion } from "../agent-tools/secret-requests.ts";
import type { QuestionnairePrompt } from "../agent-tools/questionnaires.ts";
import type { SessionStatus } from "../api/sessions.ts";

/** A question HUI itself asks: a `secret_request` or an `ask_user_question` card. */
export type HuiQuestion = SecretQuestion | QuestionnairePrompt;
import { SessionRegistryError, updateRegistry } from "./sessions.ts";
import { piRuntime } from "../runtimes/pi.ts";
import { durableRuntime } from "../runtimes/durable.ts";
import type {
  AgentRuntime,
  PromptAttachment,
  RuntimePromptOptions,
  RuntimePromptResult,
  RuntimeEvent,
  RuntimeCommand,
  RuntimeModel,
  QueuedMessage,
  RuntimeQuestion,
  RuntimeQuestionResponse,
  RuntimeCompaction,
  RuntimeQueue,
  RuntimeRewindTarget,
  RuntimeSession,
  RuntimeUsage,
  TranscriptEntry,
} from "../runtimes/types.ts";
import { RuntimeOutputError, RuntimeUnreachableError } from "../runtimes/types.ts";
import { recordDiagnosticEvent } from "../observability.ts";
import { readHuiSettings } from "../hui-settings.ts";
import type { Settings } from "../hui-settings.ts";

const MAX_AUTOMATIC_RECOVERY_ATTEMPTS = 3;

/** Replace runtime-internal attachment locations with opaque gateway URLs. */
export function publicTranscript(id: string, entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.kind !== "message" || !entry.attachments?.some((item) => item.source)) return entry;
    return {
      ...entry,
      attachments: entry.attachments.map(({ source, ...item }) => source
        ? { ...item, url: `/__hui/sessions/${encodeURIComponent(id)}/attachments/${source.message}/${"file" in source ? `files/${source.file}` : source.image}` }
        : item),
    };
  });
}

export type SubagentTaskView = {
  taskId: string;
  sessionId: string;
  parentSessionId: string;
  title: string;
  task: string;
  /** `queued`: a collected child waiting for a free slot (only in memory; saved as `starting`). */
  status: import("./sessions.ts").SubagentStatus | "queued";
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  summary?: string;
  error?: string;
};

export type SessionSnapshot = {
  transcript: readonly TranscriptEntry[];
  status: SessionStatus;
  model?: RuntimeModel;
  usage?: RuntimeUsage;
  thinking?: string;
  /** Fast mode; absent when the runtime cannot change speed. */
  fast?: boolean;
  queue: RuntimeQueue;
  /** The runtime's questions, then HUI's own pending ones. */
  questions: readonly (RuntimeQuestion | HuiQuestion)[];
  subagents: readonly SubagentTaskView[];
  /** Pending `suggest_task` cards; omitted when there are none. */
  suggestions?: readonly TaskSuggestion[];
  /** HUI-run background watchers for this conversation; omitted when none. */
  watchers?: readonly Watcher[];
  /** A running compaction, or one that ended without a summary; kept until the next turn. */
  compaction?: RuntimeCompaction;
};

/** Everything a browser watching one session can receive: pi's events, and the
 * lifecycle pi has no opinion about. */
export type SessionStreamMessage =
  | { kind: "snapshot"; snapshot: SessionSnapshot }
  | { kind: "transcript"; entries: TranscriptEntry[] }
  | { kind: "event"; event: RuntimeEvent }
  | { kind: "status"; status: SessionStatus }
  | { kind: "model"; model: RuntimeModel }
  | { kind: "thinking"; level: string }
  | { kind: "fast"; fast: boolean }
  | { kind: "closed" };

/** Lightweight gateway-wide lifecycle update. Detailed transcript/runtime
 * frames stay on the selected session stream; these tagged statuses are what
 * let one browser keep every background session row honest. */
export type SessionStatusUpdate = {
  id: string;
  status: SessionStatus;
  unread?: boolean;
};

export type RuntimeTelemetry = {
  active: true;
  pid?: number;
  bootDurationMs?: number;
};

type Subscriber = (message: SessionStreamMessage) => void;
type StatusSubscriber = (update: SessionStatusUpdate) => void;

function withOutput(message: string, output: string | undefined): string {
  return output ? `${message} · stderr: ${output}` : message;
}

/** A failure's diagnostic cause: its message plus any runtime process output. */
function failureDetail(error: unknown): string {
  if (error instanceof RuntimeOutputError) return withOutput(error.message, error.output);
  return error instanceof Error ? error.message : String(error);
}

type Live = {
  record: SessionRecord;
  /** Changes already made to `record` whose registry writes are still queued.
   * A write that lands before them read the registry without them, so the
   * record it hands back keeps them: an unread mark set or cleared here must
   * not flicker back while its write waits, or a read or a settle that checks
   * it would skip its own write. */
  unsaved: Set<Partial<SessionRecord>>;
  status: SessionStatus;
  /** Set before invoking `runtime.prompt`, closing the gap before the runtime
   * reports `agent_start` or flips its own streaming flag. */
  promptPending: boolean;
  /** Prompts being handed to the runtime. Until it accepts one, the input
   * exists only in this process, so a gateway stop would lose it. */
  submissions: number;
  /** Admission of the prompt currently crossing registry/runtime boundaries; identified followups cannot overtake it. */
  promptAdmission?: Promise<void>;
  runtime?: RuntimeSession;
  /** Wall-clock lifecycle timing for the current runtime attempt. */
  bootStartedAt: number;
  bootDurationMs?: number;
  unsubscribe?: () => void;
  unsubscribeExit?: () => void;
  subscribers: Set<Subscriber>;
  /** Detailed browser streams currently presenting this conversation. Internal
   * lifecycle watchers do not count as readers. */
  readers: number;
  /** Replayable projection of the current turn. Replaced by PI's durable
   * transcript at settlement, but kept while streaming so reconnecting clients
   * do not lose deltas that preceded their new SSE connection. */
  transcript: TranscriptEntry[];
  thinking?: string;
  fast?: boolean;
  queue: RuntimeQueue;
  /** Follow-ups not yet handed to the runtime. Keeping them here is what makes
   * OpenClaw-style edit, remove, and reorder operations truthful. */
  followUps: Array<QueuedMessage & { attachments?: readonly PromptAttachment[] }>;
  questions: Map<string, RuntimeQuestion>;
  compaction?: RuntimeCompaction;
  lastPrompt?: { text: string; attachments?: readonly PromptAttachment[] };
  turnProducedOutput: boolean;
  fallbackAttempted: boolean;
  /** The session's own model while one turn is retried on the fallback. */
  fallbackRestore?: RuntimeModel;
  /** A model turn began since the last settlement. Commands settle without
   * one and must not re-report a failure that still ends the transcript. */
  turnStarted?: boolean;
  /** Runtime error already logged in this run, so settlement does not log the
   * same failure twice. */
  loggedRunError?: string;
  /** Set before removing this entry so a slow boot cannot resurrect it. */
  closed?: boolean;
  /** A boot reattaching to a runtime hosted elsewhere is in flight. */
  reattaching?: boolean;
  /** Terminal subagent cleanup waits until a browser displaying the child has
   * left, so its final transcript does not turn into a dead stream. */
  releaseWhenUnread?: boolean;
  /** The current runtime attempt, settled once it is ready or has failed. */
  boot?: Promise<void>;
};

export type DeleteToken = symbol;

type DeletionState = {
  committed: boolean;
  pending: Set<DeleteToken>;
};

/** Returns entries consumed between two queue snapshots, preserving both
 * order and duplicate messages. Queue values are not globally unique. */
function removedQueueEntries(previous: readonly string[], next: readonly string[]): string[] {
  const remaining = [...next];
  const removed: string[] = [];
  for (const value of previous) {
    const index = remaining.indexOf(value);
    if (index >= 0) remaining.splice(index, 1);
    else removed.push(value);
  }
  return removed;
}

/** A prompt arriving at a bad moment — the session is booting or already
 * working. The route turns this into a 409 rather than a server error. */
export class SessionBusyError extends Error {}

export class LiveSessions {
  /** In-memory check used at the shutdown boundary, without a registry race. */
  get activeWorkCount(): number {
    return this.#activeWork().length;
  }

  /** Active sessions a gateway restart does not interrupt: their runtime
   * continues the run itself when it reopens, and nothing of theirs is held
   * only in this process (a booting runtime, a prompt being handed over, or
   * follow-ups not yet given to the runtime). */
  get resumableWorkCount(): number {
    return this.#activeWork().filter((live) => live.runtime?.resumesInterruptedRuns === true
      && live.status !== "starting" && live.submissions === 0 && live.followUps.length === 0).length;
  }

  /** Active work a gateway stop would lose; ordinary stop and update refuse it. */
  get blockingWorkCount(): number {
    return this.activeWorkCount - this.resumableWorkCount;
  }

  #activeWork(): Live[] {
    // A session whose host is unreachable runs there, not in this process;
    // the follow-ups HUI holds for it exist only here.
    return [...this.#live.values()].filter((live) => live.status === "starting"
      || live.status === "running" || live.status === "waiting" || live.followUps.length > 0);
  }
  #live = new Map<string, Live>();
  #statusSubscribers = new Set<StatusSubscriber>();
  /** Deleted ids stay tombstoned for this gateway lifetime so a request that
   * read the old row before DELETE committed cannot start it afterwards. */
  #deletions = new Map<string, DeletionState>();
  /** One adapter per tool a record can name. */
  #runtimes = new Map<string, AgentRuntime>();
  #updateRegistry: typeof updateRegistry;
  #readSettings: () => Promise<Settings>;
  #subagentSnapshot: (parentId: string) => readonly SubagentTaskView[] = () => [];
  #suggestionSnapshot: (sessionId: string) => readonly TaskSuggestion[] = () => [];
  #watcherSnapshot: (sessionId: string) => readonly Watcher[] = () => [];
  #huiQuestions: (sessionId: string) => readonly HuiQuestion[] = () => [];
  #aborted: (sessionId: string) => void = () => {};

  /** Injectable so the state machine can be exercised without waiting to boot a
   * real tool. A single runtime stands in for one tool, an array for several. */
  constructor(
    runtimes: AgentRuntime | AgentRuntime[] = [piRuntime, durableRuntime],
    registryUpdater: typeof updateRegistry = updateRegistry,
    settingsReader: () => Promise<Settings> = readHuiSettings,
  ) {
    this.#updateRegistry = registryUpdater;
    this.#readSettings = settingsReader;
    for (const runtime of Array.isArray(runtimes) ? runtimes : [runtimes]) {
      this.#runtimes.set(runtime.id, runtime);
    }
  }

  /** A record must name a registered adapter; an unknown one fails closed. */
  #runtimeFor(record: SessionRecord): AgentRuntime {
    const runtime = this.#runtimes.get(record.tool);
    if (runtime) {
      // The worker's host runs this same adapter; the gateway only proxies it.
      return record.worker ? remoteRuntime(record.tool) : runtime;
    }
    throw new Error(`Unsupported session tool: ${record.tool}`);
  }

  /**
   * Starts a runtime if the session has none, and returns immediately. The boot
   * is the five seconds; holding an HTTP reply for it would make opening a
   * session feel broken, so `starting` carries that news instead.
   */
  ensure(record: SessionRecord, reattach = false): boolean {
    if (this.#isDeleted(record.id)) {
      return false;
    }
    const existing = this.#live.get(record.id);
    // An errored session has no runtime left to protect, so a fresh open
    // retries it. One whose host is unreachable comes back only on `reattach`,
    // once its host is reachable again: an open must not reconnect a worker
    // the user disconnected. Anything else is already being handled.
    if (existing) {
      const unreachable = existing.status === "reconnecting" || existing.status === "disconnected";
      const retry = existing.status === "error" || (reattach && unreachable && !existing.reattaching);
      if (!retry) {
        return true;
      }
      // Preserve listeners across a failed boot. A retry is a state transition
      // on the same live session, not a replacement that silently strands SSE.
      existing.closed = false;
      existing.promptPending = false;
      existing.record = this.#withUnsaved(existing, record);
      existing.bootStartedAt = Date.now();
      existing.bootDurationMs = undefined;
      existing.reattaching = unreachable;
      this.#setStatus(existing, existing.reattaching ? "reconnecting" : "starting");
      existing.boot = this.#boot(existing);
      return true;
    }
    const live: Live = {
      record,
      unsaved: new Set(),
      status: "starting",
      promptPending: false,
      submissions: 0,
      bootStartedAt: Date.now(),
      subscribers: new Set(),
      readers: 0,
      transcript: [],
      queue: { steering: [], followUp: [] },
      followUps: [],
      questions: new Map(),
      turnProducedOutput: false,
      fallbackAttempted: false,
      ...(record.subagent && record.subagent.status !== "starting" && record.subagent.status !== "running"
        ? { releaseWhenUnread: true }
        : {}),
    };
    this.#live.set(record.id, live);
    this.#publishStatus(live, "starting", false);
    live.boot = this.#boot(live);
    return true;
  }

  /** Settles once the session's runtime is ready or has failed to start. */
  booted(id: string): Promise<void> {
    return this.#live.get(id)?.boot ?? Promise.resolve();
  }

  status(id: string): SessionStatus {
    const live = this.#live.get(id);
    return live ? this.#reported(live) : "idle";
  }

  setSubagentSnapshotProvider(
    provider: (parentId: string) => readonly SubagentTaskView[],
  ): void {
    this.#subagentSnapshot = provider;
  }

  setTaskSuggestionProvider(provider: (sessionId: string) => readonly TaskSuggestion[]): void {
    this.#suggestionSnapshot = provider;
  }

  setWatcherProvider(provider: (sessionId: string) => readonly Watcher[]): void {
    this.#watcherSnapshot = provider;
  }

  /** HUI's own pending questions (`secret_request`, `ask_user_question`): shown and
   * answered like the runtime's, and like them they leave the session waiting. */
  setHuiQuestionProvider(provider: (sessionId: string) => readonly HuiQuestion[]): void {
    this.#huiQuestions = provider;
  }

  /** Every stop (the Stop button, rewind, automations, subagents) passes here. */
  setAbortListener(listener: (sessionId: string) => void): void {
    this.#aborted = listener;
  }

  /** Re-emits a complete snapshot after coordination state changes outside the
   * runtime event stream. */
  notifySnapshot(id: string): void {
    const live = this.#live.get(id);
    if (!live) return;
    // A HUI question starts or ends a wait, which the session list shows.
    this.#setStatus(live, this.#reported(live));
    this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(id) });
  }

  /** Whether this gateway currently owns a runtime lifecycle for the id.
   * Registry rows without an opened PI process must not count as live health. */
  isLive(id: string): boolean {
    return this.#live.has(id);
  }

  /** True only while a started adapter still owns its child process. */
  hasRuntime(id: string): boolean {
    return this.#live.get(id)?.runtime !== undefined;
  }

  /** Ephemeral process facts for Sessions. Cold and failed rows are omitted. */
  runtimeTelemetry(): Map<string, RuntimeTelemetry> {
    return new Map([...this.#live.entries()].flatMap(([id, live]) => {
      if (live.status === "error" || live.closed) return [];
      const pid = live.runtime?.processId;
      return [[id, {
        active: true as const,
        ...(pid && pid > 0 ? { pid } : {}),
        ...(live.bootDurationMs !== undefined ? { bootDurationMs: live.bootDurationMs } : {}),
      }]];
    }));
  }

  /**
   * The status the UI should show. `starting`, `error`, `reconnecting` and
   * `disconnected` are lifecycle facts the runtime knows nothing about;
   * otherwise the runtime's own streaming flag decides, because that is
   * exactly what `prompt` refuses on. Reporting idle while a prompt would be
   * refused was a real inconsistency.
   */
  #reported(live: Live): SessionStatus {
    if (["starting", "error", "reconnecting", "disconnected"].includes(live.status)) {
      return live.status;
    }
    if (live.questions.size > 0 || this.#huiQuestions(live.record.id).length > 0) {
      return "waiting";
    }
    return live.promptPending || live.runtime?.isStreaming || this.#compactionBlocks(live) ? "running" : "idle";
  }

  transcript(id: string): TranscriptEntry[] {
    return publicTranscript(id, this.#live.get(id)?.transcript ?? []);
  }

  /** Image bytes for a transcript attachment, from the runtime's history. */
  async attachmentImage(id: string, message: number, image: number): Promise<{ mimeType: string; data: Buffer } | undefined> {
    return this.#live.get(id)?.runtime?.attachmentImage?.(message, image);
  }

  attachmentFile(id: string, message: number, file: number): string | undefined {
    return this.#live.get(id)?.runtime?.attachmentFile?.(message, file);
  }

  snapshot(id: string): SessionSnapshot {
    const live = this.#live.get(id);
    if (!live) {
      return {
        transcript: [],
        status: "idle",
        queue: { steering: [], followUp: [] },
        questions: [],
        subagents: [...this.#subagentSnapshot(id)],
        ...this.#suggestionField(id),
        ...this.#watcherField(id),
      };
    }
    const model = live.runtime?.currentModel?.();
    const usage = live.runtime?.currentUsage?.();
    return {
      transcript: publicTranscript(id, live.transcript),
      status: this.#reported(live),
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(live.thinking ? { thinking: live.thinking } : {}),
      ...(live.fast === undefined ? {} : { fast: live.fast }),
      queue: this.#queueSnapshot(live),
      questions: [...live.questions.values(), ...this.#huiQuestions(id)],
      subagents: [...this.#subagentSnapshot(id)],
      ...this.#suggestionField(id),
      ...this.#watcherField(id),
      ...(live.compaction ? { compaction: live.compaction } : {}),
    };
  }

  #suggestionField(id: string): { suggestions?: readonly TaskSuggestion[] } {
    const suggestions = this.#suggestionSnapshot(id);
    return suggestions.length ? { suggestions: [...suggestions] } : {};
  }

  #watcherField(id: string): { watchers?: readonly Watcher[] } {
    const watchers = this.#watcherSnapshot(id);
    return watchers.length ? { watchers: [...watchers] } : {};
  }

  /** Installs the listener and captures its first paint in one synchronous
   * operation. No runtime callback can interleave between these two steps, so
   * the browser never receives an event older than its initial snapshot. */
  watch(
    id: string,
    subscriber: Subscriber,
    options: { reader?: boolean } = {},
  ): { snapshot: SessionSnapshot; unsubscribe: () => void } {
    const live = this.#live.get(id);
    if (!live) {
      return { snapshot: this.snapshot(id), unsubscribe: () => {} };
    }
    live.subscribers.add(subscriber);
    if (options.reader) {
      live.readers += 1;
      void this.markRead(id).catch(() => {});
    }
    let subscribed = true;
    return {
      snapshot: this.snapshot(id),
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        live.subscribers.delete(subscriber);
        if (options.reader) {
          live.readers = Math.max(0, live.readers - 1);
          if (
            live.readers === 0 && live.releaseWhenUnread && live.followUps.length === 0 &&
            this.#reported(live) === "idle"
          ) {
            this.close(id);
          }
        }
      },
    };
  }

  /** Installs one listener for every live session and captures a coherent
   * status snapshot synchronously. Missing ids are cold and therefore idle. */
  watchStatuses(
    subscriber: StatusSubscriber,
  ): { statuses: SessionStatusUpdate[]; unsubscribe: () => void } {
    this.#statusSubscribers.add(subscriber);
    return {
      statuses: [...this.#live.values()].map((live) => ({
        id: live.record.id,
        status: this.#reported(live),
        ...(live.record.unread ? { unread: true } : {}),
      })),
      unsubscribe: () => this.#statusSubscribers.delete(subscriber),
    };
  }

  /** Listeners are held even before the runtime exists, so a stream opened
   * during boot misses nothing. */
  subscribe(id: string, subscriber: Subscriber): () => void {
    const live = this.#live.get(id);
    if (!live) {
      return () => {};
    }
    live.subscribers.add(subscriber);
    return () => {
      live.subscribers.delete(subscriber);
    };
  }

  async prompt(
    id: string,
    text: string,
    attachments?: readonly PromptAttachment[],
    recoveryPrompt = text,
    options?: RuntimePromptOptions,
  ): Promise<void> {
    const live = this.#live.get(id);
    if (!live?.runtime) {
      throw this.#unavailable(live);
    }
    if (this.#holdWhileCompacting(live)) {
      await this.followUp(id, text, attachments, options);
      return;
    }
    if (live.promptPending || live.runtime.isStreaming) {
      throw new SessionBusyError("That session is already working on a prompt.");
    }
    const previousRunStartedAt = live.record.runStartedAt;
    const previousRunPrompt = live.record.runPrompt;
    const previousRecoveryAttempts = live.record.runRecoveryAttempts;
    const runStartedAt = new Date().toISOString();
    let admit!: () => void;
    let refuse!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => { admit = resolve; refuse = reject; });
    admission.catch(() => {});
    live.promptAdmission = admission;
    live.promptPending = true;
    live.lastPrompt = { text, ...(attachments?.length ? { attachments } : {}) };
    live.turnProducedOutput = false;
    live.fallbackAttempted = false;
    // Every screen on this session gets the prompt before the run is announced: a chat
    // that hears "running" first treats the finished turn above as live and redraws it,
    // and one that never hears the prompt (sent by a routine, a subagent, an automation
    // or another screen) shows its reply as part of that turn. The settle's refresh from
    // PI replaces this row, even when an extension settles before the call returns.
    const prompted: TranscriptEntry = {
      kind: "message",
      role: "user",
      text,
      ...(attachments?.length ? { attachments: attachments.map((item) => ({ name: item.name, kind: item.kind, ...(item.kind === "image" ? { mimeType: item.mimeType } : {}) })) } : {}),
    };
    live.transcript.push(prompted);
    this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(id) });
    this.#setStatus(live, "running");
    live.submissions += 1;
    try {
      // This write is the recovery boundary. If the gateway or machine dies
      // after PI accepts the prompt, the next process can tell this run did not
      // reach a normal terminal event.
      await this.#save(live, {
        runStartedAt,
        runPrompt: recoveryPrompt,
        runRecoveryAttempts: recoveryPrompt === text ? undefined : previousRecoveryAttempts,
        updatedAt: runStartedAt,
      });
      await live.runtime.prompt(text, attachments, options);
      admit();
    } catch (error) {
      refuse(error);
      // A refused prompt never became unfinished work. Restore an older marker
      // when this was itself an attempt to continue an interrupted run.
      await this.#save(live, {
        runStartedAt: previousRunStartedAt,
        runPrompt: previousRunPrompt,
        runRecoveryAttempts: previousRecoveryAttempts,
      }).catch(() => {});
      live.promptPending = false;
      // A refused prompt never joined the conversation.
      const at = live.transcript.lastIndexOf(prompted);
      if (at >= 0) live.transcript.splice(at, 1);
      this.#setStatus(live, this.#reported(live));
      this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(id) });
      throw error;
    } finally {
      live.submissions -= 1;
      if (live.promptAdmission === admission) live.promptAdmission = undefined;
    }
    // Activity is what orders the sidebar, and the write is one small record on
    // a prompt rather than one per token; a failed save must not fail a prompt
    // the agent already accepted. Registry read-modify-write operations are
    // serialized by `updateRegistry`, so boot and metadata writes cannot lose
    // one another.
    await this.#save(live, { updatedAt: new Date().toISOString() }).catch(() => {});
  }

  async continueInterrupted(id: string, automatic = false): Promise<void> {
    const live = this.#ready(id);
    if (!live.record.runStartedAt) {
      throw new Error("That session has no interrupted run to continue.");
    }
    const original = live.record.runPrompt?.trim();
    const message = interruptedRunPrompt(original);
    if (!automatic && live.record.runRecoveryAttempts !== undefined) {
      await this.#save(live, { runRecoveryAttempts: undefined });
    }
    await this.prompt(id, message, undefined, original || message);
  }

  /** Opening or presenting a conversation acknowledges its latest activity. */
  async markRead(id: string): Promise<SessionRecord> {
    const live = this.#live.get(id);
    if (!live) throw new Error(`Unknown live session: ${id}`);
    if (live.record.unread !== true) return live.record;
    live.record = { ...live.record, unread: undefined };
    this.#publishStatus(live, this.#reported(live), true, false);
    try {
      await this.#save(live, { unread: undefined }, true);
    } catch (error) {
      live.record = { ...live.record, unread: true };
      this.#publishStatus(live, this.#reported(live), true, true);
      throw error;
    }
    return live.record;
  }

  /** The model in use, so a header can render before it asks for the full list. */
  currentModel(id: string): RuntimeModel | undefined {
    return this.#live.get(id)?.runtime?.currentModel?.();
  }

  /** Models the session can switch to. Empty when the runtime cannot list. */
  async models(id: string): Promise<readonly RuntimeModel[]> {
    const live = this.#live.get(id);
    if (!live?.runtime) {
      throw this.#unavailable(live);
    }
    return live.runtime.listModels ? await live.runtime.listModels() : [];
  }

  async commands(id: string): Promise<readonly RuntimeCommand[]> {
    const live = this.#live.get(id);
    if (!live?.runtime) throw this.#unavailable(live);
    return live.runtime.listCommands ? await live.runtime.listCommands() : [];
  }

  /** Inspection never boots a cold session or executes extensions implicitly. */
  async inspect(id: string): Promise<import("../runtimes/types.ts").SessionTools> {
    const runtime = this.#live.get(id)?.runtime;
    if (!runtime) return { status: "cold" };
    return runtime.inspect ? await runtime.inspect() : { status: "unsupported" };
  }

  async setModel(id: string, provider: string, modelId: string): Promise<RuntimeModel | undefined> {
    const live = this.#live.get(id);
    if (!live?.runtime) {
      throw this.#unavailable(live);
    }
    if (!live.runtime.setModel) {
      throw new Error(`${live.record.tool} cannot switch models in this build.`);
    }
    const previous = live.runtime.currentModel?.();
    await live.runtime.setModel(provider, modelId);
    const current = live.runtime.currentModel?.() ?? { provider, id: modelId, name: modelId };
    try {
      // Persisted, so reopening the session tomorrow resumes on the same model.
      await this.#save(live, {
        model: `${current.provider}/${current.id}`,
        updatedAt: new Date().toISOString(),
      });
    } catch (persistenceError) {
      if (previous) {
        let rollbackSucceeded = false;
        try {
          await live.runtime.setModel(previous.provider, previous.id);
          const reverted = live.runtime.currentModel?.() ?? previous;
          this.#broadcast(live, { kind: "model", model: reverted });
          rollbackSucceeded = true;
        } catch {}
        if (rollbackSucceeded) throw persistenceError;
      }

      const liveModel = live.runtime.currentModel?.() ?? current;
      const message =
        `PI is using ${liveModel.provider}/${liveModel.id}, but HUI could not persist ` +
        "the change or restore the previous model. Refresh state before retrying.";
      this.#broadcast(live, { kind: "model", model: liveModel });
      this.#broadcast(live, { kind: "event", event: { type: "error", message } });
      throw new SessionRegistryError(message, { cause: persistenceError });
    }
    if (current) {
      this.#broadcast(live, { kind: "model", model: current });
    }
    // The runtime fits the thinking level to the new model; the record keeps the operator's choice.
    const thinking = live.runtime.currentThinking?.();
    if (thinking && thinking !== live.thinking) {
      live.thinking = thinking;
      this.#broadcast(live, { kind: "thinking", level: thinking });
    }
    return current;
  }

  async abort(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (!live?.runtime) {
      throw this.#unavailable(live);
    }
    if (!live.runtime.abort) {
      throw new Error(`${live.record.tool} cannot stop a turn in this build.`);
    }
    // Persist the operator's intent before asking the child to stop. A gateway
    // loss during abort must not resurrect work they deliberately cancelled.
    await this.#save(live, {
      runStartedAt: undefined,
      runPrompt: undefined,
      runRecoveryAttempts: undefined,
    });
    await live.runtime.abort();
    this.#aborted(id);
    live.promptPending = false;
    this.#setStatus(live, this.#reported(live));
  }

  async clear(id: string): Promise<SessionSnapshot> {
    const live = this.#ready(id);
    if (this.#reported(live) !== "idle" || live.followUps.length || live.questions.size) {
      throw new SessionBusyError("Finish or stop active work before clearing the session.");
    }
    if (!live.runtime?.clear) throw new Error(`${live.record.tool} cannot clear sessions in this build.`);

    // Claim the session before awaiting PI so a concurrent prompt cannot land
    // between the idle check and the runtime's new_session command.
    live.promptPending = true;
    this.#setStatus(live, "running");
    let runtimeCleared = false;
    try {
      await live.runtime.clear();
      runtimeCleared = true;
      live.transcript = [...live.runtime.transcript()];
      live.compaction = undefined;
      live.queue = live.runtime.pendingQueue?.() ?? { steering: [], followUp: [] };
      live.followUps = [];
      live.questions = new Map((live.runtime.pendingQuestions?.() ?? []).map((question) => [question.id, question]));
      live.lastPrompt = undefined;
      live.turnProducedOutput = false;
      live.fallbackAttempted = false;
      live.thinking = live.runtime.currentThinking?.() ?? live.thinking;
      await this.#save(live, {
        piSessionFile: live.runtime.sessionFile,
        runStartedAt: undefined,
        runPrompt: undefined,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      live.promptPending = false;
      this.#setStatus(live, this.#reported(live));
      if (runtimeCleared) {
        const message = "The live context was cleared, but HUI could not persist the new session identity. Reopening may restore the previous context.";
        this.#broadcast(live, { kind: "event", event: { type: "error", message } });
        this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(id) });
        throw new SessionRegistryError(message, { cause: error });
      }
      throw error;
    }
    live.promptPending = false;
    this.#setStatus(live, "idle", false);
    const snapshot = this.snapshot(id);
    this.#broadcast(live, { kind: "snapshot", snapshot });
    return snapshot;
  }

  async reload(id: string): Promise<void> {
    const live = this.#ready(id);
    if (this.#reported(live) !== "idle" || live.followUps.length || live.questions.size) {
      throw new SessionBusyError("Finish or stop active work before reloading the session.");
    }
    if (!live.runtime?.reload) throw new Error(`${live.record.tool} cannot reload sessions in this build.`);
    // Claim the session so no prompt lands while extensions are being swapped.
    live.promptPending = true;
    this.#setStatus(live, "running");
    try {
      await live.runtime.reload();
    } finally {
      live.promptPending = false;
      this.#setStatus(live, this.#reported(live));
    }
  }

  async rewind(id: string, target: RuntimeRewindTarget, options?: { excludeUserMessage?: boolean }): Promise<void> {
    const live = this.#ready(id);
    if (this.#reported(live) === "running") {
      await this.abort(id);
    }
    if (this.#reported(live) !== "idle" || live.followUps.length || live.questions.size) {
      throw new SessionBusyError("Finish or stop active work before rewinding.");
    }
    if (!live.runtime?.rewind) throw new Error(`${live.record.tool} cannot rewind in this build.`);
    // Reserve the session across the async tree mutation so a concurrent prompt
    // cannot enter after an automatic abort and before PI changes branches.
    live.promptPending = true;
    this.#setStatus(live, "running");
    try {
      await live.runtime.rewind(target, options);
      // Durable rewinds continue in a fork, which has its own resume reference.
      if (live.runtime.sessionFile && live.runtime.sessionFile !== live.record.piSessionFile) {
        await this.#save(live, { piSessionFile: live.runtime.sessionFile });
      }
      live.transcript = [...live.runtime.transcript()];
      live.compaction = undefined;
      live.lastPrompt = undefined;
      live.turnProducedOutput = false;
      live.fallbackAttempted = false;
    } finally {
      live.promptPending = false;
      this.#setStatus(live, this.#reported(live), false);
    }
    this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(id) });
  }

  /** Copies the session's history up to `entryId` (its latest settled point when absent) into a new runtime
   * conversation and returns that conversation's resume reference. The session itself is untouched, running or
   * not; registering the copy as a session of its own is the caller's job. */
  async fork(id: string, entryId?: string, options?: { cwd?: string }): Promise<string> {
    const live = this.#ready(id);
    if (!live.runtime?.fork) throw new Error(`${live.record.tool} sessions cannot be forked; only Pi Durable sessions can.`);
    return options ? live.runtime.fork(entryId, options) : live.runtime.fork(entryId);
  }

  async continueRun(id: string): Promise<void> {
    const live = this.#ready(id);
    if (this.#reported(live) !== "idle" || live.followUps.length || live.questions.size) {
      throw new SessionBusyError("Finish or stop active work before continuing.");
    }
    if (!live.runtime?.continueRun) throw new Error(`${live.record.tool} cannot continue without a prompt in this build.`);
    live.promptPending = true;
    live.lastPrompt = undefined;
    live.turnProducedOutput = false;
    live.fallbackAttempted = false;
    this.#setStatus(live, "running");
    try {
      await live.runtime.continueRun();
    } catch (error) {
      live.promptPending = false;
      this.#setStatus(live, this.#reported(live));
      // A normally completed turn has nothing to resume prompt-free; send an
      // explicit continuation prompt instead of surfacing a dead end.
      if (error instanceof Error && /completed assistant response/u.test(error.message)) {
        await this.prompt(id, CONTINUE_PROMPT);
        return;
      }
      throw error;
    }
  }

  async steer(id: string, text: string, attachments?: readonly PromptAttachment[]): Promise<void> {
    const live = this.#ready(id);
    if (this.#holdWhileCompacting(live)) {
      await this.followUp(id, text, attachments);
      return;
    }
    // A runtime that compacts beside the conversation (Durable) takes input
    // meanwhile. With no run to steer, the message starts one, through the
    // prompt path so it is recorded and shown like any prompt.
    if (this.#compactingAlongside(live) && !live.promptPending && !live.runtime?.isStreaming) {
      await this.prompt(id, text, attachments);
      return;
    }
    if (!live.runtime?.steer) throw new Error(`${live.record.tool} cannot steer in this build.`);
    await live.runtime.steer(text, attachments);
  }

  /** Queues work for after the current run. Returns the id of HUI's queue item, which leaves the queue when HUI sends
   * it; undefined when the runtime queued it itself (a worker's streaming run). */
  async followUp(id: string, text: string, attachments?: readonly PromptAttachment[], options?: RuntimePromptOptions): Promise<string | undefined> {
    const live = this.#ready(id);
    // HUI removes an editable followup immediately before handing it to the runtime. Its registry write may still be
    // pending, so a newer identified input must wait for actual runtime acceptance rather than treat queue removal as
    // acceptance. A rejected earlier prompt rejects this admission too, without inventing a different ordering.
    if (options && live.promptAdmission) await live.promptAdmission;
    // HUI's queue drains only while this gateway runs; a worker keeps going
    // without it, so a follow-up to a run streaming there queues in its
    // runtime and runs even if the gateway leaves. Like steering, it is then
    // shown but no longer editable. Before the run streams (the prompt is
    // still on its way, a compaction holds the session) or while earlier ones
    // wait in HUI's editable queue, it waits there too, behind them.
    if ((options && this.supportsTrackedPrompts(id)) || (live.record.worker && live.runtime?.followUp && live.runtime.isStreaming && !live.followUps.length)) {
      // An identified routine belongs in the runtime's durable inbox even locally; HUI's editable queue is ephemeral.
      if (!live.runtime?.followUp) throw new Error("The runtime cannot queue a tracked prompt.");
      await live.runtime.followUp(text, attachments, options);
      live.queue = live.runtime.pendingQueue?.() ?? live.queue;
      this.#broadcastQueue(live);
      return undefined;
    }
    const item = crypto.randomUUID();
    live.followUps.push({
      id: item,
      text,
      mode: "followUp",
      ...(attachments?.length ? { attachments: [...attachments] } : {}),
    });
    this.#broadcastQueue(live);
    if (this.#reported(live) === "idle") void this.#drainFollowUp(live);
    return item;
  }

  /** Identified inputs are supported end to end, including receipt lookup and narrowly targeted cancellation. */
  supportsTrackedPrompts(id: string): boolean {
    const runtime = this.#live.get(id)?.runtime;
    return typeof runtime?.waitForTrackedPrompt === "function" && typeof runtime.cancelTrackedPrompt === "function";
  }

  async waitForTrackedPrompt(id: string, requestId: string): Promise<RuntimePromptResult> {
    const runtime = this.#ready(id).runtime;
    if (!runtime?.waitForTrackedPrompt) throw new Error("This runtime cannot recover an identified input.");
    return runtime.waitForTrackedPrompt(requestId);
  }

  async cancelTrackedPrompt(id: string, requestId: string): Promise<void> {
    const runtime = this.#ready(id).runtime;
    if (runtime?.cancelTrackedPrompt) await runtime.cancelTrackedPrompt(requestId);
  }

  /** PI refuses a prompt while it compacts outside a run, and a steer would wait
   * in its queue until some later prompt. Hold either in HUI's follow-up queue,
   * which drains once the compaction ends. Inside a run PI delivers steers. A
   * compaction the runtime runs beside the conversation holds nothing. */
  #holdWhileCompacting(live: Live): boolean {
    return this.#compactionBlocks(live) && !live.runtime?.isStreaming;
  }

  #compacting(live: Live): boolean {
    return live.compaction?.status === "running";
  }

  /** A running compaction that blocks the session (PI's, or Durable's blocking
   * one inside its run): the session is busy and Stop cancels it. */
  #compactionBlocks(live: Live): boolean {
    return live.compaction?.status === "running" && live.compaction.blocking !== false;
  }

  /** A compaction the runtime runs beside the conversation (Durable's manual and
   * background ones): the session stays idle, input is admitted and a run
   * carries on meanwhile. */
  #compactingAlongside(live: Live): boolean {
    return live.compaction?.status === "running" && live.compaction.blocking === false;
  }

  async compact(id: string, instructions?: string): Promise<void> {
    const live = this.#ready(id);
    if (this.#reported(live) !== "idle" || live.followUps.length || live.questions.size) {
      throw new SessionBusyError("Finish or stop active work before compacting the session.");
    }
    if (this.#compacting(live)) throw new SessionBusyError("A compaction is already running.");
    if (!live.runtime?.compact) throw new Error(`${live.record.tool} cannot compact sessions in this build.`);
    // A runtime that compacts beside the conversation (Durable) reports its
    // start while it is called. PI's events arrive later: claim the session
    // until they take over, so nothing lands first.
    const started = live.runtime.compact(instructions);
    if (!this.#compacting(live)) live.compaction = { status: "running", reason: "manual" };
    this.#setStatus(live, this.#reported(live));
    await started;
  }

  /** Cancels a manual compaction the runtime runs beside the conversation. One
   * that blocks the session is cancelled by Stop; a background one is the
   * runtime's own and keeps running. */
  async cancelCompaction(id: string): Promise<void> {
    const live = this.#ready(id);
    if (!this.#compactingAlongside(live) || live.compaction?.background) {
      throw new SessionBusyError("There is no compaction to cancel here.");
    }
    if (!live.runtime?.cancelCompaction) throw new Error(`${live.record.tool} cannot cancel a compaction in this build.`);
    await live.runtime.cancelCompaction();
  }

  editFollowUp(id: string, itemId: string, text: string): void {
    const live = this.#ready(id);
    const index = live.followUps.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error("That queued message is no longer available.");
    live.followUps[index] = { ...live.followUps[index]!, text };
    this.#broadcastQueue(live);
  }

  removeFollowUp(id: string, itemId: string): void {
    const live = this.#ready(id);
    const index = live.followUps.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error("That queued message is no longer available.");
    live.followUps.splice(index, 1);
    this.#broadcastQueue(live);
  }

  moveFollowUp(id: string, itemId: string, toIndex: number): void {
    const live = this.#ready(id);
    const fromIndex = live.followUps.findIndex((item) => item.id === itemId);
    if (fromIndex < 0) throw new Error("That queued message is no longer available.");
    const [item] = live.followUps.splice(fromIndex, 1);
    const target = Math.min(Math.max(toIndex, 0), live.followUps.length);
    live.followUps.splice(target, 0, item!);
    this.#broadcastQueue(live);
  }

  async steerFollowUp(id: string, itemId: string): Promise<void> {
    const live = this.#ready(id);
    if (!live.runtime?.steer || !live.runtime.isStreaming) {
      throw new SessionBusyError("That run is no longer available to steer.");
    }
    const index = live.followUps.findIndex((item) => item.id === itemId);
    if (index < 0) throw new Error("That queued message is no longer available.");
    const [item] = live.followUps.splice(index, 1);
    this.#broadcastQueue(live);
    try {
      await live.runtime.steer(item!.text, item!.attachments);
    } catch (error) {
      live.followUps.splice(index, 0, item!);
      this.#broadcastQueue(live);
      throw error;
    }
  }

  currentThinking(id: string): string | undefined {
    return this.#live.get(id)?.thinking;
  }

  async setThinking(id: string, level: string): Promise<void> {
    const live = this.#ready(id);
    if (!live.runtime?.setThinking) throw new Error(`${live.record.tool} cannot change thinking in this build.`);
    const previous = live.runtime.currentThinking?.() ?? live.thinking ?? live.record.thinking;
    await live.runtime.setThinking(level);
    live.thinking = live.runtime.currentThinking?.() ?? level;
    try {
      await this.#save(live, { thinking: live.thinking });
    } catch (persistenceError) {
      if (previous) {
        try {
          await live.runtime.setThinking(previous);
          live.thinking = live.runtime.currentThinking?.() ?? previous;
          this.#broadcast(live, { kind: "thinking", level: live.thinking });
          throw persistenceError;
        } catch (rollbackError) {
          if (rollbackError === persistenceError) throw persistenceError;
        }
      }

      live.thinking = live.runtime.currentThinking?.() ?? live.thinking;
      const current = live.thinking ?? level;
      const message =
        `PI is using thinking level ${current}, but HUI could not persist ` +
        "the change or restore the previous level. Refresh state before retrying.";
      this.#broadcast(live, { kind: "thinking", level: current });
      this.#broadcast(live, { kind: "event", event: { type: "error", message } });
      throw new SessionRegistryError(message, { cause: persistenceError });
    }
    this.#broadcast(live, { kind: "thinking", level: live.thinking });
  }

  async setFast(id: string, on: boolean): Promise<boolean> {
    const live = this.#ready(id);
    if (!live.runtime?.setFast) throw new Error(`${live.record.tool} cannot change speed in this build.`);
    const previous = live.runtime.currentFast?.() === true;
    await live.runtime.setFast(on);
    try {
      await this.#save(live, { fast: on || undefined });
    } catch (persistenceError) {
      await live.runtime.setFast(previous).catch(() => undefined);
      throw new SessionRegistryError("HUI could not save the speed, so the session keeps its previous one.", { cause: persistenceError });
    } finally {
      live.fast = live.runtime.currentFast?.() ?? live.fast;
      this.#broadcast(live, { kind: "fast", fast: live.fast === true });
    }
    return live.fast === true;
  }

  async respondQuestion(id: string, questionId: string, response: RuntimeQuestionResponse): Promise<void> {
    const live = this.#ready(id);
    const question = live.questions.get(questionId);
    if (!question) throw new Error(`Unknown question: ${questionId}`);
    if (!live.runtime?.respondQuestion) throw new Error(`${live.record.tool} cannot answer questions in this build.`);
    live.questions.delete(questionId);
    try {
      await live.runtime.respondQuestion(questionId, response);
    } catch (error) {
      if (!live.questions.has(questionId)) live.questions.set(questionId, question);
      this.#setStatus(live, this.#reported(live));
      throw error;
    }
    this.#setStatus(live, this.#reported(live));
    this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(id) });
  }

  async cancelQuestion(id: string, questionId: string): Promise<void> {
    const live = this.#ready(id);
    const question = live.questions.get(questionId);
    if (!question) throw new Error(`Unknown question: ${questionId}`);
    if (!live.runtime?.cancelQuestion) throw new Error(`${live.record.tool} cannot cancel questions in this build.`);
    live.questions.delete(questionId);
    try {
      await live.runtime.cancelQuestion(questionId);
    } catch (error) {
      if (!live.questions.has(questionId)) live.questions.set(questionId, question);
      this.#setStatus(live, this.#reported(live));
      throw error;
    }
    this.#setStatus(live, this.#reported(live));
    this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(id) });
  }

  /** Why a session without a runtime cannot take a request yet. */
  #unavailable(live: Live | undefined): SessionBusyError {
    const why: Partial<Record<SessionStatus, string>> = {
      reconnecting: "HUI is reconnecting to the machine this session runs on; it keeps running there. Try again once it is back.",
      disconnected: "HUI is disconnected from the machine this session runs on. Reconnect it to continue.",
    };
    return new SessionBusyError((live && why[live.status]) ?? "That session is still starting.");
  }

  /**
   * Boots an idle session's runtime again from `record` (a bot whose chat moved to another directory), keeping its
   * listeners: they see `starting`, then the fresh snapshot. A cold session has nothing to restart.
   */
  async restart(record: SessionRecord): Promise<void> {
    const live = this.#live.get(record.id);
    if (!live) return;
    if (this.#reported(live) !== "idle" || live.followUps.length || live.questions.size) {
      throw new SessionBusyError("Finish or stop active work before restarting the session.");
    }
    live.unsubscribe?.();
    live.unsubscribe = undefined;
    live.unsubscribeExit?.();
    live.unsubscribeExit = undefined;
    live.runtime?.dispose();
    live.runtime = undefined;
    live.record = this.#withUnsaved(live, record);
    live.bootStartedAt = Date.now();
    live.bootDurationMs = undefined;
    this.#setStatus(live, "starting");
    live.boot = this.#boot(live);
    await live.boot;
  }

  /** HUI stopped retrying the host of sessions it was reconnecting to. */
  stopReconnecting(id: string): void {
    const live = this.#live.get(id);
    if (live?.status === "reconnecting" && !live.reattaching) this.#setStatus(live, "disconnected");
  }

  #ready(id: string): Live {
    const live = this.#live.get(id);
    if (!live?.runtime) throw this.#unavailable(live);
    return live;
  }

  /** Stops one session's runtime and forgets it, so deleting a session cannot
   * leave a pi child running with nobody to read it. */
  close(id: string): void {
    const live = this.#live.get(id);
    if (!live) {
      return;
    }
    live.closed = true;
    live.unsubscribe?.();
    live.unsubscribeExit?.();
    live.runtime?.dispose();
    this.#live.delete(id);
  }

  /** Releases a completed background runtime as soon as no browser is actively
   * presenting it. The durable registry row and runtime-owned transcript are
   * intentionally untouched. */
  release(id: string): void {
    const live = this.#live.get(id);
    if (!live) return;
    // Not mid-way through a compaction PI runs after the turn a caller waited for.
    // One the runtime runs beside the conversation (Durable's) outlives this view.
    if (live.readers > 0 || this.#compactionBlocks(live)) {
      live.releaseWhenUnread = true;
      return;
    }
    this.close(id);
  }

  /** Phase one of DELETE: block new opens without disturbing the live runtime
   * or its subscribers while durable registry removal is pending. */
  tombstone(id: string): DeleteToken {
    const token = Symbol(id);
    const state = this.#deletions.get(id) ?? { committed: false, pending: new Set() };
    state.pending.add(token);
    this.#deletions.set(id, state);
    return token;
  }

  /** Phase two after durable removal: tell streams to terminate, then dispose
   * the runtime. The tombstone intentionally remains until explicit reimport. */
  finishDelete(id: string, token: DeleteToken): void {
    const state = this.#deletions.get(id);
    if (!state?.pending.delete(token)) {
      return;
    }
    state.committed = true;
    const live = this.#live.get(id);
    if (!live) {
      return;
    }
    live.closed = true;
    this.#broadcast(live, { kind: "closed" });
    live.subscribers.clear();
    live.unsubscribe?.();
    live.unsubscribeExit?.();
    live.runtime?.dispose();
    this.#live.delete(id);
  }

  /** Durable removal failed, so the existing runtime and streams remain the
   * active owner and new opens may reuse them. */
  rollbackDelete(id: string, token: DeleteToken): void {
    const state = this.#deletions.get(id);
    if (!state?.pending.delete(token)) {
      return;
    }
    if (!state.committed && state.pending.size === 0) {
      this.#deletions.delete(id);
    }
  }

  /** Clears a deletion tombstone only after the registry has durably accepted
   * the same id again. */
  accept(id: string): void {
    this.#deletions.delete(id);
  }

  /** Called when the server closes, so the gateway does not orphan pi children. */
  disposeAll(): void {
    for (const live of this.#live.values()) {
      live.closed = true;
      live.unsubscribe?.();
      live.unsubscribeExit?.();
      live.runtime?.dispose();
    }
    this.#live.clear();
  }

  async #boot(live: Live): Promise<void> {
    let runtime: RuntimeSession | undefined;
    try {
      const adapter = this.#runtimeFor(live.record);
      recordDiagnosticEvent({ area: "runtime", level: "info", action: "boot", summary: `Starting ${live.record.tool} runtime`, sessionId: live.record.id });
      const resume = live.record.piSessionFile;
      runtime = await adapter.start({
        cwd: live.record.cwd,
        ...(resume ? { sessionFile: resume } : {}),
        ...(live.record.title ? { title: live.record.title } : {}),
        ...(live.record.model ? { model: live.record.model } : {}),
        ...(live.record.thinking ? { thinking: live.record.thinking } : {}),
        ...(live.record.worker ? { worker: live.record.worker } : {}),
        huiSessionId: live.record.id,
      });
      if (live.record.fast) await runtime.setFast?.(true);
      // Deletion or gateway shutdown can happen while a runtime takes several
      // seconds to boot. Never attach or persist a process nobody owns.
      if (live.closed || this.#live.get(live.record.id) !== live) {
        runtime.dispose();
        return;
      }
      live.runtime = runtime;
      live.transcript = [...runtime.transcript()];
      live.thinking = runtime.currentThinking?.();
      // Only a runtime that can change speed reports one.
      live.fast = runtime.setFast ? runtime.currentFast?.() === true : undefined;
      live.queue = runtime.pendingQueue?.() ?? { steering: [], followUp: [] };
      live.questions = new Map((runtime.pendingQuestions?.() ?? []).map((question) => [question.id, question]));
      live.unsubscribe = runtime.subscribe((event) => this.#onEvent(live, runtime!, event));
      live.unsubscribeExit = runtime.onExit?.((unreachable) => this.#onExit(live, runtime!, unreachable));
      if (runtime.sessionFile) {
        // Persisted before the session is reported ready. Announcing `idle`
        // first meant a caller could act on a record that was still being
        // written, and two writers racing on the same temp file failed the
        // rename. "Idle" now means ready and durable.
        await this.#save(live, { piSessionFile: runtime.sessionFile });
      }
      // Saving the runtime identity is asynchronous. It may fail, the process
      // may exit, or DELETE may tombstone this id while the write is pending.
      // None of those states may be overwritten with a later idle broadcast.
      if (
        live.closed ||
        this.#isDeleted(live.record.id) ||
        this.#live.get(live.record.id) !== live ||
        live.runtime !== runtime ||
        live.status === "error"
      ) {
        return;
      }
      // A runtime can report a compaction it resumed after a restart while subscribing.
      const readyStatus = live.questions.size > 0
        ? "waiting"
        : runtime.isStreaming || this.#compactionBlocks(live)
          ? "running"
          : "idle";
      live.bootDurationMs = Math.max(0, Date.now() - live.bootStartedAt);
      // The following snapshot carries the full selected-session state. Only
      // the multiplexed lifecycle stream needs a separate ready transition.
      this.#setStatus(live, readyStatus, false);
      recordDiagnosticEvent({ area: "runtime", level: "info", action: "ready", summary: `${live.record.tool} runtime ready`, sessionId: live.record.id });
      if (live.record.runStartedAt && readyStatus === "idle") {
        // A runtime that resumes its own runs has already finished this one or
        // recorded its interruption; replaying it would repeat the request.
        if (runtime.resumesInterruptedRuns) {
          this.#clearRunMarker(live);
          // It settled on its host while HUI was away: what waits on it (a
          // subagent, an automation) hears that now.
          if (live.reattaching) this.#broadcast(live, { kind: "event", event: { type: "settled" } });
        } else await this.#recoverInterrupted(live);
      }
      // A resumed session only has its history after boot, so the transcript is
      // sent now rather than left empty at connect.
      this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(live.record.id) });
      // Messages queued here before the runtime was lost (a worker's run that
      // settled while this gateway was away) run now.
      void this.#drainFollowUp(live);
    } catch (error) {
      // A runtime may exit while its identity is being persisted and the caller
      // may already have started a replacement. Cleanup from the older boot
      // must never detach or dispose that replacement.
      if (runtime && live.runtime !== runtime) {
        runtime.dispose();
        return;
      }
      live.unsubscribe?.();
      live.unsubscribe = undefined;
      live.unsubscribeExit?.();
      live.unsubscribeExit = undefined;
      live.runtime?.dispose();
      live.runtime = undefined;
      if (live.closed || this.#live.get(live.record.id) !== live) {
        return;
      }
      // An unreachable host says nothing about the session, which may be
      // running there: no failure to report, only the status.
      if (error instanceof RuntimeUnreachableError) {
        recordDiagnosticEvent({ area: "runtime", level: "warning", action: "boot_unreachable", summary: "Runtime host unreachable", detail: error.message, sessionId: live.record.id });
        this.#setStatus(live, error.reconnecting ? "reconnecting" : "disconnected");
        return;
      }
      recordDiagnosticEvent({ area: "runtime", level: "error", action: "boot_failed", summary: "Runtime did not start", detail: failureDetail(error), sessionId: live.record.id });
      this.#broadcast(live, {
        kind: "event",
        event: {
          type: "error",
          message: error instanceof Error ? error.message : "The runtime did not start.",
        },
      });
      this.#setStatus(live, "error");
    } finally {
      live.reattaching = undefined;
    }
  }

  #onEvent(live: Live, runtime: RuntimeSession, event: RuntimeEvent): void {
    if (live.closed || live.runtime !== runtime) {
      return;
    }
    if (event.type === "history") {
      // A call's lines written beside the conversation: an idle chat shows them now; a turn's settle does otherwise,
      // since replacing the projection mid-turn would drop what it streamed.
      if (!live.promptPending && !runtime.isStreaming && !live.turnStarted) {
        live.transcript = [...runtime.transcript()];
        this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(live.record.id) });
      }
      return;
    }
    let refreshed = false;
    if (event.type === "compaction_start") {
      live.compaction = {
        status: "running",
        reason: event.reason,
        ...(event.blocking === false ? { blocking: false as const } : {}),
        ...(event.background ? { background: true as const } : {}),
      };
      this.#setStatus(live, this.#reported(live));
    } else if (event.type === "compaction_end") {
      const alongside = this.#compactingAlongside(live);
      recordDiagnosticEvent({ area: "session", level: event.outcome === "failed" ? "warning" : "info", action: "compaction_end", summary: `Compaction ${event.outcome} (${event.reason})`, ...(event.message ? { detail: event.message } : {}), sessionId: live.record.id });
      live.compaction = event.outcome === "done" ? undefined : { status: event.outcome, reason: event.reason, ...(event.message ? { message: event.message } : {}) };
      this.#setStatus(live, this.#reported(live));
      // One that ran beside the conversation (Durable's) ends without a settle:
      // with no turn in flight, show its summary now; a turn's settle does otherwise.
      if (alongside && !live.promptPending && !runtime.isStreaming && !live.turnStarted) {
        live.transcript = [...runtime.transcript()];
        refreshed = true;
      }
      // A compaction PI refused before starting ends without a settle.
      if (this.#reported(live) === "idle") void this.#drainFollowUp(live).then(() => this.#closeIfReleased(live));
    } else if (event.type === "turn_start") {
      recordDiagnosticEvent({ area: "session", level: "info", action: "turn_start", summary: "Agent turn started", sessionId: live.record.id });
      live.turnStarted = true;
      if (live.compaction?.status !== "running") live.compaction = undefined;
      if (live.record.runRecoveryAttempts !== undefined) {
        void this.#save(live, { runRecoveryAttempts: undefined }).catch(() => {});
      }
      this.#setStatus(live, "running");
    } else if (event.type === "settled") {
      recordDiagnosticEvent({ area: "session", level: event.historyRefreshed === false ? "warning" : "info", action: "settled", summary: event.historyRefreshed === false ? "Turn settled without refreshed history" : "Agent turn settled", sessionId: live.record.id });
      live.promptPending = false;
      // PI drops UI requests when their turn ends (Stop aborts a waiting tool).
      // One it no longer holds must not leave the session waiting forever.
      live.questions = new Map((runtime.pendingQuestions?.() ?? []).map((question) => [question.id, question]));
      // PI owns durability. Once it settles, replace the replay projection
      // rather than trying to reconcile streamed fragments with JSONL history.
      // If that authoritative refresh failed, retain the complete projected
      // turn until PI can provide a newer durable snapshot.
      if (event.historyRefreshed !== false) {
        live.transcript = [...runtime.transcript()];
        if (live.turnStarted) this.#logRunFailure(live);
      }
      live.turnStarted = undefined;
      live.loggedRunError = undefined;
      this.#clearRunMarker(live);
      this.#setStatus(live, this.#reported(live));
      void this.#routeSettledTurn(live, runtime);
    } else if (event.type === "turn_end") {
      // `settled` is the real end for pi; `turn_end` is kept because the other
      // adapters only emit that. Clear the manager guard only when the adapter
      // agrees it has stopped; pi remains streaming until `agent_end`.
      if (!live.runtime?.isStreaming) {
        live.promptPending = false;
        this.#clearRunMarker(live);
        if (live.readers === 0) this.#setUnread(live, true);
      }
      this.#setStatus(live, this.#reported(live));
    } else if (event.type === "text") {
      live.turnProducedOutput = true;
      const last = live.transcript.at(-1);
      if (last?.kind === "message" && last.role === "assistant") {
        live.transcript[live.transcript.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        live.transcript.push({ kind: "message", role: "assistant", text: event.delta });
      }
    } else if (event.type === "thinking") {
      live.turnProducedOutput = true;
      const last = live.transcript.at(-1);
      if (last?.kind === "thinking") {
        live.transcript[live.transcript.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        live.transcript.push({ kind: "thinking", text: event.delta });
      }
    } else if (event.type === "tool_start") {
      live.turnProducedOutput = true;
      recordDiagnosticEvent({ area: "runtime", level: "info", action: "tool_start", summary: `Tool started: ${event.name}`, sessionId: live.record.id });
      live.transcript.push({
        kind: "tool",
        id: event.id,
        name: event.name,
        ...(event.args !== undefined ? { args: event.args } : {}),
      });
    } else if (event.type === "tool_update" || event.type === "tool_end") {
      const index = live.transcript.findLastIndex((entry) => entry.kind === "tool" && entry.id === event.id);
      if (index >= 0) {
        const prior = live.transcript[index];
        if (prior?.kind === "tool") {
          live.transcript[index] = {
            ...prior,
            ...(event.output !== undefined ? { output: event.output } : {}),
            // A codemode script's calls so far, or a tool's result details: what a newly attached view shows.
            ...(event.details !== undefined ? { details: event.details } : {}),
            ...(event.type === "tool_end" && event.failed !== undefined ? { failed: event.failed } : {}),
          };
        }
      }
    } else if (event.type === "queue_update") {
      const delivered = [
        ...removedQueueEntries(live.queue.steering, event.queue.steering),
        ...removedQueueEntries(live.queue.followUp, event.queue.followUp),
      ];
      live.queue = { steering: [...event.queue.steering], followUp: [...event.queue.followUp] };
      // PI removes a queued instruction immediately before processing it. Keep
      // that causal user turn visible during a slow model call and reconnect,
      // rather than waiting for final durable history at settlement.
      for (const text of delivered) {
        live.transcript.push({ kind: "message", role: "user", text });
      }
      if (delivered.length) {
        this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(live.record.id) });
      }
    } else if (event.type === "question") {
      live.questions.set(event.question.id, event.question);
      this.#setStatus(live, this.#reported(live));
    } else if (event.type === "notice") {
      recordDiagnosticEvent({ area: "runtime", level: event.level, action: "notice", summary: `Runtime reported a ${event.level} notice`, detail: event.message, sessionId: live.record.id });
    } else if (event.type === "error") {
      recordDiagnosticEvent({ area: "runtime", level: "error", action: "error", summary: "Runtime reported an error", detail: withOutput(event.message, event.output), sessionId: live.record.id });
      live.loggedRunError = event.message;
      live.transcript.push({ kind: "error", message: event.message });
    }
    this.#broadcast(live, {
      kind: "event",
      event: event.type === "queue_update"
        ? { type: "queue_update", queue: this.#queueSnapshot(live) }
        : event.type === "error"
          // Process output stays in diagnostics; browsers get the message.
          ? { type: "error", message: event.message }
          : event,
    });
    if (event.type === "settled" || refreshed) {
      this.#broadcast(live, { kind: "snapshot", snapshot: this.snapshot(live.record.id) });
    }
  }

  async #routeSettledTurn(live: Live, runtime: RuntimeSession): Promise<void> {
    await this.#restoreAfterFallback(live, runtime);
    const retried = await this.#retryWithFallback(live, runtime).catch(() => false);
    if (!retried) {
      if (live.readers === 0) this.#setUnread(live, true);
      await this.#drainFollowUp(live);
      this.#closeIfReleased(live);
    }
  }

  #closeIfReleased(live: Live): void {
    if (
      live.releaseWhenUnread && live.readers === 0 && live.followUps.length === 0 &&
      this.#reported(live) === "idle" && this.#live.get(live.record.id) === live
    ) {
      this.close(live.record.id);
    }
  }

  async #retryWithFallback(live: Live, runtime: RuntimeSession): Promise<boolean> {
    if (
      live.closed || live.runtime !== runtime || live.fallbackAttempted || this.#compactionBlocks(live) ||
      live.turnProducedOutput || !live.lastPrompt || runtime.isStreaming ||
      live.transcript.at(-1)?.kind !== "error" || !runtime.setModel
    ) return false;
    const routes = (await this.#readSettings()).models;
    const current = runtime.currentModel?.();
    const currentRef = current ? `${current.provider}/${current.id}` : live.record.model ?? "";
    if (!routes.fallback || routes.fallback === currentRef || (routes.primary && currentRef !== routes.primary)) return false;
    const separator = routes.fallback.indexOf("/");
    if (separator < 1) return false;
    live.fallbackAttempted = true;
    if (current) live.fallbackRestore = current;
    const prompt = live.lastPrompt;
    this.#broadcast(live, {
      kind: "event",
      event: { type: "notice", level: "warning", message: `Primary model failed before producing output. Retrying with ${routes.fallback}.`, recovery: true },
    });
    try {
      await runtime.setModel(routes.fallback.slice(0, separator), routes.fallback.slice(separator + 1));
      live.promptPending = true;
      live.turnProducedOutput = false;
      this.#setStatus(live, "running");
      live.submissions += 1;
      try { await runtime.prompt(prompt.text, prompt.attachments); }
      finally { live.submissions -= 1; }
      return true;
    } catch (error) {
      live.promptPending = false;
      await this.#restoreAfterFallback(live, runtime);
      this.#setStatus(live, this.#reported(live));
      recordDiagnosticEvent({ area: "session", level: "error", action: "fallback_failed", summary: "Fallback retry failed", detail: failureDetail(error), sessionId: live.record.id });
      this.#broadcast(live, {
        kind: "event",
        event: { type: "error", message: error instanceof Error ? error.message : "The fallback model failed." },
      });
      return false;
    }
  }

  /** The fallback answers one failed turn; the session keeps its own model. */
  async #restoreAfterFallback(live: Live, runtime: RuntimeSession): Promise<void> {
    const model = live.fallbackRestore;
    if (!model || live.runtime !== runtime || !runtime.setModel) return;
    live.fallbackRestore = undefined;
    try {
      await runtime.setModel(model.provider, model.id);
      this.#broadcast(live, { kind: "model", model: runtime.currentModel?.() ?? model });
    } catch (error) {
      recordDiagnosticEvent({ area: "session", level: "error", action: "fallback_restore_failed", summary: "Could not switch back from the fallback model", detail: failureDetail(error), sessionId: live.record.id });
    }
  }

  /** PI records a failed model call in its durable transcript instead of
   * emitting a runtime error, so the settled history is where it shows up. */
  #logRunFailure(live: Live): void {
    const last = live.transcript.at(-1);
    if (last?.kind !== "error" || last.message === live.loggedRunError) return;
    recordDiagnosticEvent({ area: "session", level: "error", action: "run_failed", summary: "Agent run ended with an error", detail: last.message, sessionId: live.record.id });
  }

  #onExit(live: Live, runtime: RuntimeSession, unreachable?: RuntimeUnreachableError): void {
    if (live.closed || live.runtime !== runtime) {
      return;
    }
    live.unsubscribe?.();
    live.unsubscribe = undefined;
    live.unsubscribeExit?.();
    live.unsubscribeExit = undefined;
    live.runtime = undefined;
    live.promptPending = false;
    live.compaction = undefined;
    if (unreachable) {
      recordDiagnosticEvent({ area: "runtime", level: "warning", action: "unreachable", summary: "Lost the connection to the runtime's host", sessionId: live.record.id });
      // Streams stay open: the conversation goes on there and a reattach
      // brings its state back to them.
      this.#setStatus(live, unreachable.reconnecting ? "reconnecting" : "disconnected");
      return;
    }
    recordDiagnosticEvent({ area: "runtime", level: "error", action: "exit", summary: "Runtime process exited", sessionId: live.record.id });
    this.#setStatus(live, "error");
    this.#broadcast(live, { kind: "closed" });
    // Kept, not deleted: the session list still has to show that it failed, and
    // a later open replaces it with a fresh runtime.
  }

  #setStatus(live: Live, status: SessionStatus, session = true): void {
    if (live.status === status) {
      return;
    }
    live.status = status;
    this.#publishStatus(live, status, session);
  }

  #publishStatus(
    live: Live,
    status: SessionStatus,
    session = true,
    unread: boolean | undefined = live.record.unread ? true : undefined,
  ): void {
    if (session) this.#broadcast(live, { kind: "status", status });
    const update = { id: live.record.id, status, ...(unread !== undefined ? { unread } : {}) };
    for (const subscriber of this.#statusSubscribers) subscriber(update);
  }

  async #recoverInterrupted(live: Live): Promise<void> {
    const attempts = live.record.runRecoveryAttempts ?? 0;
    if (!live.record.runStartedAt || attempts >= MAX_AUTOMATIC_RECOVERY_ATTEMPTS) {
      if (live.record.runStartedAt) {
        recordDiagnosticEvent({ area: "session", level: "warning", action: "recovery_exhausted", summary: "Automatic restart recovery exhausted", sessionId: live.record.id });
      }
      return;
    }
    try {
      await this.#save(live, { runRecoveryAttempts: attempts + 1 });
      recordDiagnosticEvent({ area: "session", level: "info", action: "recovery_start", summary: "Continuing interrupted run after gateway restart", sessionId: live.record.id });
      await this.continueInterrupted(live.record.id, true);
    } catch (error) {
      recordDiagnosticEvent({ area: "session", level: "warning", action: "recovery_failed", summary: "Automatic restart recovery did not start", detail: failureDetail(error), sessionId: live.record.id });
      this.#broadcast(live, {
        kind: "event",
        event: {
          type: "error",
          message: error instanceof Error
            ? `Automatic recovery did not start: ${error.message}`
            : "Automatic recovery did not start.",
        },
      });
    }
  }

  #setUnread(live: Live, unread: boolean): void {
    if ((live.record.unread === true) === unread) return;
    const previous = live.record.unread;
    live.record = { ...live.record, unread: unread ? true : undefined };
    this.#publishStatus(live, this.#reported(live));
    void this.#save(live, { unread: unread ? true : undefined }, true).catch((error) => {
      live.record = { ...live.record, unread: previous };
      this.#publishStatus(live, this.#reported(live), true, previous === true);
      this.#broadcast(live, {
        kind: "event",
        event: {
          type: "error",
          message: error instanceof Error
            ? `HUI could not save the unread state: ${error.message}`
            : "HUI could not save the unread state.",
        },
      });
    });
  }

  /** Clear the in-memory marker immediately so the settled session is usable,
   * then durably clear it. A failed write restores recovery eligibility and is
   * surfaced on the stream instead of silently losing crash protection. */
  #clearRunMarker(live: Live): void {
    const runStartedAt = live.record.runStartedAt;
    if (!runStartedAt) return;
    const runPrompt = live.record.runPrompt;
    const runRecoveryAttempts = live.record.runRecoveryAttempts;
    live.record = { ...live.record, runStartedAt: undefined, runPrompt: undefined, runRecoveryAttempts: undefined };
    void this.#save(live, { runStartedAt: undefined, runPrompt: undefined, runRecoveryAttempts: undefined }, true).catch((error) => {
      live.record = { ...live.record, runStartedAt, runPrompt, runRecoveryAttempts };
      this.#broadcast(live, {
        kind: "event",
        event: {
          type: "error",
          message: error instanceof Error
            ? `The run finished, but HUI could not save its recovery state: ${error.message}`
            : "The run finished, but HUI could not save its recovery state.",
        },
      });
    });
  }

  #broadcast(live: Live, message: SessionStreamMessage): void {
    for (const subscriber of live.subscribers) {
      subscriber(message);
    }
  }

  #queueSnapshot(live: Live): RuntimeQueue {
    return {
      steering: [...live.queue.steering],
      followUp: [...live.queue.followUp, ...live.followUps.map((item) => item.text)],
      ...(live.followUps.length
        ? { items: live.followUps.map(({ id, text, mode }) => ({ id, text, mode })) }
        : {}),
    };
  }

  #broadcastQueue(live: Live): void {
    this.#broadcast(live, {
      kind: "event",
      event: { type: "queue_update", queue: this.#queueSnapshot(live) },
    });
  }

  async #drainFollowUp(live: Live): Promise<void> {
    if (!live.followUps.length || this.#reported(live) !== "idle") return;
    const item = live.followUps.shift()!;
    this.#broadcastQueue(live);
    try {
      await this.prompt(live.record.id, item.text, item.attachments);
    } catch (error) {
      live.followUps.unshift(item);
      this.#broadcastQueue(live);
      recordDiagnosticEvent({ area: "session", level: "warning", action: "follow_up_failed", summary: "Queued message was not sent", detail: failureDetail(error), sessionId: live.record.id });
      this.#broadcast(live, {
        kind: "event",
        event: {
          type: "error",
          message: error instanceof Error ? error.message : "Could not send the queued message.",
        },
      });
    }
  }

  /** Patches the newest record through the registry's serialized mutation
   * queue, preserving metadata written by overlapping HTTP requests. An
   * `optimistic` patch is in `live.record` already and stays there while its
   * write waits behind others (see `Live.unsaved`). */
  async #save(live: Live, patch: Partial<SessionRecord>, optimistic = false): Promise<void> {
    let saved: SessionRecord | undefined;
    if (optimistic) live.unsaved.add(patch);
    try {
      await this.#updateRegistry((sessions) => {
        const next = sessions.map((record) => {
          if (record.id !== live.record.id) {
            return record;
          }
          saved = { ...record, ...patch };
          return saved;
        });
        // `ensure` is public and useful in isolated runtime tests, so it may be
        // given a record not written by the HTTP layer. A closed boot is the one
        // case where appending would resurrect a deliberately deleted row.
        if (!saved && !live.closed && !this.#isDeleted(live.record.id)) {
          saved = { ...live.record, ...patch };
          next.push(saved);
        }
        return next;
      });
    } finally {
      // Not `.finally()` on the promise: that would resume callers a tick later.
      live.unsaved.delete(patch);
    }
    // If the row was deleted while pi booted, do not recreate it.
    if (saved) {
      live.record = this.#withUnsaved(live, saved);
    }
  }

  /** `record` with this process's changes whose writes are still queued. */
  #withUnsaved(live: Live, record: SessionRecord): SessionRecord {
    return live.unsaved.size ? Object.assign({ ...record }, ...live.unsaved) : record;
  }

  #isDeleted(id: string): boolean {
    const state = this.#deletions.get(id);
    return Boolean(state && (state.committed || state.pending.size > 0));
  }
}

/** One gateway per process: sessions outlive the window, so they cannot belong
 * to a plugin instance that gets recreated. */
export const liveSessions = new LiveSessions();
