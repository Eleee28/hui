import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { Tree } from "./tree.ts";
import { checkViews, readViews, ViewFile, type SavedViews } from "./view-file.ts";

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hui-optchat-view-file-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Nodes (0, 0..7), (1, 0..2) and (2, 0): (1, 3) and (2, 1) are not built. */
function tree(): Tree {
  const built = new Tree();
  for (let i = 0; i < 8; i++) built.set(0, i, `m${i}`);
  for (let i = 0; i < 3; i++) built.set(1, i, `p${i}`);
  built.set(2, 0, "q0");
  return built;
}

const views = (chat: readonly (readonly number[])[], compaction: readonly (readonly number[])[] = chat, batch = false) => ({ version: 1, chat: { parts: chat, batch }, compaction: { parts: compaction, batch: false } });

test("a saved view fits when it tiles the first messages without a gap and every merged part is built", () => {
  const ok = checkViews(views([[2, 0], [1, 2], [0, 6]], [[2, 0], [1, 2], [0, 6]], true), 8, tree());
  assert.deepEqual(ok, { chat: { parts: [[2, 0], [1, 2], [0, 6]], batch: true }, compaction: { parts: [[2, 0], [1, 2], [0, 6]], batch: false } });
  assert.deepEqual(checkViews(views([]), 0, new Tree()), { chat: { parts: [], batch: false }, compaction: { parts: [], batch: false } });
  assert.deepEqual(checkViews(views([[0, 0], [0, 1]], [[1, 0]]), 8, tree()), { chat: { parts: [[0, 0], [0, 1]], batch: false }, compaction: { parts: [[1, 0]], batch: false } }, "behind the log: its tail is appended at open");
  const unbuiltLeaf = new Tree();
  assert.equal(typeof checkViews(views([[0, 0], [0, 1]]), 2, unbuiltLeaf), "object", "a level-0 part may still be a placeholder");
  const problems: [unknown, number, RegExp][] = [
    [null, 8, /has no version 1/u],
    [{ ...views([[0, 0]]), version: 2 }, 8, /has no version 1/u],
    [{ version: 1, chat: { parts: [[0, 0]], batch: false } }, 8, /compaction view is malformed/u],
    [{ ...views([[0, 0]]), chat: { parts: [[0, 0]] } }, 8, /chat view is malformed/u],
    [views([[0, 0, 1]]), 8, /chat view holds a malformed part/u],
    [views([[0, 1.5]]), 8, /malformed part/u],
    [views([[53, 0]]), 8, /malformed part/u],
    [views([[0, 1]]), 8, /does not tile the chat: 1\+1 comes first/u],
    [views([[0, 0], [0, 2]]), 8, /does not tile the chat: 2\+1 follows message 0/u],
    [views([[1, 0], [0, 1]]), 8, /does not tile/u],
    [views([[2, 0], [1, 2], [1, 3]]), 8, /chat view holds 6\+2, which is not built/u],
    [views([[2, 0], [2, 1]], [[2, 0], [1, 2], [1, 3]]), 8, /not built/u],
    [views([[2, 0], [1, 2], [0, 6], [0, 7], [0, 8]]), 8, /chat view covers 9 messages, but the log holds 8/u],
    [views([[2, 0]], [[2, 0], [0, 4]]), 8, /its views cover 4 and 5 messages/u],
  ];
  for (const [value, log, problem] of problems) assert.match(String(checkViews(value, log, tree())), problem, JSON.stringify(value));
});

test("the file is replaced whole with the latest views, and a missing or garbled one says why", async (t) => {
  const dir = await directory(t);
  assert.deepEqual(await readViews(dir), { problem: "view.json is missing" });
  let current: SavedViews = { chat: { parts: [[0, 0]], batch: false }, compaction: { parts: [[0, 0]], batch: false } };
  let snapshots = 0;
  const file = new ViewFile(dir, () => { snapshots++; return current; }, assert.fail);
  file.changed();
  current = { chat: { parts: [[1, 0]], batch: true }, compaction: { parts: [[1, 0]], batch: false } };
  file.changed();
  file.changed();
  await file.flush();
  assert.equal(snapshots, 1, "changes made together are written once, as they ended");
  assert.deepEqual(await readViews(dir), { value: { version: 1, ...current } });
  assert.deepEqual(await readdir(dir), ["view.json"], "no temporary file is left behind");
  // Changes during a write wait for it, and the next write takes the state they left.
  file.changed();
  current = { chat: { parts: [[1, 0], [0, 2]], batch: false }, compaction: { parts: [[1, 0], [0, 2]], batch: false } };
  file.changed();
  await file.flush();
  assert.deepEqual(await readViews(dir), { value: { version: 1, ...current } });
  await writeFile(join(dir, "view.json"), "{\"version\":");
  assert.deepEqual(await readViews(dir), { problem: "view.json is not valid JSON" });
  assert.equal(JSON.parse(await readFile(join(dir, "view.json.tmp"), "utf8").catch(() => "null")), null);
});

test("a failing save is reported once per failing spell, and the views stay live", async (t) => {
  const dir = await directory(t);
  const reports: string[] = [];
  const missing = join(dir, "gone");
  const file = new ViewFile(missing, () => ({ chat: { parts: [], batch: false }, compaction: { parts: [], batch: false } }), (problem) => reports.push(problem));
  file.changed();
  await file.flush();
  file.changed();
  await file.flush();
  assert.equal(reports.length, 1, reports.join("\n"));
  assert.match(reports[0]!, /could not save .*gone\/view\.json/u);
});
