import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { aggregateUsage, diagnosticPath, mirrorDiagnosticLogs, readObservability, recordDiagnosticEvent } from "./observability.ts";
import type { SessionRecord } from "./sessions/sessions.ts";

test("usage aggregates numeric PI metadata without returning transcript content", async () => {
  const root = await mkdtemp(join(tmpdir(), "hui-usage-"));
  const file = join(root, "session.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "message", message: { model: "provider/model", content: "private prompt", usage: { input: 10, output: 5, cacheRead: 2, cost: 0.01 } } }),
    JSON.stringify({ type: "message", message: { model: "provider/model", content: "secret=never", usage: { inputTokens: 3, outputTokens: 7 } } }),
    // PI records prompt-cache refreshes as usage entries outside the conversation.
    JSON.stringify({ type: "usage", kind: "cache_warm", provider: "provider", model: "provider/model", usage: { input: 0, output: 0, cacheRead: 50, cost: { total: 0.02 } } }),
  ].join("\n"));
  const session = { id: "one", piSessionFile: file } as SessionRecord;
  const usage = await aggregateUsage([session]);
  assert.equal(usage.totalTokens, 77);
  assert.equal(usage.inputTokens, 13);
  assert.equal(usage.cacheReadTokens, 52);
  assert.equal(usage.costUsd, 0.03);
  assert.deepEqual(usage.models, [{ model: "provider/model", tokens: 77 }]);
  assert.doesNotMatch(JSON.stringify(usage), /private prompt|secret=never/u);
});

test("usage totals read Durable spend per conversation and model, not a transcript file", async () => {
  const sessions = [
    { id: "durable", piSessionFile: "durable:7" },
    { id: "closed", piSessionFile: "durable:8" },
  ] as SessionRecord[];
  const asked: number[] = [];
  const usage = await aggregateUsage(sessions, async (conversationId) => {
    asked.push(conversationId);
    return conversationId === 7 ? { models: {
      "anthropic/claude-opus-5-5": { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420, cost: { total: 0.25 } },
      "hui-e2e/fixture": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
    } } : undefined;
  });
  assert.deepEqual(asked, [7, 8]);
  assert.equal(usage.totalTokens, 422);
  assert.equal(usage.cacheReadTokens, 300);
  assert.equal(usage.costUsd, 0.25);
  assert.deepEqual(usage.models, [{ model: "anthropic/claude-opus-5-5", tokens: 420 }, { model: "hui-e2e/fixture", tokens: 2 }]);
  assert.deepEqual(usage.unavailable, ["closed: Durable store unavailable"]);
});

test("diagnostic events redact credential-shaped values and stay bounded to metadata", async () => {
  recordDiagnosticEvent({ area: "runtime", level: "error", action: "failure", summary: "token=abcdef0123456789 password: hunter2" });
  const snapshot = await readObservability([]);
  const newest = snapshot.activity[0];
  assert.match(newest?.summary ?? "", /\[redacted\]/u);
  assert.doesNotMatch(newest?.summary ?? "", /abcdef|hunter2/u);
  assert.equal(snapshot.usage.costUsd, null);
  assert.equal(snapshot.retention.kind, "memory");
});

test("a failure keeps its reported cause with secrets redacted, bounded, and never on info events", async () => {
  const cause = [
    'HTTP 400 {"errors":[{"detail":"validation failed: model is not allowed"}]}',
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "retry https://user:hunter2@proxy.example.test/v1?key=AIzaSyA1234567890abcdefghijklmnopqrstu",
    "api_key=sk-ant-api03-abcdefghijklmnop",
    "x".repeat(2_000),
  ].join("\n");
  recordDiagnosticEvent({ area: "runtime", level: "error", action: "boot_failed", summary: "Runtime did not start", detail: cause, sessionId: "detail-test" });
  recordDiagnosticEvent({ area: "runtime", level: "info", action: "tool_start", summary: "Tool started: read", detail: "tool output stays out" });
  const snapshot = await readObservability([]);
  const failure = snapshot.logs.find((entry) => entry.sessionId === "detail-test");
  assert.ok(failure?.detail);
  assert.match(failure.detail, /^HTTP 400 \{"errors":\[\{"detail":"validation failed: model is not allowed"\}\]\} Authorization: \[redacted\]/u);
  assert.match(failure.detail, /https:\/\/\[redacted\]@proxy\.example\.test\/v1\?key=\[redacted\]/u);
  assert.doesNotMatch(failure.detail, /abcdefghijklmnop|hunter2|AIza|sk-ant|\n/u);
  assert.equal(failure.detail.length, 600);
  assert.ok(failure.detail.endsWith("…"));
  const info = snapshot.activity.find((entry) => entry.action === "tool_start");
  assert.equal(info?.summary, "Tool started: read");
  assert.equal(info?.detail, undefined);
});

test("diagnostic paths hide ids and queries but keep literal session routes", () => {
  assert.equal(diagnosticPath("/__hui/sessions/4e54d99c-d423-4686-a61a-41ad93efee8a/prompt"), "/__hui/sessions/:id/prompt");
  assert.equal(diagnosticPath("/__hui/sessions/legacy_deck_7/events"), "/__hui/sessions/:id/events");
  assert.equal(diagnosticPath("/__hui/sessions/events"), "/__hui/sessions/events");
  assert.equal(diagnosticPath("/__hui/sessions/import"), "/__hui/sessions/import");
  assert.equal(diagnosticPath("/__hui/automation/runs/run-1/cancel"), "/__hui/automation/runs/:id/cancel");
  assert.equal(diagnosticPath("/__hui/local-paths?prefix=/Users/developer/private"), "/__hui/local-paths");
  assert.equal(diagnosticPath("/sessions/4e54d99c-d423-4686-a61a-41ad93efee8a"), "/sessions/:id");
});

test("the Logs subset is mirrored as one line per entry, oldest first, without repeats", async () => {
  recordDiagnosticEvent({ area: "session", level: "warning", action: "before_sink", summary: "Recorded before the sink", detail: "token=abcdef0123456789", sessionId: "mirror-test" });
  const lines: string[] = [];
  mirrorDiagnosticLogs((line) => lines.push(line));
  try {
    recordDiagnosticEvent({ area: "runtime", level: "info", action: "tool_start", summary: "Tool started: read", sessionId: "mirror-test" });
    recordDiagnosticEvent({ area: "runtime", level: "error", action: "boot_failed", summary: "Runtime did not start", detail: "pi exited with code 1", sessionId: "mirror-test" });
    mirrorDiagnosticLogs((line) => lines.push(line));
  } finally {
    mirrorDiagnosticLogs(undefined);
  }
  recordDiagnosticEvent({ area: "runtime", level: "error", action: "after_detach", summary: "Not mirrored" });

  const text = lines.join("");
  assert.match(text, /^\S+Z INFO gateway\/start HUI gateway started$/mu);
  assert.match(text, /^\S+Z WARNING session\/before_sink session=mirror-test Recorded before the sink: token=\[redacted\]$/mu);
  assert.match(text, /^\S+Z ERROR runtime\/boot_failed session=mirror-test Runtime did not start: pi exited with code 1$/mu);
  assert.ok(text.indexOf("gateway/start") < text.indexOf("session/before_sink"), "retained entries flush oldest first");
  assert.doesNotMatch(text, /tool_start|after_detach|abcdef0123/u);
  assert.equal(lines.filter((line) => line.includes("before_sink")).length, 1, "re-attaching does not replay");
  assert.ok(lines.every((line) => line.indexOf("\n") === line.length - 1), "each entry is exactly one line");
});
