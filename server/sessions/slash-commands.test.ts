import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { parseClearCommand, parseCompactCommand, parseReloadCommand, parseUpdateCommand } from "./slash-commands.ts";

const fixtures: { input: string; expected: unknown }[] = JSON.parse(readFileSync(new URL("./slash-commands.fixture.json", import.meta.url), "utf8"));

test("slash-commands preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.deepEqual({ clear: parseClearCommand(fixture.input), compact: parseCompactCommand(fixture.input) ?? null, reload: parseReloadCommand(fixture.input), update: parseUpdateCommand(fixture.input) }, fixture.expected);
  }
});
