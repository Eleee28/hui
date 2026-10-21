/**
 * Kanban projection of the session registry and the backlog. The first
 * column, Backlog, holds backlog items (Jira work items and local tasks);
 * the others are the HUI-owned development stage of sessions, ordered inside
 * each cell by what needs the operator first. Options are browser reading
 * preferences, like the sidebar's.
 */
import type { BacklogItem } from "../api/schema/backlog.ts";
import type { SessionPullRequest } from "../api/schema/github.ts";
import type { SessionStage } from "../api/schema/sessions.ts";
import type { SessionGroup, SessionView } from "../api/sessions.ts";
import { sessionGroupLabel } from "./session/sessions.ts";

/** Board columns, left to right. */
export const KANBAN_COLUMNS = ["backlog", "investigation", "implementation", "testing", "done"] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];
/** Stages a session can be in: every column except Backlog. */
export const SESSION_STAGES = ["investigation", "implementation", "testing", "done"] as const;
/** Where a session without a stage (or a legacy `backlog` from older gateways) sits. */
export const DEFAULT_SESSION_STAGE: SessionStage = "investigation";

export const SESSION_STAGE_LABELS: Readonly<Record<KanbanColumn, string>> = {
  backlog: "Backlog",
  investigation: "Investigation",
  implementation: "Implementation",
  testing: "Testing",
  done: "Done",
};

export function isSessionStage(value: unknown): value is SessionStage {
  return typeof value === "string" && (SESSION_STAGES as readonly string[]).includes(value);
}

export function stageRank(stage: SessionStage): number {
  return SESSION_STAGES.indexOf(stage);
}

/** Top to bottom inside a cell: what needs attention first. */
export const KANBAN_STATUSES = ["error", "waiting", "done", "working", "idle"] as const;
export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

