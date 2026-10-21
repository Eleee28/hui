import assert from "node:assert/strict";
import { test } from "vitest";
import { html } from "lit";
import {
  activateWorkView, adjacentWorkView, clampWorkPaneWidth, closeWorkView, closingLastWorkView, defaultWorkViewKey, emptyWorkPane, launchableWorkViewKinds, migrateLayoutWorkViews,
  openWorkView, parseWorkPaneStore, pruneWorkPaneStore, registerWorkViewKind, reorderWorkView, retainWorkSessions, serializeWorkPaneStore,
  sessionWorkPane, setWorkPaneMaximized, setWorkPaneOpen, setWorkPaneWidth, workPaneFits, workPaneMaximized, workViewKey, workViewKind, workViewKinds,
  WORK_PANE_CHAT_MIN_WIDTH, WORK_PANE_DEFAULT_WIDTH, WORK_PANE_MAX_WIDTH, WORK_PANE_MIN_WIDTH,
  type WorkPaneStore, type WorkViewKind, type WorkViewRef,
} from "./work-pane.ts";
import { PANE_DIVIDER_SIZE } from "./session/pane-geometry.ts";
import { closeSessionPane, isChatPane, locateSessionPane, parseSessionLayout, sessionPanes, singleSessionLayout, splitSessionPane, visibleSessionPanes, addSessionTab, type SessionLayout } from "./session/multiplexer.ts";

const T1 = "90fa8a65-bef7-4c0c-9e57-38b6f45ca52a";
const T2 = "0b8f5d1e-7c9a-4e3b-8d2f-1a6c5e4b3a29";

function fakeKind<R extends WorkViewRef>(kind: R["kind"], key: (ref: R) => string): WorkViewKind<R> {
  return { kind, label: kind, icon: html`<svg width="16" height="16"></svg>`, create: () => { throw new Error("not in tests"); }, key, title: () => kind, render: () => html`` };
}
registerWorkViewKind(fakeKind<{ kind: "terminal"; terminalId: string }>("terminal", (ref) => `terminal:${ref.terminalId}`));
registerWorkViewKind({ ...fakeKind<{ kind: "browser" }>("browser", () => "browser"), single: true });
registerWorkViewKind(fakeKind<{ kind: "files"; id: string }>("files", (ref) => `files:${ref.id}`));

test("the registry keeps kinds in registration order and keys refs through their kind", () => {
  assert.deepEqual(workViewKinds().map(({ kind }) => kind), ["terminal", "browser", "files"]);
  assert.equal(workViewKind("browser")?.label, "browser");
  assert.equal(workViewKind("vscode"), undefined);
  assert.equal(workViewKey({ kind: "terminal", terminalId: T1 }), `terminal:${T1}`);
  // An unregistered kind still has a stable key.
  assert.equal(workViewKey({ kind: "vscode" }), "vscode");
  assert.equal(defaultWorkViewKey({ kind: "files", id: "a" }), "files:a");
  // Registering again replaces the kind without changing its place.
  registerWorkViewKind({ ...fakeKind<{ kind: "browser" }>("browser", () => "browser"), single: true });
  assert.deepEqual(workViewKinds().map(({ kind }) => kind), ["terminal", "browser", "files"]);
});

test("a single-view kind stops being offered as a launcher once its view is open; others always are", () => {
  const kindsOf = (views: WorkViewRef[]) => launchableWorkViewKinds({ views }).map(({ kind }) => kind);
  assert.deepEqual(kindsOf([]), ["terminal", "browser", "files"]);
  assert.deepEqual(kindsOf([{ kind: "browser" }, { kind: "terminal", terminalId: T1 }, { kind: "files", id: "a" }]), ["terminal", "files"]);
});

