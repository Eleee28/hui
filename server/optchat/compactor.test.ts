import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { createLimiter, type Summarize, type SummaryRequest, type Timers } from "./compactor.ts";
import { OptChatMemory, type OptChatOptions } from "./memory.ts";
import { compactPrompt } from "./prompts.ts";
import { Store } from "./store.ts";
import { PLACEHOLDER } from "./tree.ts";

/** The memories each test opened, closed before its directory is removed. */
const opened = new WeakMap<TestContext, OptChatMemory[]>();

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hui-optchat-compactor-"));
  // Closes the test's memories itself before removing the directory, whatever order cleanups run in: a memory
  // still saving its view while the directory is removed fails the rm with ENOTEMPTY.
  t.onTestFinished(async () => {
    for (const memory of opened.get(t) ?? []) await memory.close();
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function open(t: TestContext, options: Partial<OptChatOptions> & Pick<OptChatOptions, "summarize">, dir?: string): Promise<OptChatMemory> {
  const memory = await OptChatMemory.open(dir ?? await directory(t), { name: "Grok", ...options });
  opened.set(t, [...(opened.get(t) ?? []), memory]);
  t.onTestFinished(() => memory.close());
  return memory;
}

/** Resolves once `done` holds, checking now and after every change of the memory. */
function until(memory: OptChatMemory, done: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (done()) { resolve(); return; }
    const off = memory.onChange(() => { if (done()) { off(); resolve(); } });
  });
}

const allBuilt = (memory: OptChatMemory) => until(memory, () => memory.status().pending === 0);
const refuse: Summarize = async () => { throw new Error("no model call expected"); };
/** The step block of a request's first user message, and the context block before it. */
const blocks = (request: SummaryRequest) => request.messages[0]!.content as readonly string[];

/** A summarizer whose calls wait until the test releases them, one by one or all. */
function gated() {
  const calls: { request: SummaryRequest; reply: (text: string) => void; fail: (error: Error) => void }[] = [];
  let running = 0;
  let peak = 0;
  const started = new Set<() => void>();
  const summarize: Summarize = (request) => new Promise((resolve, reject) => {
    running++;
    peak = Math.max(peak, running);
    const done = () => { running--; };
    calls.push({ request, reply: (text) => { done(); resolve(text); }, fail: (error) => { done(); reject(error); } });
    for (const wake of [...started]) wake();
  });
  const call = (count: number) => new Promise<void>((resolve) => {
    const check = () => { if (calls.length >= count) { started.delete(check); resolve(); } };
    started.add(check);
    check();
  });
  return { summarize, calls, call, peak: () => peak, running: () => running };
}

test("short messages and lines that fit are their own nodes, with no model call", { timeout: 10_000 }, async (t) => {
  const memory = await open(t, { summarize: refuse });
  for (const [kind, text] of [["user", "a"], ["talk", "b"], ["tool", "read {}"], ["echo", "c"]] as const) await memory.append(kind, text);
  await allBuilt(memory);
  assert.deepEqual([memory.tree.text(0, 0), memory.tree.text(1, 0), memory.tree.text(1, 1), memory.tree.text(2, 0)],
    ["user: a", "user: a\ntalk: b", "tool: read {}\necho: c", "user: a\ntalk: b\ntool: read {}\necho: c"]);
  assert.deepEqual(memory.status().usage.calls, 0);
});

test("messages are compressed one at a time, in order, and no context ever holds an unsummarized line", { timeout: 10_000 }, async (t) => {
  const requests: SummaryRequest[] = [];
  let running = 0;
  let peak = 0;
  const summarize: Summarize = async (request) => {
    requests.push(request);
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>((resolve) => setImmediate(resolve));
    running--;
    const step = blocks(request)[1]!;
    const message = /\nuser: (M\d+)/u.exec(step)?.[1];
    // 40-byte lines: two of them (81 bytes with the newline) need a model call to merge.
    return message ? `S-${message}`.padEnd(40, "-") : "MERGED";
  };
  const memory = await open(t, { summarize, node: 64, jobs: 4 });
  for (let i = 0; i < 6; i++) await memory.append("user", `M${i} ${"y".repeat(97)}`);
  await allBuilt(memory);
  const compressed = requests.filter((request) => blocks(request)[1]!.includes("Compress this message"));
  assert.deepEqual(compressed.map((request) => /\nuser: (M\d+)/u.exec(blocks(request)[1]!)?.[1]), ["M0", "M1", "M2", "M3", "M4", "M5"]);
  compressed.forEach((request, index) => {
    const before = Array.from({ length: index }, (_, k) => `S-M${k}`.padEnd(40, "-"));
    assert.equal(blocks(request)[0], `<chat>\n${before.join("\n")}\n</chat>`, "the lines before the message, bare");
  });
  const merges = requests.filter((request) => blocks(request)[1]!.includes("Merge these two lines"));
  assert.equal(merges.length, 3, "three level-1 merges; the level-2 one fits for free");
  assert.equal(memory.tree.text(2, 0), "MERGED\nMERGED");
  for (const request of requests) {
    assert(!blocks(request)[0]!.includes(PLACEHOLDER), "rule 3: the compactor only ever sees summaries");
    assert(!/^\d+\+\d+\|/mu.test(blocks(request).join("\n")), "no ids in a compactor call");
    assert.equal(request.system, compactPrompt("Grok"));
  }
  assert(peak <= 4, String(peak));
});

