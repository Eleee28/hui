import assert from "node:assert/strict";
import { test } from "vitest";
import { vscodeWorkViewKind } from "./vscode.ts";
import { WORK_SHORTCUTS } from "../../lib/work-shortcuts.ts";

test("the VS Code kind is one view per conversation with a stable key and title, and is always available", async () => {
  assert.equal(vscodeWorkViewKind.kind, "vscode");
  assert.equal(vscodeWorkViewKind.label, "VS Code");
  assert.equal(vscodeWorkViewKind.shortcut, WORK_SHORTCUTS.vscode);
  const first = await vscodeWorkViewKind.create("alpha");
  const second = await vscodeWorkViewKind.create("alpha");
  assert.deepEqual(first, { kind: "vscode" });
  assert.equal(vscodeWorkViewKind.key(first), vscodeWorkViewKind.key(second), "launching again reuses the open view");
  assert.equal(vscodeWorkViewKind.title(first), "VS Code");
  assert.equal(vscodeWorkViewKind.unavailable, undefined, "nothing on this machine disables the launcher; the view explains");
  assert.equal(vscodeWorkViewKind.settingsLink, undefined);
  assert.equal(vscodeWorkViewKind.single, true, "an open VS Code is listed instead of its launcher");
});