test("opening adds one tab per key, activates it and expands the pane; reopening only focuses it", () => {
  let store: WorkPaneStore = {};
  store = openWorkView(store, "s1", { kind: "terminal", terminalId: T1 });
  store = openWorkView(store, "s1", { kind: "browser" });
  assert.deepEqual(sessionWorkPane(store, "s1"), { open: true, width: WORK_PANE_DEFAULT_WIDTH, views: [{ kind: "terminal", terminalId: T1 }, { kind: "browser" }], active: "browser" });
  const again = openWorkView(store, "s1", { kind: "terminal", terminalId: T1 });
  assert.equal(sessionWorkPane(again, "s1").views.length, 2, "a conversation has at most one browser view and one tab per terminal");
  assert.equal(sessionWorkPane(again, "s1").active, `terminal:${T1}`);
  // Other conversations are untouched; a conversation never opened reads as the empty default.
  assert.deepEqual(sessionWorkPane(store, "s2"), emptyWorkPane());
  const quiet = openWorkView(setWorkPaneOpen(store, "s1", false), "s1", { kind: "files", id: "f" }, false);
  assert.equal(sessionWorkPane(quiet, "s1").open, false, "expand=false keeps a collapsed pane collapsed");
});

test("closing activates the previous tab, else the next, and keeps the pane open while views remain", () => {
  let store: WorkPaneStore = {};
  for (const ref of [{ kind: "terminal", terminalId: T1 }, { kind: "browser" }, { kind: "terminal", terminalId: T2 }] as WorkViewRef[]) store = openWorkView(store, "s1", ref);
  store = activateWorkView(store, "s1", "browser");
  store = closeWorkView(store, "s1", "browser");
  assert.equal(sessionWorkPane(store, "s1").active, `terminal:${T1}`);
  store = closeWorkView(store, "s1", `terminal:${T1}`);
  assert.equal(sessionWorkPane(store, "s1").active, `terminal:${T2}`);
  // Closing a background tab keeps the active one.
  const other = openWorkView(store, "s1", { kind: "browser" });
  assert.equal(sessionWorkPane(closeWorkView(other, "s1", `terminal:${T2}`), "s1").active, "browser");
  assert.equal(sessionWorkPane(closeWorkView(other, "s1", `terminal:${T2}`), "s1").open, true, "a remaining view keeps the pane open");
  assert.equal(closingLastWorkView(other, "s1", "browser"), false);
  assert.equal(closingLastWorkView(store, "s1", `terminal:${T2}`), true);
  assert.equal(closingLastWorkView(store, "s1", "missing"), false);
  assert.strictEqual(closeWorkView(store, "s1", "missing"), store);
  assert.strictEqual(activateWorkView(store, "s1", "missing"), store);
});

test("closing the last view hides the pane like Hide Work pane; showing it again lists the launchers", () => {
  let store: WorkPaneStore = openWorkView({}, "s1", { kind: "terminal", terminalId: T1 });
  store = setWorkPaneWidth(openWorkView(store, "s2", { kind: "browser" }), "s1", 700);
  const hidden = closeWorkView(store, "s1", `terminal:${T1}`);
  assert.deepEqual(sessionWorkPane(hidden, "s1"), { open: false, width: 700, views: [] }, "collapsed, its width kept");
  assert.strictEqual(hidden.s2, store.s2, "other conversations' panes are untouched");
  // Stored as closed, in the same format.
  assert.deepEqual(serializeWorkPaneStore(hidden).sessions.s1, { open: false, width: 700, views: [] });
  assert.deepEqual(parseWorkPaneStore(JSON.parse(JSON.stringify(serializeWorkPaneStore(hidden)))).s1, { open: false, width: 700, views: [] });
  // The toggle is not a no-op: it opens the empty pane, with its launchers.
  assert.deepEqual(sessionWorkPane(setWorkPaneOpen(hidden, "s1", true), "s1"), { open: true, width: 700, views: [] });
  // A view that ends by itself while the pane is collapsed leaves it collapsed.
  const collapsed = setWorkPaneOpen(store, "s1", false);
  assert.equal(sessionWorkPane(closeWorkView(collapsed, "s1", `terminal:${T1}`), "s1").open, false);
});

test("closing the last view of a maximized pane hides it and restores the chat", () => {
  const store = setWorkPaneMaximized(openWorkView({}, "s1", { kind: "files", id: "a" }), "s1", true);
  const hidden = closeWorkView(store, "s1", "files:a");
  assert.equal(sessionWorkPane(hidden, "s1").open, false);
  assert.equal("maximized" in sessionWorkPane(hidden, "s1"), false);
  assert.equal(workPaneMaximized(sessionWorkPane(setWorkPaneOpen(hidden, "s1", true), "s1"), false), false, "showing it again does not maximize it");
});

