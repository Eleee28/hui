import assert from "node:assert/strict";
import { test } from "vitest";
import { filesViewToReveal, filesWorkViewKind, newFilesViewId } from "./files.ts";
import { readFilesViewState, writeFilesViewState } from "../../lib/files/view-state.ts";
import { defaultWorkViewKey } from "../../lib/work-pane.ts";

test("each Files launch is a new view keyed by its id", async () => {
  const first = await filesWorkViewKind.create("session-a");
  const second = await filesWorkViewKind.create("session-a");
  assert.equal(first.kind, "files");
  assert.notEqual(first.id, second.id);
  assert.equal(filesWorkViewKind.key(first), `files:${first.id}`);
  assert.equal(filesWorkViewKind.key(first), defaultWorkViewKey(first));
  assert.match(newFilesViewId(), /^files-/u);
  assert.equal(filesWorkViewKind.label, "Files");
  assert.equal(filesWorkViewKind.unavailable, undefined);
});

test("the tab shows the selected file's name, or Files", () => {
  const ref = { kind: "files" as const, id: "files-title-test" };
  assert.equal(filesWorkViewKind.title(ref), "Files");
  writeFilesViewState(ref.id, { selected: "src/components/files-view.ts" }, undefined);
  assert.equal(filesWorkViewKind.title(ref), "files-view.ts");
  writeFilesViewState(ref.id, { selected: undefined }, undefined);
  assert.equal(filesWorkViewKind.title(ref), "Files");
});

test("closing the tab forgets the view's remembered selection", () => {
  const ref = { kind: "files" as const, id: "files-close-test" };
  writeFilesViewState(ref.id, { selected: "README.md" }, undefined);
  filesWorkViewKind.closed?.(ref, "session-a");
  assert.equal(readFilesViewState(ref.id, undefined).selected, undefined);
  assert.equal(filesWorkViewKind.title(ref), "Files");
});

test("its launcher icon carries an explicit size", () => {
  const markup = filesWorkViewKind.icon.strings.join("");
  assert.match(markup, /width="16" height="16"/u);
});

test("a file reference opens in the active Files view, else the first one, else a new one", () => {
  const first = { kind: "files" as const, id: "files-first" };
  const second = { kind: "files" as const, id: "files-second" };
  const terminal = { kind: "terminal" as const, terminalId: "t1" };
  assert.equal(filesViewToReveal({ views: [] }), undefined);
  assert.equal(filesViewToReveal({ views: [terminal], active: "terminal:t1" }), undefined);
  assert.equal(filesViewToReveal({ views: [terminal, first, second], active: "terminal:t1" }), first);
  assert.equal(filesViewToReveal({ views: [first, second], active: "files:files-second" }), second);
});
