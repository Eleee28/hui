import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { fallbackBranchName } from "./branch-names.ts";

const fixture: { title: string; jiraKey?: string; expected: string }[] = JSON.parse(readFileSync(new URL("./branch-names.fixture.json", import.meta.url), "utf8"));

test("branch-names preserves the shared runtime fixtures", () => {
  for (const { title, jiraKey, expected } of fixture) assert.equal(fallbackBranchName(title, jiraKey), expected);
});
