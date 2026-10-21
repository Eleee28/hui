/** Checks managed-browser wire decoders against golden binary frames and malformed JSON. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { decodeBrowserFrame, parseBrowserViewMessage } from "./browser.ts";

test("golden frames decode and malformed frames are rejected", async () => {
  const fixture = JSON.parse(await readFile(new URL("./browser.fixture.json", import.meta.url), "utf8"));
  const image = Buffer.from(fixture.image, "hex");
  const encoded = new Uint8Array(Buffer.from(fixture.frame, "hex"));
  const decoded = decodeBrowserFrame(encoded.buffer as ArrayBuffer);
  assert.deepEqual(decoded?.header, fixture.header);
  assert.deepEqual([...decoded!.image], [...image]);
  // A view into a larger buffer decodes from its own offset.
  const padded = new Uint8Array(encoded.length + 8);
  padded.set(encoded, 8);
  assert.deepEqual(decodeBrowserFrame(padded.subarray(8))?.header.tabId, fixture.header.tabId);
  const header = (value: unknown) => {
    const json = new TextEncoder().encode(JSON.stringify(value));
    const out = new Uint8Array(4 + json.length + 1);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    return out;
  };
  for (const bad of [
    new Uint8Array([0, 0]),
    new Uint8Array([0, 0, 0xff, 0xff, 1]),
    header({ tabId: "x1", width: 10, height: 10, seq: 1 }),
    header({ tabId: "t1", width: 0, height: 10, seq: 1 }),
    header({ tabId: "t1", width: 10, height: 99_999, seq: 1 }),
    header({ tabId: "t1", width: 10, height: 10 }),
    header({ tabId: "t1", width: 10, height: 10, seq: 1 }).subarray(0, -1),
  ]) assert.equal(decodeBrowserFrame(bad), undefined);
});

test("view messages are validated before the pane uses them", () => {
  assert.deepEqual(parseBrowserViewMessage({ type: "state", running: true, mode: "windowed", tabs: [{ id: "t1", title: 7, url: "u" }, { id: "../x" }, null], current: "t1", watching: "bogus", following: false }), {
    type: "state", running: true, mode: "windowed", tabs: [{ id: "t1", title: "", url: "u" }], current: "t1", watching: null, following: false,
  });
  assert.deepEqual(parseBrowserViewMessage({ type: "action", tabId: "t2", text: "Clicked e2", point: { x: 5, y: "7" }, at: "now" }), {
    type: "action", tabId: "t2", text: "Clicked e2", at: "now",
  });
  assert.deepEqual(parseBrowserViewMessage({ type: "action", tabId: "t2", text: "Clicked e2", point: { x: 5, y: 7 }, at: "now" })?.type, "action");
  for (const bad of [null, [], { type: "frame" }, { type: "action", tabId: "t1" }, { type: "action", tabId: "tab", text: "x" }]) {
    assert.equal(parseBrowserViewMessage(bad), undefined);
  }
});
