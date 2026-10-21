import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
  adjacentStage,
  backlogDrop,
  backlogLaneAccepts,
  DEFAULT_KANBAN_OPTIONS,
  DEFAULT_SESSION_STAGE,
  isSessionStage,
  SESSION_STAGE_LABELS,
  SESSION_STAGES,
  stageRank,
  pullRequestSummary,
  sessionStage,
  kanbanDropMove,
  laneAccepts,
  kanbanBoard,
  kanbanStatus,
  normalizeKanbanOptions,
  toggleKanbanColumn,
} from "./kanban.ts";
import type { SessionGroup, SessionView } from "../api/sessions.ts";
import type { BacklogItem } from "../api/schema/backlog.ts";
import type { SessionStage } from "../api/schema/sessions.ts";

const stageFixture: {
  stages: string[];
  defaultStage: string;
  labels: Record<string, string>;
  isSessionStage: { input: unknown; expected: boolean }[];
  stageRank: { input: SessionStage; expected: number }[];
} = JSON.parse(readFileSync(new URL("./session-stages.fixture.json", import.meta.url), "utf8"));

test("session stages preserve the shared runtime fixtures", () => {
  assert.deepEqual(SESSION_STAGES, stageFixture.stages);
  assert.equal(DEFAULT_SESSION_STAGE, stageFixture.defaultStage);
  const { backlog: _backlog, ...stageLabels } = SESSION_STAGE_LABELS;
  assert.deepEqual(stageLabels, stageFixture.labels);
  for (const { input, expected } of stageFixture.isSessionStage) assert.equal(isSessionStage(input), expected, String(input));
  for (const { input, expected } of stageFixture.stageRank) assert.equal(stageRank(input), expected, input);
});

function item(id: string, patch: Partial<BacklogItem> = {}): BacklogItem {
  return { id: `local:${id}`, kind: "local", title: id, group: "", ...patch };
}

function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id, title: id, group: "", cwd: "/repo/web", tool: "pi", status: "idle",
    displayCwd: "", stage: "investigation", stageOrigin: "default", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z", ...patch,
  };
}

test("status maps runtime state and an unread finished run to Done", () => {
  assert.equal(kanbanStatus({ status: "error" }), "error");
  assert.equal(kanbanStatus({ status: "waiting" }), "waiting");
  assert.equal(kanbanStatus({ status: "starting" }), "working");
  assert.equal(kanbanStatus({ status: "running", unread: true }), "working");
  assert.equal(kanbanStatus({ status: "idle", unread: true }), "done");
  assert.equal(kanbanStatus({ status: "idle" }), "idle");
});

test("cards sort top to bottom by error, waiting, done, working, idle", () => {
  const groups: SessionGroup[] = [{ label: "ungrouped", sessions: [
    session("idle", { updatedAt: "2026-09-25T00:00:00.000Z" }),
    session("working", { status: "running" }),
    session("done", { unread: true }),
    session("waiting", { status: "waiting" }),
    session("error", { status: "error" }),
  ] }];
  const [lane] = kanbanBoard(groups, "", DEFAULT_KANBAN_OPTIONS);
  assert.deepEqual(lane?.cells[1]?.sessions.map(({ id }) => id), ["error", "waiting", "done", "working", "idle"]);
  const byRecency = kanbanBoard(groups, "", { ...DEFAULT_KANBAN_OPTIONS, sortBy: "updated" });
  assert.equal(byRecency[0]?.cells[1]?.sessions[0]?.id, "idle");
});

test("stages place cards in columns and project lanes split by directory", () => {
  const groups: SessionGroup[] = [{ label: "ungrouped", sessions: [
    session("a", { stage: "testing" }),
    session("b", { cwd: "/repo/api" }),
    session("c", { cwd: "/repo/api", stage: "done" }),
  ] }];
  const lanes = kanbanBoard(groups, "", DEFAULT_KANBAN_OPTIONS);
  assert.deepEqual(lanes.map((lane) => lane.label), ["api", "web"]);
  const api = lanes[0]!;
  // Sessions without a stage start in Investigation; Backlog never holds one.
  assert.deepEqual(api.cells.map((cell) => cell.sessions.map(({ id }) => id)), [[], ["b"], [], [], ["c"]]);
  assert.deepEqual(lanes[1]!.cells[3]!.sessions.map(({ id }) => id), ["a"]);
});

