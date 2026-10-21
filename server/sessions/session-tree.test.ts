import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { sessionTreeIds } from "./session-tree.ts";

const fixtures: { input: { sessions: Parameters<typeof sessionTreeIds>[0]; rootId: string }; expected: string[] }[] = JSON.parse(readFileSync(new URL("./session-tree.fixture.json", import.meta.url), "utf8"));

test("session-tree preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.deepEqual([...sessionTreeIds(fixture.input.sessions, fixture.input.rootId)], fixture.expected);
  }
});
