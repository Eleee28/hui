/**
 * The Kanban backlog.
 *
 * HUI owns one file, `~/.config/hui/backlog.json`: local tasks (typically
 * saved from a `suggest_task` card) and, per Jira key, only HUI metadata (its
 * custom group). Jira facts are never written here; the assigned To Do work
 * items are fetched live and cached in memory for a short time.
 *
 * Writes go through a temporary file and a rename, and every read/modify/write
 * is serialized, like the session registry. A file from a newer HUI (higher
 * `version`) or one that cannot be parsed is never overwritten.
 *
 * `createBacklogLifecycle(deps)` lists the board and starts its items and
 * `suggest_task` cards as sessions, or saves a card as a local task.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import type { BacklogItem, BacklogItemKind, BacklogView } from "./api/backlog.ts";
import type { SessionJiraIssue } from "./api/sessions.ts";
import { isSessionStage, SESSION_STAGES } from "./sessions/session-stages.ts";
import { TaskSuggestionInputError, taskSuggestionPrompt, type TaskSuggestionStartMode, type TaskSuggestionStore } from "./agent-tools/task-suggestions.ts";
import {
  JIRA_KEY,
  JiraClient,
  jiraIssuesFromTranscript,
  jiraIssueUrl,
  mergeJiraRefs,
  parseJiraIssue,
  type JiraConfig,
  type JiraIssueFetcher,
  type JiraIssueRef,
  type JiraIssueStatuses,
} from "./integrations/jira.ts";
import type { liveSessions } from "./sessions/live-sessions.ts";
import { CONFIG_DIR } from "./paths.ts";
import { readRegistry, updateRegistry, type SessionNotFoundError, type SessionRecord } from "./sessions/sessions.ts";
import type { createSessionLifecycle } from "./sessions/lifecycle.ts";
import type { SessionView } from "./api/sessions.ts";
import type { createSessionViews } from "./sessions/views.ts";

export const BACKLOG_LIMITS = {
  title: 200,
  problem: 12_000,
  fix: 8_000,
  cwd: 4_096,
  group: 200,
  tasks: 500,
} as const;

export function backlogItemId(kind: BacklogItemKind, key: string): string {
  return `${kind}:${key}`;
}

export function backlogItemPrompt(item: Pick<BacklogItem, "kind" | "title" | "problem" | "fix" | "jira">): string {
  const link = item.jira ? [`Jira: [${item.jira.key}](${item.jira.url})`] : [];
  if (item.kind === "jira") {
    const summary = item.jira?.summary || item.title;
    return [
      `# ${item.jira ? `${item.jira.key}: ` : ""}${summary}`,
      ...link,
      "## Description",
      item.jira?.description?.trim() || "No description in Jira. Investigate and confirm the scope before changing code.",
    ].join("\n\n");
  }
  return [
    `# ${item.title}`,
    ...link,
    "## Problem", item.problem?.trim() || "Not described.",
    "## Proposed fix",
    item.fix?.trim() || "Not known yet. Investigate and confirm the root cause before changing code.",
  ].join("\n\n");
}

export const BACKLOG_FILE = join(CONFIG_DIR, "backlog.json");
export const BACKLOG_VERSION = 1;
const MAX_JIRA_METADATA = 1_000;

export type BacklogLocalTask = {
  id: string;
  title: string;
  problem: string;
  fix: string;
  cwd?: string;
  group: string;
  createdAt: string;
  /** A Jira work item created for or linked to this task from the board. */
  jira?: JiraIssueRef;
};

export type BacklogState = {
  version: typeof BACKLOG_VERSION;
  tasks: BacklogLocalTask[];
  /** HUI metadata per Jira key; only non-default values are kept. */
  jira: Record<string, { group: string }>;
};

export class BacklogInputError extends Error {
  override name = "BacklogInputError";
}

export class BacklogNotFoundError extends Error {
  override name = "BacklogNotFoundError";
}

/** The file exists but cannot be read safely; it is left untouched. */
export class BacklogStoreError extends Error {
  override name = "BacklogStoreError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function parseRef(value: unknown): JiraIssueRef | undefined {
  if (!isRecord(value)) return undefined;
  const key = str(value["key"], 40);
  const url = str(value["url"], 400);
  return JIRA_KEY.test(key) && /^https?:\/\/[^/\s]+\/browse\//u.test(url) ? { key, url } : undefined;
}