test("archive, subagent, column and search filters apply before lanes are built", () => {
  const groups: SessionGroup[] = [{ label: "Frontend", sessions: [
    session("live"),
    session("old", { archived: true }),
    session("child", { parentId: "live" }),
  ] }];
  const ids = (options = DEFAULT_KANBAN_OPTIONS, query = "") =>
    kanbanBoard(groups, query, options).flatMap((lane) => lane.cells.flatMap((cell) => cell.sessions.map(({ id }) => id)));
  assert.deepEqual(ids(), ["live"]);
  assert.deepEqual(ids({ ...DEFAULT_KANBAN_OPTIONS, archive: "archived" }), ["old"]);
  assert.deepEqual(ids({ ...DEFAULT_KANBAN_OPTIONS, subagents: true }).sort(), ["child", "live"]);
  assert.deepEqual(ids(DEFAULT_KANBAN_OPTIONS, "nothing"), []);
  const custom = kanbanBoard(groups, "", { ...DEFAULT_KANBAN_OPTIONS, groupBy: "custom", columns: ["backlog", "done"] });
  assert.equal(custom[0]?.label, "FRONTEND");
  assert.equal(custom[0]?.cells.length, 2);
});

test("options normalize unknown input and never hide every column", () => {
  assert.deepEqual(normalizeKanbanOptions({ groupBy: "person", columns: ["done", "backlog", "nope"] }), {
    ...DEFAULT_KANBAN_OPTIONS, columns: ["backlog", "done"],
  });
  assert.deepEqual(normalizeKanbanOptions({ columns: [] }).columns, DEFAULT_KANBAN_OPTIONS.columns);
  const one = normalizeKanbanOptions({ columns: ["testing"] });
  assert.deepEqual(toggleKanbanColumn(one, "testing").columns, DEFAULT_KANBAN_OPTIONS.columns);
  assert.deepEqual(toggleKanbanColumn(one, "backlog").columns, ["backlog", "testing"]);
});

test("drops change stage and custom group together but never the project", () => {
  const card = session("s", { group: "Frontend", stage: "implementation" });
  const frontend = { kind: "custom" as const, key: "Frontend" };
  const other = { kind: "custom" as const, key: "ungrouped" };
  assert.equal(kanbanDropMove(card, frontend, "implementation"), undefined);
  assert.deepEqual(kanbanDropMove(card, frontend, "testing"), { stage: "testing" });
  assert.deepEqual(kanbanDropMove(card, other, "implementation"), { group: "" });
  assert.deepEqual(kanbanDropMove(card, { kind: "custom", key: "Backend" }, "done"), { stage: "done", group: "Backend" });
  const ownProject = { kind: "project" as const, key: "p", cwd: "/repo/web" };
  const otherProject = { kind: "project" as const, key: "q", cwd: "/repo/api" };
  assert.deepEqual(kanbanDropMove(card, ownProject, "testing"), { stage: "testing" });
  assert.equal(kanbanDropMove(card, otherProject, "testing"), undefined);
  assert.equal(laneAccepts(card, otherProject), false);
  assert.equal(laneAccepts(card, { kind: "none" }), true);
});

test("keyboard moves stop at the board edges and never reach Backlog", () => {
  assert.equal(adjacentStage("investigation", -1), undefined);
  assert.equal(adjacentStage("investigation", 1), "implementation");
  assert.equal(adjacentStage("done", 1), undefined);
});

test("a session without a stage or with a legacy backlog stage sits in Investigation", () => {
  assert.equal(sessionStage({}), "investigation");
  assert.equal(sessionStage({ stage: "backlog" as never }), "investigation");
  assert.equal(sessionStage({ stage: "testing" }), "testing");
});

test("sessions can never be dropped into Backlog", () => {
  const card = session("s", { stage: "implementation" });
  assert.equal(laneAccepts(card, { kind: "none" }, "backlog"), false);
  assert.equal(kanbanDropMove(card, { kind: "custom", key: "Frontend" }, "backlog"), undefined);
  assert.equal(laneAccepts(card, { kind: "none" }, "testing"), true);
});

