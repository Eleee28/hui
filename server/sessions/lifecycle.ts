/**
 * A session's lifecycle: creating one (optionally in a new worktree, named by the utility model), forking it, waiting
 * for its runtime, changing its record and deleting it with its subtree. `createSessionLifecycle(deps)` takes the
 * gateway services a deletion and a worktree launch reach.
 */
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";

import type { ManagedBrowser } from "../browser/manager.ts";
import { readHuiSettings } from "../hui-settings.ts";
import { liveSessions, type DeleteToken } from "./live-sessions.ts";
import { fallbackTitle, generateSessionNames } from "../pi/model-routing.ts";
import { recordDiagnosticEvent } from "../observability.ts";
import type { PromptAttachment } from "../runtimes/types.ts";
import { SessionNotFoundError, updateRegistry, upsert, type SessionRecord } from "./sessions.ts";
import type { SubagentService } from "../agent-tools/subagents.ts";
import type { TaskSuggestionStore } from "../agent-tools/task-suggestions.ts";
import { terminals } from "../terminals/terminals.ts";
import type { WatcherService } from "../agent-tools/watchers.ts";
import { workers } from "../workers.ts";
import { resolveWorkingDirectory } from "../git/working-directories.ts";
import { checkoutSessionRef, createSessionWorktree } from "../git/worktrees.ts";
import { fallbackBranchName } from "../git/branch-names.ts";
import type { SessionStage } from "../api/sessions.ts";
import { isSessionStage, SESSION_STAGES } from "./session-stages.ts";
import { isThinkingLevel } from "./thinking.ts";
import { sessionTreeIds } from "./session-tree.ts";
import { knownPullRequestUrls } from "./stages.ts";
import { pendingSessions, pendingStatus, publishPendingStatus, type createSessionViews, type PendingSession, type PendingStatusUpdate } from "./views.ts";
import type { SessionStatus, SessionView, WorktreeProgress } from "../api/sessions.ts";

const NEW_SESSION_TOOLS = new Set(["durable", "pi"]);
/** New sessions run on Pi Durable; `HUI_SESSION_RUNTIME=pi` keeps PI's SDK
 * worker as an explicit fallback. Existing sessions keep the runtime they have. */
export function defaultSessionTool(): string {
  return process.env["HUI_SESSION_RUNTIME"] === "pi" ? "pi" : "durable";
}
export const SESSION_TITLE_MAX = 200;
export const SESSION_GROUP_MAX = 200;
/** A started suggestion's runtime must boot before its prompt is accepted. */
const SUGGESTION_READY_TIMEOUT_MS = 30_000;

const SESSION_TEXT_LABELS = {
  title: ["Session name", "A session name"],
  group: ["Session group", "A session group"],
  branchName: ["Branch name", "A branch name"],
  baseRef: ["Base branch or commit", "A base branch or commit"],
  model: ["Session model", "A session model"],
  thinking: ["Thinking level", "A thinking level"],
  initialPrompt: ["Initial prompt", "An initial prompt"],
} as const;

export function sessionText(
  body: Record<string, unknown>,
  key: keyof typeof SESSION_TEXT_LABELS,
  maximum: number,
  options: { optional: boolean; allowEmpty: boolean },
): string | undefined {
  if (!(key in body)) {
    return options.optional ? undefined : "";
  }
  const [label, aLabel] = SESSION_TEXT_LABELS[key];
  if (typeof body[key] !== "string") {
    throw new Error(`${label} must be text.`);
  }
  const value = body[key].trim();
  if (!options.allowEmpty && !value) {
    throw new Error(`${aLabel} must be 1-${maximum} characters.`);
  }
  if (value.length > maximum) {
    throw new Error(`${aLabel} must be ${options.allowEmpty ? `at most ${maximum}` : `1-${maximum}`} characters.`);
  }
  return value;
}

/** Registers a session and starts it. The directory is checked before anything
 * is written: a bad cwd would otherwise fail minutes later, inside pi. */
