import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { BOT_TRIGGER_LIMITS, botTriggerFilterSummary, cooldownLabel } from "./triggers-format.ts";

test("trigger limits and labels match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./triggers-format.fixture.json", import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(fixture.limits)) assert.equal(BOT_TRIGGER_LIMITS[key as keyof typeof BOT_TRIGGER_LIMITS], value, key);
  for (const item of fixture.cooldowns) assert.equal(cooldownLabel(item.input), item.expected, String(item.input));
  for (const item of fixture.filters) assert.equal(botTriggerFilterSummary({ filter: item.input }), item.expected);
});
