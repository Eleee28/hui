import assert from "node:assert/strict";
import { test } from "vitest";

import { worktreeProgressLabel } from "./worktree-progress.ts";

test("worktree progress names the naming step before the Git phases", () => {
  assert.equal(worktreeProgressLabel({ phase: "naming" }), "Naming worktree");
  assert.equal(worktreeProgressLabel({ phase: "preparing" }), "Preparing Git worktree");
  assert.equal(worktreeProgressLabel({ phase: "checkout", percent: 40 }), "Checking out files");
  assert.equal(worktreeProgressLabel({ phase: "filtering" }), "Running checkout filters");
  assert.equal(worktreeProgressLabel({ phase: "finalizing" }), "Finalizing Git worktree");
  assert.equal(worktreeProgressLabel(undefined), "Preparing Git worktree");
});
