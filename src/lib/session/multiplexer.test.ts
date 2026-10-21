import assert from "node:assert/strict";
import { test } from "vitest";
import { addSessionTab, isChatPane, moveSessionPane, visibleSessionPanes, sessionPaneMoveTarget } from "./multiplexer.ts";
import { activeSessionPane, closeSessionPane, focusSessionPane, locateSessionPane, parseSessionLayout, replacePaneSession, resizeSessionLayout, resizeSessionWeights, SESSION_SPLIT_MEDIA, sessionDropRect, sessionDropZone, sessionPanes, singleSessionLayout, splitSessionPane, type SessionLayout, type SessionPane, type SplitDirection } from "./multiplexer.ts";

// Terminal and browser panes are no longer created (they live in the Work pane), but layouts saved before it hold
// them; these build that stored shape so the format stays readable and movable until loading migrates it.
function replacePaneTerminal(layout: SessionLayout, paneId: string, terminalId: string): SessionLayout {
  const next = structuredClone(layout);
  const pane = locateSessionPane(next, paneId)?.pane;
  if (pane) pane.terminalId = terminalId;
  return next;
}
function splitTerminalPane(layout: SessionLayout, paneId: string, owner: string, terminalId: string, direction: SplitDirection): SessionLayout {
  const next = splitSessionPane(layout, paneId, owner, direction);
  return next === layout ? layout : replacePaneTerminal(next, next.activePaneId, terminalId);
}
function splitBrowserPane(layout: SessionLayout, paneId: string, owner: string, direction: SplitDirection): SessionLayout {
  const next = structuredClone(splitSessionPane(layout, paneId, owner, direction));
  const pane = locateSessionPane(next, next.activePaneId)?.pane;
  if (next.activePaneId !== layout.activePaneId && pane) pane.browser = true;
  return next.activePaneId === layout.activePaneId ? layout : next;
}
function browserPaneFor(layout: SessionLayout, sessionId: string): SessionPane | undefined {
  return sessionPanes(layout).find((pane) => pane.browser && pane.sessionId === sessionId);
}

test("all four edges insert alongside the targeted column or within its stack", () => {
  const initial = singleSessionLayout("alpha");
  const right = splitSessionPane(initial, "p1", "beta", "right");
  const left = splitSessionPane(right, "p1", "gamma", "left");
  const down = splitSessionPane(left, "p1", "delta", "down");
  const up = splitSessionPane(down, "p1", "epsilon", "up");
  assert.deepEqual(up.columns.map((c) => c.panes.map((p) => p.sessionId)), [["gamma"], ["epsilon", "alpha", "delta"], ["beta"]]);
  assert.deepEqual(up.columnWeights, [0.25, 0.25, 0.5]);
  assert.deepEqual(up.columns[1]!.paneWeights, [0.25, 0.25, 0.5]);
  assert.equal(activeSessionPane(up).sessionId, "epsilon");
  assert.deepEqual(initial, singleSessionLayout("alpha"));
});

