import assert from "node:assert/strict";
import { test } from "vitest";
import { clearFilesViewState, DEFAULT_FILES_VIEW_STATE, filesViewTitle, normalizeFilesViewState, readFilesViewState, writeFilesViewState, onFilesViewReveal, requestFilesViewReveal, takeFilesViewReveal } from "./view-state.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("malformed stored state falls back to the defaults", () => {
  assert.deepEqual(normalizeFilesViewState(null), DEFAULT_FILES_VIEW_STATE);
  assert.deepEqual(normalizeFilesViewState({ selected: 4, expanded: ["a", 2, "a"], navigatorOpen: false, markdown: "html" }), {
    selected: undefined, expanded: ["a"], navigatorOpen: false, markdown: "rendered",
  });
});

test("each view keeps its own selection and the tab title follows it", () => {
  const storage = new MemoryStorage();
  writeFilesViewState("view-a", { selected: "src/a.ts", expanded: ["src"] }, storage);
  writeFilesViewState("view-b", { selected: "README.md", markdown: "source" }, storage);
  assert.equal(readFilesViewState("view-a", storage).selected, "src/a.ts");
  assert.equal(readFilesViewState("view-b", storage).markdown, "source");
  assert.equal(filesViewTitle("view-a"), "a.ts");
  assert.equal(filesViewTitle("view-b"), "README.md");
  assert.deepEqual(JSON.parse(storage.values.get("hui.files-view.v1:view-a")!), { selected: "src/a.ts", expanded: ["src"], navigatorOpen: true, markdown: "rendered" });
  clearFilesViewState("view-a", storage);
  assert.equal(storage.values.has("hui.files-view.v1:view-a"), false);
  assert.equal(readFilesViewState("view-a", storage).selected, undefined);
});

test("a fresh page reads what an earlier one stored", () => {
  const storage = new MemoryStorage();
  storage.setItem("hui.files-view.v1:view-c", JSON.stringify({ selected: "docs/x.md", expanded: ["docs"], navigatorOpen: false, markdown: "source" }));
  assert.deepEqual(readFilesViewState("view-c", storage), { selected: "docs/x.md", expanded: ["docs"], navigatorOpen: false, markdown: "source" });
});

test("a reveal request waits for its view, selects a file right away and is taken once", () => {
  const seen: string[] = [];
  const stop = onFilesViewReveal("reveal-view", () => seen.push("notified"));
  requestFilesViewReveal("reveal-view", { path: "src/a.ts", kind: "file", line: 12 }, undefined);
  assert.deepEqual(seen, ["notified"]);
  assert.equal(readFilesViewState("reveal-view", undefined).selected, "src/a.ts");
  assert.equal(filesViewTitle("reveal-view"), "a.ts");
  assert.deepEqual(takeFilesViewReveal("reveal-view"), { path: "src/a.ts", kind: "file", line: 12 });
  assert.equal(takeFilesViewReveal("reveal-view"), undefined);
  stop();
  requestFilesViewReveal("reveal-view", { path: "docs", kind: "directory" }, undefined);
  assert.deepEqual(seen, ["notified"], "an unsubscribed view is not notified, but its request still waits");
  assert.equal(readFilesViewState("reveal-view", undefined).selected, "src/a.ts", "a folder does not change the selection");
  clearFilesViewState("reveal-view", undefined);
  assert.equal(takeFilesViewReveal("reveal-view"), undefined, "closing the view drops its request");
});
