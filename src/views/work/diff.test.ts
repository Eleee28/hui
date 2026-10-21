import assert from "node:assert/strict";
import { test } from "vitest";
import { DIFF_WORK_VIEW_SHORTCUT, diffWorkViewKind, newDiffViewId } from "./diff.ts";
import { readDiffViewState, writeDiffViewState } from "../../lib/diff/view-state.ts";
import { defaultWorkViewKey, parseWorkViewRef } from "../../lib/work-pane.ts";
import { WORK_SHORTCUTS } from "../../lib/work-shortcuts.ts";

test("each Diff launch is a new view keyed by its id", async () => {
  const first = await diffWorkViewKind.create("session-a");
  const second = await diffWorkViewKind.create("session-a");
  assert.equal(first.kind, "diff");
  assert.notEqual(first.id, second.id);
  assert.equal(diffWorkViewKind.key(first), `diff:${first.id}`);
  assert.equal(diffWorkViewKind.key(first), defaultWorkViewKey(first));
  assert.match(newDiffViewId(), /^diff-/u);
  assert.equal(diffWorkViewKind.label, "Diff");
  assert.equal(diffWorkViewKind.title(first), "Diff");
  assert.equal(diffWorkViewKind.unavailable, undefined);
});

test("its shortcut is D in the Work pane scheme and its icon has an explicit size", () => {
  assert.equal(DIFF_WORK_VIEW_SHORTCUT, WORK_SHORTCUTS.diff);
  assert.equal(diffWorkViewKind.shortcut, "Mod+Alt+Shift+KeyD");
  assert.match(diffWorkViewKind.icon.strings.join(""), /width="16" height="16"/u);
});

test("a stored Diff tab survives a reload; a malformed one is dropped", () => {
  assert.deepEqual(parseWorkViewRef({ kind: "diff", id: "diff-1" }, () => true), { kind: "diff", id: "diff-1" });
  assert.equal(parseWorkViewRef({ kind: "diff", id: "" }, () => true), undefined);
  assert.equal(parseWorkViewRef({ kind: "diff", id: "x\u0000" }, () => true), undefined);
});

test("closing the tab forgets the view's remembered comparison", () => {
  const ref = { kind: "diff" as const, id: "diff-close-test" };
  writeDiffViewState(ref.id, { comparison: "last-commit" }, undefined);
  diffWorkViewKind.closed?.(ref, "session-a");
  assert.equal(readDiffViewState(ref.id, undefined).comparison, undefined);
});
