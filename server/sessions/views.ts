/**
 * What the browser sees of a session: the `SessionView` wire shape built from a registry record and its live state,
 * the grouped session list (with the stages pull requests prove persisted), and worktree sessions still pending
 * creation. `createSessionViews(deps)` takes the gateway services a view reads.
 */
import { displayPath } from "../git/working-directories.ts";
import { liveSessions, type SessionStatusUpdate } from "./live-sessions.ts";
import { recordDiagnosticEvent } from "../observability.ts";
import { pullRequestsFromTranscript, type PullRequestStatuses } from "../integrations/pull-requests.ts";
import { runtimeMemoryByPid } from "../runtimes/resources.ts";
import type { TranscriptEntry } from "../runtimes/types.ts";
import { groupSessions, readSessionRegistry, updateRegistry, type SessionRecord } from "./sessions.ts";
import type { WatcherService } from "../agent-tools/watchers.ts";
import { workers } from "../workers.ts";
import type { SessionJiraIssue, SessionStatus, SessionView, WorktreeProgress } from "../api/sessions.ts";
import { progressCardFromTranscript } from "./progress-card.ts";
import { effectiveSessionStage, stageRank } from "./session-stages.ts";

/** Worktree sessions whose checkout is still being created, shown in the
 * sidebar before their record exists. Memory only: a restart forgets them. */
export type PendingSession = { record: SessionRecord; creating?: WorktreeProgress; error?: string; prompt: string };
export type PendingStatusUpdate = Pick<SessionStatusUpdate, "id" | "status">
  & Pick<SessionView, "creating" | "creationError">
  & { title?: string };
export const pendingSessions = new Map<string, PendingSession>();
export const pendingStatusSubscribers = new Set<(update: PendingStatusUpdate) => void>();

export function pendingStatus({ record, creating, error }: PendingSession): PendingStatusUpdate {
  return {
    id: record.id,
    status: error ? "error" : "starting",
    ...(creating ? { creating } : {}),
    ...(error ? { creationError: error } : {}),
  };
}

export function publishPendingStatus(update: PendingStatusUpdate): void {
  for (const subscriber of pendingStatusSubscribers) subscriber(update);
}

/** Pull-request evidence is only visible while a transcript is loaded. Persist
 * each advance it proves so a cold session keeps its column after a restart.
 * Only a changed stage writes; ordinary polling stays read-only. */
let stagePersistence: Promise<unknown> = Promise.resolve();
function persistInferredStages(records: readonly SessionRecord[], views: readonly SessionView[]): void {
  const stored = new Map(records.map((record) => [record.id, record.stage]));
  const inferred = new Map(views
    .filter((view) => view.stageOrigin === "pullRequest" && stored.get(view.id) !== view.stage)
    .map((view) => [view.id, view.stage]));
  if (!inferred.size) return;
  stagePersistence = stagePersistence.then(() => updateRegistry((current) => current.map((record) => {
    const stage = inferred.get(record.id);
    if (!stage || record.stageSource === "operator" || record.stage === stage) return record;
    return stageRank(stage) > stageRank(effectiveSessionStage(record).stage)
      ? { ...record, stage, stageSource: "pullRequest" }
      : record;
  }))).catch((error: unknown) => {
    recordDiagnosticEvent({
      area: "session",
      level: "error",
      action: "session_stage_persist_failed",
      summary: error instanceof Error ? error.message : "Could not persist an inferred session stage.",
    });
  });
}

/** Flags sessions whose own turn may be idle while work they started goes on:
 * a running watcher, or a running subagent anywhere below them. */
export function markBackgroundWork(views: SessionView[], watching: (id: string) => boolean): void {
  const byId = new Map(views.map((view) => [view.id, view]));
  for (const view of views) {
    if (watching(view.id)) view.background = true;
    if (view.status !== "running" && !watching(view.id)) continue;
    // `seen` stops a corrupt parent cycle from looping forever.
    const seen = new Set([view.id]);
    for (let parent = byId.get(view.parentId ?? ""); parent && !seen.has(parent.id); parent = byId.get(parent.parentId ?? "")) {
      seen.add(parent.id);
      parent.background = true;
    }
  }
}

export type SessionViewDeps = {
  bots: () => { identity(botId: string): SessionView["bot"] };
  botRegistry: { list(): Promise<unknown> };
  pullRequestStatuses: () => Pick<PullRequestStatuses, "view">;
  jiraIssues: (record: SessionRecord, transcript: readonly TranscriptEntry[]) => SessionJiraIssue[];
  watchers: () => Pick<WatcherService, "list">;
};

