import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { BacklogItem } from "../api/backlog.ts";
import type { SessionView } from "../api/sessions.ts";
import { BacklogController } from "./backlog-controller.ts";

const fake = vi.hoisted(() => ({
  calls: [] as { call: string; answer: (outcome: unknown) => void }[],
}));

const pending = (call: string) => new Promise((resolve, reject) => {
  fake.calls.push({ call, answer: (outcome) => outcome instanceof Error ? reject(outcome) : resolve(outcome) });
});

vi.mock("../api/backlog.ts", () => ({
  loadBacklog: (refresh: boolean) => pending(refresh ? "load (refresh)" : "load"),
  setBacklogItemGroup: (id: string, group: string) => pending(`group ${id} ${group}`),
  removeBacklogItem: (id: string) => pending(`remove ${id}`),
  addSuggestionToBacklog: (session: string, id: string) => pending(`backlog ${session} ${id}`),
}));
vi.mock("../api/jira.ts", () => ({ loadJiraConnection: () => pending("jira connection") }));
vi.mock("../components/backlog-start-dialog.ts", () => ({}));
vi.mock("../components/jira-create-dialog.ts", () => ({}));
vi.mock("../components/jira-link-dialog.ts", () => ({}));

beforeEach(() => { fake.calls = []; });

