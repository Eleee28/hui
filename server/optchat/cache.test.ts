import assert from "node:assert/strict";
import { test } from "vitest";
import { BLOCK_LINES, blockCuts, blockMarks, markCache, markedPrefix } from "./cache.ts";

const view = (count: number, from = 0) => `<chat>\n${Array.from({ length: count }, (_, k) => `${from + k}+1|line ${from + k}`).join("\n")}\n</chat>`;
const pieces = (text: string, cuts: readonly number[]) => [0, ...cuts].map((start, k) => text.slice(start, cuts[k] ?? text.length));

test("a view is cut into blocks of four lines: <chat> opens the first, and the last, partial one ends with </chat>", () => {
  assert.equal(BLOCK_LINES, 4);
  const ten = view(10);
  assert.deepEqual(pieces(ten, blockCuts(ten)), [
    "<chat>\n0+1|line 0\n1+1|line 1\n2+1|line 2\n3+1|line 3",
    "\n4+1|line 4\n5+1|line 5\n6+1|line 6\n7+1|line 7",
    "\n8+1|line 8\n9+1|line 9\n</chat>",
  ]);
  const eight = view(8);
  assert.deepEqual(pieces(eight, blockCuts(eight)).at(-1), "\n</chat>", "no partial line left: </chat> alone, never an empty block");
  assert.deepEqual(blockCuts(view(3)), [], "no whole block");
  assert.deepEqual(blockCuts("<chat>\n\n</chat>", 1), [], "an empty view has no line to cut");
  assert.deepEqual(pieces(view(1), blockCuts(view(1), 1)), ["<chat>\n0+1|line 0", "\n</chat>"]);
  for (const count of [4, 5, 77, 256]) {
    const text = view(count);
    const cuts = blockCuts(text);
    assert.equal(pieces(text, cuts).join(""), text, "the blocks are the view, in order");
    assert.equal(cuts.length, Math.floor(count / 4));
    assert(pieces(text, cuts).slice(0, -1).every((block) => block.split("\n").filter((line) => /^\d+\+1\|/u.test(line)).length === 4), "whole blocks hold four lines");
  }
});

test("the mark goes on the last whole block, and on the block the previous request marked while it starts this one", () => {
  const before = view(10);
  const previous = markedPrefix(before, blockCuts(before));
  assert.equal(previous, pieces(before, blockCuts(before)).slice(0, 2).join(""), "the prefix up to the last whole block");
  assert.equal(markedPrefix(view(3), blockCuts(view(3))), undefined);
  // 90 lines later the old mark sits 22 blocks back, past Anthropic's 20-block lookback: marked again, it is found.
  const grown = view(100);
  assert.deepEqual(blockMarks(grown, blockCuts(grown), previous), [1, 24]);
  assert.deepEqual(blockMarks(grown, blockCuts(grown)), [24], "with no previous request, the last whole block alone");
  // A batch rewrote the view from its first line: the old prefix is gone, and so is its mark.
  const merged = `<chat>\n0+2|merged${grown.slice(grown.indexOf("\n2+1|"))}`;
  assert.deepEqual(blockMarks(merged, blockCuts(merged), previous), [blockCuts(merged).length - 1]);
  assert.deepEqual(blockMarks(before, blockCuts(before), previous), [1], "the same block: marked once");
  assert.deepEqual(blockMarks(view(6), blockCuts(view(6)), previous), [0], "a shorter view never carries a mark past its end");
  assert.deepEqual(blockMarks(view(3), blockCuts(view(3)), previous), []);
});

const control = { type: "ephemeral" };
/** A request as pi-ai shapes it for Anthropic: marks on the system prompt, the last tool and the request's last block. */
const payload = (text: string, system = [{ type: "text", text: "S", cache_control: { ...control } }]) => ({
  system,
  tools: [{ name: "read" }, { name: "zoom", cache_control: { ...control } }],
  messages: [{ role: "user", content: [{ type: "text", text }, { type: "text", text: "input", cache_control: { ...control } }] }],
});
type Payload = ReturnType<typeof payload>;
const breakpoints = (request: Payload) => [...request.system, ...request.tools, ...request.messages[0]!.content].filter((block) => (block as { cache_control?: unknown }).cache_control !== undefined).length;

test("the view goes as its blocks with pi-ai's own mark on the chosen ones, within Anthropic's four breakpoints", () => {
  const text = view(10);
  const cuts = blockCuts(text);
  const anthropic = { api: "anthropic-messages" };
  assert.equal(markCache(payload(text), { api: "openai-responses" }, text, cuts, [1]), undefined, "other APIs cache prefixes by themselves: untouched");
  assert.equal(markCache(payload(text), { api: "openai-completions" }, text, cuts, [1]), undefined);
  assert.equal(markCache(payload(text), anthropic, "other", cuts, [1]), undefined, "no such block");
  assert.equal(markCache(payload(text), anthropic, text, cuts, []), undefined, "nothing to mark");
  const uncached = payload(text);
  delete (uncached.system[0] as { cache_control?: unknown }).cache_control;
  delete (uncached.tools[1] as { cache_control?: unknown }).cache_control;
  delete (uncached.messages[0]!.content[1] as { cache_control?: unknown }).cache_control;
  assert.equal(markCache(uncached, anthropic, text, cuts, [1]), undefined, "pi-ai does not cache: neither do the marks");

  const one = markCache(payload(text), anthropic, text, cuts, [1]) as Payload;
  assert.deepEqual(one.messages[0]!.content, [
    { type: "text", text: "<chat>\n0+1|line 0\n1+1|line 1\n2+1|line 2\n3+1|line 3" },
    { type: "text", text: "\n4+1|line 4\n5+1|line 5\n6+1|line 6\n7+1|line 7", cache_control: control },
    { type: "text", text: "\n8+1|line 8\n9+1|line 9\n</chat>" },
    { type: "text", text: "input", cache_control: control },
  ]);
  assert.deepEqual([one.tools[1]!.cache_control, one.system[0]!.cache_control, breakpoints(one)], [control, control, 4], "four fit: nothing gives way");

  const two = markCache(payload(view(100)), anthropic, view(100), blockCuts(view(100)), [1, 24]) as Payload;
  assert.deepEqual([two.tools[1], two.system[0]!.cache_control, breakpoints(two)], [{ name: "zoom" }, control, 4], "the tools' mark gives way first");
  assert.deepEqual(two.messages[0]!.content.at(-1)!.cache_control, control, "pi-ai's mark at the request end stays");
  // A Claude Code login gets two marked system blocks from pi-ai: the first of them gives way next.
  const oauth = [{ type: "text", text: "Claude Code", cache_control: { ...control } }, { type: "text", text: "S", cache_control: { ...control } }];
  const logged = markCache(payload(view(100), oauth), anthropic, view(100), blockCuts(view(100)), [1, 24]) as Payload;
  assert.deepEqual([logged.system.map((block) => block.cache_control), breakpoints(logged)], [[undefined, control], 4]);
  const marked = logged.messages[0]!.content.flatMap((block, k) => (block as { cache_control?: unknown }).cache_control ? [k] : []);
  assert.deepEqual(marked, [1, 24, 26], "both view marks and the end mark");
  assert.equal(logged.messages[0]!.content.slice(0, -1).map((block) => block.text).join(""), view(100));
});
