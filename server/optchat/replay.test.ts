import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { blockCuts, blockMarks, markCache, markedPrefix } from "./cache.ts";
import type { Summarize } from "./compactor.ts";
import { OptChatMemory } from "./memory.ts";

// A long chat replayed through the engine, every node built before the next message and a turn every four messages,
// with each turn's and compaction's request marked as the gateway marks it and read the way Anthropic's prompt cache
// reads requests (docs/optchat.md, "Prompt caching"): an entry only at a mark, found by looking back at most 20 blocks
// from a later mark.

const MESSAGES = 3_000;
const TURN = 4;

/** mulberry32: the same chat on every run and every Node version. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = "the a build test cache view line merge node tree turn user reply tool echo file path error fixed done run check push branch commit diff patch model token batch log open read write".split(" ");
const KINDS = ["user", "talk", "tool", "echo"] as const;

/** 55% short messages (60-300 bytes, each its own line) and 45% long ones (600-3,000 bytes, summarized). */
function chat(count: number): { kind: (typeof KINDS)[number]; text: string }[] {
  const next = random(7);
  const words = (size: number) => {
    let text = "";
    while (text.length < size) text += `${WORDS[Math.floor(next() * WORDS.length)]} `;
    return text.slice(0, size).trimEnd();
  };
  return Array.from({ length: count }, (_, i) => ({ kind: KINDS[i % 4]!, text: words(next() < 0.55 ? 60 + Math.floor(next() * 241) : 600 + Math.floor(next() * 2_400)) }));
}

type Block = { type?: string; text?: string; name?: string; cache_control?: unknown };
type Payload = { system?: Block[]; tools?: Block[]; messages: { role: string; content: Block[] }[] };
const control = () => ({ type: "ephemeral" });

/** Anthropic's prompt cache over a series of requests: the share of each request's measured blocks read from it. */
function anthropicCache() {
  const entries = new Set<string>();
  return (payload: Payload, measured: (block: Block) => boolean): number => {
    const blocks = [...payload.tools ?? [], ...payload.system ?? [], ...payload.messages.flatMap((message) => message.content)];
    const keys: string[] = [];
    let key = "";
    for (const block of blocks) keys.push(key = createHash("sha1").update(key).update("\0").update(JSON.stringify({ ...block, cache_control: undefined })).digest("hex"));
    const marks = blocks.flatMap((block, k) => block.cache_control === undefined ? [] : [k]);
    assert(marks.length <= 4, `${marks.length} breakpoints`);
    let read = -1;
    for (const mark of marks) {
      for (let at = mark; at >= Math.max(0, mark - 19); at--) if (entries.has(keys[at]!)) { read = Math.max(read, at); break; }
    }
    for (const mark of marks) entries.add(keys[mark]!);
    let total = 0;
    let hit = 0;
    blocks.forEach((block, k) => {
      if (!measured(block)) return;
      total += Buffer.byteLength(block.text ?? "");
      if (k <= read) hit += Buffer.byteLength(block.text ?? "");
    });
    return total ? hit / total : 0;
  };
}

const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sharedPrefix = (a: string, b: string) => {
  let k = 0;
  while (k < a.length && k < b.length && a.charCodeAt(k) === b.charCodeAt(k)) k++;
  return k;
};