function parseTask(value: unknown): BacklogLocalTask | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value["id"], 100);
  const title = str(value["title"], BACKLOG_LIMITS.title);
  if (!id || !title) return undefined;
  const cwd = str(value["cwd"], BACKLOG_LIMITS.cwd);
  const jira = parseRef(value["jira"]);
  return {
    id,
    title,
    problem: str(value["problem"], BACKLOG_LIMITS.problem),
    fix: str(value["fix"], BACKLOG_LIMITS.fix),
    ...(cwd && isAbsolute(cwd) ? { cwd } : {}),
    group: str(value["group"], BACKLOG_LIMITS.group),
    createdAt: str(value["createdAt"], 40),
    ...(jira ? { jira } : {}),
  };
}

export function emptyBacklog(): BacklogState {
  return { version: BACKLOG_VERSION, tasks: [], jira: {} };
}

/** Throws `BacklogStoreError` for a file HUI must not overwrite. */
export function parseBacklogFile(raw: unknown): BacklogState {
  if (!isRecord(raw)) throw new BacklogStoreError("HUI's backlog file is not a JSON object.");
  const version = raw["version"];
  if (typeof version !== "number" || version > BACKLOG_VERSION) {
    throw new BacklogStoreError(`HUI's backlog file has version ${String(version)}, which this HUI cannot read.`);
  }
  const tasks = Array.isArray(raw["tasks"]) ? raw["tasks"].flatMap((task) => parseTask(task) ?? []) : [];
  const jira: BacklogState["jira"] = {};
  if (isRecord(raw["jira"])) {
    for (const [key, meta] of Object.entries(raw["jira"])) {
      const group = isRecord(meta) ? str(meta["group"], BACKLOG_LIMITS.group) : "";
      if (JIRA_KEY.test(key) && group) jira[key] = { group };
    }
  }
  return { version: BACKLOG_VERSION, tasks: tasks.slice(0, BACKLOG_LIMITS.tasks), jira };
}

function groupValue(value: unknown): string {
  if (typeof value !== "string") throw new BacklogInputError("A group must be text.");
  const group = value.trim();
  if (group.length > BACKLOG_LIMITS.group) throw new BacklogInputError(`A group must be at most ${BACKLOG_LIMITS.group} characters.`);
  return group.toLocaleLowerCase() === "ungrouped" ? "" : group;
}

export type BacklogTaskInput = { title: string; problem: string; fix?: string; cwd?: string; group?: string };

