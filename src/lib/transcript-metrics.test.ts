import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { sanitizeMetrics } from "./transcript-metrics.ts";

const fixtures: { input: unknown; expected: unknown }[] = JSON.parse(readFileSync(new URL("./transcript-metrics.fixture.json", import.meta.url), "utf8"));

test("sanitizeMetrics preserves the shared runtime fixtures", () => {
  for (const { input, expected } of fixtures) assert.deepEqual(sanitizeMetrics(input), expected, JSON.stringify(input));
});