async function createSession(
  body: Record<string, unknown>,
  sessions: Pick<typeof liveSessions, "accept" | "ensure"> = liveSessions,
  registryUpdater: typeof updateRegistry = updateRegistry,
  onWorktreeProgress?: (progress: WorktreeProgress) => void,
  /** Server-decided fields, never taken from a browser body: an operator
   * stage placement (a started backlog item). `onPending` receives the
   * provisional record once the body is valid, again once it is named.
   * `nameSession` replaces the utility-model call in tests. */
  seed: {
    stage?: SessionStage;
    onPending?: (record: SessionRecord) => void;
    nameSession?: typeof generateSessionNames;
    /** A bot's chat: its bot, and the Durable conversation already created for it (bot-service.ts). */
    bot?: { id: string; piSessionFile: string };
    /** A fork: the resume reference of the conversation copy it continues (`liveSessions.fork`). */
    piSessionFile?: string;
  } = {},
): Promise<SessionRecord> {
  if (typeof body["cwd"] !== "string") throw new Error("Working directory must be text.");
  if (body["worker"] !== undefined && (typeof body["worker"] !== "string" || !body["worker"].trim())) {
    throw new Error("Worker must be a worker id.");
  }
  const worker = typeof body["worker"] === "string" ? body["worker"].trim() : undefined;
  let cwd: string;
  if (worker) {
    // The remote checks the directory when the session starts, so creating
    // one never waits on a first connection or installation.
    await workers.get(worker);
    cwd = body["cwd"].trim();
    if (!cwd.startsWith("/") && cwd !== "~" && !cwd.startsWith("~/")) throw new Error("A remote directory must be absolute or start with ~/.");
    if (body["worktree"] === true || body["baseRef"] !== undefined) throw new Error("Worktrees and branch checkouts are not available on remote workers yet.");
  } else {
    cwd = resolveWorkingDirectory(body["cwd"]);
    let info;
    try {
      info = await stat(cwd);
    } catch {
      throw new Error(`No such directory: ${cwd}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Not a directory: ${cwd}`);
    }
  }

  const title = sessionText(body, "title", SESSION_TITLE_MAX, {
    optional: true,
    allowEmpty: false,
  });
  const initialPrompt = sessionText(body, "initialPrompt", 4_000, {
    optional: true,
    allowEmpty: false,
  });
  const group =
    sessionText(body, "group", SESSION_GROUP_MAX, { optional: true, allowEmpty: true }) ?? "";
  if (body["worktree"] !== undefined && typeof body["worktree"] !== "boolean") {
    throw new Error("Create in workspace must be true or false.");
  }
  const requestedWorktree = body["worktree"] === true;
  const branchName = sessionText(body, "branchName", SESSION_TITLE_MAX, {
    optional: true,
    allowEmpty: false,
  });
  const baseRef = sessionText(body, "baseRef", SESSION_TITLE_MAX, {
    optional: true,
    allowEmpty: false,
  });
  if (branchName && !requestedWorktree) {
    throw new Error("A branch name requires Create workspace.");
  }
  // Which runtime drives it. An unknown name is rejected rather than silently
  // started on the default runtime.
  const tool = typeof body["tool"] === "string" ? body["tool"].trim() : "";
  if (tool && !NEW_SESSION_TOOLS.has(tool)) {
    throw new Error(`Unsupported session tool: ${tool}`);
  }
  const requestedModel = sessionText(body, "model", SESSION_TITLE_MAX, {
    optional: true,
    allowEmpty: false,
  });
  // Only the first slash separates the provider; gateway model IDs may
  // themselves be namespaced, e.g. vercel-ai-gateway/anthropic/claude-opus.
  if (requestedModel && !/^[^/\s]+\/\S+$/.test(requestedModel)) {
    throw new Error("Session model must use provider/id format.");
  }
  const thinking = sessionText(body, "thinking", 16, {
    optional: true,
    allowEmpty: false,
  });
  if (thinking && !isThinkingLevel(thinking)) {
    throw new Error(`Unsupported thinking level: ${thinking}`);
  }
  if (body["fast"] !== undefined && typeof body["fast"] !== "boolean") {
    throw new Error("Fast mode must be true or false.");
  }
  const fast = body["fast"] === true;
  // A worker runs the same runtime a local session would.
  const runtimeTool = tool || defaultSessionTool();
  const settings = await readHuiSettings();
  // Sessions started without a choice (suggestions, backlog items) use the
  // primary route rather than whatever PI currently treats as its default.
  const model = requestedModel || settings.models.primary;
  const id = randomUUID();
  const now = new Date().toISOString();
  const recordNamed = (named: string): SessionRecord => ({
    id,
    title: named,
    group,
    cwd,
    ...(worker ? { worker } : {}),
    tool: runtimeTool,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(fast ? { fast } : {}),
    ...(seed.stage ? { stage: seed.stage, stageSource: "operator" as const } : {}),
    ...(seed.bot ? { bot: seed.bot.id, piSessionFile: seed.bot.piSessionFile } : {}),
    ...(seed.piSessionFile ? { piSessionFile: seed.piSessionFile } : {}),
    createdAt: now,
    updatedAt: now,
    source: "hui",
  });
  // Without an operator branch name, a new worktree gets a short generated
  // one, asked for in the same utility call that names the session.
  if (initialPrompt && requestedWorktree && !branchName) onWorktreeProgress?.({ phase: "naming" });
  const provisionalTitle = title ?? (initialPrompt ? fallbackTitle(initialPrompt) : basename(cwd));
  seed.onPending?.(recordNamed(provisionalTitle));
  const nameSession = seed.nameSession ?? generateSessionNames;
  // A worktree needs its branch name before Git starts, and its request has
  // already returned. A plain session is registered under the provisional
  // title at once and renamed when the utility model answers, so the request
  // never waits on a model call.
  const namesLater = Boolean(initialPrompt && !title && !requestedWorktree);
  // Utility calls are tool-free and run on this machine.
  const namingCwd = worker ? homedir() : cwd;
  const names = initialPrompt && !namesLater
    ? await nameSession({
        cwd: namingCwd,
        prompt: initialPrompt,
        settings,
        ...(title ? { title } : {}),
        branch: requestedWorktree && !branchName,
      })
    : undefined;
  const effectiveTitle = title ?? names?.title ?? provisionalTitle;
  if (names) seed.onPending?.(recordNamed(effectiveTitle));
  const effectiveBranchName = branchName
    ?? names?.branchName
    ?? (requestedWorktree ? fallbackBranchName(effectiveTitle) : undefined);
  const createdWorktree = requestedWorktree
    ? await createSessionWorktree({
        sourceDirectory: cwd,
        title: effectiveTitle,
        ...(effectiveBranchName ? { branchName: effectiveBranchName } : {}),
        baseRef,
        branchPrefix: settings.branchPrefix,
        onProgress: onWorktreeProgress,
      })
    : undefined;
  if (createdWorktree) cwd = createdWorktree.cwd;
  if (!createdWorktree && baseRef) await checkoutSessionRef(cwd, baseRef);
  const record = recordNamed(effectiveTitle);
  // Persisted before the runtime starts, so a second connection can find it
  // while pi is still booting.
  try {
    await registryUpdater((records) => upsert(records, [record]));
  } catch (error) {
    if (createdWorktree) {
      try {
        await createdWorktree.rollback();
      } catch (rollbackError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)} Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    throw error;
  }
  sessions.accept(record.id);
  sessions.ensure(record);
  if (namesLater && initialPrompt) {
    void renameWithGeneratedTitle(record, () => nameSession({ cwd: namingCwd, prompt: initialPrompt, settings }), registryUpdater);
  }
  return record;
}