test("backlog items fill only the Backlog column, in their group, project or OTHER lane", () => {
  const groups: SessionGroup[] = [{ label: "Frontend", sessions: [session("a", { group: "Frontend" })] }];
  const backlog = [
    item("x"),
    item("y", { group: "Frontend", cwd: "/repo/web" }),
    { id: "jira:CI-1", kind: "jira" as const, title: "Jira one", group: "Backend", jira: { key: "CI-1", url: "https://acme.atlassian.net/browse/CI-1" } },
  ];
  const cellIds = (lane: { cells: { items: BacklogItem[] }[] } | undefined) => lane?.cells.map((cell) => cell.items.map(({ id }) => id));

  const custom = kanbanBoard(groups, "", { ...DEFAULT_KANBAN_OPTIONS, groupBy: "custom" }, backlog);
  assert.deepEqual(custom.map((lane) => lane.label), ["FRONTEND", "BACKEND", "OTHER"]);
  assert.deepEqual(cellIds(custom[0]), [["local:y"], [], [], [], []]);
  assert.deepEqual(cellIds(custom[1]), [["jira:CI-1"], [], [], [], []]);
  assert.deepEqual(cellIds(custom[2]), [["local:x"], [], [], [], []]);

  const project = kanbanBoard(groups, "", DEFAULT_KANBAN_OPTIONS, backlog);
  assert.deepEqual(project.map((lane) => lane.label), ["web", "OTHER"]);
  assert.deepEqual(cellIds(project[0]), [["local:y"], [], [], [], []]);
  assert.deepEqual(project[0]!.cells[1]!.sessions.map(({ id }) => id), ["a"]);
  assert.deepEqual(cellIds(project[1]), [["local:x", "jira:CI-1"], [], [], [], []]);

  const flat = kanbanBoard(groups, "", { ...DEFAULT_KANBAN_OPTIONS, groupBy: "none" }, backlog);
  assert.equal(flat[0]!.cells[0]!.items.length, 3);
  // Search covers Jira keys; archived views have no backlog.
  assert.deepEqual(kanbanBoard(groups, "ci-1", { ...DEFAULT_KANBAN_OPTIONS, groupBy: "none" }, backlog)[0]!.cells[0]!.items.map(({ id }) => id), ["jira:CI-1"]);
  assert.equal(kanbanBoard(groups, "", { ...DEFAULT_KANBAN_OPTIONS, groupBy: "none", archive: "archived" }, backlog)[0]!.cells[0]!.items.length, 0);
});

test("a backlog drop inside Backlog only regroups; anywhere else it asks to start", () => {
  const task = item("t", { group: "Frontend", cwd: "/repo/web" });
  assert.deepEqual(backlogDrop(task, { kind: "custom", key: "Backend" }, "backlog"), { kind: "group", group: "Backend" });
  assert.deepEqual(backlogDrop(task, { kind: "custom", key: "ungrouped" }, "backlog"), { kind: "group", group: "" });
  assert.equal(backlogDrop(task, { kind: "custom", key: "Frontend" }, "backlog"), undefined);
  assert.equal(backlogDrop(task, { kind: "none", key: "flat" }, "backlog"), undefined);
  assert.deepEqual(backlogDrop(task, { kind: "custom", key: "Backend" }, "implementation"), { kind: "start", stage: "implementation", group: "Backend", cwd: "/repo/web" });
  assert.deepEqual(backlogDrop(task, { kind: "project", key: "p", cwd: "/repo/api" }, "testing"), { kind: "start", stage: "testing", group: "Frontend", cwd: "/repo/api" });
  assert.deepEqual(backlogDrop(item("u"), { kind: "none", key: "flat" }, "investigation"), { kind: "start", stage: "investigation", group: "" });
  // Project lanes are directories: inside Backlog an item stays in its own lane.
  assert.equal(backlogLaneAccepts(task, { kind: "project", key: "\u0000project:/repo/api" }, "backlog"), false);
  assert.equal(backlogLaneAccepts(task, { kind: "project", key: "\u0000project:/repo/web" }, "backlog"), true);
  assert.equal(backlogLaneAccepts(task, { kind: "project", key: "\u0000project:/repo/api" }, "done"), true);
});

test("pull request summaries count states and name the dominant one", () => {
  assert.equal(pullRequestSummary([]), undefined);
  assert.deepEqual(pullRequestSummary([{ state: "merged" }]), { total: 1, counts: { merged: 1 }, dominant: "merged", label: "1 PR · 1 merged" });
  const mixed = pullRequestSummary([{ state: "merged" }, { state: "open" }, { state: "closed" }, {}]);
  assert.equal(mixed?.dominant, "open");
  assert.equal(mixed?.label, "4 PRs · 1 open, 1 merged, 1 closed");
});
