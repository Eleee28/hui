import assert from "node:assert/strict";
import { test } from "vitest";
import { formatGatewayUptime } from "./gateway-presentation.ts";

test("gateway uptime uses compact whole units across boundaries", () => {
  for (const [seconds, expected] of [
    [0, "0s"], [59.9, "59s"], [60, "1m"], [2246, "37m"],
    [3600, "1h"], [3661, "1h 1m"], [86400, "1d"],
    [183840, "2d 3h 4m"], [86460, "1d 1m"],
    [-1, "—"], [NaN, "—"], [Infinity, "—"],
  ] as const) assert.equal(formatGatewayUptime(seconds), expected);
});