export const KANBAN_STATUS_LABELS: Readonly<Record<KanbanStatus, string>> = {
  error: "Error",
  waiting: "Waiting input",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

/** `done` is a finished run the operator has not read yet. */
export function kanbanStatus(session: Pick<SessionView, "status" | "unread">): KanbanStatus {
  if (session.status === "error") return "error";
  if (session.status === "waiting") return "waiting";
  if (session.status === "running" || session.status === "starting") return "working";
  // Out of reach (`reconnecting`, `disconnected`) is not a failure; it reads idle.
  return session.unread ? "done" : "idle";
}

export type KanbanOptions = {
  groupBy: "project" | "custom" | "none";
  sortBy: "status" | "updated" | "created";
  archive: "active" | "archived" | "all";
  /** Visible columns, always in canonical order. */
  columns: KanbanColumn[];
  subagents: boolean;
  hideEmpty: "filtering" | "always" | "never";
};

export const DEFAULT_KANBAN_OPTIONS: Readonly<KanbanOptions> = {
  groupBy: "project",
  sortBy: "status",
  archive: "active",
  columns: [...KANBAN_COLUMNS],
  subagents: false,
  hideEmpty: "filtering",
};

export const KANBAN_OPTIONS_KEY = "hui.kanban-options";

export function normalizeKanbanOptions(value: unknown): KanbanOptions {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const columns = Array.isArray(raw["columns"])
    ? KANBAN_COLUMNS.filter((stage) => (raw["columns"] as unknown[]).includes(stage))
    : [...KANBAN_COLUMNS];
  return {
    groupBy: raw["groupBy"] === "custom" || raw["groupBy"] === "none" ? raw["groupBy"] : "project",
    sortBy: raw["sortBy"] === "updated" || raw["sortBy"] === "created" ? raw["sortBy"] : "status",
    archive: raw["archive"] === "archived" || raw["archive"] === "all" ? raw["archive"] : "active",
    // A board with no columns is useless; an emptied list restores all of them.
    columns: columns.length ? columns : [...KANBAN_COLUMNS],
    subagents: raw["subagents"] === true,
    hideEmpty: raw["hideEmpty"] === "always" || raw["hideEmpty"] === "never" ? raw["hideEmpty"] : "filtering",
  };
}

export function toggleKanbanColumn(options: KanbanOptions, stage: KanbanColumn): KanbanOptions {
  const visible = options.columns.includes(stage)
    ? options.columns.filter((column) => column !== stage)
    : [...options.columns, stage];
  return normalizeKanbanOptions({ ...options, columns: visible });
}

export function isDefaultKanbanOptions(options: KanbanOptions): boolean {
  return JSON.stringify(options) === JSON.stringify(DEFAULT_KANBAN_OPTIONS);
}

export function readKanbanOptions(): KanbanOptions {
  try {
    return normalizeKanbanOptions(JSON.parse(localStorage.getItem(KANBAN_OPTIONS_KEY) ?? "null"));
  } catch {
    return normalizeKanbanOptions(null);
  }
}

export function writeKanbanOptions(options: KanbanOptions) {
  try { localStorage.setItem(KANBAN_OPTIONS_KEY, JSON.stringify(options)); } catch { /* Keep the in-memory choice. */ }
}

export type KanbanCell = { stage: KanbanColumn; sessions: SessionView[]; items: BacklogItem[] };
export type KanbanLane = {
  key: string;
  label: string;
  kind: KanbanOptions["groupBy"];
  cwd?: string;
  cells: KanbanCell[];
  count: number;
};

/** A session's column. Sessions never sit in Backlog: no stage, or a legacy
 * `backlog` from an older gateway, means Investigation. */
export function sessionStage(session: Partial<Pick<SessionView, "stage">>): SessionStage {
  return isSessionStage(session.stage) ? session.stage : DEFAULT_SESSION_STAGE;
}

function matches(session: SessionView, query: string): boolean {
  const pullRequests = (session.pullRequests ?? []).map((pr) => `${pr.repository}#${pr.number} ${pr.title ?? ""}`).join(" ");
  const jira = (session.jiraIssues ?? []).map((issue) => `${issue.key} ${issue.summary ?? ""}`).join(" ");
  return `${session.title} ${session.cwd} ${session.group} ${sessionGroupLabel(session.group)} ${pullRequests} ${jira}`
    .toLocaleLowerCase().includes(query);
}

function itemMatches(item: BacklogItem, query: string): boolean {
  return `${item.title} ${item.cwd ?? ""} ${item.group} ${sessionGroupLabel(item.group)} ${item.jira?.key ?? ""} ${item.jira?.status ?? ""} ${item.problem ?? ""}`
    .toLocaleLowerCase().includes(query);
}

function compare(a: SessionView, b: SessionView, sortBy: KanbanOptions["sortBy"]): number {
  if (sortBy === "status") {
    const rank = KANBAN_STATUSES.indexOf(kanbanStatus(a)) - KANBAN_STATUSES.indexOf(kanbanStatus(b));
    if (rank) return rank;
  }
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  const time = sortBy === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt);
  return time || a.id.localeCompare(b.id);
}

function projectLabel(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) || cwd || "OTHER";
}

const PROJECT_PREFIX = "\u0000project:";
/** Project view: backlog items without a directory share one OTHER lane. */
export const PROJECT_OTHER_LANE = `${PROJECT_PREFIX}`;
const FLAT_LANE = "\u0000flat";

function customLaneKey(group: string): string {
  return !group || group === "ungrouped" ? "ungrouped" : group;
}

/** The lane a backlog item belongs to under the given grouping. */
export function backlogItemLaneKey(item: Pick<BacklogItem, "group" | "cwd">, groupBy: KanbanOptions["groupBy"]): string {
  if (groupBy === "custom") return customLaneKey(item.group);
  if (groupBy === "project") return item.cwd ? `${PROJECT_PREFIX}${item.cwd}` : PROJECT_OTHER_LANE;
  return FLAT_LANE;
}

type LaneDraft = { key: string; label: string; kind: KanbanOptions["groupBy"]; cwd?: string; sessions: SessionView[]; items: BacklogItem[] };

/** Rows (lanes) × visible columns. Virtual project lanes never become
 * registry groups. Backlog items only ever fill the Backlog column. */
