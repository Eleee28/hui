import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { parseTaskSuggestions, taskSuggestionJiraDescription, taskSuggestionLocation, taskSuggestionPreview, taskSuggestionPrompt } from "./task-suggestions.ts";

test("browser helpers normalize, locate and describe suggestions", () => {
  assert.deepEqual(parseTaskSuggestions([
    { id: "a", title: " T ", problem: "P", fix: "F", cwd: "/repo", createdAt: "now" },
    { id: "b", title: "", problem: "P", cwd: "/repo" },
    { id: "c", title: "No problem", fix: "F", cwd: "/repo" },
    "junk",
  ]), [{ id: "a", title: "T", problem: "P", fix: "F", cwd: "/repo", createdAt: "now" }]);
  assert.deepEqual(parseTaskSuggestions(undefined), []);
  assert.equal(taskSuggestionLocation("/home/developer/Projects/HUI/"), "HUI");
  assert.equal(taskSuggestionLocation("/"), "/");
  assert.equal(taskSuggestionJiraDescription({ problem: "It breaks.", fix: "Patch it." }), "## Problem\n\nIt breaks.\n\n## Proposed fix\n\nPatch it.");
  assert.equal(taskSuggestionJiraDescription({ problem: "It breaks.", fix: "" }), "## Problem\n\nIt breaks.");
  assert.equal(taskSuggestionPrompt({ title: "T", problem: "It breaks.", fix: "Patch it." }), "# T\n\n## Problem\n\nIt breaks.\n\n## Proposed fix\n\nPatch it.");
  assert.match(taskSuggestionPrompt({ title: "T", problem: "It breaks.", fix: "" }), /## Proposed fix\n\nNot known yet\. Investigate and confirm the root cause before changing code\.$/);
  assert.equal(taskSuggestionPreview("## Cause\n\n- The `select` in **x.ts**\n\n```ts\ncode\n```\nsee [docs](https://x)"), "Cause The select in x.ts see docs");
});


const fixture: { input: { title: string; problem: string; fix: string }; prompt: string; jira: string }[] = JSON.parse(readFileSync(new URL("./task-suggestions.fixture.json", import.meta.url), "utf8"));

test("task-suggestions preserves the shared runtime fixtures", () => {
  for (const { input, prompt, jira } of fixture) {
    assert.equal(taskSuggestionPrompt(input), prompt);
    assert.equal(taskSuggestionJiraDescription(input), jira);
  }
});