const FORK_SUFFIX = " (fork)";
const forkTitle = (title: string) => `${title.slice(0, SESSION_TITLE_MAX - FORK_SUFFIX.length)}${FORK_SUFFIX}`;

export type ForkRequest = { entryId?: string; worktree?: boolean; branchName?: string };

/** Validates a fork route body; unknown fields are ignored like every other session route. */
function forkRequest(body: Record<string, unknown>): ForkRequest {
  if (body["entryId"] !== undefined && (typeof body["entryId"] !== "string" || !body["entryId"].trim())) {
    throw new Error("A fork point must be a history entry id.");
  }
  if (body["worktree"] !== undefined && typeof body["worktree"] !== "boolean") throw new Error("Worktree must be true or false.");
  const branchName = sessionText(body, "branchName", SESSION_TITLE_MAX, { optional: true, allowEmpty: false });
  if (branchName && body["worktree"] !== true) throw new Error("A branch name requires a new worktree.");
  return {
    ...(typeof body["entryId"] === "string" ? { entryId: body["entryId"].trim() } : {}),
    ...(body["worktree"] === true ? { worktree: true } : {}),
    ...(branchName ? { branchName } : {}),
  };
}

/**
 * A fork from a session, start to finish: the optional worktree first (from the source checkout's HEAD, on a new
 * branch, as New Session makes one), then the conversation copy moved into it, then the record. A failure after the
 * worktree exists removes it again. Uncommitted changes in the source checkout stay there.
 */