test("splitting the same session creates independent pane identities", () => {
  const layout = splitSessionPane(singleSessionLayout("alpha"), "p1", "alpha", "right");
  assert.deepEqual(sessionPanes(layout).map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(sessionPanes(layout).map((p) => p.sessionId), ["alpha", "alpha"]);
});

test("center replacement and focus preserve unrelated pane identities and weights", () => {
  const original = splitSessionPane(singleSessionLayout("alpha"), "p1", "beta", "right");
  const next = replacePaneSession(focusSessionPane(original, "p1"), "p1", "gamma");
  assert.equal(activeSessionPane(next).sessionId, "gamma");
  assert.deepEqual(next.columns[1], original.columns[1]);
  assert.deepEqual(next.columnWeights, original.columnWeights);
  assert.equal(sessionPanes(original)[0]!.sessionId, "alpha");
});

test("either column can close and the survivor retains its pane and column identity", () => {
  const layout = splitSessionPane(singleSessionLayout("alpha"), "p1", "beta", "right");
  for (const id of ["p1", "p2"]) {
    const next = closeSessionPane(layout, id);
    assert.equal(sessionPanes(next).length, 1);
    assert.deepEqual(next.columnWeights, [1]);
    assert.equal(activeSessionPane(next).id, id === "p1" ? "p2" : "p1");
    assert.equal(next.columns[0]!.id, id === "p1" ? "c2" : "c1");
    assert.strictEqual(closeSessionPane(next, next.activePaneId), next);
  }
  assert.equal(sessionPanes(layout).length, 2);
});

test("close selects previous stacked pane, then previous column, then first survivor", () => {
  let layout = splitSessionPane(singleSessionLayout("alpha"), "p1", "beta", "right");
  layout = splitSessionPane(layout, "p2", "gamma", "down");
  assert.equal(closeSessionPane(layout, "p3").activePaneId, "p2");
  assert.equal(closeSessionPane(focusSessionPane(layout, "p2"), "p2").activePaneId, "p1");
  const next = closeSessionPane(focusSessionPane(layout, "p1"), "p1");
  assert.equal(next.activePaneId, "p2");
  assert.deepEqual(next.columns[0]!.paneWeights, [0.5, 0.5]);
  assert.equal(closeSessionPane(layout, "p1").activePaneId, "p3");
});

test("resize redistributes only the adjacent pair and clamps like OpenClaw", () => {
  assert.deepEqual(resizeSessionWeights([0.2, 0.3, 0.5], 1, 0.75), [0.2, 0.6000000000000001, 0.2]);
  assert.deepEqual(resizeSessionWeights([0.5, 0.5], 0, 0), [0.15, 0.85]);
  assert.deepEqual(resizeSessionWeights([0.5, 0.5], 0, 1), [0.85, 0.15000000000000002]);
  assert.deepEqual(resizeSessionWeights([1], 0, 0.5), [1]);
  assert.deepEqual(resizeSessionWeights([0.5, 0.5], 0, NaN), [0.5, 0.5]);
  let layout = splitSessionPane(singleSessionLayout("a"), "p1", "b", "right");
  layout = splitSessionPane(layout, "p2", "c", "down");
  const columns = resizeSessionLayout(layout, undefined, 0, 0.6);
  const rows = resizeSessionLayout(columns, "c2", 0, 0.7);
  assert.deepEqual(rows.columnWeights, [0.6, 0.4]);
  assert.deepEqual(rows.columns[1]!.paneWeights, [0.7, 0.30000000000000004]);
  assert.deepEqual(layout.columnWeights, [0.5, 0.5]);
});

test("drop hit testing uses 30% bands and normalized nearest-edge corner distance", () => {
  const rect = { left: 100, top: 200, width: 800, height: 600 };
  for (const [x, y, edge] of [[0.1, 0.5, "left"], [0.9, 0.5, "right"], [0.5, 0.1, "up"], [0.5, 0.9, "down"], [0.1, 0.2, "left"], [0.2, 0.1, "up"], [0.3, 0.5, "left"]] as const) {
    assert.deepEqual(sessionDropZone(rect, rect.left + rect.width * x, rect.top + rect.height * y), { kind: "edge", edge });
  }
  assert.deepEqual(sessionDropZone(rect, 500, 500), { kind: "center" });
  assert.deepEqual(sessionDropRect(rect, { kind: "edge", edge: "right" }), { left: 500, top: 200, width: 400, height: 600 });
  assert.deepEqual(sessionDropRect(rect, { kind: "edge", edge: "down" }), { left: 100, top: 500, width: 800, height: 300 });
  assert.deepEqual(sessionDropRect(rect, { kind: "center" }), rect);
});

test("local layout restores safely and rejects corrupt ids, weights or shapes", () => {
  const layout = splitSessionPane(singleSessionLayout("a"), "p1", "b", "down");
  assert.deepEqual(parseSessionLayout(JSON.parse(JSON.stringify(layout))), layout);
  const bad = (mutate: (layout: SessionLayout) => void) => {
    const copy = structuredClone(layout);
    mutate(copy);
    assert.equal(parseSessionLayout(copy), undefined);
  };
  bad((l) => { l.activePaneId = "p999"; });
  bad((l) => { l.columns[0]!.panes[1]!.id = "p1"; });
  bad((l) => { l.columns[0]!.paneWeights[1] = NaN; });
  bad((l) => { l.columnWeights = []; });
  bad((l) => { l.columns[0]!.panes[0]!.sessionId = ""; });
  bad((l) => { l.columns[0]!.panes = []; });
  assert.equal(parseSessionLayout(null), undefined);
  assert.equal(parseSessionLayout({ columns: [] }), undefined);
  assert.equal(SESSION_SPLIT_MEDIA, "(max-width: 1099px)");
  assert.equal(locateSessionPane(layout, "missing"), undefined);
});

test("drop previews preserve DOMRect prototype dimensions for center and edge zones", () => {
  const domRect = Object.create({ left: 20, top: 30, width: 800, height: 600 });
  assert.deepEqual(sessionDropRect(domRect, { kind: "center" }), { left: 20, top: 30, width: 800, height: 600 });
  assert.deepEqual(sessionDropRect(domRect, { kind: "edge", edge: "left" }), { left: 20, top: 30, width: 400, height: 600 });
  assert.deepEqual(sessionDropRect(domRect, { kind: "edge", edge: "up" }), { left: 20, top: 30, width: 800, height: 300 });
});

test("terminal panes keep owner, identity and sizing through reload and session replacement", () => {
  const id = "90fa8a65-bef7-4c0c-9e57-38b6f45ca52a";
  const original = singleSessionLayout("alpha");
  const layout = splitTerminalPane(original, "p1", "alpha", id, "down");
  assert.deepEqual(activeSessionPane(layout), { id: "p2", sessionId: "alpha", terminalId: id });
  assert.deepEqual(parseSessionLayout(JSON.parse(JSON.stringify(layout))), layout);
  assert.deepEqual(original, singleSessionLayout("alpha"));
  const replaced = replacePaneSession(layout, "p2", "beta");
  assert.deepEqual(activeSessionPane(replaced), { id: "p2", sessionId: "beta" });
  assert.deepEqual(replaced.columns[0]!.paneWeights, layout.columns[0]!.paneWeights);
  assert.deepEqual(activeSessionPane(closeSessionPane(layout, "p2")), { id: "p1", sessionId: "alpha" });
  assert.equal(parseSessionLayout(replacePaneTerminal(layout, "p2", "invalid")), undefined);
});

test("a browser pane belongs to its session, survives reload and yields to the chat on replacement", () => {
  const layout = splitBrowserPane(singleSessionLayout("alpha"), "p1", "alpha", "right");
  assert.deepEqual(sessionPanes(layout), [{ id: "p1", sessionId: "alpha" }, { id: "p2", sessionId: "alpha", browser: true }]);
  assert.equal(activeSessionPane(layout).id, "p2");
  assert.equal(browserPaneFor(layout, "alpha")?.id, "p2");
  assert.equal(browserPaneFor(layout, "beta"), undefined);
  assert.deepEqual(sessionPanes(layout).map(isChatPane), [true, false]);
  assert.equal(isChatPane({ id: "p3", sessionId: "alpha", terminalId: "00000000-0000-4000-8000-000000000000" }), false);
  assert.deepEqual(parseSessionLayout(JSON.parse(JSON.stringify(layout))), layout);
  assert.deepEqual(sessionPanes(replacePaneSession(layout, "p2", "beta"))[1], { id: "p2", sessionId: "beta" });
  assert.equal(splitBrowserPane(layout, "missing", "alpha", "right"), layout);
  const stored = JSON.parse(JSON.stringify(layout));
  stored.columns[1].panes[0].browser = "yes";
  assert.equal(parseSessionLayout(stored), undefined);
  stored.columns[1].panes[0].browser = true;
  stored.columns[1].panes[0].terminalId = "00000000-0000-4000-8000-000000000000";
  assert.equal(parseSessionLayout(stored), undefined, "a pane is a browser or a terminal, never both");
});

test("center moves swap whole panes across columns without changing sizes or owners", () => {
  const terminalId = "90fa8a65-bef7-4c0c-9e57-38b6f45ca52a";
  const initial = splitTerminalPane(singleSessionLayout("alpha"), "p1", "alpha", terminalId, "right");
  const before = structuredClone(initial);
  const moved = moveSessionPane(initial, "p2", "p1", { kind: "center" });
  assert.deepEqual(moved.columns.map((c) => c.panes.map((p) => p.id)), [["p2"], ["p1"]]);
  assert.equal(activeSessionPane(moved).terminalId, terminalId);
  assert.deepEqual(moved.columnWeights, initial.columnWeights);
  assert.deepEqual(initial, before);
  assert.deepEqual(parseSessionLayout(JSON.parse(JSON.stringify(moved))), moved);
});

test("edge moves reuse pane identities, remove empty columns and retain every view exactly once", () => {
  let initial = splitSessionPane(singleSessionLayout("same"), "p1", "same", "right");
  initial = splitSessionPane(initial, "p2", "third", "down");
  for (const edge of ["left", "right", "up", "down"] as const) {
    const moved = moveSessionPane(initial, "p1", "p3", { kind: "edge", edge });
    assert.deepEqual(sessionPanes(moved).map(({ id }) => id).sort(), ["p1", "p2", "p3"]);
    assert.equal(activeSessionPane(moved).id, "p1");
    assert.equal(moved.columns.some(({ id }) => id === "c1"), false);
    assert.equal(moved.columns.length, edge === "up" || edge === "down" ? 1 : 2);
    assert.ok(parseSessionLayout(moved));
    assert.equal(sessionPanes(moved).filter(({ sessionId }) => sessionId === "same").length, 2);
  }
  const rows = moveSessionPane(initial, "p1", "p3", { kind: "edge", edge: "up" });
  assert.deepEqual(rows.columns[0]!.panes.map(({ id }) => id), ["p2", "p1", "p3"]);
  const reordered = moveSessionPane(rows, "p3", "p2", { kind: "edge", edge: "up" });
  assert.deepEqual(reordered.columns[0]!.panes.map(({ id }) => id), ["p3", "p2", "p1"]);
  assert.deepEqual(initial.columns.map((c) => c.panes.map((p) => p.id)), [["p1"], ["p2", "p3"]]);
});

test("self drops and missing or stale pane identities are inert", () => {
  const layout = splitSessionPane(singleSessionLayout("a"), "p1", "b", "right");
  for (const [source, target] of [["p1", "p1"], ["missing", "p2"], ["p1", "missing"]]) {
    for (const zone of [{ kind: "center" }, { kind: "edge", edge: "down" }] as const) {
      assert.strictEqual(moveSessionPane(layout, source!, target!, zone), layout);
    }
  }
});

test("keyboard movement finds neighbors for columns, stacks and transitions between them", () => {
  let layout = splitSessionPane(singleSessionLayout("a"), "p1", "b", "right");
  layout = splitSessionPane(layout, "p2", "c", "down");
  assert.equal(sessionPaneMoveTarget(layout, "p1", "right"), "p2");
  assert.equal(sessionPaneMoveTarget(layout, "p2", "left"), "p1");
  assert.equal(sessionPaneMoveTarget(layout, "p2", "down"), "p3");
  assert.equal(sessionPaneMoveTarget(layout, "p3", "up"), "p2");
  assert.equal(sessionPaneMoveTarget(layout, "p2", "up"), "p1");
  assert.equal(sessionPaneMoveTarget(layout, "p1", "down"), "p2");
  assert.equal(sessionPaneMoveTarget(layout, "p1", "left"), undefined);
  const stacked = moveSessionPane(layout, "p1", "p2", { kind: "edge", edge: "up" });
  assert.equal(sessionPaneMoveTarget(stacked, "p1", "right"), "p2");
});

test("repeated moves preserve a valid persisted layout and all session/terminal identities", () => {
  let layout = splitTerminalPane(singleSessionLayout("same"), "p1", "same", "90fa8a65-bef7-4c0c-9e57-38b6f45ca52a", "right");
  layout = splitSessionPane(layout, "p1", "same", "down");
  layout = splitSessionPane(layout, "p2", "other", "down");
  const identities = sessionPanes(layout).sort((a, b) => a.id.localeCompare(b.id));
  let seed = 1982;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 300; i++) {
    const before = structuredClone(layout);
    const panes = sessionPanes(layout);
    const source = panes[Math.floor(random() * panes.length)]!.id;
    const target = panes[Math.floor(random() * panes.length)]!.id;
    const edge = (["left", "right", "up", "down"] as const)[Math.floor(random() * 4)]!;
    const moved = moveSessionPane(layout, source, target, i % 3 ? { kind: "edge", edge } : { kind: "center" });
    assert.deepEqual(layout, before);
    assert.deepEqual(sessionPanes(moved).sort((a, b) => a.id.localeCompare(b.id)), identities);
    assert.deepEqual(parseSessionLayout(moved), moved);
    layout = moved;
  }
});

