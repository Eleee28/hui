// Ported from AgentsInTheCloud's packages/files/test/file-draft.test.ts (MIT), adapted to etags and Vitest.
import assert from "node:assert/strict";
import { test } from "vitest";
import { draftKey, draftStatus, existingDraft, FileDraft, forgetDraft, openDraft, releaseDraft, type SaveRequest, type SaveResult } from "./draft.ts";
import { editFileText, editorText } from "../editable-text.ts";

const file = { content: "original\r\n", etag: "e1", writable: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

class MemoryStorage {
  values = new Map<string, string>();
  failing = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failing) throw new Error("quota exceeded"); this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("serializes writes and drains edits made during a save", async () => {
  const requests: SaveRequest[] = [];
  const first = deferred<SaveResult>();
  const draft = new FileDraft(file, async (request) => {
    requests.push(request);
    return requests.length === 1 ? first.promise : { etag: "e3" };
  });
  draft.edit("first\r\n");
  const saving = draft.flush();
  draft.edit("second\r\n");
  assert.equal(draft.flush(), saving);
  assert.equal(requests.length, 1);
  first.resolve({ etag: "e2" });
  await saving;
  assert.deepEqual(requests, [{ content: "first\r\n", etag: "e1" }, { content: "second\r\n", etag: "e2" }]);
  assert.equal(draft.dirty, false);
  assert.equal(draft.etag, "e3");
});

test("a failed write keeps the draft and its version for a retry", async () => {
  let fail = true;
  const draft = new FileDraft(file, async () => {
    if (fail) throw new Error("Offline");
    return { etag: "e2" };
  });
  draft.edit("unsaved");
  await draft.flush();
  assert.equal(draft.error, "Offline");
  assert.deepEqual(draftStatus(draft), { state: "error", text: "Not saved: Offline" });
  assert.equal(draft.content, "unsaved");
  assert.equal(draft.etag, "e1");
  assert.equal(draft.dirty, true);
  fail = false;
  await draft.flush();
  assert.equal(draft.error, undefined);
  assert.equal(draft.dirty, false);
  assert.deepEqual(draftStatus(draft), { state: "saved", text: "Saved" });
});

test("a conflict keeps the edits until the operator overwrites or reloads", async () => {
  const latest = { ...file, content: "external\r\n", etag: "e2" };
  const requests: SaveRequest[] = [];
  const draft = new FileDraft(file, async (request) => {
    requests.push(request);
    return request.etag === "e2" ? { etag: "e3" } : { conflict: latest };
  });
  draft.edit("mine\r\n");
  await draft.flush();
  await draft.flush();
  assert.equal(requests.length, 1, "a conflicted draft does not retry on its own");
  assert.equal(draft.content, "mine\r\n");
  assert.deepEqual(draft.conflict, latest);
  assert.equal(draftStatus(draft).state, "conflict");
  // Overwrite names the version the conflict showed, never a blind force.
  await draft.flush(true);
  assert.deepEqual(requests[1], { content: "mine\r\n", etag: "e2" });
  assert.equal(draft.dirty, false);
  assert.equal(draft.conflict, undefined);
  draft.edit("discard");
  draft.accept(latest);
  assert.equal(draft.content, latest.content);
  assert.equal(draft.dirty, false);
});

for (const separator of ["\n", "\r\n", "\r"]) {
  test(`keeps ${JSON.stringify(separator)} separators through edits`, () => {
    const content = `one${separator}two${separator}`;
    assert.equal(editFileText(content, [{ from: 1, to: 1, insert: "X" }]), `oXne${separator}two${separator}`);
    assert.equal(editFileText(content, [{ from: 4, to: 4, insert: "new\n" }]), `one${separator}new${separator}two${separator}`);
  });
}

test("keeps untouched mixed endings, a BOM, astral text and a missing final newline", () => {
  const content = "\ufeff😀a\r\nb\nc\rd";
  assert.equal(editorText(content), "\ufeff😀a\nb\nc\nd");
  assert.equal(editFileText(content, [{ from: 3, to: 4, insert: "A" }, { from: 9, to: 10, insert: "D" }]), "\ufeff😀A\r\nb\nc\rD");
  assert.equal(editFileText(content, [{ from: 4, to: 7, insert: "" }]), "\ufeff😀ac\rd");
});

test("a lost acknowledgment reconciles when the disk already holds the draft", () => {
  const draft = new FileDraft(file, async () => { throw new Error("unused"); });
  draft.edit("recovered\r\n");
  draft.changedOnDisk({ ...file, content: draft.content, etag: "e2" });
  assert.equal(draft.dirty, false);
  assert.equal(draft.conflict, undefined);
  assert.equal(draft.etag, "e2");
});

test("a refresh during a write cannot replace the draft or invent a conflict", async () => {
  const result = deferred<SaveResult>();
  const draft = new FileDraft(file, () => result.promise);
  draft.edit("mine");
  const saving = draft.flush();
  draft.changedOnDisk({ ...file, content: "mine", etag: "e2" });
  assert.equal(draft.savedContent, file.content);
  assert.equal(draft.conflict, undefined);
  result.resolve({ etag: "e2" });
  await saving;
  assert.equal(draft.content, "mine");
  assert.equal(draft.dirty, false);
});

test("a clean draft follows the disk; read-only files never save", async () => {
  let writes = 0;
  const draft = new FileDraft({ ...file, writable: false }, async () => { writes++; return { etag: "x" }; });
  assert.deepEqual(draftStatus(draft), { state: "read-only", text: "Read only" });
  draft.changedOnDisk({ content: "agent edit\n", etag: "e2", writable: false });
  assert.equal(draft.content, "agent edit\n");
  draft.edit("typed anyway");
  await draft.flush();
  assert.equal(writes, 0);
});

test("views of one file share a draft, and unsaved text survives a reload in storage", async () => {
  const storage = new MemoryStorage();
  const key = draftKey("session", "notes.md");
  const writes: SaveRequest[] = [];
  const hold = deferred<SaveResult>();
  const save = async (request: SaveRequest) => { writes.push(request); return hold.promise; };
  const a = openDraft(key, file, save, storage);
  const b = openDraft(key, file, save, storage);
  assert.equal(a, b);
  a.edit("unsaved\r\n");
  assert.equal(JSON.parse(storage.values.get(`hui.file-draft.v1:${key}`)!).content, "unsaved\r\n");
  // The page goes away before the save lands: a new page restores the text and saves it over the same version.
  forgetDraft(key, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  assert.equal(existingDraft(key), undefined);
  const restored = openDraft(key, file, async (request) => { writes.push(request); return { etag: "e2" }; }, storage);
  assert.equal(restored.content, "unsaved\r\n");
  assert.equal(restored.dirty, true);
  await restored.flush();
  assert.deepEqual(writes.at(-1), { content: "unsaved\r\n", etag: "e1" });
  assert.equal(storage.values.has(`hui.file-draft.v1:${key}`), false);
  const listener = () => {};
  restored.listeners.add(listener);
  await releaseDraft(key, restored, listener);
  assert.equal(existingDraft(key), undefined);
  hold.resolve({ etag: "unused" });
});

test("a restored draft whose file moved on becomes a conflict", () => {
  const storage = new MemoryStorage();
  const key = draftKey("session", "moved.md");
  storage.setItem(`hui.file-draft.v1:${key}`, JSON.stringify({ base: { content: "old", etag: "e1" }, content: "mine" }));
  const draft = openDraft(key, { content: "agent", etag: "e9", writable: true }, async () => ({ etag: "x" }), storage);
  assert.equal(draft.content, "mine");
  assert.equal(draft.conflict?.content, "agent");
  forgetDraft(key, storage);
});

test("a failing storage reports the risk without blocking saves", async () => {
  const storage = new MemoryStorage();
  storage.failing = true;
  const key = draftKey("session", "full.md");
  const draft = openDraft(key, file, async () => ({ etag: "e2" }), storage);
  draft.edit("text");
  assert.match(draftStatus(draft).text, /Draft backup failed: quota exceeded/u);
  storage.failing = false;
  await draft.flush();
  assert.equal(draft.dirty, false);
  assert.deepEqual(draftStatus(draft), { state: "saved", text: "Saved" });
  forgetDraft(key, storage);
});
