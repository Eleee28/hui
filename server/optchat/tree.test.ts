import assert from "node:assert/strict";
import { test } from "vitest";
import { endOf, freeLeaf, freeMerge, label, nodeCount, partAt, startOf, Tree } from "./tree.ts";

test("node (l, i) covers [i·2^l, (i+1)·2^l) and is named id+n after its messages", () => {
  assert.deepEqual([startOf([0, 7]), endOf([0, 7]), label([0, 7])], [7, 8, "7+1"]);
  assert.deepEqual([startOf([3, 273]), endOf([3, 273]), label([3, 273])], [2184, 2192, "2184+8"]);
  assert.deepEqual(partAt(2184, 8), [3, 273]);
  assert.deepEqual(partAt(5, 1), [0, 5]);
  for (const [id, n] of [[3, 2], [4, 3], [-1, 1], [0, 0], [1.5, 1], [2, 0.5]] as const) assert.equal(partAt(id, n), undefined, `${id}+${n}`);
  assert.equal(nodeCount(0), 0);
  assert.equal(nodeCount(5), 5 + 2 + 1);
  assert.equal(nodeCount(8), 8 + 4 + 2 + 1);
});

test("free nodes: a source that fits is its own node, verbatim", () => {
  assert.equal(freeLeaf("user", "keep it!!!", 16), "user: keep it!!!", "exactly 16 bytes");
  assert.equal(freeLeaf("user", "keep it!!!!", 16), undefined, "17 bytes");
  assert.equal(freeLeaf("user", "ééé", 12), "user: ééé", "bytes, not characters: 6 + 6");
  assert.equal(freeLeaf("user", "éééé", 13), undefined);
  assert.equal(freeMerge("user: a", "talk: b", 15), "user: a\ntalk: b");
  assert.equal(freeMerge("user: a", "talk: b", 14), undefined);
});

test("the tree keeps the first text of a node", () => {
  const tree = new Tree();
  assert.equal(tree.set(2, 1, "first"), true);
  assert.equal(tree.set(2, 1, "second"), false);
  assert.deepEqual([tree.text(2, 1), tree.size(2, 1), tree.count, tree.depth, tree.has(0, 0)], ["first", 5, 1, 3, false]);
  tree.set(2, 0, "zero");
  assert.deepEqual(tree.level(2), [[0, "zero"], [1, "first"]]);
});
