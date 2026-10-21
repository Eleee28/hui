/** Session-tree coordination modeled after OpenClaw's session tools. */
import { randomUUID } from "node:crypto";

import {
  liveSessions,
  type LiveSessions,
  type SubagentTaskView,
} from "../sessions/live-sessions.ts";
import type { SessionStatus } from "../api/sessions.ts";
import { recordDiagnosticEvent } from "../observability.ts";
import {
  readRegistry,
  updateRegistry,
  type SessionRecord,
  type SubagentStatus,
} from "../sessions/sessions.ts";
import { AgentToolInputError, rootSessionId } from "../sessions/session-tree.ts";
import type { TranscriptEntry } from "../runtimes/types.ts";
import { piThinking } from "../runtimes/model-controls.ts";
import { isThinkingLevel } from "../sessions/thinking.ts";
import { formatSubagentCompletionEvent, SUBAGENT_COMPLETION_MARKER, type SubagentCompletionItem } from "./subagent-completion.ts";

const MAX_ACTIVE_SUBAGENTS = 8;
/** Collected children of one session tree (OpenClaw's Swarm defaults): at most this many start or run at once… */
const MAX_RUNNING_COLLECTED = 32;
/** …and at most this many are queued, starting or running; more are refused. */
const MAX_LIVE_COLLECTED = 50;
const MAX_WAIT_IDS = 100;
const READY_TIMEOUT_MS = 30_000;
const DELIVERY_RETRY_MS = 5_000;
const HISTORY_MAX_BYTES = 80 * 1024;
const OVERSIZED_HISTORY_ENTRY: TranscriptEntry = {
  kind: "error",
  message: "A transcript entry was omitted because it exceeds the session history limit.",
};
const ACTIVE_STATUSES = new Set<SubagentStatus>(["starting", "running"]);

type SessionAccess = Pick<
  LiveSessions,
  | "abort"
  | "accept"
  | "close"
  | "ensure"
  | "followUp"
  | "models"
  | "notifySnapshot"
  | "prompt"
  | "release"
  | "setSubagentSnapshotProvider"
  | "snapshot"
  | "status"
  | "steer"
  | "transcript"
  | "watch"
>;

type RunControl = {
  settle: (status: SubagentStatus, error?: string) => void;
};

type QueuedChild = { child: SessionRecord; root: string; runTimeoutSeconds: number };

function text(
  params: Record<string, unknown>,
  key: string,
  maximum: number,
  optional = false,
): string | undefined {
  const raw = params[key];
  if (raw === undefined && optional) return undefined;
  if (typeof raw !== "string") throw new AgentToolInputError(`${key} must be text.`);
  const value = raw.trim();
  if (!value || value.length > maximum) {
    throw new AgentToolInputError(`${key} must be 1-${maximum} characters.`);
  }
  return value;
}

