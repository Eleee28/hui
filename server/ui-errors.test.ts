import assert from "node:assert/strict";
import { test } from "vitest";

import { readObservability } from "./observability.ts";
import { parseUiErrorBatch, UiErrorLog, UiErrorReportError } from "./ui-errors.ts";

const SESSION = "4e54d99c-d423-4686-a61a-41ad93efee8a";

async function uiEvents(marker: string) {
  return (await readObservability([])).logs.filter((entry) => entry.area === "ui" && (entry.detail ?? "").includes(marker));
}

test("a valid batch keeps known fields, defaults count and suppressed, and ignores extras", () => {
  const batch = parseUiErrorBatch({
    reports: [
      { kind: "uncaught_error", message: " TypeError: x is not a function ", location: "/assets/index.js:1:200", page: "/settings/tools", extra: true },
      { kind: "request_failed", message: "Failed to fetch", count: 3, firstAt: "2026-09-28T10:00:00.000Z", lastAt: "2026-09-28T10:01:00.000Z", request: { method: "POST", path: "/__hui/sessions" } },
    ],
    note: "ignored",
  });
  assert.deepEqual(batch, {
    suppressed: 0,
    reports: [
      { kind: "uncaught_error", message: "TypeError: x is not a function", count: 1, location: "/assets/index.js:1:200", page: "/settings/tools" },
      { kind: "request_failed", message: "Failed to fetch", count: 3, firstAt: "2026-09-28T10:00:00.000Z", lastAt: "2026-09-28T10:01:00.000Z", request: { method: "POST", path: "/__hui/sessions" } },
    ],
  });
});

test("malformed batches are refused at the boundary", () => {
  const report = { kind: "uncaught_error", message: "boom" };
  for (const [value, reason] of [
    [null, /must be an object/u],
    [{ reports: [] }, /1 to 20/u],
    [{ reports: Array.from({ length: 21 }, () => report) }, /1 to 20/u],
    [{ reports: [report], suppressed: -1 }, /suppressed/u],
    [{ reports: [{ ...report, kind: "console" }] }, /kind is not supported/u],
    [{ reports: [{ ...report, message: "  " }] }, /message/u],
    [{ reports: [{ ...report, message: "x".repeat(2_001) }] }, /message/u],
    [{ reports: [{ ...report, count: 0 }] }, /count/u],
    [{ reports: [{ ...report, count: 1.5 }] }, /count/u],
    [{ reports: [{ ...report, firstAt: "yesterday" }] }, /firstAt/u],
    [{ reports: [{ ...report, page: "settings" }] }, /page must be a path/u],
    [{ reports: [{ kind: "request_failed", message: "Failed to fetch" }] }, /request is required/u],
    [{ reports: [{ kind: "request_failed", message: "Failed to fetch", request: { method: "GET", path: "https://example.test/" } }] }, /\/__hui\/ path/u],
    [{ reports: [{ kind: "request_failed", message: "Failed to fetch", request: { method: "get", path: "/__hui/settings" } }] }, /method/u],
  ] as const) {
    assert.throws(() => parseUiErrorBatch(value), (error: unknown) => error instanceof UiErrorReportError && reason.test(error.message), JSON.stringify(value).slice(0, 80));
  }
});

test("reports become ui diagnostics with their cause, place, time and session", async () => {
  const log = new UiErrorLog();
  const result = log.record(parseUiErrorBatch({
    suppressed: 2,
    reports: [
      { kind: "request_failed", message: "Failed to fetch marker-request", count: 3, firstAt: "2026-09-28T10:00:00.000Z", lastAt: "2026-09-28T10:01:00.000Z", page: `/sessions/${SESSION}`, request: { method: "POST", path: `/__hui/sessions/${SESSION}/prompt` } },
      { kind: "uncaught_error", message: "TypeError: marker-uncaught token=abcdef0123456789", location: "/assets/index.js:1:200", page: "/settings/tools", firstAt: "2026-09-28T10:02:00.000Z" },
      { kind: "unhandled_rejection", message: "Error: marker-rejection", page: `/sessions/${SESSION}` },
    ],
  }), 0);
  assert.deepEqual(result, { recorded: 4, dropped: 0 });

  const [request] = await uiEvents("marker-request");
  assert.equal(request?.level, "warning");
  assert.equal(request?.action, "request_failed");
  assert.equal(request?.summary, "UI request could not reach the gateway (3×)");
  assert.equal(request?.detail, "POST /__hui/sessions/:id/prompt: Failed to fetch marker-request on /sessions/:id · first 2026-09-28T10:00:00.000Z, last 2026-09-28T10:01:00.000Z");
  assert.equal(request?.sessionId, SESSION);

  const [uncaught] = await uiEvents("marker-uncaught");
  assert.equal(uncaught?.level, "error");
  assert.equal(uncaught?.summary, "Uncaught error in the UI");
  assert.equal(uncaught?.detail, "TypeError: marker-uncaught token=[redacted] at /assets/index.js:1:200 on /settings/tools · at 2026-09-28T10:02:00.000Z");
  assert.equal(uncaught?.sessionId, undefined);

  const [rejection] = await uiEvents("marker-rejection");
  assert.equal(rejection?.summary, "Unhandled promise rejection in the UI");
  assert.equal(rejection?.sessionId, SESSION);

  const suppressed = (await readObservability([])).logs.find((entry) => entry.action === "reports_suppressed");
  assert.equal(suppressed?.summary, "2 more UI errors were not reported");
});

test("more than 60 reports a minute are dropped after one rate-limit warning", async () => {
  const log = new UiErrorLog();
  const batch = (label: string) => parseUiErrorBatch({
    reports: Array.from({ length: 20 }, (_, index) => ({ kind: "uncaught_error", message: `${label} ${index}` })),
  });
  const start = 1_000_000;
  assert.deepEqual(log.record(batch("marker-limit-a"), start), { recorded: 20, dropped: 0 });
  assert.deepEqual(log.record(batch("marker-limit-b"), start + 1_000), { recorded: 20, dropped: 0 });
  assert.deepEqual(log.record(batch("marker-limit-c"), start + 2_000), { recorded: 20, dropped: 0 });
  assert.deepEqual(log.record(batch("marker-limit-d"), start + 3_000), { recorded: 0, dropped: 20 });
  assert.deepEqual(log.record(batch("marker-limit-e"), start + 4_000), { recorded: 0, dropped: 20 });
  const warnings = (await readObservability([])).logs.filter((entry) => entry.action === "reports_rate_limited");
  assert.equal(warnings.length, 1);
  assert.equal((await uiEvents("marker-limit-d")).length, 0);
  assert.deepEqual(log.record(batch("marker-limit-f"), start + 60_000), { recorded: 20, dropped: 0 }, "a new minute starts a new window");
});