test("tabs share a spot, show one pane and survive a save", () => {
  const split = splitSessionPane(singleSessionLayout("alpha"), "p1", "beta", "right");
  const tabbed = addSessionTab(split, "p1", "gamma");
  assert.deepEqual(visibleSessionPanes(tabbed).map(({ id }) => id), ["p3", "p2"]);
  assert.deepEqual(sessionPanes(tabbed).map(({ id, sessionId }) => `${id}:${sessionId}`), ["p1:alpha", "p3:gamma", "p2:beta"]);
  assert.equal(tabbed.activePaneId, "p3");
  assert.strictEqual(addSessionTab(tabbed, "p3", "alpha").columns[0]!.panes[0]!.id, "p1", "an open session's tab is reused");
  assert.equal(sessionPanes(addSessionTab(tabbed, "p3", "alpha")).length, 3);
  // Focusing a hidden tab shows it; closing the shown tab shows its neighbour.
  const back = focusSessionPane(tabbed, "p1");
  assert.deepEqual(visibleSessionPanes(back).map(({ id }) => id), ["p1", "p2"]);
  const closed = closeSessionPane(tabbed, "p3");
  assert.deepEqual(closed.columns[0]!.panes, [{ id: "p1", sessionId: "alpha" }]);
  assert.equal(closed.activePaneId, "p1");
  // Closing a hidden tab leaves the shown one alone.
  assert.deepEqual(visibleSessionPanes(closeSessionPane(tabbed, "p1")).map(({ id }) => id), ["p3", "p2"]);
  assert.equal(closeSessionPane(tabbed, "p1").activePaneId, "p3");
  // A split requested from a tab that was hidden meanwhile still opens beside its spot.
  assert.deepEqual(splitSessionPane(tabbed, "p1", "delta", "down").columns[0]!.panes.map(({ id }) => id), ["p3", "p4"]);
  assert.deepEqual(parseSessionLayout(JSON.parse(JSON.stringify(tabbed))), tabbed);
  const spot = tabbed.columns[0]!.panes[0]!;
  const withSpot = (pane: object) => parseSessionLayout({ ...tabbed, columns: [{ ...tabbed.columns[0], panes: [pane] }, tabbed.columns[1]] });
  assert.equal(withSpot({ ...spot, tabIndex: 9 }), undefined);
  assert.equal(withSpot({ ...spot, tabs: [{ ...spot.tabs![0], tabs: [{ id: "p9", sessionId: "x" }], tabIndex: 0 }] }), undefined, "no tabs inside tabs");
});

