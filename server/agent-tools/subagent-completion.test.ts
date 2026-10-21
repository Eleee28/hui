import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { CONTINUE_PROMPT, SUBAGENT_COMPLETION_MARKER, formatSubagentCompletionEvent } from "./subagent-completion.ts";

const fixture: { continuePrompt: string; marker: string; cases: { input: Parameters<typeof formatSubagentCompletionEvent>[0]; expected: string }[] } = JSON.parse(readFileSync(new URL("./subagent-completion.fixture.json", import.meta.url), "utf8"));

test("completion events preserve their prompts, framing and escaped results", () => {
  assert.equal(CONTINUE_PROMPT, fixture.continuePrompt);
  assert.equal(SUBAGENT_COMPLETION_MARKER, fixture.marker);
  for (const item of fixture.cases) assert.equal(formatSubagentCompletionEvent(item.input), item.expected);
});
