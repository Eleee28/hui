import assert from "node:assert/strict";
import { test } from "vitest";
import { endOf, nodeCount, PLACEHOLDER, startOf, Tree, type Part } from "./tree.ts";
import { View, type ViewLimits } from "./view.ts";

/** Every complete node over `count` messages, each text `size` bytes. */
function fullTree(count: number, size = 10): Tree {
  const tree = new Tree();
  for (let l = 0; 2 ** l <= count; l++) for (let i = 0; (i + 1) * 2 ** l <= count; i++) tree.set(l, i, `L${l}N${i}`.padEnd(size, ".").slice(0, size));
  assert.equal(tree.count, nodeCount(count));
  return tree;
}

function folded(tree: Tree, limits: ViewLimits) {
  const source = { length: 0, tree };
  const view = new View(source, limits);
  const append = (batch = false) => { view.append(source.length++, batch); return view.parts(); };
  return { source, view, append };
}

/** Every part of `before` is still in `after` or inside a part of it. */
function coarsens(before: readonly Part[], after: readonly Part[]): boolean {
  return before.every((part) => after.some((next) => startOf(next) <= startOf(part) && endOf(part) <= endOf(next)));
}

/**
 * Taelin's rollback list as a binary counter, newest entry first: each entry is the message that starts a line and a
 * bit. A new message flips the newest bit from 0 to 1 and is dropped (its line joins the newest), or, on a 1, takes the
 * newest place with a 0 and carries the entry it displaced on into the rest of the list the same way.
 */
class RollbackList {
  readonly #entries: { start: number; bit: 0 | 1 }[] = [];
  #count = 0;