async function forkFromSession(
  source: SessionRecord,
  request: ForkRequest,
  fork: (entryId: string | undefined, options?: { cwd: string }) => Promise<string>,
  sessions: Pick<typeof liveSessions, "accept" | "ensure"> = liveSessions,
  registryUpdater: typeof updateRegistry = updateRegistry,
  worktreesRoot?: string,
): Promise<SessionRecord> {
  if (!request.worktree) return forkSession(source, await fork(request.entryId), sessions, registryUpdater);
  if (source.worker) throw new Error("Worktrees are not available on remote workers yet.");
  const settings = await readHuiSettings();
  const worktree = await createSessionWorktree({
    sourceDirectory: source.cwd,
    title: forkTitle(source.title),
    branchName: request.branchName ?? `${fallbackBranchName(source.title)}-fork`,
    branchPrefix: settings.branchPrefix,
    ...(worktreesRoot ? { root: worktreesRoot } : {}),
  });
  try {
    const reference = await fork(request.entryId, { cwd: worktree.cwd });
    return await forkSession(source, reference, sessions, registryUpdater, worktree.cwd);
  } catch (error) {
    try {
      await worktree.rollback();
    } catch (rollbackError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
}

/**
 * Registers a fork's conversation copy as a session of its own. It takes what runs the work from the source (its
 * directory, worker, group, runtime, model and reasoning) and none of the operator's marks: it starts unpinned, read,
 * without an icon, Jira links or a Kanban stage. Pull request marks come from the transcript, so pull requests the
 * source opened before the fork point show on the copy too. It shares the source's checkout; nothing in Git changes.
 */
async function forkSession(
  source: SessionRecord,
  piSessionFile: string,
  sessions: Pick<typeof liveSessions, "accept" | "ensure"> = liveSessions,
  registryUpdater: typeof updateRegistry = updateRegistry,
  /** A worktree made for the fork: the session works there instead of in the source's directory. */
  cwd: string = source.cwd,
): Promise<SessionRecord> {
  return createSession({
    cwd,
    ...(source.worker ? { worker: source.worker } : {}),
    group: source.group,
    title: forkTitle(source.title),
    tool: source.tool,
    ...(source.model ? { model: source.model } : {}),
    ...(source.thinking ? { thinking: source.thinking } : {}),
    ...(source.fast ? { fast: true } : {}),
  }, sessions, registryUpdater, undefined, { piSessionFile });
}

/**
 * Replaces a session's provisional title with the utility model's name. An
 * operator rename or a delete in the meantime wins: only a record still
 * carrying the provisional title changes. Open browsers learn the new title
 * from the session status stream.
 */
async function renameWithGeneratedTitle(
  record: SessionRecord,
  generate: () => Promise<{ title: string }>,
  registryUpdater: typeof updateRegistry = updateRegistry,
  publish: (update: PendingStatusUpdate) => void = publishPendingStatus,
  status: (id: string) => SessionStatus = (id) => liveSessions.status(id),
): Promise<SessionRecord | undefined> {
  try {
    const { title } = await generate();
    if (!title || title === record.title) return undefined;
    let renamed: SessionRecord | undefined;
    await registryUpdater((records) => records.map((current) => {
      if (current.id !== record.id || current.title !== record.title) return current;
      renamed = { ...current, title };
      return renamed;
    }));
    if (renamed) publish({ id: record.id, status: status(record.id), title });
    return renamed;
  } catch (error) {
    recordDiagnosticEvent({
      area: "session",
      level: "warning",
      action: "session_title_failed",
      sessionId: record.id,
      summary: error instanceof Error ? error.message : "Could not store the generated session title.",
    });
    return undefined;
  }
}

/** Resolves once a freshly created session can accept its first prompt. A
 * session HUI is disconnected from fails at once, so its prompt is never sent
 * later, behind the caller's back. */
function waitForSessionReady(
  id: string,
  timeoutMs = SUGGESTION_READY_TIMEOUT_MS,
  sessions: Pick<typeof liveSessions, "watch"> = liveSessions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watched.unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const inspect = (status: SessionStatus) => {
      if (status === "idle") finish();
      else if (status === "error") finish(new Error("The new session runtime could not start."));
      else if (status === "disconnected") finish(new Error("HUI is disconnected from the machine the new session runs on. Reconnect it and try again."));
    };
    const timer = setTimeout(() => finish(new Error("The new session did not start in time.")), timeoutMs);
    timer.unref();
    const watched = sessions.watch(id, (message) => {
      if (message.kind === "status") inspect(message.status);
      else if (message.kind === "snapshot") inspect(message.snapshot.status);
      else if (message.kind === "closed") finish(new Error("The new session runtime exited."));
    });
    inspect(watched.snapshot.status);
  });
}

