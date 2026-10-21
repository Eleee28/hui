import assert from "node:assert/strict";
import { test } from "vitest";
import { WORK_SHORTCUTS } from "../../lib/work-shortcuts.ts";
import { WORK_PANE_MAXIMIZE_SHORTCUT, WORK_PANE_TOGGLE_SHORTCUT } from "../../lib/work-pane.ts";
import { BROWSER_WORK_VIEW_SHORTCUT } from "./browser.ts";
import { FILES_WORK_VIEW_SHORTCUT, filesWorkViewKind } from "./files.ts";
import { VSCODE_WORK_VIEW_SHORTCUT } from "./vscode.ts";
import { DIFF_WORK_VIEW_SHORTCUT } from "./diff.ts";
import { TERMINAL_WORK_VIEW_SHORTCUT } from "./terminal.ts";

test("the views and the pane toggle read their binding from the table", () => {
  assert.equal(WORK_PANE_TOGGLE_SHORTCUT, WORK_SHORTCUTS.togglePane);
  assert.equal(WORK_PANE_MAXIMIZE_SHORTCUT, WORK_SHORTCUTS.maximizePane);
  assert.equal(TERMINAL_WORK_VIEW_SHORTCUT, WORK_SHORTCUTS.terminal);
  assert.equal(BROWSER_WORK_VIEW_SHORTCUT, WORK_SHORTCUTS.browser);
  assert.equal(FILES_WORK_VIEW_SHORTCUT, WORK_SHORTCUTS.files);
  assert.equal(filesWorkViewKind.shortcut, WORK_SHORTCUTS.files);
  assert.equal(VSCODE_WORK_VIEW_SHORTCUT, WORK_SHORTCUTS.vscode);
  assert.equal(DIFF_WORK_VIEW_SHORTCUT, WORK_SHORTCUTS.diff);
});
