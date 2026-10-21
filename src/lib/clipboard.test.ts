import assert from "node:assert/strict";
import { test } from "vitest";
import { writeClipboardImage, writeClipboardText } from "./clipboard.ts";

test("uses the modern clipboard API when it is available", async () => {
  const writes: string[] = [];
  const copied = await writeClipboardText("hello", {
    clipboard: { writeText: async (text) => { writes.push(text); } },
    legacyCopy: () => { throw new Error("legacy fallback must not run"); },
  });
  assert.equal(copied, true);
  assert.deepEqual(writes, ["hello"]);
});

test("falls back when clipboard access is unavailable or rejected", async () => {
  for (const clipboard of [null, { writeText: async () => { throw new Error("denied"); } }]) {
    const writes: string[] = [];
    const copied = await writeClipboardText("http origin", {
      clipboard,
      legacyCopy: (text) => { writes.push(text); return true; },
    });
    assert.equal(copied, true);
    assert.deepEqual(writes, ["http origin"]);
  }
});

test("reports failure when neither copy path succeeds", async () => {
  assert.equal(await writeClipboardText("nope", { clipboard: null, legacyCopy: () => false }), false);
});

const png = () => Promise.resolve(new Blob(["png"], { type: "image/png" }));

test("copies images through the async clipboard as a PNG item", async () => {
  const written: unknown[][] = [];
  const item = { types: ["image/png"] } as unknown as ClipboardItem;
  const result = await writeClipboardImage(png(), {
    clipboard: { write: async (items) => { written.push(items); } },
    createItem: () => item,
    legacyCopy: async () => { throw new Error("legacy fallback must not run"); },
  });
  assert.equal(result, "image");
  assert.deepEqual(written, [[item]]);
});

test("falls back to a rich-content image copy without the async image clipboard", async () => {
  for (const options of [
    { clipboard: null, createItem: () => ({}) as ClipboardItem },
    { clipboard: { write: async () => {} }, createItem: null },
    { clipboard: { write: async () => { throw new Error("denied"); } }, createItem: () => ({}) as ClipboardItem },
  ]) {
    let fallbackCalls = 0;
    const result = await writeClipboardImage(png(), { ...options, legacyCopy: async () => { fallbackCalls += 1; return true; } });
    assert.equal(result, "html");
    assert.equal(fallbackCalls, 1);
  }
});

test("reports image copy failure when the PNG cannot be produced or copied", async () => {
  const failed = Promise.reject(new Error("tainted canvas"));
  failed.catch(() => {});
  assert.equal(await writeClipboardImage(failed, { clipboard: null, createItem: null, legacyCopy: async (blob) => Boolean(await blob) }), false);
  assert.equal(await writeClipboardImage(png(), { clipboard: null, createItem: null, legacyCopy: async () => false }), false);
});
