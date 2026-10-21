import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { THINKING_LEVELS, isThinkingLevel } from "./thinking.ts";

const fixture: { levels: string[]; invalid: string[] } = JSON.parse(readFileSync(new URL("./thinking.fixture.json", import.meta.url), "utf8"));

test("thinking preserves the shared runtime fixtures", () => {
  assert.deepEqual(THINKING_LEVELS, fixture.levels);
  for (const level of fixture.levels) assert.equal(isThinkingLevel(level), true);
  for (const level of fixture.invalid) assert.equal(isThinkingLevel(level), false);
});