test("an open pane restored without views stays open: only closing a view hides it", () => {
  const restored = parseWorkPaneStore({ version: 1, sessions: { s1: { open: true, width: 600, views: [] }, s2: { open: true, width: 600, views: [{ kind: "vscode" }] } } });
  assert.deepEqual(restored.s1, { open: true, width: 600, views: [] });
  // A record whose only view is of an unknown kind loads empty, and still open.
  assert.deepEqual(restored.s2, { open: true, width: 600, views: [] });
  // Re-creating views (opening one already open) never closes anything.
  const store = openWorkView(restored, "s1", { kind: "browser" });
  assert.equal(sessionWorkPane(openWorkView(store, "s1", { kind: "browser" }), "s1").open, true);
});

test("reordering moves one tab and clamps the index; adjacent tabs wrap around", () => {
  let store: WorkPaneStore = {};
  for (const ref of [{ kind: "terminal", terminalId: T1 }, { kind: "browser" }, { kind: "files", id: "a" }] as WorkViewRef[]) store = openWorkView(store, "s1", ref);
  const keys = (s: WorkPaneStore) => sessionWorkPane(s, "s1").views.map(workViewKey);
  assert.deepEqual(keys(reorderWorkView(store, "s1", "files:a", 0)), ["files:a", `terminal:${T1}`, "browser"]);
  assert.deepEqual(keys(reorderWorkView(store, "s1", `terminal:${T1}`, 99)), ["browser", "files:a", `terminal:${T1}`]);
  assert.strictEqual(reorderWorkView(store, "s1", "browser", 1), store);
  assert.strictEqual(reorderWorkView(store, "s1", "browser", Number.NaN), store);
  const pane = sessionWorkPane(store, "s1");
  assert.equal(adjacentWorkView(pane, 1), `terminal:${T1}`);
  assert.equal(adjacentWorkView(pane, -1), "browser");
  assert.equal(adjacentWorkView(emptyWorkPane(), 1), undefined);
});

test("each side-by-side chat column keeps its room; the pane yields width down to its minimum", () => {
  // 1180px beside the sidebar: one chat column leaves 760px, two leave 334px (420px each and the 6px divider
  // between them), three cannot fit the pane at all.
  const twoColumns = 2 * WORK_PANE_CHAT_MIN_WIDTH + PANE_DIVIDER_SIZE;
  assert.equal(clampWorkPaneWidth(700, 1180, 1), 700);
  assert.equal(clampWorkPaneWidth(700, 1180, 2), 1180 - twoColumns);
  assert.equal(clampWorkPaneWidth(Number.POSITIVE_INFINITY, 1180, 2), 334, "End reaches the widest two columns allow");
  assert.equal(clampWorkPaneWidth(700, 1180, 3), WORK_PANE_MIN_WIDTH, "never below its own minimum");
  assert.equal(workPaneFits(1180, 1), true);
  assert.equal(workPaneFits(1180, 2), true);
  assert.equal(workPaneFits(twoColumns + WORK_PANE_MIN_WIDTH, 2), true, "exactly enough room");
  assert.equal(workPaneFits(twoColumns + WORK_PANE_MIN_WIDTH - 1, 2), false);
  assert.equal(workPaneFits(1180, 3), false, "three columns and the pane cannot all fit: the pane collapses to its rail");
  assert.equal(workPaneFits(0, 3), true, "before the row is measured nothing collapses");
  assert.equal(workPaneFits(undefined, 3), true);
  const store = setWorkPaneWidth({}, "s1", 700, 1180, 2);
  assert.equal(sessionWorkPane(store, "s1").width, 334);
});

test("widths stay between the minimum and what leaves the chat its room", () => {
  assert.equal(clampWorkPaneWidth(100), WORK_PANE_MIN_WIDTH);
  assert.equal(clampWorkPaneWidth(99_999), WORK_PANE_MAX_WIDTH);
  assert.equal(clampWorkPaneWidth(900, 1200), 1200 - WORK_PANE_CHAT_MIN_WIDTH);
  assert.equal(clampWorkPaneWidth(900, 500), WORK_PANE_MIN_WIDTH, "a cramped window still shows a usable pane");
  assert.equal(clampWorkPaneWidth(Number.NaN), WORK_PANE_DEFAULT_WIDTH);
  assert.equal(clampWorkPaneWidth(Number.POSITIVE_INFINITY, 1440), 1440 - WORK_PANE_CHAT_MIN_WIDTH, "End resizes to the widest the chat allows");
  assert.equal(clampWorkPaneWidth(612.4), 612);
  assert.equal(clampWorkPaneWidth(900, 1200, 0), 1200 - WORK_PANE_CHAT_MIN_WIDTH, "no chat column still counts as one");
  const store = setWorkPaneWidth({}, "s1", 700, 1440);
  assert.equal(sessionWorkPane(store, "s1").width, 700);
  assert.strictEqual(setWorkPaneWidth(store, "s1", 700, 1440), store);
  assert.strictEqual(setWorkPaneOpen(store, "s1", false), store);
});

