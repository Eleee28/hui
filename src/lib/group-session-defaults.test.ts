import assert from "node:assert/strict";
import { test } from "vitest";
import { groupCheckoutDefaults } from "./group-session-defaults.ts";

const checkout = { available: true, headBranch: "feature/current", defaultBranch: "main", branches: ["main", "release"] };
test("legacy groups start in Branch on the repository default", () => {
  assert.deepEqual(groupCheckoutDefaults("/repo", checkout, { cwd: "/repo" }), { worktree: false, baseRef: "main" });
});
test("both group modes honor a saved ref only in the group's directory", () => {
  for (const workspaceMode of ["branch", "worktree"] as const) {
    const group = { cwd: "/repo", workspaceMode, baseRef: "release" };
    assert.deepEqual(groupCheckoutDefaults(" /repo ", checkout, group), { worktree: workspaceMode === "worktree", baseRef: "release" });
    assert.deepEqual(groupCheckoutDefaults("/other", checkout, group), { worktree: false, baseRef: "main" });
    assert.deepEqual(groupCheckoutDefaults("/repo", { ...checkout, available: false }, group), { worktree: false, baseRef: "" });
  }
});
test("missing refs fall back to default, current branch, then HEAD", () => {
  const group = { cwd: "/repo", workspaceMode: "worktree" as const };
  assert.deepEqual(groupCheckoutDefaults("/repo", checkout, group), { worktree: true, baseRef: "main" });
  assert.equal(groupCheckoutDefaults("/repo", { ...checkout, defaultBranch: "" }, group).baseRef, "feature/current");
  assert.equal(groupCheckoutDefaults("/repo", { ...checkout, defaultBranch: "", headBranch: "" }, group).baseRef, "HEAD");
});