async function updateSession(
  id: string,
  body: Record<string, unknown>,
  registryUpdater: typeof updateRegistry = updateRegistry,
): Promise<SessionRecord> {
  const patch: Partial<SessionRecord> = {};
  const title = sessionText(body, "title", SESSION_TITLE_MAX, {
    optional: true,
    allowEmpty: false,
  });
  if (title !== undefined) patch.title = title;
  const group = sessionText(body, "group", SESSION_GROUP_MAX, {
    optional: true,
    allowEmpty: true,
  });
  if (group !== undefined) patch.group = group;
  if ("pinned" in body) {
    if (typeof body["pinned"] !== "boolean") {
      throw new Error("Pinned must be a boolean.");
    }
    patch.pinned = body["pinned"];
  }
  for (const key of ["archived", "unread"] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== "boolean") {
      throw new Error(`${key === "archived" ? "Archived" : "Unread"} must be a boolean.`);
    }
    patch[key] = body[key];
  }
  if ("icon" in body) {
    if (typeof body["icon"] !== "string") throw new Error("Session icon must be text.");
    const icon = body["icon"].trim();
    if (icon.length > 32) throw new Error("Session icon must be at most 32 characters.");
    patch.icon = icon || undefined;
  }
  if ("stage" in body) {
    // An operator placement; `null` hands the column back to the agent and
    // pull-request signals, starting again from Investigation. Backlog holds
    // backlog items, never sessions.
    if (body["stage"] === null) {
      patch.stage = undefined;
      patch.stageSource = undefined;
      patch.stagePullRequests = undefined;
    } else if (body["stage"] === "backlog") {
      throw new Error("Sessions cannot be moved to Backlog; it holds backlog items only.");
    } else if (isSessionStage(body["stage"])) {
      patch.stage = body["stage"];
      patch.stageSource = "operator";
      const known = knownPullRequestUrls(id);
      patch.stagePullRequests = known.length ? known : undefined;
    } else {
      throw new Error(`Session stage must be null or one of: ${SESSION_STAGES.join(", ")}.`);
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new Error("Nothing to change.");
  }

  let updated: SessionRecord | undefined;
  await registryUpdater((records) => {
    if (!records.some((record) => record.id === id)) {
      throw new SessionNotFoundError(`unknown session: ${id}`);
    }
    const tree = patch.archived === undefined ? new Set([id]) : sessionTreeIds(records, id);
    return records.map((record) => {
      if (record.id !== id) {
        return tree.has(record.id) ? { ...record, archived: patch.archived } : record;
      }
      updated = { ...record, ...patch };
      return updated;
    });
  });
  if (!updated) throw new SessionNotFoundError(`unknown session: ${id}`);
  return updated;
}

export type SessionLifecycleDeps = {
  views: Pick<ReturnType<typeof createSessionViews>, "pendingView">;
  readAttachments: (sessionId: string, raw: unknown) => Promise<{ attachments: PromptAttachment[]; cleanupRejected(): Promise<void> }>;
  subagents: () => Pick<SubagentService, "forgetSessions">;
  taskSuggestions: () => Pick<TaskSuggestionStore, "forget">;
  watchers: () => Pick<WatcherService, "forget">;
  managedBrowser: () => Pick<ManagedBrowser, "closeOwner">;
};

