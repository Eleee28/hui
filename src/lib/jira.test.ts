import assert from "node:assert/strict";
import { test } from "vitest";

import { jiraIssueAccessibleLabel, primaryJiraIssue } from "./jira.ts";
import type { SessionJiraIssue } from "../api/schema/sessions.ts";
import { applyJiraDraft, jiraParentHint } from "./jira.ts";

const issue = (key: string, patch: Partial<SessionJiraIssue> = {}): SessionJiraIssue => ({
  key, url: `https://acme.atlassian.net/browse/${key}`, ...patch,
});

test("the newest linked work item owns the row mark", () => {
  assert.equal(primaryJiraIssue(undefined), undefined);
  assert.equal(primaryJiraIssue([]), undefined);
  const primary = primaryJiraIssue([issue("CI-1"), issue("CI-2")]);
  assert.equal(primary?.issue.key, "CI-2");
  assert.deepEqual(primary?.others.map((item) => item.key), ["CI-1"]);
});

test("accessible labels name the key, status, summary and extra links", () => {
  assert.equal(jiraIssueAccessibleLabel(issue("CI-2", { status: "In Progress", summary: "Fix flake" }), 3), "Jira CI-2, in progress: Fix flake, 2 more linked");
  assert.equal(jiraIssueAccessibleLabel(issue("CI-2")), "Jira CI-2, status unavailable");
});

test("an agent draft never overwrites fields the operator edited", () => {
  const draft = { parent: "CI-1", summary: "Agent summary", description: "Agent body" };
  assert.deepEqual(applyJiraDraft({ parent: "", summary: "", description: "" }, new Set(), draft), draft);
  assert.deepEqual(
    applyJiraDraft({ parent: "", summary: "Mine", description: "" }, new Set(["summary"] as const), draft),
    { parent: "CI-1", summary: "Mine", description: "Agent body" },
  );
});

test("an empty parent always says whether the model chose none or why nothing was suggested", () => {
  const draft = { project: "CI", parent: "" };
  assert.deepEqual(jiraParentHint({ ...draft, parent: "CI-1", parentChoice: "suggested" }, false), { suggested: true, reason: "" });
  assert.deepEqual(jiraParentHint({ ...draft, parentChoice: "suggested" }, false), { suggested: true, reason: "No open parent matches this work." });
  assert.match(jiraParentHint({ ...draft, parentChoice: "unmatched", rejectedParent: "OPS-99" }, false).reason, /suggested OPS-99, which isn't an open parent in CI/u);
  assert.match(jiraParentHint({ ...draft, parentChoice: "none-available" }, false).reason, /CI has no open parent/u);
  assert.match(jiraParentHint({ ...draft, parentChoice: "not-drafted" }, false).reason, /prefilled locally/u);
  assert.deepEqual(jiraParentHint({ ...draft, parentChoice: "omitted" }, false), { suggested: false, reason: "The model didn't choose a parent." });
  assert.deepEqual(jiraParentHint({ ...draft, parentChoice: "suggested" }, true), { suggested: false, reason: "" }, "an operator choice replaces the hint");
  assert.deepEqual(jiraParentHint(undefined, false), { suggested: false, reason: "" });
});

test("search results join the known projects, sorted, without losing the selection", async () => {
  const { mergeJiraProjects } = await import("./jira.ts");
  const merged = mergeJiraProjects([{ key: "ZZ", name: "Zeta" }, { key: "CI", name: "CI" }], [{ key: "AB", name: "Alpha" }, { key: "CI", name: "CI Platform" }]);
  assert.deepEqual(merged.map((project) => `${project.key}:${project.name}`), ["AB:Alpha", "CI:CI Platform", "ZZ:Zeta"]);
});
