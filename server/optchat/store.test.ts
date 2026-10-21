import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { LineFile, readLines, Store, type MessageLine } from "./store.ts";

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hui-optchat-store-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const message = (i: number, text: string, date = "2026-10-05T10:00:00.000Z"): MessageLine =>
  ({ i, kind: "user", text, size: Buffer.byteLength(`user: ${text}`), date });

test("lines go to the file of their local day, with global ids and private modes", async (t) => {
  const dir = join(await directory(t), "memory");
  let now = new Date(2026, 9, 5, 23, 59);
  const { store, messages, nodes } = await Store.open(dir, { now: () => now, report: assert.fail });
  assert.deepEqual([messages, nodes], [[], []]);
  await store.appendMessage(message(0, "first"));
  now = new Date(2026, 9, 6, 0, 1);
  await store.appendMessage(message(1, "second"));
  await store.appendNode({ l: 0, i: 0, text: "user: first", size: 11 });
  await store.close();
  assert.equal(await readFile(join(dir, "main", "2026-10-05.jsonl"), "utf8"), `${JSON.stringify(message(0, "first"))}\n`);
  assert.equal(await readFile(join(dir, "main", "2026-10-06.jsonl"), "utf8"), `${JSON.stringify(message(1, "second"))}\n`);
  assert.equal(await readFile(join(dir, "tree", "2026-10-06.jsonl"), "utf8"), `${JSON.stringify({ l: 0, i: 0, text: "user: first", size: 11 })}\n`);
  for (const path of [dir, join(dir, "main"), join(dir, "tree")]) assert.equal((await stat(path)).mode & 0o777, 0o700, path);
  assert.equal((await stat(join(dir, "main", "2026-10-05.jsonl"))).mode & 0o777, 0o600);
  const reopened = await Store.open(dir, { now: () => now, report: assert.fail });
  assert.deepEqual(reopened.messages.map((line) => line.text), ["first", "second"]);
  assert.deepEqual(reopened.nodes, [{ l: 0, i: 0, text: "user: first", size: 11 }]);
  await reopened.store.close();
});

test("a torn line is reported and skipped, and the next line starts on its own", async (t) => {
  const dir = await directory(t);
  await mkdir(join(dir, "main"), { recursive: true });
  const day = join(dir, "main", "2026-10-05.jsonl");
  await writeFile(day, `${JSON.stringify(message(0, "kept"))}\n{"i":1,"kind":"user","te`);
  const reports: string[] = [];
  const now = () => new Date(2026, 9, 5, 12);
  const { store, messages } = await Store.open(dir, { now, report: (problem) => reports.push(problem) });
  assert.deepEqual(messages.map((line) => line.text), ["kept"]);
  assert.equal(reports.length, 1);
  assert.match(reports[0]!, /2026-10-05\.jsonl:2: skipped a torn line/u);
  await store.appendMessage(message(1, "after the crash"));
  await store.close();
  const text = await readFile(day, "utf8");
  assert(text.endsWith(`{"i":1,"kind":"user","te\n${JSON.stringify(message(1, "after the crash"))}\n`), JSON.stringify(text));
  const again: string[] = [];
  const reopened = await Store.open(dir, { now, report: (problem) => again.push(problem) });
  assert.deepEqual(reopened.messages.map((line) => line.text), ["kept", "after the crash"], "never edited, only skipped");
  assert.equal(again.length, 1);
  await reopened.store.close();
});

test("a complete last line without its newline is kept, and gets one before the next line", async (t) => {
  const dir = await directory(t);
  await mkdir(join(dir, "tree"), { recursive: true });
  const day = join(dir, "tree", "2026-10-05.jsonl");
  await writeFile(day, JSON.stringify({ l: 0, i: 0, text: "user: a", size: 7 }));
  const { store, nodes } = await Store.open(dir, { now: () => new Date(2026, 9, 5, 12), report: assert.fail });
  assert.equal(nodes.length, 1);
  await store.appendNode({ l: 0, i: 1, text: "user: b", size: 7 });
  await store.close();
  assert.equal(await readFile(day, "utf8"), `${JSON.stringify({ l: 0, i: 0, text: "user: a", size: 7 })}\n${JSON.stringify({ l: 0, i: 1, text: "user: b", size: 7 })}\n`);
});

test("ids order the log across day files; a gap refuses to open", async (t) => {
  const dir = await directory(t);
  await mkdir(join(dir, "main"), { recursive: true });
  // A clock set back wrote message 2 into an earlier day's file.
  await writeFile(join(dir, "main", "2026-10-04.jsonl"), `${JSON.stringify(message(2, "two"))}\n`);
  await writeFile(join(dir, "main", "2026-10-05.jsonl"), `${JSON.stringify(message(0, "zero"))}\n${JSON.stringify(message(1, "one"))}\n${JSON.stringify(message(1, "dup"))}\n`);
  const reports: string[] = [];
  const { store, messages } = await Store.open(dir, { now: () => new Date(), report: (problem) => reports.push(problem) });
  assert.deepEqual(messages.map((line) => line.text), ["zero", "one", "two"]);
  assert.match(reports.join("\n"), /second message 1/u);
  await store.close();
  await writeFile(join(dir, "main", "2026-10-06.jsonl"), `${JSON.stringify(message(4, "four"))}\n`);
  await assert.rejects(() => Store.open(dir, { now: () => new Date(), report: () => {} }), /has no message 3/u);
});

test("a line file appends one JSON line per write and reads back past torn ones", async (t) => {
  const path = join(await directory(t), "runs.jsonl");
  const file = new LineFile(path);
  await file.append({ run: 1 });
  await file.append({ run: 2 });
  await file.close();
  assert.deepEqual(await readLines(path, assert.fail), { values: [{ run: 1 }, { run: 2 }], terminated: true });
  assert.deepEqual(await readLines(join(path, "..", "missing.jsonl"), assert.fail), { values: [], terminated: true });
});