export class BacklogStore {
  readonly path: string;
  readonly #uuid: () => string;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path = BACKLOG_FILE, options: { uuid?: () => string; now?: () => Date } = {}) {
    this.path = path;
    this.#uuid = options.uuid ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async read(): Promise<BacklogState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") return emptyBacklog();
      throw new BacklogStoreError("HUI's backlog file could not be read.", { cause: error });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new BacklogStoreError("HUI's backlog file is not valid JSON.", { cause: error });
    }
    return parseBacklogFile(raw);
  }

  async #write(state: BacklogState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.path);
  }

  /** Serialized read/modify/write; a failed mutation leaves the file as it was
   * and does not block later ones. */
  update<T>(mutate: (state: BacklogState) => { state: BacklogState; result: T }): Promise<T> {
    const operation = this.#queue.then(async () => {
      const { state, result } = mutate(await this.read());
      await this.#write({ ...state, version: BACKLOG_VERSION });
      return result;
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async addTask(input: BacklogTaskInput): Promise<BacklogLocalTask> {
    const title = str(input.title, BACKLOG_LIMITS.title);
    if (!title) throw new BacklogInputError("A backlog task needs a title.");
    const problem = str(input.problem, BACKLOG_LIMITS.problem);
    const cwd = input.cwd ? normalize(input.cwd.trim()) : "";
    if (cwd && !isAbsolute(cwd)) throw new BacklogInputError("A backlog task directory must be an absolute path.");
    const task: BacklogLocalTask = {
      id: this.#uuid(),
      title,
      problem,
      fix: str(input.fix, BACKLOG_LIMITS.fix),
      ...(cwd ? { cwd } : {}),
      group: groupValue(input.group ?? ""),
      createdAt: this.#now().toISOString(),
    };
    return this.update((state) => {
      if (state.tasks.length >= BACKLOG_LIMITS.tasks) {
        throw new BacklogInputError(`The backlog already holds ${BACKLOG_LIMITS.tasks} local tasks. Remove stale ones first.`);
      }
      return { state: { ...state, tasks: [task, ...state.tasks] }, result: task };
    });
  }

  removeTask(id: string): Promise<BacklogLocalTask> {
    return this.update((state) => {
      const found = state.tasks.find((task) => task.id === id);
      if (!found) throw new BacklogNotFoundError("That task is no longer in the backlog.");
      return { state: { ...state, tasks: state.tasks.filter((task) => task.id !== id) }, result: found };
    });
  }

  /** `itemId` is a board id: `local:<uuid>` or `jira:<KEY>`. */
  async setGroup(itemId: string, value: unknown): Promise<string> {
    const group = groupValue(value);
    const [kind, key = ""] = splitItemId(itemId);
    if (kind === "jira") {
      if (!JIRA_KEY.test(key)) throw new BacklogNotFoundError("That is not a Jira backlog item.");
      return this.update((state) => {
        const jira = { ...state.jira };
        if (group) jira[key] = { group };
        else delete jira[key];
        // Bounded: the oldest metadata goes first.
        const keys = Object.keys(jira);
        for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_JIRA_METADATA))) delete jira[stale];
        return { state: { ...state, jira }, result: group };
      });
    }
    return this.update((state) => {
      if (!state.tasks.some((task) => task.id === key)) throw new BacklogNotFoundError("That task is no longer in the backlog.");
      return { state: { ...state, tasks: state.tasks.map((task) => task.id === key ? { ...task, group } : task) }, result: group };
    });
  }

  attachJira(taskId: string, ref: JiraIssueRef): Promise<BacklogLocalTask> {
    return this.update((state) => {
      const found = state.tasks.find((task) => task.id === taskId);
      if (!found) throw new BacklogNotFoundError("That task is no longer in the backlog.");
      const next = { ...found, jira: ref };
      return { state: { ...state, tasks: state.tasks.map((task) => task.id === taskId ? next : task) }, result: next };
    });
  }

  /** A started Jira item leaves the backlog through its session link; its
   * group metadata is no longer needed. */
  forgetJira(key: string): Promise<void> {
    return this.update((state) => {
      if (!(key in state.jira)) return { state, result: undefined };
      const jira = { ...state.jira };
      delete jira[key];
      return { state: { ...state, jira }, result: undefined };
    });
  }
}

export function splitItemId(id: string): ["jira" | "local" | "", string] {
  const index = id.indexOf(":");
  const kind = id.slice(0, index);
  return kind === "jira" || kind === "local" ? [kind, id.slice(index + 1)] : ["", ""];
}

/* ── Jira feed ─────────────────────────────────────────────────────────── */

/** Assigned work items in the To Do status category (To Do, Backlog, …). */
export const ASSIGNED_TODO_JQL = 'assignee = currentUser() AND statusCategory = "To Do" ORDER BY updated DESC';
const FEED_LIMIT = 100;

export async function fetchAssignedTodo(client: Pick<JiraClient, "search">, site: string): Promise<SessionJiraIssue[]> {
  const raws = await client.search(ASSIGNED_TODO_JQL, FEED_LIMIT, ["summary", "status", "issuetype", "description"]);
  return raws.flatMap((raw) => {
    const key = typeof raw["key"] === "string" ? raw["key"] : "";
    if (!JIRA_KEY.test(key)) return [];
    const details = parseJiraIssue(raw, key);
    // The JQL already filters; this guards against a site whose categories differ.
    if (details.statusCategory && details.statusCategory !== "new") return [];
    return [{ key, url: jiraIssueUrl(site, key), ...details }];
  });
}

export type BacklogFeedResult = { issues: SessionJiraIssue[] } | { error: string };

/** Short-lived cache of the assigned-items query with in-flight sharing, so a
 * board refresh and a start request do not both hit Jira. Failures are cached
 * briefly too, and never replace the last good answer with invented data. */