test("over a long chat each turn's view starts with the last one's, and the cache reads nearly all of every request", { timeout: 240_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-optchat-replay-"));
  const compactions: { context: string; step: string; at: number }[] = [];
  let at = 0;
  const summarize: Summarize = async (request) => {
    const [context, step] = request.messages[0]!.content as readonly string[];
    if (request.messages.length === 1) compactions.push({ context: context!, step: step!, at });
    return `summary ${createHash("sha256").update(step!).digest("hex")} `.repeat(8).slice(0, 512);
  };
  const memory = await OptChatMemory.open(dir, { name: "Grok", summarize });
  // Close the memory before its directory goes, or a final save fails the rm.
  t.onTestFinished(async () => { await memory.close(); await rm(dir, { recursive: true, force: true }); });
  const built = () => new Promise<void>((resolve) => {
    if (memory.status().pending === 0) { resolve(); return; }
    const off = memory.onChange(() => { if (memory.status().pending === 0) { off(); resolve(); } });
  });

  const turnCache = anthropicCache();
  const turns: { view: string; size: number; read: number }[] = [];
  let previous: string | undefined;
  let full = -1;
  let batches = 0;
  let size = 0;
  for (const [i, message] of chat(MESSAGES).entries()) {
    at = i;
    await memory.append(message.kind, message.text);
    await built();
    const status = memory.status();
    if (status.viewBytes < size) batches++;
    size = status.viewBytes;
    // Both views grow alike until the view first nears its high mark; measured from there on.
    if (full === -1 && size >= 120_000) full = i;
    if (i % TURN) continue;
    // Turn: the view of every line before its input, marked as the gateway marks it, after pi-ai's own marks.
    const parts = memory.parts(i);
    const view = memory.renderParts(parts);
    const payload: Payload = {
      tools: [{ name: "zoom", cache_control: control() }],
      system: [{ type: "text", text: "system prompt", cache_control: control() }],
      messages: [{ role: "user", content: [{ type: "text", text: view }, { type: "text", text: `input ${i}`, cache_control: control() }] }],
    };
    const cuts = blockCuts(view);
    // A view of fewer than four lines has no whole block to mark: pi-ai's own marks go alone.
    assert.equal(markCache(payload, { api: "anthropic-messages" }, view, cuts, blockMarks(view, cuts, previous)) === undefined, cuts.length === 0);
    previous = markedPrefix(view, cuts);
    const read = turnCache(payload, (block) => block.type === "text" && block !== payload.messages[0]!.content.at(-1) && !payload.system!.includes(block));
    if (full !== -1) turns.push({ view, size: parts.reduce((total, [l, n]) => total + memory.tree.size(l, n)!, 0), read });
  }
  assert(full !== -1 && turns.length > 500, `${turns.length} turns after the view filled at message ${full}`);

  // The view is a sawtooth between 64 and 128 KB that only grows at its end between batches.
  assert(batches >= 8, `${batches} batches`);
  const sizes = turns.map((turn) => turn.size);
  assert(Math.max(...sizes) <= 128_000 && Math.min(...sizes) >= 60_000, `views of ${Math.min(...sizes)} to ${Math.max(...sizes)} bytes`);
  assert(average(sizes) > 80_000 && average(sizes) < 112_000, `${average(sizes)} bytes on average`);
  const unchanged = turns.slice(1).map((turn, k) => sharedPrefix(turns[k]!.view, turn.view) / turn.view.length);
  assert(average(unchanged) > 0.9, `${average(unchanged)} of each view is the last one's`);
  const read = average(turns.map((turn) => turn.read));
  assert(read > 0.9, `${read} of each view read from the cache`);
  console.log(`${turns.length} turns from message ${full}: views of ${Math.round(average(sizes))} bytes on average, ${(100 * average(unchanged)).toFixed(1)}% unchanged from the last turn, ${(100 * read).toFixed(1)}% read from the cache`);

  // Compactions read the compaction view, 16 to 32 KB, and one another's prefix of it.
  const contextCache = anthropicCache();
  let marked: string | undefined;
  const contexts: { bytes: number; read: number }[] = [];
  for (const { context, step, at: message } of compactions) {
    const payload: Payload = {
      system: [{ type: "text", text: "compactor prompt", cache_control: control() }],
      messages: [{ role: "user", content: [{ type: "text", text: context }, { type: "text", text: step, cache_control: control() }] }],
    };
    const cuts = blockCuts(context);
    if (markCache(payload, { api: "anthropic-messages" }, context, cuts, blockMarks(context, cuts, marked)) !== undefined) marked = markedPrefix(context, cuts);
    const shared = contextCache(payload, (block) => block !== payload.messages[0]!.content.at(-1) && !payload.system!.includes(block));
    if (message >= full) contexts.push({ bytes: Buffer.byteLength(context), read: shared });
  }
  assert(contexts.length > 1_000, String(contexts.length));
  // At most 32,000 bytes of lines, plus <chat> tags and a newline between lines.
  assert(contexts.every(({ bytes }) => bytes <= 32_000 + 200), `a context of ${Math.max(...contexts.map(({ bytes }) => bytes))} bytes`);
  const contextBytes = average(contexts.map(({ bytes }) => bytes));
  assert(contextBytes > 16_000 && contextBytes < 32_000, `${contextBytes} bytes of context on average`);
  const contextRead = average(contexts.map(({ read: share }) => share));
  assert(contextRead > 0.9, `${contextRead} of each context read from the cache`);
  console.log(`${contexts.length} compactions: contexts of ${Math.round(contextBytes)} bytes on average, ${(100 * contextRead).toFixed(1)}% read from the cache`);
});