export function kanbanBoard(
  groups: readonly SessionGroup[],
  search: string,
  options: KanbanOptions,
  backlog: readonly BacklogItem[] = [],
): KanbanLane[] {
  const query = search.trim().toLocaleLowerCase();
  const visible = (session: SessionView) =>
    (options.archive === "all" || Boolean(session.archived) === (options.archive === "archived")) &&
    (options.subagents || !session.parentId);
  // Backlog items are neither archived nor subagents: they follow the Active view.
  const items = options.archive === "archived" ? [] : backlog;
  let lanes: LaneDraft[];
  if (options.groupBy === "custom") {
    const byKey = new Map<string, LaneDraft>();
    for (const group of groups) {
      const key = customLaneKey(group.label);
      byKey.set(key, { key, label: sessionGroupLabel(group.label), kind: "custom", sessions: group.sessions.filter(visible), items: [] });
    }
    for (const item of items) {
      const key = backlogItemLaneKey(item, "custom");
      let lane = byKey.get(key);
      if (!lane) {
        lane = { key, label: sessionGroupLabel(item.group), kind: "custom", sessions: [], items: [] };
        byKey.set(key, lane);
      }
      lane.items.push(item);
    }
    lanes = [...byKey.values()].sort((a, b) => Number(a.key === "ungrouped" || !a.key) - Number(b.key === "ungrouped" || !b.key));
  } else if (options.groupBy === "project") {
    const byProject = new Map<string, LaneDraft>();
    const lane = (key: string, cwd: string | undefined) => {
      let found = byProject.get(key);
      if (!found) {
        found = cwd
          ? { key, label: projectLabel(cwd), kind: "project", cwd, sessions: [], items: [] }
          : { key, label: "OTHER", kind: "project", sessions: [], items: [] };
        byProject.set(key, found);
      }
      return found;
    };
    for (const session of groups.flatMap((group) => group.sessions).filter(visible)) {
      lane(`${PROJECT_PREFIX}${session.cwd}`, session.cwd || undefined).sessions.push(session);
    }
    for (const item of items) lane(backlogItemLaneKey(item, "project"), item.cwd).items.push(item);
    lanes = [...byProject.values()].sort((a, b) =>
      Number(!a.cwd) - Number(!b.cwd) || a.label.localeCompare(b.label) || (a.cwd ?? "").localeCompare(b.cwd ?? ""));
  } else {
    lanes = [{ key: FLAT_LANE, label: "", kind: "none", sessions: groups.flatMap((group) => group.sessions).filter(visible), items: [...items] }];
  }
  const filtering = Boolean(query) || options.archive !== "active";
  const hideEmpty = options.hideEmpty === "always" || (options.hideEmpty === "filtering" && filtering);
  return lanes.flatMap((lane) => {
    const laneMatches = lane.kind !== "none" && Boolean(query) && `${lane.label} ${lane.cwd ?? ""}`.toLocaleLowerCase().includes(query);
    const sessions = lane.sessions.filter((session) => !query || laneMatches || matches(session, query));
    const laneItems = lane.items.filter((item) => !query || laneMatches || itemMatches(item, query));
    const cells = options.columns.map((stage): KanbanCell => ({
      stage,
      sessions: stage === "backlog" ? [] : sessions.filter((session) => sessionStage(session) === stage).sort((a, b) => compare(a, b, options.sortBy)),
      items: stage === "backlog" ? laneItems : [],
    }));
    const count = cells.reduce((total, cell) => total + cell.sessions.length + cell.items.length, 0);
    return count || (lane.kind === "none") || (!hideEmpty && lane.kind === "custom")
      ? [{ key: lane.key, label: lane.label, kind: lane.kind, ...(lane.cwd ? { cwd: lane.cwd } : {}), cells, count }]
      : [];
  });
}

/** What a card move changes. `stage: null` hands the stage back to the agent. */
export type KanbanMove = { stage?: SessionStage | null; group?: string };

/** The registry group a lane stands for: custom lanes map to a stored group
 * ("" for OTHER); project and flat lanes are not groups. */
export function laneGroup(lane: Pick<KanbanLane, "kind" | "key">): string | undefined {
  if (lane.kind !== "custom") return undefined;
  return !lane.key || lane.key === "ungrouped" ? "" : lane.key;
}

/** The patch for dropping `session` on `lane`/`stage`, or undefined when the
 * drop is refused or changes nothing. A project lane is the session's working
 * directory, fixed at creation, so a card can never change project; Backlog
 * holds backlog items only. */
