import assert from "node:assert/strict";
import { test } from "vitest";

import { parseProcessRows, processTreeMemory } from "./resources.ts";

test("parses ps rows and rejects malformed process data", () => {
  assert.deepEqual(parseProcessRows(" 10 1 2048\n11 10 512\ninvalid\n12 10 -1\n"), [
    { pid: 10, parentPid: 1, rssBytes: 2 * 1024 * 1024 },
    { pid: 11, parentPid: 10, rssBytes: 512 * 1024 },
  ]);
});

test("sums each runtime root with its complete process tree", () => {
  const rows = parseProcessRows("10 1 100\n11 10 50\n12 11 25\n20 1 80\n21 20 20\n");
  assert.deepEqual([...processTreeMemory(rows, [10, 20, 99])], [
    [10, 175 * 1024],
    [20, 100 * 1024],
  ]);
});

test("a malformed parent cycle cannot double-count or loop", () => {
  const rows = parseProcessRows("10 11 100\n11 10 50\n");
  assert.equal(processTreeMemory(rows, [10]).get(10), 150 * 1024);
});