test("loading tolerates garbage and drops unknown kinds, invalid refs and duplicate tabs", () => {
  for (const value of [null, undefined, 42, "x", [], { sessions: [] }, { sessions: "x" }]) assert.deepEqual(parseWorkPaneStore(value), {});
  const store = parseWorkPaneStore({
    version: 1,
    sessions: {
      s1: {
        open: true,
        width: 99_999,
        views: [
          { kind: "terminal", terminalId: T1 }, { kind: "terminal", terminalId: T1 }, { kind: "terminal", terminalId: "../etc" },
          { kind: "browser" }, { kind: "browser", extra: 1 }, { kind: "spreadsheet" }, { kind: "vscode" }, null, "files", { kind: "files", id: "" },
          { kind: "files", id: "notes" },
        ],
        active: "spreadsheet",
      },
      s2: { open: "yes", views: "none" },
      "": { open: true },
      "bad\u0007id": { open: true },
      s3: [],
    },
  });
  assert.deepEqual(store, {
    s1: { open: true, width: WORK_PANE_MAX_WIDTH, views: [{ kind: "terminal", terminalId: T1 }, { kind: "browser" }, { kind: "files", id: "notes" }], active: `terminal:${T1}` },
    s2: { open: false, width: WORK_PANE_DEFAULT_WIDTH, views: [] },
  });
  // A kind registered later (VS Code once enabled) is kept when the caller knows it.
  assert.deepEqual(parseWorkPaneStore({ sessions: { s1: { views: [{ kind: "vscode" }], active: "vscode" } } }, () => true).s1?.views, [{ kind: "vscode" }]);
});

test("the stored shape round-trips and leaves untouched conversations out", () => {
  let store: WorkPaneStore = openWorkView({}, "s1", { kind: "terminal", terminalId: T1 });
  store = setWorkPaneWidth(store, "s2", 700);
  store = { ...store, s3: emptyWorkPane() };
  const saved = serializeWorkPaneStore(store);
  assert.deepEqual(Object.keys(saved.sessions), ["s1", "s2"]);
  assert.equal(saved.version, 1);
  assert.deepEqual(parseWorkPaneStore(JSON.parse(JSON.stringify(saved))), { s1: store.s1, s2: store.s2 });
});

test("maximizing expands the pane over the chat; restoring keeps it open; hiding it also restores", () => {
  let store: WorkPaneStore = openWorkView({}, "s1", { kind: "terminal", terminalId: T1 }, false);
  store = setWorkPaneMaximized(store, "s1", true);
  assert.deepEqual(sessionWorkPane(store, "s1"), { open: true, maximized: true, width: WORK_PANE_DEFAULT_WIDTH, views: [{ kind: "terminal", terminalId: T1 }], active: `terminal:${T1}` });
  assert.strictEqual(setWorkPaneMaximized(store, "s1", true), store);
  assert.equal(workPaneMaximized(sessionWorkPane(store, "s1"), false), true);
  assert.equal(workPaneMaximized(sessionWorkPane(store, "s1"), true), false, "narrow screens show one panel at a time and ignore it");
  // Other conversations keep their own state.
  assert.equal(sessionWorkPane(store, "s2").maximized, undefined);
  const restored = setWorkPaneMaximized(store, "s1", false);
  assert.deepEqual(sessionWorkPane(restored, "s1"), { open: true, width: WORK_PANE_DEFAULT_WIDTH, views: [{ kind: "terminal", terminalId: T1 }], active: `terminal:${T1}` });
  assert.strictEqual(setWorkPaneMaximized(restored, "s1", false), restored);
  const hidden = setWorkPaneOpen(store, "s1", false);
  assert.equal(sessionWorkPane(hidden, "s1").open, false);
  assert.equal("maximized" in sessionWorkPane(hidden, "s1"), false, "showing it again brings the chat back beside it");
  assert.equal(workPaneMaximized(sessionWorkPane(setWorkPaneOpen(hidden, "s1", true), "s1"), false), false);
  // Tab changes keep the pane maximized.
  const tabbed = openWorkView(store, "s1", { kind: "browser" });
  assert.equal(sessionWorkPane(closeWorkView(tabbed, "s1", "browser"), "s1").maximized, true);
});