export function kanbanDropMove(
  session: Pick<SessionView, "stage" | "group" | "cwd">,
  lane: Pick<KanbanLane, "kind" | "key" | "cwd">,
  stage: KanbanColumn,
): KanbanMove | undefined {
  if (!laneAccepts(session, lane, stage) || !isSessionStage(stage)) return undefined;
  const move: KanbanMove = {};
  if (sessionStage(session) !== stage) move.stage = stage;
  const group = laneGroup(lane);
  const current = !session.group || session.group === "ungrouped" ? "" : session.group;
  if (group !== undefined && group !== current) move.group = group;
  return Object.keys(move).length ? move : undefined;
}

/** Whether a cell accepts a dragged session at all (a same-cell drop is a
 * no-op, not a refusal): never Backlog, never another project's lane. */
export function laneAccepts(session: Pick<SessionView, "cwd">, lane: Pick<KanbanLane, "kind" | "cwd">, stage?: KanbanColumn): boolean {
  if (stage === "backlog") return false;
  return lane.kind !== "project" || lane.cwd === session.cwd;
}

/** What dropping a backlog item on a cell does. Inside the Backlog column it
 * only changes the item's group (custom lanes); anywhere else it asks to
 * start a session in that column. */
export type BacklogDrop =
  | { kind: "group"; group: string }
  | { kind: "start"; stage: SessionStage; group: string; cwd?: string };

export function backlogDrop(
  item: Pick<BacklogItem, "group" | "cwd">,
  lane: Pick<KanbanLane, "kind" | "key" | "cwd">,
  stage: KanbanColumn,
): BacklogDrop | undefined {
  const current = !item.group || item.group === "ungrouped" ? "" : item.group;
  const group = laneGroup(lane);
  if (stage === "backlog") {
    return group !== undefined && group !== current ? { kind: "group", group } : undefined;
  }
  const cwd = lane.kind === "project" ? lane.cwd ?? item.cwd : item.cwd;
  return { kind: "start", stage, group: group ?? current, ...(cwd ? { cwd } : {}) };
}

/** Whether a cell accepts a dragged backlog item: any work column; inside
 * Backlog only another custom lane (its group) or its own lane. */
export function backlogLaneAccepts(
  item: Pick<BacklogItem, "group" | "cwd">,
  lane: Pick<KanbanLane, "kind" | "key">,
  stage: KanbanColumn,
): boolean {
  if (stage !== "backlog") return true;
  return lane.kind !== "project" || lane.key === backlogItemLaneKey(item, "project");
}

/** The neighbouring session stage for keyboard moves, or undefined at an
 * edge; Backlog is not a session stage. */
export function adjacentStage(stage: SessionStage, direction: -1 | 1): SessionStage | undefined {
  return SESSION_STAGES[SESSION_STAGES.indexOf(stage) + direction];
}

export type PullRequestSummary = {
  total: number;
  counts: Partial<Record<NonNullable<SessionPullRequest["state"]> | "unknown", number>>;
  /** The state that best describes the set: open work first, then merged. */
  dominant: NonNullable<SessionPullRequest["state"]> | "unknown";
  label: string;
};

const PR_STATE_ORDER = ["open", "draft", "merged", "closed", "unknown"] as const;

/** Count and state breakdown for a card, e.g. `2 PRs · 1 open, 1 merged`. */
export function pullRequestSummary(pullRequests: readonly Pick<SessionPullRequest, "state">[] | undefined): PullRequestSummary | undefined {
  if (!pullRequests?.length) return undefined;
  const counts: PullRequestSummary["counts"] = {};
  for (const pr of pullRequests) {
    const state = pr.state ?? "unknown";
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const dominant = PR_STATE_ORDER.find((state) => counts[state]) ?? "unknown";
  const parts = PR_STATE_ORDER.filter((state) => counts[state] && state !== "unknown").map((state) => `${counts[state]} ${state}`);
  const total = pullRequests.length;
  return { total, counts, dominant, label: `${total} PR${total === 1 ? "" : "s"}${parts.length ? ` · ${parts.join(", ")}` : ""}` };
}
