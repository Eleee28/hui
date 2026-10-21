import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionViewCache } from "./view-cache.ts";

test("focus changes touch recency without moving render slots or reconnecting views", () => {
  const cache = new SessionViewCache();
  assert.deepEqual(cache.retain("a"), ["a"]);
  assert.deepEqual(cache.retain("b"), ["a", "b"]);
  assert.deepEqual(cache.retain("c"), ["a", "b", "c"]);
  assert.deepEqual(cache.retain("a"), ["a", "b", "c"]);
  assert.deepEqual(cache.retain("d"), ["a", "d", "c"], "reuse the oldest slot, not the array order");
});

test("unsaved queue edits pin cached views above the cap then release them", () => {
  const cache = new SessionViewCache();
  for (const id of ["a", "b", "c"]) cache.retain(id);
  assert.deepEqual(cache.retain("d", new Set(["a", "b", "c"])), ["a", "b", "c", "d"]);
  assert.deepEqual(cache.retain("d"), ["b", "c", "d"]);
  assert.deepEqual(cache.retain("e"), ["e", "c", "d"]);
});

test("deleted registry sessions cannot remain in hidden view slots", () => {
  const cache = new SessionViewCache();
  for (const id of ["a", "b", "c"]) cache.retain(id);
  cache.removeMissing(new Set(["a", "c"]));
  assert.deepEqual(cache.retain("c"), ["a", "c"]);
  assert.deepEqual(cache.retain("d"), ["a", "d", "c"]);
});
