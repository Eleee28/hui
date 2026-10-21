import assert from "node:assert/strict";
import { test } from "vitest";
import { ReplayBuffer } from "./replay.ts";

const LIMIT = 64 * 1024;
const bytes = (text: string) => Buffer.from(text, "utf8");

test("small and large chunks replay in order without loss below the limit", () => {
  const buffer = new ReplayBuffer(LIMIT);
  let expected = "";
  for (let i = 0; i < 500; i++) { const chunk = `line ${i}\r\n`; buffer.append(bytes(chunk)); expected += chunk; }
  const big = "x".repeat(20_000);
  buffer.append(bytes(big)); expected += big;
  buffer.append(bytes("tail")); expected += "tail";
  assert.equal(buffer.text(), expected);
  assert.equal(buffer.byteLength, Buffer.byteLength(expected));
  assert.equal(buffer.truncated, false);
  buffer.append(bytes("after read"));
  assert.equal(buffer.text(), expected + "after read", "reading does not stop later appends from packing");
});

test("trimming keeps the newest bytes, on a code point boundary, and marks truncation", () => {
  const buffer = new ReplayBuffer(LIMIT);
  let expected = "";
  for (let i = 0; i < 40_000; i++) { const chunk = i % 3 ? "é雪" : "😀"; buffer.append(bytes(chunk)); expected += chunk; }
  const text = buffer.text();
  assert.equal(buffer.truncated, true);
  assert.ok(buffer.byteLength <= LIMIT);
  assert.ok(buffer.byteLength > LIMIT - 4, "only a partial code point is dropped beyond the limit");
  assert.equal(Buffer.byteLength(text), buffer.byteLength);
  assert.ok(!text.includes("\uFFFD"));
  assert.ok(expected.endsWith(text));
});

test("a chunk larger than the limit keeps only its own UTF-8-aligned tail", () => {
  const buffer = new ReplayBuffer(LIMIT);
  buffer.append(bytes("old"));
  const huge = "😀".repeat(LIMIT);
  buffer.append(bytes(huge));
  const text = buffer.text();
  assert.equal(buffer.truncated, true);
  assert.ok(buffer.byteLength <= LIMIT);
  assert.ok(!text.includes("old") && !text.includes("\uFFFD"));
  assert.ok(huge.endsWith(text));
  buffer.append(bytes("next"));
  assert.ok(buffer.text().endsWith("😀next"));
});

test("appending stays proportional to the chunk, not the buffer", () => {
  const buffer = new ReplayBuffer(256 * 1024);
  const chunk = bytes("y".repeat(4096));
  const started = process.hrtime.bigint();
  // 64 MiB through a full 256 KiB buffer; re-encoding the buffer per chunk would copy 4 GiB.
  for (let i = 0; i < 16_384; i++) buffer.append(chunk);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(buffer.byteLength, 256 * 1024);
  assert.ok(elapsedMs < 2_000, `16,384 appends took ${elapsedMs} ms`);
});

test("empty appends change nothing and the limit must fit a block", () => {
  const buffer = new ReplayBuffer(LIMIT);
  buffer.append(new Uint8Array(0));
  assert.equal(buffer.text(), "");
  assert.equal(buffer.truncated, false);
  assert.throws(() => new ReplayBuffer(1024), RangeError);
});
