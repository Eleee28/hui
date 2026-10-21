import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import type { Summarize } from "./compactor.ts";
import { OptChatMemory, type OptChatOptions } from "./memory.ts";
import { localDateTime } from "./text.ts";
import { PLACEHOLDER } from "./tree.ts";

/** The memories each test opened, closed before its directory is removed. */
const opened = new WeakMap<TestContext, OptChatMemory[]>();

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hui-optchat-memory-"));
  // Closes the test's memories itself before removing the directory, whatever order cleanups run in: a memory
  // still saving its view while the directory is removed fails the rm with ENOTEMPTY.
  t.onTestFinished(async () => {
    for (const memory of opened.get(t) ?? []) await memory.close();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function open(t: TestContext, dir: string, options: Partial<OptChatOptions> = {}): Promise<OptChatMemory> {
  const memory = await OptChatMemory.open(dir, { name: "Grok", summarize: refuse, ...options });
  opened.set(t, [...(opened.get(t) ?? []), memory]);
  t.onTestFinished(() => memory.close());
  return memory;
}

function until(memory: OptChatMemory, done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (done()) { resolve(); return; }
    const off = memory.onChange(() => { if (done()) { off(); resolve(); } });
  });
}

const refuse: Summarize = async () => { throw new Error("no model call expected"); };
/** A deterministic 32-byte line for any request. */
const digest: Summarize = async (request) => `summary ${createHash("sha256").update(JSON.stringify(request.messages)).digest("hex").slice(0, 24)}`;
const never: Summarize = (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));

test("a tool result keeps CAP characters, head and tail; other messages stay whole", { timeout: 10_000 }, async (t) => {
  const memory = await open(t, await directory(t), { cap: 100 });
  const long = `HEAD${"x".repeat(1_000)}TAIL`;
  assert.equal(await memory.append("echo", long), 0);
  assert.equal(await memory.append("user", long), 1);
  const echo = memory.message(0)!;
  assert(echo.text.length <= 100 && echo.text.startsWith("HEAD") && echo.text.endsWith("TAIL"), echo.text);
  assert.match(echo.text, /\n\[\d+ characters cut\]\n/u);
  assert.equal(echo.size, Buffer.byteLength(`echo: ${echo.text}`));
  assert.equal(memory.message(1)!.text, long);
});

test("zoom and date answer in the spec's formats, and refuse lines that do not exist", { timeout: 10_000 }, async (t) => {
  let now = new Date(2026, 9, 5, 19, 9, 33);
  const memory = await open(t, await directory(t), { now: () => now });
  await memory.append("user", "first line\nsecond line", { entry: 3, part: 0 });
  now = new Date(2026, 9, 5, 19, 10, 0);
  for (const [kind, text] of [["talk", "done"], ["tool", "read {\"path\":\"a\"}"], ["echo", "a\nb"]] as const) await memory.append(kind, text);
  await until(memory, () => memory.status().pending === 0);
  assert.equal(memory.zoom(0, 1), "0+0|user: first line\nsecond line", "a message whole, newlines kept");
  assert.equal(memory.zoom(0, 2), "0+1|user: first line second line\n1+1|talk: done", "the two lines under it, one per line");
  assert.equal(memory.zoom(0, 4), `0+2|user: first line second line talk: done\n2+2|tool: read {"path":"a"} echo: a b`);
  for (const [id, n] of [[1, 2], [0, 3], [0, 8], [4, 1], [-1, 1], [2, 0]] as const) assert.equal(memory.zoom(id, n), `No line ${id}+${n}.`);
  assert.equal(memory.date(0), localDateTime(new Date(2026, 9, 5, 19, 9, 33)));
  assert.equal(memory.date(3), localDateTime(new Date(2026, 9, 5, 19, 10, 0)));
  assert.deepEqual([memory.date(4), memory.date(-1), memory.date(1.5)], ["No message 4.", "No message -1.", "No message 1.5."]);
  assert.deepEqual(memory.message(0)!.src, { entry: 3, part: 0 });

  const pending = await open(t, await directory(t), { summarize: never, node: 16 });
  await pending.append("user", "far too long for sixteen bytes");
  await pending.append("talk", "also too long for it");
  assert.equal(pending.zoom(0, 2), `0+1|${PLACEHOLDER}\n1+1|${PLACEHOLDER}`, "lines not summarized yet say so");
});

