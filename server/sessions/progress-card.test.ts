import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { progressCardFromTranscript } from "./progress-card.ts";

const fixture: { input: { kind: string; name?: string; args?: unknown }[]; expected: unknown }[] = JSON.parse(readFileSync(new URL("./progress-card.fixture.json", import.meta.url), "utf8"));

test("progress-card preserves the shared runtime fixtures", () => {
  for (const { input, expected } of fixture) assert.deepEqual(progressCardFromTranscript(input) ?? null, expected);
});