export class BacklogJiraFeed {
  readonly #ttlMs: number;
  readonly #failureTtlMs: number;
  readonly #now: () => number;
  #cacheKey = "";
  #value?: BacklogFeedResult;
  #freshUntil = 0;
  #inflight?: Promise<BacklogFeedResult>;

  constructor(options: { ttlMs?: number; failureTtlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 60_000;
    this.#failureTtlMs = options.failureTtlMs ?? 15_000;
    this.#now = options.now ?? Date.now;
  }

  /** `cacheKey` identifies the connection (site + account); a new one refetches. */
  get(cacheKey: string, load: () => Promise<SessionJiraIssue[]>, force = false): Promise<BacklogFeedResult> {
    if (cacheKey !== this.#cacheKey) this.invalidate();
    this.#cacheKey = cacheKey;
    if (!force && this.#value && this.#freshUntil > this.#now()) return Promise.resolve(this.#value);
    if (this.#inflight) return this.#inflight;
    const request = load().then(
      (issues): BacklogFeedResult => ({ issues }),
      (error: unknown): BacklogFeedResult => ({ error: error instanceof Error ? error.message : "Jira could not be reached." }),
    ).then((value) => {
      if (this.#inflight === request) {
        this.#inflight = undefined;
        this.#value = value;
        this.#freshUntil = this.#now() + ("error" in value ? this.#failureTtlMs : this.#ttlMs);
      }
      return value;
    });
    this.#inflight = request;
    return request;
  }

  /** The last successful answer's copy of one item, without a request. */
  cached(key: string): SessionJiraIssue | undefined {
    return this.#value && "issues" in this.#value ? this.#value.issues.find((issue) => issue.key === key) : undefined;
  }

  invalidate(): void {
    this.#value = undefined;
    this.#freshUntil = 0;
    this.#inflight = undefined;
  }
}

/* ── merged view ───────────────────────────────────────────────────────── */

/**
 * The board's backlog: local tasks (newest first), then assigned To Do Jira
 * items in Jira's order. A Jira key already linked to a session, or attached
 * to a local task, is not listed as its own item.
 */
export function mergeBacklog(input: {
  state: BacklogState;
  issues: readonly SessionJiraIssue[];
  linkedKeys: ReadonlySet<string>;
  /** Live view of an attached key (cached Jira facts); defaults to the reference. */
  viewAttached?: (ref: JiraIssueRef) => SessionJiraIssue;
}): BacklogItem[] {
  const view = input.viewAttached ?? ((ref: JiraIssueRef) => ({ ...ref }));
  const attached = new Set(input.state.tasks.flatMap((task) => task.jira ? [task.jira.key] : []));
  const local = input.state.tasks.map((task): BacklogItem => ({
    id: backlogItemId("local", task.id),
    kind: "local",
    title: task.title,
    group: task.group,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    problem: task.problem,
    ...(task.fix ? { fix: task.fix } : {}),
    createdAt: task.createdAt,
    ...(task.jira ? { jira: view(task.jira) } : {}),
  }));
  const seen = new Set<string>();
  const jira = input.issues.flatMap((issue): BacklogItem[] => {
    if (seen.has(issue.key) || input.linkedKeys.has(issue.key) || attached.has(issue.key)) return [];
    seen.add(issue.key);
    return [{
      id: backlogItemId("jira", issue.key),
      kind: "jira",
      title: issue.summary || issue.key,
      group: input.state.jira[issue.key]?.group ?? "",
      jira: issue,
    }];
  });
  return [...local, ...jira];
}

export type BacklogLifecycleDeps = {
  liveSessions: typeof liveSessions;
  lifecycle: Pick<ReturnType<typeof createSessionLifecycle>, "createSession" | "waitForSessionReady">;
  views: Pick<ReturnType<typeof createSessionViews>, "toView">;
  taskSuggestions: TaskSuggestionStore;
  backlogStore: BacklogStore;
  backlogFeed: BacklogJiraFeed;
  jiraConfig: () => JiraConfig | undefined;
  jiraConfigReady: Promise<void>;
  jiraClient: () => JiraClient;
  jiraStatuses: JiraIssueStatuses;
  defaultSessionTool: () => string;
  SESSION_TITLE_MAX: number;
  SessionNotFoundError: typeof SessionNotFoundError;
};

export function createBacklogLifecycle(deps: BacklogLifecycleDeps) {
  const { liveSessions, taskSuggestions, backlogStore, backlogFeed, jiraConfig, jiraConfigReady, jiraClient, jiraStatuses } = deps;
  const { defaultSessionTool, SESSION_TITLE_MAX, SessionNotFoundError } = deps;
  const { createSession, waitForSessionReady } = deps.lifecycle;
  const { toView } = deps.views;

  /**
   * Starts a suggestion as its own session: same group and runtime as the
   * source, the suggestion's directory and title, and its problem plus proposed
   * fix (or a request to investigate) as the first turn. The card is removed only once that prompt has been accepted; a
   * failure releases it so the operator can retry, and keeps any created
   * session visible rather than deleting it behind their back.
   */
  async function startTaskSuggestion(
    source: SessionRecord,
    suggestionId: string,
    mode: TaskSuggestionStartMode = "session",
  ): Promise<SessionView> {
    const suggestion = taskSuggestions.claim(source.id, suggestionId);
    try {
      if (mode === "current") {
        // Same conversation: prompt when idle, otherwise steer the active run
        // like a composer message, falling back to a queued follow-up.
        if (!liveSessions.ensure(source)) throw new SessionNotFoundError(`unknown session: ${source.id}`);
        if (liveSessions.status(source.id) === "starting") await waitForSessionReady(source.id);
        const text = taskSuggestionPrompt(suggestion);
        if (liveSessions.status(source.id) === "idle") await liveSessions.prompt(source.id, text);
        else {
          try { await liveSessions.steer(source.id, text); }
          catch { await liveSessions.followUp(source.id, text); }
        }
        taskSuggestions.remove(source.id, suggestionId);
        const current = (await readRegistry()).find((session) => session.id === source.id) ?? source;
        return toView(current, liveSessions.status(source.id));
      }
      const record = await createSession({
        cwd: suggestion.cwd,
        title: suggestion.title.slice(0, SESSION_TITLE_MAX),
        group: source.group,
        tool: defaultSessionTool(),
        ...(suggestion.worker ? { worker: suggestion.worker } : {}),
        ...(mode === "worktree" ? { worktree: true } : {}),
      });
      await waitForSessionReady(record.id);
      await liveSessions.prompt(record.id, taskSuggestionPrompt(suggestion));
      taskSuggestions.remove(source.id, suggestionId);
      const current = (await readRegistry()).find((session) => session.id === record.id) ?? record;
      return toView(current, liveSessions.status(record.id));
    } catch (error) {
      taskSuggestions.release(suggestionId);
      throw error;
    }
  }

  /** Backlog items whose session is being started, so a double drop cannot
   * start the same item twice. */
  const startingBacklogItems = new Set<string>();

  /** Jira keys any session already holds (registry links and, for loaded
   * transcripts, work items the session created). */
  async function sessionLinkedJiraKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const record of await readRegistry()) {
      for (const ref of mergeJiraRefs(record.jiraIssues ?? [], jiraIssuesFromTranscript(liveSessions.transcript(record.id)))) keys.add(ref.key);
    }
    return keys;
  }

  function jiraFetcherFor(url: string): JiraIssueFetcher | undefined {
    const config = jiraConfig();
    if (!config || new URL(url).origin !== new URL(config.site).origin) return undefined;
    return (key: string) => new JiraClient(config).issue(key);
  }

  async function listBacklog(force = false): Promise<BacklogView> {
    await jiraConfigReady;
    const state = await backlogStore.read();
    const linkedKeys = await sessionLinkedJiraKeys();
    const config = jiraConfig();
    let issues: SessionJiraIssue[] = [];
    let jira: BacklogView["jira"] = { status: "unconfigured" };
    if (config) {
      const result = await backlogFeed.get(`${config.site}\u0000${config.email}`, () => fetchAssignedTodo(new JiraClient(config), config.site), force);
      if ("issues" in result) {
        issues = result.issues;
        jira = { status: "ok" };
      } else {
        jira = { status: "unavailable", message: result.error };
      }
    }
    const items = mergeBacklog({ state, issues, linkedKeys, viewAttached: (ref) => jiraStatuses.view(ref, jiraFetcherFor(ref.url)) });
    return { items, jira };
  }

  async function findBacklogItem(itemId: string): Promise<BacklogItem> {
    const item = (await listBacklog()).items.find((candidate) => candidate.id === itemId);
    if (!item) throw new BacklogNotFoundError("That item is no longer in the backlog.");
    return item;
  }

  /**
   * Starts a backlog item as a session: its title, the chosen directory (and
   * optional worktree/base ref), the chosen group and an operator placement in
   * the target column. The first prompt is the Jira summary and description or
   * the local problem and fix. Only once that prompt is accepted does the item
   * leave the backlog: a Jira key is linked to the session, a local task is
   * removed. A failure keeps the item; a session already created is kept.
   */
  async function startBacklogItem(itemId: string, body: Record<string, unknown>): Promise<SessionView> {
    if (!isSessionStage(body["stage"])) throw new BacklogInputError(`stage must be one of: ${SESSION_STAGES.join(", ")}.`);
    const stage = body["stage"];
    if (typeof body["group"] !== "string") throw new BacklogInputError("A group must be text.");
    if (startingBacklogItems.has(itemId)) throw new BacklogInputError("That item is already starting.");
    startingBacklogItems.add(itemId);
    try {
      let item = await findBacklogItem(itemId);
      // The first prompt carries the full description; refresh it when the
      // cached feed copy has none.
      if (item.jira && item.kind === "jira" && !item.jira.description && jiraConfig()) {
        try {
          const details = await jiraClient().issue(item.jira.key);
          item = { ...item, jira: { ...item.jira, ...details } };
        } catch { /* Start with what the feed confirmed. */ }
      }
      const record = await createSession({
        cwd: body["cwd"],
        title: item.title.slice(0, SESSION_TITLE_MAX),
        group: body["group"],
        tool: defaultSessionTool(),
        ...(body["worktree"] !== undefined ? { worktree: body["worktree"] } : {}),
        ...(body["branchName"] ? { branchName: body["branchName"] } : {}),
        ...(body["baseRef"] ? { baseRef: body["baseRef"] } : {}),
      }, liveSessions, updateRegistry, undefined, { stage });
      await waitForSessionReady(record.id);
      await liveSessions.prompt(record.id, backlogItemPrompt(item));
      if (item.jira) {
        const ref = { key: item.jira.key, url: item.jira.url };
        await updateRegistry((sessions) => sessions.map((session) => session.id === record.id
          ? { ...session, jiraIssues: mergeJiraRefs(session.jiraIssues ?? [], [ref]) }
          : session));
      }
      const [kind, key] = splitItemId(itemId);
      if (kind === "local") await backlogStore.removeTask(key).catch((error: unknown) => { if (!(error instanceof BacklogNotFoundError)) throw error; });
      else if (kind === "jira") await backlogStore.forgetJira(key);
      const current = (await readRegistry()).find((session) => session.id === record.id) ?? record;
      return toView(current, liveSessions.status(record.id));
    } finally {
      startingBacklogItems.delete(itemId);
    }
  }

  /** A pending suggestion becomes a local backlog task (group OTHER, same
   * directory) and its card is removed. */
  async function saveSuggestionToBacklog(sessionId: string, suggestionId: string) {
    const suggestion = taskSuggestions.claim(sessionId, suggestionId);
    try {
      // Backlog items start on this machine; a remote directory means nothing here.
      if (suggestion.worker) throw new TaskSuggestionInputError("Suggestions from a remote worker can't go to the backlog yet. Start it in a new session instead.");
      const task = await backlogStore.addTask({ title: suggestion.title, problem: suggestion.problem, fix: suggestion.fix, cwd: suggestion.cwd, group: "" });
      taskSuggestions.remove(sessionId, suggestionId);
      return task;
    } finally {
      taskSuggestions.release(suggestionId);
    }
  }

  return { startTaskSuggestion, saveSuggestionToBacklog, listBacklog, findBacklogItem, startBacklogItem };
}