/** Message `i` of a synthetic chat: every third one too long to be its own line. */
const chatText = (i: number) => i % 3 === 0 ? `message ${i} ${"long ".repeat(12)}` : `a short message, number ${i}`;
const chatKind = (i: number) => i % 2 ? "talk" as const : "user" as const;

// A view folded again from the log differs from the live one wherever a batch met unbuilt parents or placeholders, and
// every cached prefix dies with it: the memory saves its views and a reopen loads them as they were.
test("a reopen loads both views as the memory left them, byte for byte, even where a fold would differ", { timeout: 20_000 }, async (t) => {
  const dir = await directory(t);
  // The summaries wait until the test releases them: batches run while lines are placeholders and parents unbuilt.
  const held: (() => void)[] = [];
  const slow: Summarize = (request, signal) => new Promise((resolve) => { held.push(() => resolve(digest(request, signal))); });
  const memory = await OptChatMemory.open(dir, { name: "Grok", summarize: slow, node: 40, view: 320, context: 200 });
  for (let i = 0; i < 60; i++) {
    await memory.append(chatKind(i), chatText(i));
    // Every fourth message lets the summaries so far through, so the views fill with lines built at odd moments.
    if (i % 4 === 3) { while (held.length) held.shift()!(); await new Promise((resolve) => setImmediate(resolve)); }
  }
  while (memory.status().pending) { while (held.length) held.shift()!(); await new Promise((resolve) => setImmediate(resolve)); }
  const view = memory.view();
  const parts = memory.parts();
  const compaction = memory.compaction();
  assert(parts.some(([l]) => l >= 3), "old lines cover many messages");
  assert(compaction.parts.length < parts.length, "the compaction view is the chat view merged further");
  await memory.close();
  const saved = JSON.parse(await readFile(join(dir, "view.json"), "utf8")) as { version: number; chat: { parts: unknown; batch: boolean } };
  assert.deepEqual([saved.version, saved.chat.parts], [1, parts]);
  const reports: string[] = [];
  const reopened = await open(t, dir, { summarize: refuse, node: 40, view: 320, context: 200, report: (problem) => reports.push(problem) });
  assert.equal(reopened.view(), view, "the same bytes: the next turn reads its prefix from the cache");
  assert.deepEqual([reopened.parts(), reopened.compaction()], [parts, compaction]);
  assert.equal(reports.join("\n"), "", "nothing folded, nothing to report");
  assert.deepEqual(reopened.status(), { messages: 60, built: reopened.status().built, pending: 0, viewBytes: reopened.status().viewBytes, viewLines: parts.length, usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  await reopened.close();
  // Without the file the views are folded from message 0 with every node built: other views, and a diagnostic.
  await rm(join(dir, "view.json"));
  const folded = await open(t, dir, { summarize: refuse, node: 40, view: 320, context: 200, report: (problem) => reports.push(problem) });
  assert.match(reports.join("\n"), /folded the views of .* again from message 0: view\.json is missing/u);
  assert.notEqual(folded.view(), view, "a fold does not give back the live view");
});

test("a saved view behind the log gets the messages logged after it appended, as they were live", { timeout: 20_000 }, async (t) => {
  const dir = await directory(t);
  const options = { name: "Grok", summarize: digest, node: 40, view: 4_000, context: 1_000 };
  const memory = await OptChatMemory.open(dir, options);
  const built = () => until(memory, () => memory.status().pending === 0);
  for (let i = 0; i < 30; i++) { await memory.append(chatKind(i), chatText(i)); await built(); }
  await memory.close();
  await copyFile(join(dir, "view.json"), join(dir, "behind.json"));
  const live = await open(t, dir, { ...options });
  const head = live.parts();
  for (let i = 30; i < 40; i++) { await live.append(chatKind(i), chatText(i)); await until(live, () => live.status().pending === 0); }
  assert.deepEqual(live.parts(), [...head, ...Array.from({ length: 10 }, (_, k) => [0, 30 + k] as const)], "under the high mark: appends only");
  const view = live.view();
  const compaction = live.compaction();
  await live.close();
  // A crash lost the last saves: the file stops at message 30, the log at 40.
  await copyFile(join(dir, "behind.json"), join(dir, "view.json"));
  const reports: string[] = [];
  const reopened = await open(t, dir, { ...options, summarize: refuse, report: (problem) => reports.push(problem) });
  assert.deepEqual([reopened.view(), reopened.compaction(), reports], [view, compaction, []]);
  await reopened.close();
  assert.deepEqual((JSON.parse(await readFile(join(dir, "view.json"), "utf8")) as { chat: { parts: unknown } }).chat.parts, reopened.parts(), "and saved again");
});

test("a missing or invalid view file is folded again from the log, saved, and reported", { timeout: 20_000 }, async (t) => {
  const dir = await directory(t);
  const options = { name: "Grok", summarize: digest, node: 40, view: 400, context: 200 };
  const memory = await OptChatMemory.open(dir, options);
  for (let i = 0; i < 24; i++) { await memory.append(chatKind(i), chatText(i)); await until(memory, () => memory.status().pending === 0); }
  await memory.close();
  const good = JSON.parse(await readFile(join(dir, "view.json"), "utf8")) as { version: number; chat: { parts: [number, number][]; batch: boolean }; compaction: { parts: [number, number][]; batch: boolean } };
  assert(good.chat.parts.some(([l]) => l > 0), "some lines merged");
  const variants: [string, string, RegExp][] = [
    ["not JSON", "{\"version\": 1, \"chat\":", /view\.json is not valid JSON/u],
    ["another version", JSON.stringify({ ...good, version: 2 }), /view\.json has no version 1/u],
    ["a malformed part", JSON.stringify({ ...good, chat: { ...good.chat, parts: [[0, -1], ...good.chat.parts.slice(1)] } }), /chat view holds a malformed part/u],
    ["a gap", JSON.stringify({ ...good, chat: { ...good.chat, parts: good.chat.parts.filter((_, k) => k !== 1) } }), /chat view does not tile the chat/u],
    ["past the log", JSON.stringify({ ...good, chat: { ...good.chat, parts: [...good.chat.parts, [0, 24]] }, compaction: { ...good.compaction, parts: [...good.compaction.parts, [0, 24]] } }), /chat view covers 25 messages, but the log holds 24/u],
    ["views of different lengths", JSON.stringify({ ...good, compaction: { ...good.compaction, parts: good.compaction.parts.slice(0, -1) } }), /its views cover 24 and \d+ messages/u],
    ["no batch state", JSON.stringify({ ...good, compaction: { parts: good.compaction.parts } }), /compaction view is malformed/u],
  ];
  for (const [name, text, problem] of variants) {
    await writeFile(join(dir, "view.json"), text);
    const reports: string[] = [];
    const reopened = await open(t, dir, { ...options, summarize: refuse, report: (report) => reports.push(report) });
    assert.match(reports.join("\n"), problem, name);
    assert.deepEqual(reopened.parts(), good.chat.parts, `${name}: folded again, here to the same view since every node was built live`);
    await reopened.close();
    const rewritten = JSON.parse(await readFile(join(dir, "view.json"), "utf8")) as typeof good;
    assert.deepEqual([rewritten.version, rewritten.chat.parts], [1, good.chat.parts], `${name}: saved again`);
  }
  // A new memory has nothing to fold and nothing to report.
  const fresh: string[] = [];
  const empty = await open(t, await directory(t), { ...options, report: (report) => fresh.push(report) });
  assert.deepEqual([empty.parts(), fresh], [[], []]);
});

// Its appends wait on fsyncs, which a busy machine slows down: it keeps the suite's limit rather than one of its own.
test("the compaction view stays between its low and high marks, and merges whenever the chat view batches", async (t) => {
  const contexts: string[] = [];
  const summarize: Summarize = async (request, signal) => { contexts.push(request.messages[0]!.content[0] as string); return `${await digest(request, signal)} ${"z".repeat(360)}`; };
  const memory = await open(t, await directory(t), { summarize, view: 64_000, context: 32_000 });
  let chatSize = 0;
  let filled = false;
  let chatBatches = 0;
  for (let i = 0; i < 700; i++) {
    // 250-450 byte lines: each its own leaf, and two of them need a model call to merge.
    await memory.append(chatKind(i), `message ${i} ${"w".repeat(240 + ((i * 37) % 200))}`);
    await until(memory, () => memory.status().pending === 0);
    const { size } = memory.compaction();
    const { viewBytes } = memory.status();
    assert(size <= 32_000, `message ${i}: ${size} bytes, past the high mark`);
    if (size > 16_000) filled = true;
    else if (filled) assert(size > 16_000 - 1_024, `message ${i}: a batch stops just under the low mark, not at ${size}`);
    if (viewBytes < chatSize) {
      chatBatches++;
      // Down to its low mark, then the new message's line replaced its placeholder.
      assert(size <= 16_000 + 512, `message ${i}: the chat view batched, so the compaction view merged too, yet holds ${size} bytes`);
    }
    chatSize = viewBytes;
  }
  assert(filled && chatBatches >= 2, String(chatBatches));
  assert(contexts.length > 100);
  for (const context of contexts) assert(Buffer.byteLength(context) <= 32_000 + 20 + 400, `a compaction context of ${Buffer.byteLength(context)} bytes`);
});

test("status says when a turn waits for summaries, and closing ends the wait", { timeout: 10_000 }, async (t) => {
  let release!: (text: string) => void;
  const gate: Summarize = () => new Promise((resolve) => { release = resolve; });
  const memory = await open(t, await directory(t), { summarize: gate, node: 16 });
  const changes: string[] = [];
  memory.onChange(() => changes.push(JSON.stringify(memory.status().waiting ?? false)));
  await memory.append("user", "far too long for sixteen bytes");
  await memory.append("user", "ok");
  const settled = memory.settle(2);
  assert.equal(memory.status().waiting, true);
  assert.equal(memory.settled(2), false);
  release("short");
  assert.equal(await settled, true);
  assert.equal(memory.status().waiting, undefined);
  assert(changes.includes("true") && changes.at(-1) === "false", changes.join(","));
  await memory.append("user", "another one too long");
  const late = memory.settle(3);
  await memory.close();
  assert.equal(await late, false);
  await assert.rejects(() => memory.append("user", "after close"), /closed/u);
});

test("the browse page shows the view, every message and each level, escaped", { timeout: 10_000 }, async (t) => {
  const memory = await open(t, await directory(t));
  await memory.append("user", "<script>alert('x')</script> & more");
  await memory.append("talk", "ok");
  await until(memory, () => memory.status().pending === 0);
  const page = memory.html();
  assert(page.startsWith("<!doctype html>"));
  assert(!page.includes("<script>"), "nothing from the log is markup");
  assert(page.includes("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; more"));
  for (const heading of ["View · 2 lines", "ROOT · 2 messages", "Level 0 · 2 nodes", "Level 1 · 1 nodes"]) assert(page.includes(heading), heading);
  assert(page.includes("<b>0+2</b>") || page.includes("<b>0+1</b>"));
});
