import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { BOT_FACT_KINDS, BOT_FACT_LIMITS } from "./facts.ts";

test("memory kinds and limits match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./facts.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(BOT_FACT_KINDS, fixture.kinds);
  assert.deepEqual(BOT_FACT_LIMITS, fixture.limits);
});