test("over the limit, the same conversation shows the cut, and after TRIES replies the shortest wins", { timeout: 10_000 }, async (t) => {
  const replies = [`${"a".repeat(511)}é${"b".repeat(100)}`, "c".repeat(530), "d".repeat(520), "e".repeat(540), "f".repeat(525)];
  const requests: SummaryRequest[] = [];
  const memory = await open(t, { summarize: async (request) => { requests.push(request); return `  ${replies[requests.length - 1]}\n`; } });
  await memory.append("user", "z".repeat(600));
  await allBuilt(memory);
  assert.equal(requests.length, 5);
  assert.equal(memory.tree.text(0, 0), "d".repeat(520), "a stubborn node keeps its shortest try");
  assert.deepEqual(requests.map((request) => request.messages.length), [1, 3, 5, 7, 9]);
  const second = requests[1]!.messages;
  assert.deepEqual(second[1], { role: "assistant", content: `  ${replies[0]}\n` });
  // The 512th byte falls inside "é": the cut ends on the character before it.
  assert.deepEqual(second[2], { role: "user", content: [`That line is 613 bytes; the limit is 512. It must end where it is cut here:\n${"a".repeat(511)}| ← LIMIT`] });
  const feedback = requests[4]!.messages[8];
  assert(feedback?.role === "user");
  assert.equal(feedback.content[0]!.split("\n")[0], "That line is 540 bytes; the limit is 512. It must end where it is cut here:");

  const early: SummaryRequest[] = [];
  const fits = await open(t, { summarize: async (request) => { early.push(request); return early.length === 1 ? "x".repeat(600) : "short enough"; } });
  await fits.append("user", "z".repeat(600));
  await allBuilt(fits);
  assert.deepEqual([early.length, fits.tree.text(0, 0)], [2, "short enough"]);
});

test("a failed node is retried every RETRY forever, and only its first failure is reported", { timeout: 10_000 }, async (t) => {
  const timers: (() => void)[] = [];
  const fake: Timers = { set: (callback) => { timers.push(callback); return callback; }, clear: (handle) => { timers.splice(timers.indexOf(handle as () => void), 1); } };
  const outcomes = [new Error("provider down"), new Error("still down"), "   ", "back up"];
  let calls = 0;
  const reports: string[] = [];
  const memory = await open(t, {
    timers: fake, retryMs: 10_000, report: (problem, error) => reports.push(`${problem}: ${(error as Error).message}`),
    summarize: async () => { const outcome = outcomes[calls++]!; if (outcome instanceof Error) throw outcome; return outcome; },
  });
  await memory.append("user", "z".repeat(600));
  await until(memory, () => memory.status().failing !== undefined);
  const failing = memory.status().failing!;
  assert.deepEqual([failing.node, failing.error, calls, timers.length], ["0+1", "provider down", 1, 1]);
  assert.match(reports[0]!, /could not summarize 0\+1 .*: provider down/u);
  for (const expected of [2, 3]) {
    timers.shift()!();
    await until(memory, () => calls === expected && timers.length === 1);
    assert.deepEqual(memory.status().failing, failing, "the first failure stays reported");
  }
  assert.equal(reports.length, 1, "failures after the first are not reported again");
  timers.shift()!();
  await allBuilt(memory);
  assert.deepEqual([memory.tree.text(0, 0), memory.status().failing, timers.length], ["back up", undefined, 0]);
});

test("each memory runs at most JOBS nodes, and a shared limiter bounds model calls across memories", { timeout: 10_000 }, async (t) => {
  // Eight summarized messages whose lines need a model call to merge: four merges are ready at once.
  async function seeded(): Promise<string> {
    const dir = await directory(t);
    const { store } = await Store.open(dir, { now: () => new Date(), report: assert.fail });
    for (let i = 0; i < 8; i++) {
      const text = `M${i} ${"y".repeat(90)}`;
      await store.appendMessage({ i, kind: "user", text, size: Buffer.byteLength(`user: ${text}`), date: new Date().toISOString() });
      await store.appendNode({ l: 0, i, text: `S${i}`.padEnd(60, "-"), size: 60 });
    }
    await store.close();
    return dir;
  }
  const local = gated();
  const memory = await open(t, { summarize: local.summarize, node: 100, jobs: 2 }, await seeded());
  await local.call(2);
  assert.deepEqual([local.calls.length, local.running()], [2, 2], "JOBS caps one memory");
  for (let k = 0; k < 4; k++) {
    await local.call(Math.min(k + 2, 4));
    assert(local.running() <= 2, String(local.running()));
    local.calls[k]!.reply("MERGED");
  }
  await allBuilt(memory);
  assert.deepEqual([local.calls.length, local.peak()], [4, 2], "four model merges; the levels above fit for free");

  const shared = gated();
  const limiter = createLimiter(1);
  const first = await open(t, { summarize: shared.summarize, node: 100, jobs: 4, limiter }, await seeded());
  const second = await open(t, { summarize: shared.summarize, node: 100, jobs: 4, limiter }, await seeded());
  for (let count = 1; count <= 8; count++) {
    await shared.call(count);
    assert.equal(shared.running(), 1, "one call at a time across both memories");
    shared.calls[count - 1]!.reply("MERGED");
  }
  await Promise.all([until(first, () => first.status().pending === 0), until(second, () => second.status().pending === 0)]);
  assert.equal(shared.peak(), 1);
});