test("the maximized flag persists, and records without it (or collapsed ones with it) load as not maximized", () => {
  const store = setWorkPaneMaximized(openWorkView({}, "s1", { kind: "terminal", terminalId: T1 }), "s1", true);
  const saved = JSON.parse(JSON.stringify(serializeWorkPaneStore(store)));
  assert.equal(saved.sessions.s1.maximized, true);
  assert.deepEqual(parseWorkPaneStore(saved), { s1: store.s1 });
  const older = parseWorkPaneStore({ version: 1, sessions: { s1: { open: true, width: 600, views: [], active: "x" } } });
  assert.deepEqual(older.s1, { open: true, width: 600, views: [] });
  const odd = parseWorkPaneStore({ version: 1, sessions: { s1: { open: false, maximized: true, width: 600, views: [] }, s2: { open: true, maximized: "yes", width: 600, views: [] } } });
  assert.equal("maximized" in odd.s1!, false);
  assert.equal("maximized" in odd.s2!, false);
  // Not maximized is the default and is not written.
  assert.equal("maximized" in serializeWorkPaneStore(setWorkPaneMaximized(store, "s1", false)).sessions.s1!, false);
});

test("removed conversations are forgotten and only recently focused ones with views stay mounted", () => {
  let store: WorkPaneStore = {};
  for (const id of ["a", "b", "c", "d"]) store = openWorkView(store, id, { kind: "browser" });
  assert.strictEqual(pruneWorkPaneStore(store, new Set(["a", "b", "c", "d", "e"])), store);
  assert.deepEqual(Object.keys(pruneWorkPaneStore(store, new Set(["b", "d"]))), ["b", "d"]);
  let retained: string[] = [];
  for (const focused of ["a", "b", "empty", "c", "d"]) retained = retainWorkSessions(retained, focused, store);
  assert.deepEqual(retained, ["d", "c", "b"], "three conversations, most recent first, none without views");
  assert.deepEqual(retainWorkSessions(retained, "b", store), ["b", "d", "c"]);
  assert.deepEqual(retainWorkSessions(retained, undefined, store), ["d", "c", "b"]);
});

/* ── migration from the chat multiplexer ──────────────────────────────────── */

function withTerminal(layout: SessionLayout, paneId: string, terminalId: string): SessionLayout {
  const next = structuredClone(layout);
  for (const column of next.columns) for (const spot of column.panes) for (const pane of [spot, ...(spot.tabs ?? [])]) if (pane.id === paneId) pane.terminalId = terminalId;
  return next;
}
function withBrowser(layout: SessionLayout, paneId: string): SessionLayout {
  const next = structuredClone(layout);
  for (const column of next.columns) for (const spot of column.panes) for (const pane of [spot, ...(spot.tabs ?? [])]) if (pane.id === paneId) pane.browser = true;
  return next;
}

