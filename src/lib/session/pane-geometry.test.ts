import assert from "node:assert/strict";
import { test } from "vitest";
import { paneColumnMinimum, paneTrackSizes, sessionPaneGeometry } from "./pane-geometry.ts";
import { closeSessionPane, moveSessionPane, resizeSessionLayout, singleSessionLayout, splitSessionPane } from "./multiplexer.ts";

test("tracks redistribute constrained space and overflow rather than overlap", () => {
  assert.deepEqual(paneTrackSizes(1006, [0.5, 0.5], 320), [500, 500]);
  assert.deepEqual(paneTrackSizes(1006, [0.15, 0.85], 320), [320, 680]);
  assert.deepEqual(paneTrackSizes(400, [0.5, 0.5], 320), [320, 320]);
  assert.deepEqual(paneTrackSizes(1212, [0.05, 0.05, 0.9], 320), [320, 320, 560]);
});

test("flat pane geometry retains independent row sizes and correctly sized resize hit areas", () => {
  let layout = splitSessionPane(singleSessionLayout("a"), "p1", "b", "right");
  layout = splitSessionPane(layout, "p2", "c", "down");
  layout = resizeSessionLayout(layout, "c2", 0, 0.7);
  const geometry = sessionPaneGeometry(layout, 1006, 606);
  assert.deepEqual(geometry.panes.get("p1"), { left: 0, top: 0, width: 500, height: 606 });
  assert.deepEqual(geometry.panes.get("p2"), { left: 506, top: 0, width: 500, height: 400 });
  assert.deepEqual(geometry.panes.get("p3"), { left: 506, top: 406, width: 500, height: 200 });
  assert.equal(geometry.dividers.find(({ columnId }) => columnId)?.extent, 600);
  assert.equal(geometry.dividers.find(({ columnId }) => !columnId)?.extent, 1000);
  const moved = sessionPaneGeometry(moveSessionPane(layout, "p1", "p3", { kind: "center" }), 1006, 606);
  assert.deepEqual(moved.panes.get("p1"), geometry.panes.get("p3"));
  assert.deepEqual(moved.panes.get("p3"), geometry.panes.get("p1"));
  assert.equal(moved.panes.size, 3);
});

test("beside an open Work pane each chat column keeps 420px when the room allows, rebalancing by weight", () => {
  // Three columns, one closed: the survivors' saved weights would have given 514/320.
  let layout = splitSessionPane(singleSessionLayout("a"), "p1", "b", "right");
  layout = splitSessionPane(layout, "p2", "c", "right");
  layout = { ...layout, columnWeights: [0.62, 0.27, 0.11] };
  layout = closeSessionPane(layout, "p3");
  const widths = (geometry: ReturnType<typeof sessionPaneGeometry>) => ["p1", "p2"].map((id) => Math.round(geometry.panes.get(id)!.width));
  assert.deepEqual(widths(sessionPaneGeometry(layout, 846, 600)), [520, 320], "without the pane the old 320px floor applies");
  assert.deepEqual(widths(sessionPaneGeometry(layout, 846, 600, 420)), [420, 420]);
  // More room: proportional above the floor.
  assert.deepEqual(widths(sessionPaneGeometry(layout, 1206, 600, 420)), [780, 420]);
  assert.deepEqual(widths(sessionPaneGeometry(layout, 2006, 600, 420)), [1393, 607]);
  // Three columns where 420 each cannot fit: an equal share, never below 320.
  const three = { ...splitSessionPane(splitSessionPane(singleSessionLayout("a"), "p1", "b", "right"), "p2", "c", "right"), columnWeights: [0.6, 0.2, 0.2] };
  const squeezed = sessionPaneGeometry(three, 1150, 600, 420);
  assert.deepEqual(["p1", "p2", "p3"].map((id) => Math.round(squeezed.panes.get(id)!.width)), [380, 379, 379]);
  assert.equal(paneColumnMinimum(1150, 3, 420), 379);
  assert.equal(paneColumnMinimum(900, 3, 420), 320, "never below the usual floor; the row scrolls instead");
  assert.equal(paneColumnMinimum(846, 2, 420), 420);
  assert.equal(paneColumnMinimum(846, 2), 320);
  assert.equal(paneColumnMinimum(200, 1, 420), 200, "a single column narrower than the floor fills the row");
});

test("the chat splitter cannot drag a column below its minimum", () => {
  const layout = splitSessionPane(singleSessionLayout("a"), "p1", "b", "right");
  const beside = sessionPaneGeometry(layout, 1006, 600, 420).dividers.find(({ columnId }) => !columnId)!;
  const range = (divider: { minRatio: number; maxRatio: number }) => [divider.minRatio, divider.maxRatio].map((ratio) => Math.round(ratio * 1000) / 1000);
  assert.equal(beside.extent, 1000);
  assert.deepEqual(range(beside), [0.42, 0.58]);
  const alone = sessionPaneGeometry(layout, 1006, 600).dividers.find(({ columnId }) => !columnId)!;
  assert.deepEqual(range(alone), [0.32, 0.68]);
  const wide = sessionPaneGeometry(layout, 3006, 600).dividers.find(({ columnId }) => !columnId)!;
  assert.deepEqual([wide.minRatio, wide.maxRatio], [0.15, 0.85], "the divider's usual limits still hold");
  const tight = sessionPaneGeometry(layout, 806, 600, 420).dividers.find(({ columnId }) => !columnId)!;
  assert.deepEqual([tight.minRatio, tight.maxRatio], [0.5, 0.5], "no room to move keeps the middle");
  // Weights of 2:1 held at 420/420 report the split the columns show, inside the range (aria-valuenow too).
  const uneven = sessionPaneGeometry({ ...layout, columnWeights: [2 / 3, 1 / 3] }, 846, 600, 420).dividers.find(({ columnId }) => !columnId)!;
  assert.equal(uneven.ratio, 0.5);
  assert.equal(sessionPaneGeometry({ ...layout, columnWeights: [2 / 3, 1 / 3] }, 1406, 600).dividers[0]!.ratio, 2 / 3, "a free split keeps its weights");
  const rows = sessionPaneGeometry(splitSessionPane(singleSessionLayout("a"), "p1", "b", "down"), 800, 1006).dividers.find(({ columnId }) => columnId)!;
  assert.equal(rows.minRatio, 0.2, "stacked panes keep 200px");
});