const FIX: BacklogItem = { id: "fix", title: "Fix the toast" } as BacklogItem;
const DOCS: BacklogItem = { id: "docs", title: "Write docs" } as BacklogItem;
const view = (...items: BacklogItem[]) => ({ items, jira: { status: "unconfigured" } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const SOURCE = { id: "source", title: "Source" } as SessionView;
const suggestion = (id: string) => ({ id, title: `Do ${id}`, problem: `${id} is broken`, cwd: "/repo" });

function setup({ kanban = false } = {}) {
  const notes: string[] = [];
  let sessionRefreshes = 0;
  let paneChanges = 0;
  const shell = { selected: SOURCE as SessionView | undefined };
  const host = { updates: 0, addController: () => {}, removeController: () => {}, requestUpdate() { this.updates += 1; }, updateComplete: Promise.resolve(true) };
  const backlog = new BacklogController(host, {
    notify: (message, failed) => notes.push(failed ? `error: ${message}` : message),
    showNote: (message, level) => notes.push(`${level} note: ${message}`),
    refreshSessions: async () => { sessionRefreshes += 1; },
    paneRegistryChanged: () => { paneChanges += 1; },
    selected: () => shell.selected,
    selectSession: () => {},
    kanbanOpen: () => kanban,
  });
  return { backlog, host, notes, shell, sessionRefreshes: () => sessionRefreshes, paneChanges: () => paneChanges };
}

test("only the latest read fills the column; a failed read shows its error", async () => {
  const { backlog } = setup();
  const first = backlog.refresh();
  const second = backlog.refresh(true);
  assert.equal(backlog.loading, true);
  fake.calls[1]!.answer(view(FIX));
  fake.calls[0]!.answer(view(DOCS));
  await Promise.all([first, second]);
  assert.deepEqual(backlog.items, [FIX], "the older read arriving later is dropped");
  assert.equal(backlog.loading, false);
  void backlog.refresh();
  fake.calls[2]!.answer(new Error("Jira is down"));
  await settle();
  assert.equal(backlog.error, "Jira is down");
  assert.deepEqual(backlog.items, [FIX]);
});

test("moving a task waits for the server, one task at a time, and not to its own group", async () => {
  const { backlog, notes } = setup();
  backlog.setGroup({ ...FIX, group: "ungrouped" }, "");
  assert.equal(fake.calls.length, 0);
  backlog.setGroup(FIX, "web");
  backlog.setGroup(DOCS, "web");
  assert.deepEqual(fake.calls.map(({ call }) => call), ["group fix web"]);
  assert.equal(backlog.pendingId, "fix");
  fake.calls[0]!.answer(view({ ...FIX, group: "web" }));
  await settle();
  assert.equal(backlog.pendingId, "");
  assert.equal(backlog.items[0]?.group, "web");
  assert.deepEqual(notes, ["Moving Fix the toast to WEB…", "Moved Fix the toast to WEB."]);
});

test("a started task leaves the column at once and both lists are read again", async () => {
  const { backlog, notes, sessionRefreshes } = setup();
  void backlog.refresh();
  fake.calls[0]!.answer(view(FIX, DOCS));
  await settle();
  backlog.openStart(FIX, { stage: "testing", group: "" });
  await settle();
  assert.equal(backlog.starting?.item, FIX);
  backlog.started({ title: "Fix the toast", stage: "testing" } as SessionView, FIX);
  assert.equal(backlog.starting, undefined);
  assert.deepEqual(backlog.items, [DOCS]);
  assert.equal(sessionRefreshes(), 1);
  assert.equal(fake.calls.at(-1)?.call, "load");
  assert.deepEqual(notes, ["Started “Fix the toast” from the backlog in Testing."]);
});

test("removing asks first, can't be cancelled while it runs, and closes either way", async () => {
  const { backlog, notes } = setup();
  const submit = { preventDefault: () => {} } as Event;
  backlog.askRemove(FIX);
  backlog.cancelRemove();
  assert.equal(backlog.removing, undefined);
  backlog.askRemove(FIX);
  backlog.confirmRemove(submit);
  backlog.cancelRemove();
  assert.equal(backlog.removing, FIX, "Cancel waits for the removal under way");
  fake.calls[0]!.answer(view(DOCS));
  await settle();
  assert.equal(backlog.removing, undefined);
  assert.deepEqual(backlog.items, [DOCS]);
  backlog.askRemove(DOCS);
  backlog.confirmRemove(submit);
  fake.calls[1]!.answer(new Error("gone"));
  await settle();
  assert.equal(backlog.removing, undefined);
  assert.equal(backlog.pendingId, "");
  assert.deepEqual(notes, ["Removed “Fix the toast” from the backlog.", "error: gone"]);
});

test("linking Jira to a backlog task reads the backlog again; linking a session reads the sessions", async () => {
  const { backlog, notes, sessionRefreshes } = setup();
  backlog.cardAction(FIX, "jira:link");
  await settle();
  assert.equal(backlog.jiraLinkBacklogItem, FIX);
  backlog.jiraLinked({ key: "HUI-1", url: "https://jira/HUI-1", backlogItemId: "fix" });
  assert.equal(backlog.jiraLinkBacklogItem, undefined);
  assert.deepEqual(fake.calls.map(({ call }) => call), ["load"]);
  assert.equal(sessionRefreshes(), 0);
  backlog.openJiraLink(SOURCE);
  await settle();
  assert.equal(backlog.jiraLinkSession, SOURCE);
  backlog.jiraLinked({ key: "HUI-2", url: "https://jira/HUI-2" });
  assert.equal(backlog.jiraLinkSession, undefined);
  assert.equal(sessionRefreshes(), 1);
  assert.equal(fake.calls.length, 1, "away from the board the backlog is not read for a session link");
  assert.deepEqual(notes, ["Linked Jira work item HUI-1 to the backlog task.", "Linked Jira work item HUI-2."]);
});

test("on the board, a session link also reads the backlog", () => {
  const { backlog, notes, sessionRefreshes } = setup({ kanban: true });
  backlog.jiraLinked({ key: "HUI-3", url: "https://jira/HUI-3" });
  assert.deepEqual(fake.calls.map(({ call }) => call), ["load"]);
  assert.equal(sessionRefreshes(), 1);
  assert.deepEqual(notes, ["Linked Jira work item HUI-3.", "Linked Jira work item HUI-3."]);
});

test("a filed suggestion leaves its card at once and the panes hear of it", async () => {
  const { backlog, notes, paneChanges } = setup();
  backlog.adoptSnapshot([suggestion("a"), suggestion("b")], []);
  assert.deepEqual(fake.calls.map(({ call }) => call), ["jira connection"], "suggestions ask once whether Jira is connected");
  fake.calls[0]!.answer({ configured: true });
  await settle();
  assert.equal(backlog.jiraConfigured, true);
  backlog.setSuggestionIndex(5);
  assert.equal(backlog.taskSuggestionIndex, 1);
  backlog.fileSuggestionInJira(backlog.taskSuggestions[1]!);
  await settle();
  assert.equal(backlog.jiraCreateSession, SOURCE);
  backlog.jiraCreated({ key: "HUI-4", url: "https://jira/HUI-4", suggestionId: "b" });
  assert.deepEqual(backlog.taskSuggestions.map(({ id }) => id), ["a"]);
  assert.equal(backlog.taskSuggestionIndex, 0);
  assert.equal(backlog.jiraCreateSession, undefined);
  assert.equal(backlog.jiraCreateSuggestion, undefined);
  assert.equal(paneChanges(), 1);
  assert.deepEqual(notes, ["Created Jira work item HUI-4."]);
});

test("a newly flagged suggestion shows first; otherwise the operator keeps their place", () => {
  const { backlog } = setup();
  backlog.adoptSnapshot([suggestion("a"), suggestion("b")], []);
  backlog.setSuggestionIndex(1);
  backlog.adoptSnapshot([suggestion("a"), suggestion("b"), suggestion("c")], []);
  assert.equal(backlog.taskSuggestionIndex, 1);
  backlog.adoptSnapshot([suggestion("new"), suggestion("a")], []);
  assert.equal(backlog.taskSuggestionIndex, 0);
});

test("saving a suggestion to the backlog runs once and drops the answer for another session", async () => {
  const { backlog, notes, shell } = setup();
  backlog.adoptSnapshot([suggestion("a")], []);
  backlog.saveSuggestionToBacklog(backlog.taskSuggestions[0]!);
  backlog.saveSuggestionToBacklog(backlog.taskSuggestions[0]!);
  assert.deepEqual(fake.calls.map(({ call }) => call), ["jira connection", "backlog source a"]);
  assert.equal(backlog.taskSuggestionPendingId, "a");
  shell.selected = { id: "other" } as SessionView;
  fake.calls[1]!.answer([]);
  await settle();
  assert.deepEqual(backlog.taskSuggestions.map(({ id }) => id), ["a"]);
  assert.equal(backlog.taskSuggestionPendingId, "");
  assert.deepEqual(notes, ["info note: Added “Do a” to the Kanban backlog."]);
});