test("a saved layout with terminal and browser panes moves them into their conversations' Work panes", () => {
  // alpha | terminal(alpha) over beta-with-a-hidden-browser(beta)-tab ; focus on the terminal.
  let layout = splitSessionPane(singleSessionLayout("alpha"), "p1", "alpha", "right"); // p2
  layout = splitSessionPane(layout, "p2", "beta", "down"); // p3
  layout = addSessionTab(layout, "p3", "beta-browser-owner"); // p4 shown in p3's spot
  layout = { ...withBrowser(withTerminal(layout, "p2", T1), "p4"), activePaneId: "p2" };
  // The browser tab belongs to beta; addSessionTab used a placeholder session to create the tab.
  for (const column of layout.columns) for (const spot of column.panes) for (const pane of [spot, ...(spot.tabs ?? [])]) if (pane.id === "p4") pane.sessionId = "beta";
  const stored = JSON.parse(JSON.stringify(layout));
  const parsed = parseSessionLayout(stored);
  assert.ok(parsed, "the old format stays readable");

  const { layout: migrated, store, moved } = migrateLayoutWorkViews(parsed, {});
  assert.equal(moved, 2);
  assert.ok(sessionPanes(migrated).every(isChatPane));
  assert.deepEqual(sessionPanes(migrated).map(({ id, sessionId }) => `${id}:${sessionId}`), ["p1:alpha", "p3:beta"]);
  assert.deepEqual(migrated.columns.map((column) => column.panes.length), [1, 1], "the emptied stack collapses like a closed pane");
  assert.equal(migrated.activePaneId, "p1", "focus moves to the terminal's own conversation");
  assert.deepEqual(parseSessionLayout(JSON.parse(JSON.stringify(migrated))), migrated);
  assert.deepEqual(sessionWorkPane(store, "alpha"), { open: true, width: WORK_PANE_DEFAULT_WIDTH, views: [{ kind: "terminal", terminalId: T1 }], active: `terminal:${T1}` });
  assert.deepEqual(sessionWorkPane(store, "beta").views, [{ kind: "browser" }]);
  assert.equal(sessionWorkPane(store, "beta").open, true, "the browser tab was the shown one in its spot");
  // Stacked in one column, the focused terminal stays the active view over the browser shown below it.
  let stacked = splitSessionPane(singleSessionLayout("alpha"), "p1", "alpha", "right");
  stacked = splitSessionPane(stacked, "p2", "alpha", "down");
  stacked = { ...withBrowser(withTerminal(stacked, "p2", T1), "p3"), activePaneId: "p2" };
  assert.equal(sessionWorkPane(migrateLayoutWorkViews(stacked, {}).store, "alpha").active, `terminal:${T1}`);
  // Migrating again finds nothing to move.
  assert.equal(migrateLayoutWorkViews(migrated, store).moved, 0);
  assert.strictEqual(migrateLayoutWorkViews(migrated, store).layout, migrated);
});

test("a layout of a single terminal pane becomes that conversation's chat, and existing Work views are kept", () => {
  const layout = withTerminal(singleSessionLayout("alpha"), "p1", T2);
  const before = openWorkView({}, "alpha", { kind: "browser" });
  const { layout: migrated, store } = migrateLayoutWorkViews(layout, before);
  assert.deepEqual(sessionPanes(migrated), [{ id: "p1", sessionId: "alpha" }]);
  assert.deepEqual(sessionWorkPane(store, "alpha").views, [{ kind: "browser" }, { kind: "terminal", terminalId: T2 }]);
  assert.equal(sessionWorkPane(store, "alpha").active, `terminal:${T2}`);
});

test("a hidden terminal tab joins behind the conversation's active view without expanding a collapsed pane", () => {
  let layout = addSessionTab(singleSessionLayout("alpha"), "p1", "alpha-terminal"); // p2 shown
  layout = { ...withTerminal(layout, "p2", T1), activePaneId: "p2" };
  for (const column of layout.columns) for (const spot of column.panes) for (const pane of [spot, ...(spot.tabs ?? [])]) if (pane.id === "p2") pane.sessionId = "alpha";
  // Show the chat tab instead, so the terminal is the hidden one.
  const chatShown = parseSessionLayout(JSON.parse(JSON.stringify(layout)))!;
  const swapped = { ...chatShown, activePaneId: "p1", columns: [{ ...chatShown.columns[0]!, panes: [{ id: "p1", sessionId: "alpha", tabs: [{ id: "p2", sessionId: "alpha", terminalId: T1 }], tabIndex: 0 }] }] };
  const collapsed = setWorkPaneOpen(openWorkView({}, "alpha", { kind: "browser" }), "alpha", false);
  const { layout: migrated, store } = migrateLayoutWorkViews(parseSessionLayout(swapped)!, collapsed);
  assert.deepEqual(visibleSessionPanes(migrated), [{ id: "p1", sessionId: "alpha" }]);
  assert.equal(locateSessionPane(migrated, "p1")?.pane.tabs, undefined);
  assert.deepEqual(sessionWorkPane(store, "alpha"), { open: false, width: WORK_PANE_DEFAULT_WIDTH, views: [{ kind: "browser" }, { kind: "terminal", terminalId: T1 }], active: "browser" });
  assert.deepEqual(closeSessionPane(migrated, "p1"), migrated, "the chat remains the last pane");
});
