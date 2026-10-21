import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fallbackBranchName } from "./backlog-start.ts";
import { test } from "vitest";

import { backlogBranchOptions, backlogStartRequest, backlogStartStep, canStartBacklog, type BacklogStartState } from "./backlog-start.ts";

const repo = { available: true, headBranch: "dev", defaultBranch: "main", branches: ["dev", "main", "release/1", "feature/old"] };
const plain = { available: false, headBranch: "", defaultBranch: "", branches: [] };

function state(patch: Partial<BacklogStartState> = {}): BacklogStartState {
  return { cwd: "/repo", checkout: repo, loading: false, mode: "branch", name: "", suggestedName: "", baseRef: "main", ...patch };
}

test("a repository immediately exposes Branch; Worktree adds the suffix step", () => {
  assert.equal(backlogStartStep(state({ cwd: "", checkout: undefined })), "folder");
  assert.equal(backlogStartStep(state({ loading: true })), "folder");
  assert.equal(backlogStartStep(state({ checkout: undefined })), "folder");
  assert.equal(backlogStartStep(state({ checkout: plain })), "plain");
  assert.equal(backlogStartStep(state({ checkout: plain, mode: "worktree" })), "plain");
  assert.equal(backlogStartStep(state()), "branch");
  assert.equal(backlogStartStep(state({ mode: "branch" })), "branch");
  assert.equal(backlogStartStep(state({ mode: "worktree" })), "worktree");
});

test("Start waits for inspection and only Worktree needs a suffix", () => {
  assert.equal(canStartBacklog(state({ checkout: undefined })), false);
  assert.equal(canStartBacklog(state({ loading: true, checkout: plain })), false);
  assert.equal(canStartBacklog(state({ checkout: plain })), true);
  assert.equal(canStartBacklog(state()), true);
  assert.equal(canStartBacklog(state({ mode: "branch" })), true);
  assert.equal(canStartBacklog(state({ mode: "worktree" })), false);
  assert.equal(canStartBacklog(state({ mode: "worktree", name: "  " })), false);
  assert.equal(canStartBacklog(state({ mode: "worktree", suggestedName: "rate-limit" })), true);
  assert.equal(canStartBacklog(state({ mode: "worktree", name: "mine" })), true);
});

test("start requests keep the checkout semantics", () => {
  assert.equal(backlogStartRequest(state({ loading: true })), undefined);
  assert.deepEqual(backlogStartRequest(state()), { cwd: "/repo", worktree: false, baseRef: "main" });
  assert.deepEqual(backlogStartRequest(state({ cwd: " /plain ", checkout: plain })), { cwd: "/plain", worktree: false });
  // The current head needs no switch; another branch switches the checkout.
  assert.deepEqual(backlogStartRequest(state({ mode: "branch", baseRef: "dev" })), { cwd: "/repo", worktree: false });
  assert.deepEqual(backlogStartRequest(state({ mode: "branch", baseRef: " main " })), { cwd: "/repo", worktree: false, baseRef: "main" });
  // A typed name wins over the suggestion; a cleared field uses the suggestion.
  assert.deepEqual(backlogStartRequest(state({ mode: "worktree", name: "my-name", suggestedName: "model-name" })),
    { cwd: "/repo", worktree: true, branchName: "my-name", baseRef: "main" });
  assert.deepEqual(backlogStartRequest(state({ mode: "worktree", suggestedName: "model-name", baseRef: "" })),
    { cwd: "/repo", worktree: true, branchName: "model-name", baseRef: "main" });
  assert.deepEqual(backlogStartRequest(state({ mode: "worktree", name: "x", baseRef: "release/1" })),
    { cwd: "/repo", worktree: true, branchName: "x", baseRef: "release/1" });
});

test("branch options put the default first without truncating searchable options", () => {
  assert.deepEqual(backlogBranchOptions(repo), ["main", "dev", "release/1", "feature/old"]);
  const branches = Array.from({ length: 20 }, (_, i) => `topic/${i}`);
  assert.deepEqual(backlogBranchOptions({ ...repo, branches }), ["main", ...branches]);
});

test("switching modes keeps the chosen ref and only Worktree submits the suffix", () => {
  const selected = state({ baseRef: "release/1", name: "my-fix" });
  assert.deepEqual(backlogStartRequest(selected), { cwd: "/repo", worktree: false, baseRef: "release/1" });
  assert.deepEqual(backlogStartRequest({ ...selected, mode: "worktree" }),
    { cwd: "/repo", worktree: true, baseRef: "release/1", branchName: "my-fix" });
  assert.deepEqual(backlogStartRequest(state({ baseRef: "" })), { cwd: "/repo", worktree: false, baseRef: "main" });
});

const fixture: { title: string; jiraKey?: string; expected: string }[] = JSON.parse(readFileSync(new URL("./backlog-start.fixture.json", import.meta.url), "utf8"));

test("backlog-start preserves the shared runtime fixtures", () => {
  for (const { title, jiraKey, expected } of fixture) assert.equal(fallbackBranchName(title, jiraKey), expected);
});