export function createSessionViews(deps: SessionViewDeps) {
  function toView(
    record: SessionRecord,
    status: SessionStatus,
    runtime?: SessionView["runtime"],
  ): SessionView {
    const transcript = liveSessions.transcript(record.id);
    const pullRequests = pullRequestsFromTranscript(transcript).map((ref) => deps.pullRequestStatuses().view(ref));
    const jiraIssues = deps.jiraIssues(record, transcript);
    const bot = record.bot ? deps.bots().identity(record.bot) : undefined;
    return {
      id: record.id,
      progress: progressCardFromTranscript(transcript),
      ...(pullRequests.length ? { pullRequests } : {}),
      ...(jiraIssues.length ? { jiraIssues } : {}),
      title: record.title,
      group: record.group,
      cwd: record.cwd,
      displayCwd: record.worker ? `${workers.nameOf(record.worker) ?? "Remote"}:${record.cwd}` : record.cwd ? displayPath(record.cwd) : "",
      ...(record.worker ? { worker: { id: record.worker, name: workers.nameOf(record.worker) ?? "Remote worker" } } : {}),
      tool: record.tool,
      status,
      ...(runtime ? { runtime } : {}),
      ...(record.runStartedAt && status !== "running" && status !== "waiting"
        ? { interrupted: true as const }
        : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinking ? { thinking: record.thinking } : {}),
      ...(record.pinned ? { pinned: true } : {}),
      ...(record.archived ? { archived: true } : {}),
      ...(record.unread ? { unread: true } : {}),
      ...(record.icon ? { icon: record.icon } : {}),
      ...(record.parentId ? { parentId: record.parentId } : {}),
      ...(record.subagent ? { subagent: record.subagent } : {}),
      ...(bot ? { bot } : {}),
      ...effectiveSessionStage(record, pullRequests),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function pendingView(entry: PendingSession): SessionView {
    const { id: _id, status, ...creation } = pendingStatus(entry);
    return {
      ...toView(entry.record, status),
      ...creation,
      // A failed launch hands its prompt back so dismissing it loses nothing.
      ...(entry.error && entry.prompt ? { initialPrompt: entry.prompt } : {}),
    };
  }

  /** The stored record has no idea whether a runtime is booting, so the live
   * status is layered on at read time. */
  async function listSessionViews(): Promise<{ label: string; sessions: SessionView[] }[]> {
    // Taken before the registry read: a record is persisted before its pending
    // entry is dropped, so every list contains a finishing session once.
    const pendingSnapshot = [...pendingSessions.values()];
    // Refreshes the bot names session views show; a broken bots.json leaves them plain sessions.
    await deps.botRegistry.list().catch(() => undefined);
    const registry = await readSessionRegistry();
    const runtimes = liveSessions.runtimeTelemetry();
    const memoryByPid = await runtimeMemoryByPid([...runtimes.values()].flatMap(({ pid }) => pid ? [pid] : []));
    const runtimeViews = new Map([...runtimes].map(([id, runtime]) => [id, {
      active: true as const,
      ...(runtime.pid && memoryByPid.has(runtime.pid) ? { memoryBytes: memoryByPid.get(runtime.pid)! } : {}),
      ...(runtime.bootDurationMs !== undefined ? { bootDurationMs: runtime.bootDurationMs } : {}),
    }]));
    const registered = new Set(registry.sessions.map(({ id }) => id));
    const pending = new Map(pendingSnapshot.filter(({ record }) => !registered.has(record.id)).map((entry) => [entry.record.id, entry]));
    const views = groupSessions([...registry.sessions, ...[...pending.values()].map(({ record }) => record)], registry.groups).map((group) => ({
      label: group.label,
      ...(group.cwd ? { cwd: group.cwd } : {}),
      ...(group.workspaceMode ? { workspaceMode: group.workspaceMode } : {}),
      ...(group.baseRef ? { baseRef: group.baseRef } : {}),
      sessions: group.sessions.map((record) => {
        const entry = pending.get(record.id);
        return entry ? pendingView(entry) : toView(record, liveSessions.status(record.id), runtimeViews.get(record.id));
      }),
    }));
    const all = views.flatMap((group) => group.sessions);
    markBackgroundWork(all, (id) => deps.watchers().list(id).some((watcher) => watcher.state === "running"));
    persistInferredStages(registry.sessions, all);
    return views;
  }

  return { toView, pendingView, listSessionViews };
}
