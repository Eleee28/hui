import assert from "node:assert/strict";
import { test } from "vitest";
import {
  HUI_SESSION_DRAG_TYPE,
  MAX_SESSION_PANE_RATIO,
  MIN_SESSION_PANE_RATIO,
  clampSessionPaneRatio,
  readSessionDragId,
  sessionPaneRatioAt,
  sessionPaneRatioForKey,
  writeSessionDrag,
} from "./pane-layout.ts";

test("session drag payload supports both pane-copy and group-move destinations", () => {
  const values = new Map<string, string>();
  const transfer = {
    effectAllowed: "none" as DataTransfer["effectAllowed"],
    setData(type: string, value: string) { values.set(type, value); },
    getData(type: string) { return values.get(type) ?? ""; },
  };

  writeSessionDrag(transfer, { id: "session-2", title: "Second session" });

  assert.equal(transfer.effectAllowed, "copyMove");
  assert.equal(values.get(HUI_SESSION_DRAG_TYPE), "session-2");
  assert.equal(values.get("text/plain"), "Second session");
  assert.equal(readSessionDragId(transfer), "session-2");
  assert.equal(readSessionDragId(null), "");
});

test("pane resizing follows the pointer and keeps both panes usable", () => {
  assert.equal(sessionPaneRatioAt(500, 0, 1000), 0.5);
  assert.equal(sessionPaneRatioAt(-100, 0, 1000), MIN_SESSION_PANE_RATIO);
  assert.equal(sessionPaneRatioAt(1200, 0, 1000), MAX_SESSION_PANE_RATIO);
  assert.equal(sessionPaneRatioAt(200, 0, 0), 0.5);
  assert.equal(clampSessionPaneRatio(Number.NaN), 0.5);
});

test("pane separator supports keyboard resizing", () => {
  assert.equal(sessionPaneRatioForKey(0.5, "ArrowLeft"), 0.45);
  assert.equal(sessionPaneRatioForKey(0.5, "ArrowRight"), 0.55);
  assert.equal(sessionPaneRatioForKey(0.5, "Home"), MIN_SESSION_PANE_RATIO);
  assert.equal(sessionPaneRatioForKey(0.5, "End"), MAX_SESSION_PANE_RATIO);
  assert.equal(sessionPaneRatioForKey(0.5, "Enter"), undefined);
});