export function createSessionLifecycle(deps: SessionLifecycleDeps) {
  /**
   * Returns as soon as a worktree session's input is valid, so the browser can
   * show it and start others while Git works. The gateway sends the first prompt
   * once the runtime is ready: nothing depends on the launching page staying open.
   */
  async function startWorktreeSession(
    body: Record<string, unknown>,
    sessions: Pick<typeof liveSessions, "accept" | "ensure" | "status" | "watch" | "prompt"> = liveSessions,
    registryUpdater: typeof updateRegistry = updateRegistry,
  ): Promise<SessionView> {
    const prompt = typeof body["initialPrompt"] === "string" ? body["initialPrompt"].trim() : "";
    let entry: PendingSession | undefined;
    let creating: WorktreeProgress = { phase: "preparing" };
    let accept!: (view: SessionView) => void;
    const accepted = new Promise<SessionView>((resolve) => { accept = resolve; });
    const created = createSession(body, sessions, registryUpdater, (progress) => {
      creating = progress;
      if (!entry) return;
      entry.creating = progress;
      publishPendingStatus(pendingStatus(entry));
    }, {
      onPending: (record) => {
        entry = { record, creating, prompt };
        pendingSessions.set(record.id, entry);
        publishPendingStatus(pendingStatus(entry));
        accept(deps.views.pendingView(entry));
      },
    });
    void created.then(async (record) => {
      pendingSessions.delete(record.id);
      publishPendingStatus({ id: record.id, status: sessions.status(record.id) });
      if (!prompt) return;
      // No browser is waiting on this, so allow a slow runtime boot.
      await waitForSessionReady(record.id, 10 * 60_000, sessions);
      const prepared = await deps.readAttachments(record.id, body["initialAttachments"]);
      await sessions.prompt(record.id, prompt, prepared.attachments).catch(async (error: unknown) => {
        await prepared.cleanupRejected();
        throw error;
      });
    }, (error: unknown) => {
      // Invalid input rejects before `onPending` and is answered by the request.
      if (!entry) return;
      entry.creating = undefined;
      entry.error = error instanceof Error ? error.message : "Could not create the Git worktree.";
      publishPendingStatus(pendingStatus(entry));
    }).catch((error: unknown) => {
      // ponytail: the session shows its runtime error, but this prompt is only logged;
      // hand it back like a failed checkout's `initialPrompt` if runtimes fail here in practice.
      recordDiagnosticEvent({
        area: "session",
        level: "error",
        action: "session_initial_prompt_failed",
        summary: error instanceof Error ? error.message : "Could not send the first prompt.",
      });
    });
    // Invalid input rejects before `onPending`; otherwise the pending view wins.
    await Promise.race([accepted, created]);
    return accepted;
  }

  /** Tombstone first to close stale open/events races. If durable removal fails,
   * roll the tombstone back so the still-existing row can be opened again. */
  async function deleteSession(
    id: string,
    sessions: Pick<
      typeof liveSessions,
      "tombstone" | "finishDelete" | "rollbackDelete"
    > = liveSessions,
    registryUpdater: typeof updateRegistry = updateRegistry,
  ): Promise<void> {
    const tokens = new Map<string, DeleteToken>([[id, sessions.tombstone(id)]]);
    const remote: SessionRecord[] = [];
    try {
      await registryUpdater((records) => {
        if (!records.some((record) => record.id === id)) {
          throw new SessionNotFoundError(`unknown session: ${id}`);
        }
        const tree = sessionTreeIds(records, id);
        for (const descendant of tree) {
          if (!tokens.has(descendant)) tokens.set(descendant, sessions.tombstone(descendant));
        }
        remote.push(...records.filter((record) => tree.has(record.id) && record.worker));
        return records.filter((record) => !tree.has(record.id));
      });
    } catch (error) {
      for (const [sessionId, token] of tokens) sessions.rollbackDelete(sessionId, token);
      throw error;
    }
    deps.subagents().forgetSessions(new Set(tokens.keys()));
    deps.taskSuggestions().forget(tokens.keys());
    // A remote process this gateway is not attached to would otherwise linger.
    for (const worker of new Set(remote.map((record) => record.worker!))) {
      void workers.forget(worker, remote.filter((record) => record.worker === worker).map((record) => record.id)).catch(() => undefined);
    }
    for (const [sessionId, token] of tokens) {
      sessions.finishDelete(sessionId, token);
      terminals.closeOwner(sessionId);
      deps.managedBrowser().closeOwner(sessionId);
    }
    // Watcher cleanup must not fail a deletion that already committed.
    try {
      await deps.watchers().forget(tokens.keys());
    } catch (error) {
      recordDiagnosticEvent({
        area: "session",
        level: "error",
        action: "watcher_forget_failed",
        summary: error instanceof Error ? error.message : "Could not remove deleted conversations' watchers.",
      });
    }
  }

  return {
    createSession,
    forkRequest,
    forkFromSession,
    forkSession,
    renameWithGeneratedTitle,
    startWorktreeSession,
    waitForSessionReady,
    deleteSession,
    updateSession,
  };
}