test("moving a pane adds it as a tab, splits it out, or swaps just that pane", () => {
  const split = splitSessionPane(singleSessionLayout("alpha"), "p1", "beta", "right");
  const tabbed = moveSessionPane(split, "p2", "p1", { kind: "tab" });
  assert.equal(tabbed.columns.length, 1);
  assert.deepEqual(sessionPanes(tabbed).map(({ id }) => id), ["p1", "p2"]);
  assert.equal(tabbed.activePaneId, "p2");
  assert.strictEqual(moveSessionPane(tabbed, "p1", "p2", { kind: "tab" }), tabbed, "its own spot is a no-op");
  // A hidden tab dragged to its own spot's edge becomes its own spot again.
  const out = moveSessionPane(tabbed, "p1", "p2", { kind: "edge", edge: "right" });
  assert.deepEqual(out.columns.map((column) => column.panes.map(({ id, tabs }) => `${id}${tabs ? "+" : ""}`)), [["p2"], ["p1"]]);
  // Center swaps only the dragged pane; the target spot keeps its other tabs.
  const three = addSessionTab(splitSessionPane(singleSessionLayout("alpha"), "p1", "beta", "right"), "p2", "gamma");
  const swapped = moveSessionPane(three, "p1", "p3", { kind: "center" });
  assert.deepEqual(visibleSessionPanes(swapped).map(({ id }) => id), ["p3", "p1"]);
  assert.deepEqual(sessionPanes(swapped).map(({ id }) => id), ["p3", "p2", "p1"]);
  // A hidden tab dropped on another spot's centre swaps in and its own spot keeps showing.
  const hidden = moveSessionPane(three, "p2", "p1", { kind: "center" });
  assert.deepEqual(visibleSessionPanes(hidden).map(({ id }) => id), ["p2", "p3"]);
  assert.deepEqual(sessionPanes(hidden).map(({ id }) => id), ["p2", "p1", "p3"]);
});
