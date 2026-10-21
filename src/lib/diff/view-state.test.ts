import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DIFF_COMPARISONS, isDiffComparison } from "./view-state.ts";
import { test } from "vitest";
import type { DiffInfo } from "../../api/schema/diff.ts";
import { chosenParent, clearDiffViewState, initialComparison, normalizeDiffViewState, readDiffViewState, writeDiffViewState } from "./view-state.ts";

type Available = Extract<DiffInfo, { available: true }>;
const info = (patch: Partial<Available> = {}): Available => ({
  available: true, root: "~/r", subdirectory: "", branch: "feature-b", detached: false, unborn: false, uncommitted: 0,
  branches: [{ ref: "refs/heads/feature-a", name: "feature-a", remote: false, distance: 2 }, { ref: "refs/heads/main", name: "main", remote: false, distance: 5 }],
  parent: { ref: "refs/heads/feature-a", name: "feature-a", remote: false, distance: 2, source: "nearest" },
  comparisons: ["uncommitted", "last-commit", "parent", "default"], ...patch,
});

test("a view opens on uncommitted changes when there are any, else the previous branch", () => {
  assert.equal(initialComparison(info({ uncommitted: 3 }), undefined), "uncommitted");
  assert.equal(initialComparison(info(), undefined), "parent");
  assert.equal(initialComparison(info({ comparisons: ["uncommitted", "last-commit", "default"] }), undefined), "default");
  assert.equal(initialComparison(info({ comparisons: ["uncommitted", "last-commit"] }), undefined), "last-commit");
  assert.equal(initialComparison(info({ comparisons: ["uncommitted"] }), undefined), "uncommitted");
});

test("a remembered comparison wins while it still applies", () => {
  assert.equal(initialComparison(info({ uncommitted: 3 }), "default"), "default");
  // Detached now: no previous branch any more.
  assert.equal(initialComparison(info({ uncommitted: 1, comparisons: ["uncommitted", "last-commit", "default"] }), "parent"), "uncommitted");
});

test("a picked previous branch is kept only while it is offered", () => {
  assert.equal(chosenParent(info(), undefined), "refs/heads/feature-a");
  assert.equal(chosenParent(info(), "refs/heads/main"), "refs/heads/main");
  assert.equal(chosenParent(info(), "refs/heads/deleted"), "refs/heads/feature-a");
});

test("stored state is validated, remembered per view and forgotten on close", () => {
  assert.deepEqual(normalizeDiffViewState({ comparison: "HEAD~2", parent: "--evil", uncommitted: false, layout: "split", selected: 7 }), {
    comparison: undefined, parent: undefined, uncommitted: false, layout: "split", selected: undefined,
  });
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
  writeDiffViewState("diff-a", { comparison: "parent", parent: "refs/heads/main", selected: "src/a.ts" }, store);
  writeDiffViewState("diff-b", { layout: "split" }, store);
  assert.equal(readDiffViewState("diff-a", store).comparison, "parent");
  assert.equal(readDiffViewState("diff-b", store).comparison, undefined);
  assert.equal(readDiffViewState("diff-b", store).layout, "split");
  clearDiffViewState("diff-a", store);
  assert.equal(readDiffViewState("diff-a", store).selected, undefined);
  assert.equal(values.has("hui.diff-view.v1:diff-a"), false);
});

test("diff comparison guards match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./view-state.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(DIFF_COMPARISONS, fixture.comparisons);
  for (const item of fixture.cases) assert.equal(isDiffComparison(item.input), item.expected);
});
