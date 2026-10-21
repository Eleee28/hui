import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { backlogItemPrompt } from "./backlog.ts";
import type { BacklogItem } from "./schema/backlog.ts";

const fixture: { input: Pick<BacklogItem, "kind" | "title" | "problem" | "fix" | "jira">; expected: string }[] = JSON.parse(readFileSync(new URL("./backlog.fixture.json", import.meta.url), "utf8"));

test("backlog preserves the shared runtime fixtures", () => {
  for (const { input, expected } of fixture) assert.equal(backlogItemPrompt(input), expected);
});
