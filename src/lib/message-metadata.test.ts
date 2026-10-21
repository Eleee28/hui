import assert from "node:assert/strict";
import { test } from "vitest";
import { elapsedLabel, metricSummary, relativeTime, replyDraft } from "./message-metadata.ts";
import { normalizeTranscript } from "./transcript-state.ts";

test("reply preserves the draft and quotes every line without sending", () => {
  assert.equal(replyDraft("Existing draft", "one\r\n\ntwo"), "Existing draft\n\n> one\n> \n> two\n\n");
});
test("time labels handle boundaries, clock skew and missing measurements", () => {
  assert.equal(elapsedLabel(87000), "1m 27s");
  assert.equal(elapsedLabel(40), "40 ms");
  assert.equal(relativeTime(1000, 0), "just now");
  assert.equal(relativeTime(0, 180000), "3m ago");
  assert.equal(metricSummary(), "");
  assert.equal(metricSummary({ outputTokens: 0 }), "0 output tokens");
  assert.equal(metricSummary({ outputTokens: 1234567 }), "1,234,567 output tokens");
});
test("snapshot normalization retains measured zeroes and rejects invalid values", () => {
  const [entry] = normalizeTranscript([{ kind: "message", role: "assistant", text: "Answer", metrics: { inputTokens: 0, outputTokens: -1, costUsd: NaN, durationMs: 87, completedAt: 1234 } }]);
  assert.deepEqual(entry?.metrics, { inputTokens: 0, durationMs: 87, completedAt: 1234 });
});