  push(): void {
    let carried = this.#count++;
    for (let k = 0; ; k++) {
      const entry = this.#entries[k];
      if (!entry) { this.#entries.push({ start: carried, bit: 0 }); return; }
      if (entry.bit === 0) { entry.bit = 1; return; }
      this.#entries[k] = { start: carried, bit: 0 };
      carried = entry.start;
    }
  }

  /** The list read as a view: each entry starts a line that runs to the next newer one, the newest to now. */
  parts(): Part[] {
    const starts = this.#entries.map((entry) => entry.start).reverse();
    return starts.map((start, k) => {
      const span = (starts[k + 1] ?? this.#count) - start;
      const l = Math.log2(span);
      assert(Number.isInteger(l) && start % span === 0, `${start}+${span} is not a tree node`);
      return [l, start / span] as const;
    });
  }
}

test("with the rollback list's length as its budget, the view makes exactly the merges Taelin's push makes", () => {
  const count = 5_000;
  const tree = new Tree();
  for (let l = 0; 2 ** l <= count; l++) for (let i = 0; (i + 1) * 2 ** l <= count; i++) tree.set(l, i, "x");
  const { view, append } = folded(tree, { high: 0, low: 0 });
  const list = new RollbackList();
  for (let t = 0; t < count; t++) {
    list.push();
    const expected = list.parts();
    // One-byte lines: the size is the line count; high = low makes every step one batch down to the list's length.
    view.limits = { high: expected.length, low: expected.length };
    const before = view.parts();
    const after = append();
    assert.deepEqual(after, expected, `message ${t}`);
    // Push merges at most one pair per message, and so does the view: one line in, at most one pair out.
    assert(after.length === before.length + 1 || (after.length === before.length && coarsens(before, after)), `message ${t}`);
  }
  assert(Math.abs(view.length - Math.log2(count)) < 2, `about log2(T) lines: ${view.length}`);
});

test("a pair is due by how long ago it ended: at ten messages 8+1 and 9+1 merge before 0+4 and 4+4", () => {
  const { view, append } = folded(fullTree(11, 1), { high: 3, low: 3 });
  for (let t = 0; t < 9; t++) append();
  assert.deepEqual(view.parts(), [[2, 0], [2, 1], [0, 8]]);
  // (T - last) / 2^l: 8-9 ended 0 messages ago, 0-7 ended 2 messages ago in 4-message lines, half a line. Measured
  // from each pair's first message instead, (10 - 0) / 4 beats (10 - 8) / 1, and 0-7 would merge.
  assert.deepEqual(append(), [[2, 0], [2, 1], [1, 4]]);
  assert.deepEqual(append(), [[3, 0], [1, 4], [0, 10]]);
});

test("each message appends its part, then the most due pair with a built parent merges until the view fits", () => {
  const { view, append } = folded(fullTree(10), { high: 40, low: 40 });
  const steps: Part[][] = [];
  for (let i = 0; i < 10; i++) steps.push(append());
  assert.deepEqual(steps, [
    [[0, 0]],
    [[0, 0], [0, 1]],
    [[0, 0], [0, 1], [0, 2]],
    [[0, 0], [0, 1], [0, 2], [0, 3]],
    // due = (T + 1) / 2^l - i: (6 - 0) beats (6 - 2).
    [[1, 0], [0, 2], [0, 3], [0, 4]],
    [[1, 0], [1, 1], [0, 4], [0, 5]],
    // The level-1 pair, 8/2 - 0 = 4, ties the level-0 pair at 4, 8 - 4 = 4: the oldest goes first.
    [[2, 0], [0, 4], [0, 5], [0, 6]],
    [[2, 0], [1, 2], [0, 6], [0, 7]],
    [[2, 0], [1, 2], [1, 3], [0, 8]],
    // 11/2 - 2 = 3.5 beats 11 - 8 = 3.
    [[2, 0], [2, 1], [0, 8], [0, 9]],
  ]);
  assert.deepEqual([view.size, view.length], [40, 4]);
  // Never split: every part of an earlier step is still in the view or inside a part of it.
  for (let k = 1; k < steps.length; k++) assert(coarsens(steps[k - 1]!, steps[k]!), `step ${k} split a part`);
});

test("between batches the view only appends; past the high mark one batch merges it down to the low mark", () => {
  // Lines of 10 to 50 bytes: one byte more for each of the four levels a line may sit at, so sizes differ by level.
  const count = 3_000;
  const tree = new Tree();
  for (let l = 0; 2 ** l <= count; l++) for (let i = 0; (i + 1) * 2 ** l <= count; i++) tree.set(l, i, "y".repeat(10 + ((i * 7 + l * 13) % 37) + l));
  const { view, append } = folded(tree, { high: 2_000, low: 1_000 });
  let batches = 0;
  let previous: Part[] = [];
  let lowest = Number.POSITIVE_INFINITY;
  for (let t = 0; t < count; t++) {
    const sizeBefore = view.size;
    const parts = append();
    if (view.batches === batches) {
      assert.deepEqual(parts, [...previous, [0, t]], `message ${t}: no batch, so only an append`);
    } else {
      batches = view.batches;
      assert(sizeBefore <= 2_000 && sizeBefore + tree.size(0, t)! > 2_000, `message ${t}: a batch starts only past the high mark`);
      assert(view.size <= 1_000, `message ${t}: a batch ends at the low mark, at ${view.size}`);
      assert(coarsens(previous, parts), `message ${t}: a batch only merges`);
      lowest = Math.min(lowest, view.size);
    }
    assert(view.size <= 2_000, `message ${t}: every parent is built, so the view never stays past its high mark`);
    assert.equal(view.batching, false);
    previous = parts;
  }
  // Each batch merges about 1,000 bytes of lines; one merge saves at most a line's worth, so it stops just under 1,000.
  assert(batches >= 30 && batches <= 120, String(batches));
  assert(lowest > 1_000 - 2 * 51, String(lowest));
});

test("a batch that parents not built yet stop short goes on as they are built and as messages arrive", () => {
  const tree = new Tree();
  for (let i = 0; i < 8; i++) tree.set(0, i, `L0N${i}`.padEnd(10, "."));
  const { view, append } = folded(tree, { high: 45, low: 25 });
  for (let i = 0; i < 4; i++) append();
  assert.deepEqual([view.size, view.batching], [40, false], "under the high mark: appends only");
  append();
  assert.deepEqual([view.parts(), view.size, view.batching], [[[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], 50, true], "past it, but no parent is built");
  tree.set(1, 1, "L1N1".padEnd(10, "."));
  view.built(1, 1);
  assert.deepEqual([view.parts(), view.batching], [[[0, 0], [0, 1], [1, 1], [0, 4]], true], "the only mergeable pair, though not the most due");
  append();
  assert.deepEqual([view.size, view.batching], [50, true], "a new message joins the batch still under way");
  tree.set(1, 0, "L1N0".padEnd(10, "."));
  view.built(1, 0);
  assert.deepEqual([view.parts(), view.size, view.batching], [[[1, 0], [1, 1], [0, 4], [0, 5]], 40, true]);
  tree.set(2, 0, "L2N0".padEnd(10, "."));
  view.built(2, 0);
  assert.deepEqual([view.parts(), view.size, view.batching], [[[2, 0], [0, 4], [0, 5]], 30, true], "still over the low mark");
  tree.set(1, 2, "L1N2".padEnd(10, "."));
  view.built(1, 2);
  assert.deepEqual([view.parts(), view.size, view.batching], [[[2, 0], [1, 2]], 20, false], "down to the low mark: the batch is over");
  append();
  append();
  assert.deepEqual([view.size, view.batching], [40, false], "back to appending only");
});

test("a forced batch merges a view under its high mark down to its low mark, and restore takes a saved state over", () => {
  const tree = fullTree(8);
  const { view, append } = folded(tree, { high: 1_000, low: 30 });
  for (let i = 0; i < 6; i++) append();
  assert.deepEqual([view.size, view.batches], [60, 0], "under the high mark: appends only");
  assert.deepEqual([append(true), view.size, view.batches, view.batching], [[[2, 0], [1, 2], [0, 6]], 30, 1, false]);
  assert.deepEqual([append(true), view.size, view.batches], [[[2, 0], [1, 2], [1, 3]], 30, 2]);
  const roomy = folded(tree, { high: 1_000, low: 500 });
  roomy.append(true);
  assert.deepEqual([roomy.view.batches, roomy.view.batching], [0, false], "a forced batch under the low mark is no batch");
  const copy = new View({ length: 8, tree }, { high: 1_000, low: 30 });
  copy.restore(view.state());
  assert.deepEqual([copy.parts(), copy.size, copy.batching, copy.end], [[[2, 0], [1, 2], [1, 3]], 30, false, 8]);
  const lower = new View({ length: 8, tree }, { high: 10, low: 10 });
  lower.restore({ parts: view.parts(), batch: false });
  assert.deepEqual(lower.parts(), [[3, 0]], "a lower high mark than the state was saved under starts a batch at once");
  const resumed = new View({ length: 8, tree }, { high: 1_000, low: 20 });
  resumed.restore({ parts: view.parts(), batch: true });
  assert.deepEqual([resumed.parts(), resumed.batching], [[[2, 0], [2, 1]], false], "a batch saved under way goes on");
});

test("an unsummarized message counts and renders as its placeholder; settle waits for it and aborts", async () => {
  const tree = new Tree();
  const { view, append } = folded(tree, { high: 1_000, low: 500 });
  append(); append();
  assert.equal(view.size, 2 * Buffer.byteLength(PLACEHOLDER));
  assert.deepEqual([view.first(), view.settled(0), view.settled(1)], [0, true, false]);
  const waited = view.settle(1);
  const controller = new AbortController();
  const aborted = view.settle(2, controller.signal);
  assert.equal(view.waiting, 2);
  controller.abort();
  assert.equal(await aborted, false);
  assert.equal(view.waiting, 1);
  tree.set(0, 0, "user: hi\nthere");
  view.built(0, 0);
  assert.equal(await waited, true);
  assert.deepEqual([view.waiting, view.first(), view.size], [0, 1, Buffer.byteLength("user: hi\nthere") + Buffer.byteLength(PLACEHOLDER)]);
  assert.equal(view.render(), `<chat>\n0+1|user: hi there\n1+1|${PLACEHOLDER}\n</chat>`);
  assert.equal(await view.settle(1, AbortSignal.abort()), true, "already settled");
  const late = view.settle(2);
  view.close();
  assert.equal(await late, false, "closing releases waiters");
});

test("a compaction's context is the bare lines before its end, up to the first line not built", () => {
  const tree = new Tree();
  for (const i of [0, 1, 3]) tree.set(0, i, `user: line ${i}\nwrapped`);
  const { view, append } = folded(tree, { high: 1_000, low: 500 });
  for (let i = 0; i < 4; i++) append();
  assert.deepEqual(view.context(1), ["user: line 0 wrapped"], "no ids, newlines as spaces, nothing from its end on");
  assert.deepEqual(view.context(2), ["user: line 0 wrapped", "user: line 1 wrapped"]);
  assert.deepEqual(view.context(4), ["user: line 0 wrapped", "user: line 1 wrapped"], "line 2 is not built: line 3 is left out too");
  assert.deepEqual(view.context(0), []);
});

test("a frozen prefix tiles exactly the messages before its bound", () => {
  const { view, append } = folded(fullTree(4), { high: 10, low: 10 });
  append(); append();
  assert.deepEqual(view.parts(), [[1, 0]]);
  assert.deepEqual(view.parts(1), [[0, 0]], "a part straddling the bound gives its children");
  assert.deepEqual(view.parts(2), [[1, 0]]);
  append(); append();
  assert.deepEqual(view.parts(), [[2, 0]]);
  assert.deepEqual(view.parts(3), [[1, 0], [0, 2]]);
  assert.equal(view.render(view.parts(3)), "<chat>\n0+2|L1N0......\n2+1|L0N2......\n</chat>");
  assert.equal(new View({ length: 0, tree: new Tree() }, { high: 10, low: 5 }).render(), "<chat>\n\n</chat>");
});
