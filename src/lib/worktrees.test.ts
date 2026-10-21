import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { isMergedCleanupCandidate } from "./worktrees.ts";
import type { WorktreeRow } from "../api/schema/worktrees.ts";

const fixture: { input: WorktreeRow; expected: boolean }[] = JSON.parse(readFileSync(new URL("./worktrees.fixture.json", import.meta.url), "utf8"));

test("worktrees preserves the shared runtime fixtures", () => {
  for (const { input, expected } of fixture) assert.equal(isMergedCleanupCandidate(input), expected);
});
