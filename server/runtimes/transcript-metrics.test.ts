import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { RuntimeTimings, sanitizeMetrics } from "./transcript-metrics.ts";
import { transcriptFrom } from "./pi.ts";

const fixtures: { input: unknown; expected: unknown }[] = JSON.parse(readFileSync(new URL("./transcript-metrics.fixture.json", import.meta.url), "utf8"));

test("sanitizeMetrics preserves the shared runtime fixtures", () => {
  for (const { input, expected } of fixtures) assert.deepEqual(sanitizeMetrics(input), expected, JSON.stringify(input));
});

test("correlates model and tool measurements and never derives time from adjacent messages", () => {
  const timings = new RuntimeTimings();
  const message = { role: "assistant", timestamp: 100, content: [{ type: "thinking", thinking: "Plan" }, { type: "text", text: "Answer" }], usage: { input: 12, output: 3, cacheRead: 0, cost: { total: 0 } } };
  timings.observe({ type: "message_start", message }, 1000);
  timings.observe({ type: "tool_execution_start", toolCallId: "tool" }, 1010);
  timings.observe({ type: "tool_execution_end", toolCallId: "tool" }, 1030);
  timings.observe({ type: "message_end", message }, 1087);
  const entries = transcriptFrom([message], timings);
  assert.equal(entries[0]?.metrics, undefined);
  assert.deepEqual(entries[1]?.metrics, { timestamp: 100, completedAt: 1087, durationMs: 87, inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, costUsd: 0 });
  assert.deepEqual(timings.get("tool", "tool", 100), { completedAt: 1030, durationMs: 20 });
  assert.equal(transcriptFrom([message])[1]?.metrics?.durationMs, undefined);
  assert.equal(transcriptFrom([message])[1]?.metrics?.completedAt, undefined);
});
test("unpaired completion reports its instant but not a fabricated duration", () => {
  const timings = new RuntimeTimings();
  timings.observe({ type: "message_end", message: { role: "assistant", timestamp: 10 } }, 200);
  assert.deepEqual(timings.get("message", 10), { completedAt: 200 });
  timings.observe({ type: "message_end", message: { role: "user", timestamp: 11 } }, 210);
  assert.deepEqual(timings.get("message", 11), {});
});

test("reused tool IDs never overwrite an earlier model call's timing", () => {
  const timings = new RuntimeTimings();
  for (const timestamp of [100, 200]) {
    timings.observe({ type: "message_start", message: { role: "assistant", timestamp } }, timestamp);
    timings.observe({ type: "tool_execution_start", toolCallId: "same" }, timestamp);
    timings.observe({ type: "tool_execution_end", toolCallId: "same" }, timestamp + timestamp / 10);
  }
  assert.equal(timings.get("tool", "same", 100).durationMs, 10);
  assert.equal(timings.get("tool", "same", 200).durationMs, 20);
  assert.deepEqual(timings.get("tool", "same", 50), {});
});

test("tool-only model calls retain usage once without calling model time tool time", () => {
  const entries = transcriptFrom([{ role: "assistant", timestamp: 123,
    content: [{ type: "toolCall", id: "a", name: "read" }, { type: "toolCall", id: "b", name: "read" }],
    usage: { input: 5, output: 2 } }]);
  assert.equal(entries[0]?.metrics, undefined);
  assert.deepEqual(entries[1]?.metrics, { timestamp: 123, inputTokens: 5, outputTokens: 2 });
});