function integer(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = params[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw new AgentToolInputError(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return raw;
}

function visibleTree(records: readonly SessionRecord[], callerId: string): SessionRecord[] {
  const root = rootSessionId(records, callerId);
  return records.filter((record) => rootSessionId(records, record.id) === root);
}

/** The session and its ancestors. */
function lineage(records: readonly SessionRecord[], sessionId: string): SessionRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const chain: SessionRecord[] = [];
  for (let current = byId.get(sessionId); current && !chain.includes(current); current = current.parentId ? byId.get(current.parentId) : undefined) {
    chain.push(current);
  }
  return chain;
}

function taskView(record: SessionRecord): SubagentTaskView | undefined {
  if (!record.parentId || !record.subagent) return undefined;
  return {
    taskId: record.subagent.taskId,
    sessionId: record.id,
    parentSessionId: record.parentId,
    title: record.title,
    task: record.subagent.task,
    status: record.subagent.status,
    startedAt: record.subagent.startedAt,
    updatedAt: record.subagent.updatedAt,
    ...(record.subagent.endedAt ? { endedAt: record.subagent.endedAt } : {}),
    ...(record.subagent.summary ? { summary: record.subagent.summary } : {}),
    ...(record.subagent.error ? { error: record.subagent.error } : {}),
  };
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function lastAssistant(entries: readonly TranscriptEntry[]): string {
  const entry = entries.findLast((item) => item.kind === "message" && item.role === "assistant");
  return entry?.kind === "message" ? entry.text.trim() : "";
}

function boundedHistory(entries: readonly TranscriptEntry[], limit: number): TranscriptEntry[] {
  const selected: TranscriptEntry[] = [];
  let bytes = 2;
  for (const entry of entries.slice(-limit).toReversed()) {
    const serialized = JSON.stringify(entry);
    const candidate = Buffer.byteLength(serialized, "utf8") > HISTORY_MAX_BYTES - 2
      ? OVERSIZED_HISTORY_ENTRY
      : entry;
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    const separatorBytes = selected.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + candidateBytes > HISTORY_MAX_BYTES) break;
    bytes += separatorBytes + candidateBytes;
    selected.push(candidate);
  }
  return selected.reverse();
}

export class SubagentService {
  #tasks = new Map<string, SubagentTaskView[]>();
  #controls = new Map<string, RunControl>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #disposed = false;
  #deliveryFlights = new Map<string, Promise<void>>();
  #admitted = new Map<string, string>();
  #deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Collected children waiting for a slot, in spawn order. In memory only: they are saved as `starting`. */
  #queue = new Map<string, QueuedChild>();
  /** Collected children started from the queue, by task ID, with their tree's root. */
  #running = new Map<string, string>();
  /** `agents_wait` calls, told about every registry change, and with nothing when the service shuts down. */
  #waiters = new Set<(records?: readonly SessionRecord[]) => void>();
  private readonly sessions: SessionAccess;
  private readonly registryReader: typeof readRegistry;
  private readonly registryUpdater: typeof updateRegistry;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    sessions: SessionAccess = liveSessions,
    registryReader: typeof readRegistry = readRegistry,
    registryUpdater: typeof updateRegistry = updateRegistry,
    now: () => Date = () => new Date(),
    uuid: () => string = randomUUID,
  ) {
    this.sessions = sessions;
    this.registryReader = registryReader;
    this.registryUpdater = registryUpdater;
    this.now = now;
    this.uuid = uuid;
    sessions.setSubagentSnapshotProvider((parentId) => this.snapshot(parentId));
  }

  async initialize(): Promise<void> {
    const now = this.now().toISOString();
    const records = await this.registryUpdater((current) => current.map((record) =>
      record.subagent && ACTIVE_STATUSES.has(record.subagent.status)
        ? {
            ...record,
            subagent: {
              ...record.subagent,
              status: "interrupted" as const,
              completionDelivery: "pending" as const,
              updatedAt: now,
              endedAt: now,
              error: "The HUI gateway restarted before this subagent finished.",
            },
          }
        : record,
    ));
    this.#replaceCache(records);
    // Startup must not wait for a parent model/runtime to become available.
    this.#scheduleDelivery();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#deliveryTimer) clearTimeout(this.#deliveryTimer);
    this.#deliveryTimer = undefined;
    this.#admitted.clear();
    this.#queue.clear();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const control of this.#controls.values()) control.settle("interrupted");
    this.#controls.clear();
    for (const waiter of this.#waiters) waiter();
  }

  snapshot(parentId: string): readonly SubagentTaskView[] {
    return (this.#tasks.get(parentId) ?? []).map((task) => this.#queue.has(task.taskId) ? { ...task, status: "queued" } : task);
  }

  #status(record: SessionRecord): SubagentTaskView["status"] | null {
    if (!record.subagent) return null;
    return this.#queue.has(record.subagent.taskId) ? "queued" : record.subagent.status;
  }

  /** Drop task projections after a registry subtree was durably removed. */
  forgetSessions(ids: ReadonlySet<string>): void {
    for (const [parentId, tasks] of this.#tasks) {
      const kept = tasks.filter((task) => {
        if (!ids.has(parentId) && !ids.has(task.sessionId)) return true;
        this.#admitted.delete(task.taskId);
        this.#queue.delete(task.taskId);
        return false;
      });
      if (kept.length === tasks.length) continue;
      if (kept.length) this.#tasks.set(parentId, kept);
      else this.#tasks.delete(parentId);
      if (!ids.has(parentId)) this.sessions.notifySnapshot(parentId);
    }
    // A wait on a deleted child ends now, naming it.
    if (this.#waiters.size) void this.registryReader().then((records) => { for (const waiter of this.#waiters) waiter(records); }, () => undefined);
  }

  async handle(
    callerSessionId: string,
    action: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#disposed) throw new Error("Subagent service is shutting down.");
    switch (action) {
      case "sessions_spawn": return this.#spawn(callerSessionId, params);
      case "agents_wait": return this.#wait(callerSessionId, params, signal);
      case "sessions_list": return this.#list(callerSessionId, params);
      case "sessions_history": return this.#history(callerSessionId, params);
      case "sessions_send": return this.#send(callerSessionId, params);
      case "subagents": return this.#subagents(callerSessionId, params);
      default: throw new AgentToolInputError(`Unknown agent tool action: ${action}`);
    }
  }

  async #spawn(callerId: string, params: Record<string, unknown>) {
    const task = text(params, "task", 20_000)!;
    const label = text(params, "label", 120, true);
    const model = text(params, "model", 200, true);
    const thinking = text(params, "thinking", 16, true);
    const runTimeoutSeconds = integer(params, "runTimeoutSeconds", 0, 0, 3_600);
    const collect = params["collect"] === true;
    if (model && !/^[^/\s]+\/\S+$/.test(model)) {
      throw new AgentToolInputError("model must use provider/id format.");
    }
    if (thinking && !isThinkingLevel(thinking)) {
      throw new AgentToolInputError(`Unsupported thinking level: ${thinking}`);
    }
    if (model) await this.#assertModelAvailable(callerId, model);
    const taskId = this.uuid();
    const sessionId = this.uuid();
    const now = this.now().toISOString();
    let child: SessionRecord | undefined;
    let root = "";
    const records = await this.registryUpdater((current) => {
      const caller = current.find((record) => record.id === callerId);
      if (!caller) throw new AgentToolInputError(`Unknown caller session: ${callerId}`);
      root = rootSessionId(current, callerId);
      // Ordinary and collected children have separate limits.
      const active = current.filter((record) =>
        record.subagent && ACTIVE_STATUSES.has(record.subagent.status) &&
        (record.subagent.collect === true) === collect &&
        rootSessionId(current, record.id) === root,
      ).length;
      if (collect) {
        // One level of collected children: their caps and the parent's lane assume a flat group.
        if (lineage(current, callerId).some((record) => record.subagent?.collect)) {
          throw new AgentToolInputError("A collected subagent cannot spawn collected subagents of its own; return the work to its parent.");
        }
        if (active >= MAX_LIVE_COLLECTED) {
          throw new AgentToolInputError(`At most ${MAX_LIVE_COLLECTED} collected subagents may be queued or running in one session tree.`);
        }
      } else if (active >= MAX_ACTIVE_SUBAGENTS) {
        throw new AgentToolInputError(`At most ${MAX_ACTIVE_SUBAGENTS} subagents may run in one session tree.`);
      }
      child = {
        id: sessionId,
        title: label ?? truncate(task.replace(/\s+/g, " "), 72),
        group: caller.group,
        ...(caller.archived ? { archived: true } : {}),
        cwd: caller.cwd,
        // A remote session's children run on the same worker.
        ...(caller.worker ? { worker: caller.worker } : {}),
        tool: caller.tool,
        model: model ?? caller.model,
        // Ultra stays with the session that chose it; its children work at the same level without delegating on their own.
        thinking: thinking ?? (caller.thinking && piThinking(caller.thinking)),
        parentId: caller.id,
        subagent: {
          taskId,
          task,
          ...(label ? { label } : {}),
          status: "starting",
          startedAt: now,
          updatedAt: now,
          ...(collect ? { collect: true as const } : {}),
        },
        createdAt: now,
        updatedAt: now,
        source: "hui",
      };
      return [
        ...current.map((record) => record.id === caller.id ? { ...record, updatedAt: now } : record),
        child,
      ];
    });
    if (collect) this.#queue.set(taskId, { child: child!, root, runTimeoutSeconds });
    this.#replaceCache(records);
    if (collect) this.#pump();
    else this.#launch(child!, runTimeoutSeconds);
    recordDiagnosticEvent({
      area: "session",
      level: "info",
      action: "subagent_spawn",
      summary: `Spawned subagent: ${child!.title}`,
      sessionId: callerId,
    });
    return {
      status: "accepted",
      taskId,
      childSessionKey: sessionId,
      label: child!.title,
      ...(this.#queue.has(taskId) ? { queued: true } : {}),
    };
  }

  #launch(child: SessionRecord, runTimeoutSeconds: number): void {
    // A fresh UUID has no old tombstone to clear. Preserve any concurrent
    // ancestor deletion that committed after registration and before launch.
    this.sessions.ensure(child);
    void this.#run(child, runTimeoutSeconds).catch((error: unknown) => {
      recordDiagnosticEvent({
        area: "session",
        level: "error",
        action: "subagent_run_failed",
        summary: error instanceof Error ? error.message : "Could not finish subagent bookkeeping.",
        sessionId: child.parentId,
      });
    });
  }

  /** Start queued collected children, in spawn order, while their tree has a free slot. */
  #pump(): void {
    if (this.#disposed) return;
    for (const [taskId, queued] of this.#queue) {
      const running = [...this.#running.values()].filter((root) => root === queued.root).length;
      if (running >= MAX_RUNNING_COLLECTED) continue;
      this.#queue.delete(taskId);
      this.#running.set(taskId, queued.root);
      this.#launch(queued.child, queued.runTimeoutSeconds);
      this.sessions.notifySnapshot(queued.child.parentId!);
    }
  }

  /** Reject an unknown model before a child exists, so the caller can retry in
   * the same turn. An unavailable or empty catalog is not a reason to block. */
  async #assertModelAvailable(callerId: string, model: string): Promise<void> {
    const catalog = await this.sessions.models(callerId).catch(() => []);
    const names = catalog.map((entry) => `${entry.provider}/${entry.id}`);
    if (!names.length || names.includes(model)) return;
    const id = model.slice(model.lastIndexOf("/") + 1);
    const similar = names.filter((name) => name.endsWith(`/${id}`)).slice(0, 5);
    throw new AgentToolInputError(similar.length
      ? `Unknown model: ${model}. Did you mean ${similar.join(" or ")}?`
      : `Unknown model: ${model}. Available models include ${names.slice(0, 10).join(", ")}.`);
  }

  async #run(child: SessionRecord, runTimeoutSeconds: number): Promise<void> {
    const taskId = child.subagent!.taskId;
    try {
      await this.#waitUntilReady(child.id);
      const completion = this.#waitForCompletion(child, runTimeoutSeconds);
      // Only from `starting`: a task cancelled meanwhile stays cancelled.
      if (!(await this.#markRunning(child.id))) {
        completion.cancel();
        return;
      }
      // Settled during that save (cancelled, or its runtime failed; its control is gone): record that, unprompted.
      if (this.#controls.has(taskId)) {
        try {
          await this.sessions.prompt(child.id, `[Subagent Task]\n${child.subagent!.task}`);
        } catch (error) {
          completion.cancel();
          throw error;
        }
      }
      const outcome = await completion.promise;
      if (outcome.status === "cancelled") return; // #cancel records it
      const summary = outcome.status === "completed"
        ? truncate(lastAssistant(this.sessions.transcript(child.id)), 20_000)
        : "";
      await this.#finishTask(child.id, outcome.status, summary, outcome.error);
    } catch (error) {
      await this.#finishTask(
        child.id,
        "failed",
        "",
        error instanceof Error ? error.message : "The subagent failed.",
      );
    } finally {
      this.#controls.delete(taskId);
      if (this.#running.delete(taskId)) this.#pump();
    }
  }

  #waitForCompletion(child: SessionRecord, runTimeoutSeconds: number): {
    promise: Promise<{ status: SubagentStatus; error?: string }>;
    cancel: () => void;
  } {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let resolvePromise!: (value: { status: SubagentStatus; error?: string }) => void;
    const cleanup = () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
        this.#timers.delete(timer);
      }
      this.#controls.delete(child.subagent!.taskId);
    };
    const settle = (status: SubagentStatus, error?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ status, ...(error ? { error } : {}) });
    };
    const promise = new Promise<{ status: SubagentStatus; error?: string }>((resolve) => {
      resolvePromise = resolve;
      const watched = this.sessions.watch(child.id, (message) => {
        if (message.kind === "event" && message.event.type === "settled") settle("completed");
        else if (message.kind === "status" && message.status === "error") {
          settle("failed", "The subagent runtime failed.");
        } else if (message.kind === "status" && message.status === "disconnected") {
          settle("failed", "HUI is disconnected from the machine the subagent runs on.");
        } else if (message.kind === "closed") {
          settle("failed", "The subagent runtime exited.");
        }
      });
      unsubscribe = watched.unsubscribe;
      if (runTimeoutSeconds > 0) {
        timer = setTimeout(() => {
          settle("timed_out", `The subagent exceeded ${runTimeoutSeconds} seconds.`);
          void this.sessions.abort(child.id).catch(() => undefined);
        }, runTimeoutSeconds * 1_000);
        this.#timers.add(timer);
      }
    });
    this.#controls.set(child.subagent!.taskId, { settle });
    return { promise, cancel: () => settle("failed", "The subagent prompt was rejected.") };
  }

  /** `deliver: false` when nothing should reach the parent, such as children its Stop cancelled. */
  async #finishTask(
    sessionId: string,
    status: SubagentStatus,
    summary = "",
    error = "",
    deliver = true,
  ): Promise<void> {
    let finished = false;
    const now = this.now().toISOString();
    const records = await this.registryUpdater((current) => current.map((record) => {
      if (record.id !== sessionId || !record.subagent || !ACTIVE_STATUSES.has(record.subagent.status)) {
        return record;
      }
      finished = true;
      return {
        ...record,
        updatedAt: now,
        subagent: {
          ...record.subagent,
          status,
          updatedAt: now,
          endedAt: now,
          completionDelivery: deliver ? "pending" : "delivered",
          ...(summary ? { summary } : {}),
          ...(error ? { error } : {}),
        },
      };
    }));
    if (!finished) return;
    // Request release before publishing the terminal snapshot. A caller that
    // reacts to that snapshot may immediately reopen the durable session;
    // publishing first would let this cleanup race with the new runtime.
    this.sessions.release(sessionId);
    this.#replaceCache(records);
    const child = records.find((record) => record.id === sessionId);
    // Its slot frees now, not after the delivery below.
    if (child?.subagent && this.#running.delete(child.subagent.taskId)) this.#pump();
    // Shutdown deliberately settles in-memory controls. The next gateway marks
    // unfinished records interrupted; do not wake a parent while this one is
    // tearing its runtimes down.
    if (this.#disposed) return;
    if (!child?.parentId) return;
    recordDiagnosticEvent({
      area: "session",
      level: status === "completed" ? "info" : "warning",
      action: "subagent_finish",
      summary: `Subagent ${status}: ${child.title}`,
      sessionId: child.parentId,
    });
    await this.flushCompletions();
  }

  #scheduleDelivery(): void {
    if (this.#disposed || this.#deliveryTimer) return;
    this.#deliveryTimer = setTimeout(() => {
      this.#deliveryTimer = undefined;
      void this.flushCompletions();
    }, DELIVERY_RETRY_MS);
    this.#deliveryTimer.unref();
  }

  /** Retry the durable outbox. Single-flight per parent; no competing turns. */
  async flushCompletions(): Promise<void> {
    if (this.#disposed) return;
    let pending = false;
    try {
      const records = await this.registryReader();
      const parents = new Set(records.filter((record) =>
        record.parentId && record.subagent?.completionDelivery === "pending" &&
        !ACTIVE_STATUSES.has(record.subagent.status)).map((record) => record.parentId!));
      pending = parents.size > 0;
      await Promise.all([...parents].map((parentId) => {
        const running = this.#deliveryFlights.get(parentId);
        if (running) return running;
        const flight = this.#deliverParent(parentId).catch((error: unknown) => {
          recordDiagnosticEvent({ area: "session", level: "warning", action: "subagent_delivery_retry",
            summary: error instanceof Error ? error.message : "Subagent delivery failed; retained for retry.",
            sessionId: parentId });
        }).finally(() => this.#deliveryFlights.delete(parentId));
        this.#deliveryFlights.set(parentId, flight);
        return flight;
      }));
    } catch (error) {
      pending = true;
      recordDiagnosticEvent({ area: "session", level: "warning", action: "subagent_delivery_retry",
        summary: error instanceof Error ? error.message : "Could not read completion outbox." });
    } finally {
      if (pending) this.#scheduleDelivery();
    }
  }

  async #deliverParent(parentId: string): Promise<void> {
    const records = await this.registryReader();
    const candidates = records.filter((record) => record.parentId === parentId &&
      record.subagent?.completionDelivery === "pending" && !ACTIVE_STATUSES.has(record.subagent.status));
    const parent = records.find((record) => record.id === parentId);
    if (!parent || !candidates.length || this.#disposed) return;
    if (!this.sessions.ensure(parent)) throw new Error("Parent runtime is unavailable; completion retained.");
    await this.#waitUntilReady(parentId);
    if (this.#disposed) return;

    // Admission to a volatile runtime queue is not delivery. Only acknowledge
    // IDs observed in the hydrated transcript; this also handles a crash after
    // PI wrote the event but before HUI saved the acknowledgement.
    const observed = new Set<string>();
    for (const entry of this.sessions.transcript(parentId)) {
      if (entry.kind !== "message" || entry.role !== "user" ||
          !entry.text.startsWith(`${SUBAGENT_COMPLETION_MARKER}\ndelivery_ids: `)) continue;
      try {
        const ids: unknown = JSON.parse(entry.text.split("\n")[1]!.slice("delivery_ids: ".length));
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") observed.add(id);
      } catch { /* Unrecognized transcript content cannot acknowledge a task. */ }
    }
    const confirmed = candidates.filter((record) => observed.has(record.subagent!.taskId));
    if (confirmed.length) {
      const ids = new Set(confirmed.map((record) => record.subagent!.taskId));
      const updated = await this.registryUpdater((current) => current.map((record) =>
        record.parentId === parentId && record.subagent?.completionDelivery === "pending" && ids.has(record.subagent.taskId)
          ? { ...record, subagent: { ...record.subagent, completionDelivery: "delivered" as const } } : record));
      for (const id of ids) this.#admitted.delete(id);
      this.#replaceCache(updated);
    }
    // Completions are batched until the parent's ordinary children have all finished; a Swarm does not hold them.
    if (records.some((record) => record.parentId === parentId && record.subagent && !record.subagent.collect &&
      ACTIVE_STATUSES.has(record.subagent.status))) return;
    const queue = this.sessions.snapshot(parentId).queue;
    const busy = ["running", "waiting"].includes(this.sessions.status(parentId));
    const remaining = candidates.filter((record) => {
      const id = record.subagent!.taskId;
      if (observed.has(id)) return false;
      // A busy parent may still collect it with `agents_wait`; once idle, an uncollected result is delivered. Until
      // then the retry timer polls every five seconds, as for any pending delivery.
      if (record.subagent!.collect && busy) return false;
      const admitted = this.#admitted.get(id);
      // A busy turn may already have consumed steering while the transcript
      // projection is waiting for settlement. Never inject it twice mid-turn.
      if (admitted && (busy || queue.steering.includes(admitted) || queue.followUp.includes(admitted))) return false;
      return true;
    });
    if (!remaining.length || this.#disposed) return;
    const items: SubagentCompletionItem[] = remaining.map((record) => ({
      sessionId: record.id, title: record.title, task: record.subagent!.task,
      status: record.subagent!.status, startedAt: record.subagent!.startedAt,
      ...(record.subagent!.endedAt ? { endedAt: record.subagent!.endedAt } : {}),
      result: record.subagent!.summary || record.subagent!.error || `Subagent ended with status ${record.subagent!.status}.`,
    }));
    const ids = remaining.map((record) => record.subagent!.taskId);
    const message = formatSubagentCompletionEvent(items).replace(SUBAGENT_COMPLETION_MARKER,
      `${SUBAGENT_COMPLETION_MARKER}\ndelivery_ids: ${JSON.stringify(ids)}`);
    if (busy) {
      try {
        await this.sessions.steer(parentId, message);
      } catch {
        if (this.#disposed) return;
        if (this.sessions.status(parentId) === "idle") await this.sessions.prompt(parentId, message);
        else await this.sessions.followUp(parentId, message);
      }
    } else {
      await this.sessions.prompt(parentId, message);
    }
    for (const id of ids) this.#admitted.set(id, message);
  }

  async #list(callerId: string, params: Record<string, unknown>) {
    const limit = integer(params, "limit", 50, 1, 100);
    const records = await this.registryReader();
    const visible = visibleTree(records, callerId)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    return {
      count: visible.length,
      sessions: visible.map((record) => ({
        sessionKey: record.id,
        title: record.title,
        parentSessionKey: record.parentId ?? null,
        runtimeStatus: this.sessions.status(record.id),
        subagentStatus: this.#status(record),
        updatedAt: record.updatedAt,
      })),
    };
  }

  async #history(callerId: string, params: Record<string, unknown>) {
    const sessionKey = text(params, "sessionKey", 200)!;
    const limit = integer(params, "limit", 20, 1, 100);
    const includeTools = params["includeTools"] === true;
    const target = await this.#authorizedTarget(callerId, sessionKey);
    if (!this.sessions.ensure(target)) throw new AgentToolInputError(`Unknown session: ${sessionKey}`);
    if (this.sessions.status(target.id) === "starting") await this.#waitUntilReady(target.id);
    const transcript = this.sessions.transcript(target.id)
      .filter((entry) => includeTools || entry.kind !== "tool");
    return {
      sessionKey: target.id,
      title: target.title,
      status: this.sessions.status(target.id),
      messages: boundedHistory(transcript, limit),
    };
  }

  async #send(callerId: string, params: Record<string, unknown>) {
    const sessionKey = text(params, "sessionKey", 200)!;
    const message = text(params, "message", 20_000)!;
    const timeoutSeconds = integer(params, "timeoutSeconds", 30, 0, 120);
    if (callerId === sessionKey && timeoutSeconds > 0) {
      throw new AgentToolInputError("A session cannot synchronously wait for a reply from itself.");
    }
    const [caller, target] = await Promise.all([
      this.#authorizedTarget(callerId, callerId),
      this.#authorizedTarget(callerId, sessionKey),
    ]);
    if (!this.sessions.ensure(target)) throw new AgentToolInputError(`Unknown session: ${sessionKey}`);
    if (this.sessions.status(target.id) === "starting") await this.#waitUntilReady(target.id);
    const delivered = `[Inter-session message from ${caller.title} (${caller.id})]\n${message}`;
    const baseline = this.sessions.transcript(target.id).length;
    const reply = timeoutSeconds > 0
      ? this.#waitForReply(target.id, delivered, baseline, timeoutSeconds * 1_000)
      : undefined;
    try {
      const state = this.sessions.status(target.id);
      if (state === "running" || state === "waiting") {
        await this.sessions.followUp(target.id, delivered);
      } else {
        await this.sessions.prompt(target.id, delivered);
      }
    } catch (error) {
      reply?.cancel();
      throw error;
    }
    if (!reply) return { status: "accepted", sessionKey: target.id };
    return { status: "ok", sessionKey: target.id, reply: await reply.promise };
  }

  #waitForReply(
    sessionId: string,
    prompt: string,
    baseline: number,
    timeoutMs: number,
  ): { promise: Promise<string>; cancel: () => void } {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let rejectPromise!: (error: Error) => void;
    const cleanup = () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
        this.#timers.delete(timer);
      }
    };
    const readReply = (): string | undefined => {
      const entries = this.sessions.transcript(sessionId);
      const promptIndex = entries.findIndex((entry, index) =>
        index >= baseline && entry.kind === "message" && entry.role === "user" && entry.text === prompt,
      );
      if (promptIndex < 0) return undefined;
      const answer = entries.slice(promptIndex + 1)
        .findLast((entry) => entry.kind === "message" && entry.role === "assistant");
      return answer?.kind === "message" && answer.text.trim() ? answer.text.trim() : undefined;
    };
    const promise = new Promise<string>((resolve, reject) => {
      rejectPromise = reject;
      const check = () => {
        const answer = readReply();
        if (!answer || settled) return;
        settled = true;
        cleanup();
        resolve(answer);
      };
      const watched = this.sessions.watch(sessionId, (stream) => {
        if (stream.kind === "closed") {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error("The target session exited before replying."));
          }
          return;
        }
        check();
      });
      unsubscribe = watched.unsubscribe;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`No reply within ${Math.round(timeoutMs / 1_000)} seconds.`));
      }, timeoutMs);
      this.#timers.add(timer);
      check();
    });
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectPromise(new Error("Message delivery failed."));
      },
    };
  }

  async #subagents(callerId: string, params: Record<string, unknown>) {
    const action = text(params, "action", 20)!;
    const records = await this.registryReader();
    const visible = visibleTree(records, callerId).filter((record) => record.subagent);
    if (action === "list") {
      return {
        count: visible.length,
        subagents: visible.map((record) => ({
          taskId: record.subagent!.taskId,
          sessionKey: record.id,
          parentSessionKey: record.parentId,
          label: record.title,
          task: record.subagent!.task,
          status: this.#status(record),
          updatedAt: record.subagent!.updatedAt,
        })),
      };
    }
    if (action !== "steer" && action !== "kill") {
      throw new AgentToolInputError("subagents action must be list, steer, or kill.");
    }
    const targetKey = text(params, "target", 200)!;
    const target = visible.find((record) =>
      record.id === targetKey || record.subagent?.taskId === targetKey,
    );
    if (!target?.subagent) throw new AgentToolInputError(`Unknown visible subagent: ${targetKey}`);
    if (!ACTIVE_STATUSES.has(target.subagent.status)) {
      throw new AgentToolInputError(`Subagent ${target.id} is already ${target.subagent.status}.`);
    }
    if (action === "steer") {
      const message = text(params, "message", 20_000)!;
      if (this.sessions.status(target.id) !== "running") {
        throw new AgentToolInputError("The subagent is not running yet.");
      }
      await this.sessions.steer(target.id, `[Parent steering]\n${message}`);
      return { status: "steered", sessionKey: target.id, taskId: target.subagent.taskId };
    }
    await this.#cancel(target, "Cancelled by another agent.");
    return { status: "cancelled", sessionKey: target.id, taskId: target.subagent.taskId };
  }

  /** The run, settled as cancelled, leaves recording the outcome to this. */
  async #cancel(target: SessionRecord, error: string, deliver = true): Promise<void> {
    const taskId = target.subagent!.taskId;
    this.#queue.delete(taskId);
    this.#controls.get(taskId)?.settle("cancelled");
    if (this.sessions.status(target.id) === "running" || this.sessions.status(target.id) === "waiting") {
      await this.sessions.abort(target.id).catch(() => undefined);
    }
    await this.#finishTask(target.id, "cancelled", "", error, deliver);
  }

  /** The operator stopped the parent: its queued and running collected children stop with it. Nothing of theirs is
   * delivered back, finished results its wait had not returned included, which would start another turn. */
  async cancelCollected(parentId: string): Promise<void> {
    const collected = (record: SessionRecord) => record.parentId === parentId && record.subagent?.collect === true;
    // Before the cancels, whose own delivery pass would otherwise hand a stopped parent these results, and after, for
    // children that finished meanwhile.
    const settle = async () => this.#replaceCache(await this.registryUpdater((current) => current.map((record) =>
      collected(record) && record.subagent!.completionDelivery === "pending"
        ? { ...record, subagent: { ...record.subagent!, completionDelivery: "delivered" as const } } : record)));
    // A delivery already under way read its results before this; let it finish while the parent is still busy.
    await this.#deliveryFlights.get(parentId);
    await settle();
    const active = (await this.registryReader()).filter((record) => collected(record) && ACTIVE_STATUSES.has(record.subagent!.status));
    await Promise.all(active.map((child) => this.#cancel(child, "Stopped with its parent.", false)));
    await settle();
  }

  /** Wait until every listed child of the caller has finished, or the timeout passes. What it returns counts as
   * delivered, so the parent is not told again. */
  async #wait(callerId: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const ids = params["ids"];
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_WAIT_IDS || !ids.every((id) => typeof id === "string" && id.trim())) {
      throw new AgentToolInputError(`ids must list 1-${MAX_WAIT_IDS} task ids.`);
    }
    const wanted = (ids as string[]).map((id) => id.trim());
    const timeoutSeconds = integer(params, "timeoutSeconds", 600, 1, 3_600);
    const pick = (records: readonly SessionRecord[]) => wanted.map((id) => records.find((record) =>
      record.parentId === callerId && record.subagent && (record.subagent.taskId === id || record.id === id)));
    // A deleted child ends the wait too; the call then fails, naming it.
    const finished = (records: readonly SessionRecord[]) => {
      const picked = pick(records);
      return picked.some((record) => !record) || picked.every((record) => !ACTIVE_STATUSES.has(record!.subagent!.status));
    };
    // Listen before the first read, so a child finishing in between still wakes the wait.
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => { wake = resolve; });
    const listener = (records?: readonly SessionRecord[]) => { if (!records || finished(records)) wake(); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    this.#waiters.add(listener);
    try {
      const initial = await this.registryReader();
      const unknown = wanted.filter((_, index) => !pick(initial)[index]);
      if (unknown.length) throw new AgentToolInputError(`Not a subagent of this session: ${unknown.join(", ")}`);
      if (!finished(initial)) {
        await Promise.race([
          woken,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutSeconds * 1_000);
            this.#timers.add(timer);
          }),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error("The wait was cancelled."));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      }
    } finally {
      this.#waiters.delete(listener);
      signal?.removeEventListener("abort", onAbort);
      if (timer) {
        clearTimeout(timer);
        this.#timers.delete(timer);
      }
    }
    const records = pick(await this.registryReader());
    const deleted = wanted.filter((_, index) => !records[index]);
    if (deleted.length) throw new AgentToolInputError(`Subagent deleted while waiting: ${deleted.join(", ")}`);
    const done = records.filter((record) => record && !ACTIVE_STATUSES.has(record.subagent!.status)) as SessionRecord[];
    const returned = new Set(done.map((record) => record.subagent!.taskId));
    if (returned.size) {
      this.#replaceCache(await this.registryUpdater((current) => current.map((record) =>
        record.subagent?.completionDelivery === "pending" && returned.has(record.subagent.taskId)
          ? { ...record, subagent: { ...record.subagent, completionDelivery: "delivered" as const } } : record)));
      for (const id of returned) this.#admitted.delete(id);
    }
    return {
      completed: done.map((record) => ({
        taskId: record.subagent!.taskId,
        sessionKey: record.id,
        label: record.title,
        status: record.subagent!.status,
        ...(record.subagent!.summary ? { result: record.subagent!.summary } : {}),
        ...(record.subagent!.error ? { error: record.subagent!.error } : {}),
      })),
      pending: records.filter((record) => record && ACTIVE_STATUSES.has(record.subagent!.status)).map((record) => record!.subagent!.taskId),
    };
  }

  async #authorizedTarget(callerId: string, targetId: string): Promise<SessionRecord> {
    const records = await this.registryReader();
    const target = visibleTree(records, callerId).find((record) => record.id === targetId);
    if (!target) throw new AgentToolInputError(`Session ${targetId} is outside the current agent tree.`);
    return target;
  }

  #waitUntilReady(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        watched.unsubscribe();
        if (timer) {
          clearTimeout(timer);
          this.#timers.delete(timer);
        }
        if (error) reject(error);
        else resolve();
      };
      const inspect = (status: SessionStatus) => {
        if (status === "idle" || status === "running" || status === "waiting") finish();
        else if (status === "error") finish(new Error("The target runtime could not start."));
        else if (status === "disconnected") finish(new Error("The target runtime's machine is disconnected."));
      };
      const watched = this.sessions.watch(sessionId, (message) => {
        if (message.kind === "status") inspect(message.status);
        else if (message.kind === "snapshot") inspect(message.snapshot.status);
        else if (message.kind === "closed") finish(new Error("The target runtime exited."));
      });
      timer = setTimeout(() => finish(new Error("The target runtime did not start in time.")), READY_TIMEOUT_MS);
      this.#timers.add(timer);
      inspect(watched.snapshot.status);
    });
  }

  async #markRunning(sessionId: string): Promise<boolean> {
    let started = false;
    const now = this.now().toISOString();
    const records = await this.registryUpdater((current) => current.map((record) => {
      if (record.id !== sessionId || record.subagent?.status !== "starting") return record;
      started = true;
      return { ...record, subagent: { ...record.subagent, status: "running" as const, updatedAt: now }, updatedAt: now };
    }));
    this.#replaceCache(records);
    return started;
  }

  #replaceCache(records: readonly SessionRecord[]): void {
    const previousParents = new Set(this.#tasks.keys());
    const next = new Map<string, SubagentTaskView[]>();
    for (const record of records) {
      const view = taskView(record);
      if (!view) continue;
      const children = next.get(view.parentSessionId) ?? [];
      children.push(view);
      next.set(view.parentSessionId, children);
    }
    for (const children of next.values()) {
      children.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    this.#tasks = next;
    for (const waiter of this.#waiters) waiter(records);
    for (const parentId of new Set([...previousParents, ...next.keys()])) {
      this.sessions.notifySnapshot(parentId);
    }
  }
}
