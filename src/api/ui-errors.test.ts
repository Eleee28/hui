import assert from "node:assert/strict";
import { test, vi } from "vitest";

import {
  installUiErrorReporting,
  resetUiErrorReporting,
  sendUiErrorReports,
  UiErrorReporter,
  type ReporterTimers,
  type SendOutcome,
  type UiErrorReport,
} from "./ui-errors.ts";
import { trackedFetch } from "./request.ts";

/** Deterministic clock and timers: time moves only through advance(). */
function fakeTimers() {
  let now = Date.parse("2026-09-28T10:00:00.000Z");
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: ReporterTimers & { advance(ms: number): Promise<void>; delays(): number[] } = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
      // Let the flush's awaited send settle.
      for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    delays: () => [...timers.values()].map((timer) => timer.at - now),
  };
  return clock;
}

function recorder(outcomes: SendOutcome[] = []) {
  const batches: Array<{ reports: UiErrorReport[]; suppressed: number; keepalive: boolean }> = [];
  const send = async (reports: UiErrorReport[], suppressed: number, keepalive: boolean): Promise<SendOutcome> => {
    batches.push({ reports: reports.map((report) => ({ ...report })), suppressed, keepalive });
    return outcomes.shift() ?? "sent";
  };
  return { batches, send };
}

test("repeated errors become one report with a count, sent after a short delay", async () => {
  const clock = fakeTimers();
  const { batches, send } = recorder();
  const reporter = new UiErrorReporter(send, clock);
  reporter.record({ kind: "uncaught_error", message: "TypeError: boom", location: "/assets/a.js:1:2" });
  await clock.advance(500);
  reporter.record({ kind: "uncaught_error", message: "TypeError: boom", location: "/assets/a.js:1:2" });
  reporter.record({ kind: "unhandled_rejection", message: "Error: other" });
  assert.equal(batches.length, 0, "nothing is sent before the flush delay");
  await clock.advance(1_500);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]?.reports, [
    { kind: "uncaught_error", message: "TypeError: boom", location: "/assets/a.js:1:2", count: 2, firstAt: "2026-09-28T10:00:00.000Z", lastAt: "2026-09-28T10:00:00.500Z" },
    { kind: "unhandled_rejection", message: "Error: other", count: 1, firstAt: "2026-09-28T10:00:00.500Z", lastAt: "2026-09-28T10:00:00.500Z" },
  ]);
  assert.equal(batches[0]?.suppressed, 0);
});

test("a steady stream of errors cannot postpone the flush", async () => {
  const clock = fakeTimers();
  const { batches, send } = recorder();
  const reporter = new UiErrorReporter(send, clock);
  for (let step = 0; step < 5; step += 1) {
    reporter.record({ kind: "uncaught_error", message: "loop" });
    await clock.advance(500);
  }
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.reports[0]?.count, 4);
});

test("at most 20 distinct reports wait; the rest are counted as suppressed", async () => {
  const clock = fakeTimers();
  const { batches, send } = recorder();
  const reporter = new UiErrorReporter(send, clock);
  for (let index = 0; index < 23; index += 1) reporter.record({ kind: "uncaught_error", message: `error ${index}` });
  await clock.advance(2_000);
  assert.equal(batches[0]?.reports.length, 20);
  assert.equal(batches[0]?.suppressed, 3);
});

test("an undeliverable batch is retried with backoff, merging what arrives meanwhile", async () => {
  const clock = fakeTimers();
  const { batches, send } = recorder(["retry", "retry", "sent"]);
  const reporter = new UiErrorReporter(send, clock);
  reporter.record({ kind: "request_failed", message: "Failed to fetch", request: { method: "GET", path: "/__hui/settings" } });
  await clock.advance(2_000);
  assert.deepEqual(clock.delays(), [5_000]);
  reporter.record({ kind: "request_failed", message: "Failed to fetch", request: { method: "GET", path: "/__hui/settings" } });
  await clock.advance(5_000);
  assert.deepEqual(clock.delays(), [10_000], "backoff doubles");
  await clock.advance(10_000);
  assert.equal(batches.length, 3);
  assert.equal(batches[2]?.reports[0]?.count, 2);
  assert.equal(batches[2]?.reports[0]?.firstAt, "2026-09-28T10:00:00.000Z");
  assert.deepEqual(clock.delays(), [], "nothing is left to send");
});

test("a successful HUI request sends waiting reports without waiting for the backoff", async () => {
  const clock = fakeTimers();
  const { batches, send } = recorder(["retry"]);
  const reporter = new UiErrorReporter(send, clock);
  reporter.record({ kind: "uncaught_error", message: "boom" });
  await clock.advance(2_000);
  reporter.reachable();
  await clock.advance(0);
  assert.equal(batches.length, 2);
});

test("a refused batch is dropped rather than retried", async () => {
  const clock = fakeTimers();
  const { batches, send } = recorder(["drop"]);
  const reporter = new UiErrorReporter(send, clock);
  reporter.record({ kind: "uncaught_error", message: "boom" });
  await clock.advance(2_000);
  await clock.advance(120_000);
  assert.equal(batches.length, 1);
  assert.deepEqual(clock.delays(), []);
});

test("page handlers report uncaught errors and rejections, skipping noise", async (t) => {
  resetUiErrorReporting();
  t.onTestFinished(resetUiErrorReporting);
  const clock = fakeTimers();
  const { batches, send } = recorder();
  const target = new EventTarget();
  installUiErrorReporting(target, send, clock);
  const dispatch = (type: string, fields: Record<string, unknown>) => target.dispatchEvent(Object.assign(new Event(type), fields));
  const failure = new TypeError("x is not a function");
  failure.stack = "TypeError: x is not a function\n    at render (http://localhost:5173/src/hui-app.ts?t=1:10:5)";
  dispatch("error", { error: failure, message: "Uncaught TypeError: x is not a function", filename: "http://localhost:5173/src/hui-app.ts", lineno: 10, colno: 5 });
  dispatch("error", { message: "Script error.", filename: "" });
  dispatch("error", { message: "ResizeObserver loop completed with undelivered notifications." });
  const rejected = new Error("save failed");
  rejected.stack = "Error: save failed\n    at save (http://localhost:5173/src/lib/settings/settings-store.ts:80:11)";
  dispatch("unhandledrejection", { reason: rejected });
  dispatch("unhandledrejection", { reason: new DOMException("The user aborted a request.", "AbortError") });
  await clock.advance(2_000);
  assert.deepEqual(batches[0]?.reports.map(({ kind, message, location }) => ({ kind, message, location })), [
    { kind: "uncaught_error", message: "TypeError: x is not a function", location: "http://localhost:5173/src/hui-app.ts:10:5" },
    { kind: "unhandled_rejection", message: "Error: save failed", location: "http://localhost:5173/src/lib/settings/settings-store.ts:80:11" },
  ]);
});

test("trackedFetch reports HUI requests that cannot connect, once, and nothing else", async (t) => {
  resetUiErrorReporting();
  t.onTestFinished(resetUiErrorReporting);
  const clock = fakeTimers();
  const { batches, send } = recorder();
  const target = new EventTarget();
  installUiErrorReporting(target, send, clock);
  const offline = new TypeError("Failed to fetch");
  const responses: Array<Response | Error> = [
    offline,
    new DOMException("The operation was aborted.", "AbortError"),
    new TypeError("Failed to fetch"),
    new Response("{}", { status: 200 }),
  ];
  vi.stubGlobal("fetch", async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  await assert.rejects(trackedFetch("/__hui/settings?fresh=1", { method: "put" }), (error) => error === offline);
  await assert.rejects(trackedFetch("/__hui/sessions/abc/events"), { name: "AbortError" });
  await assert.rejects(trackedFetch("https://example.test/embed.js"), TypeError);
  // The same failure surfacing as an unhandled rejection is not reported twice.
  target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: offline }));
  await clock.advance(2_000);
  assert.deepEqual(batches[0]?.reports.map(({ kind, message, request }) => ({ kind, message, request })), [
    { kind: "request_failed", message: "Failed to fetch", request: { method: "PUT", path: "/__hui/settings" } },
  ]);
  assert.equal((await trackedFetch("/__hui/settings")).status, 200);
});

test("the report request carries the client header and maps statuses to outcomes", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const statuses: Array<number | Error> = [202, 503, 400, new TypeError("Failed to fetch")];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    const next = statuses.shift()!;
    if (next instanceof Error) throw next;
    return new Response("{}", { status: next });
  });
  const report: UiErrorReport = { kind: "uncaught_error", message: "boom", count: 1, firstAt: "2026-09-28T10:00:00.000Z", lastAt: "2026-09-28T10:00:00.000Z" };
  assert.equal(await sendUiErrorReports([report], 2, true), "sent");
  assert.equal(await sendUiErrorReports([report], 0, false), "retry");
  assert.equal(await sendUiErrorReports([report], 0, false), "drop");
  assert.equal(await sendUiErrorReports([report], 0, false), "retry");
  assert.equal(seen[0]?.url, "/__hui/diagnostics/ui-errors");
  assert.equal(seen[0]?.init?.method, "POST");
  assert.deepEqual(seen[0]?.init?.headers, { "x-hui": "1", "content-type": "application/json" });
  assert.equal(seen[0]?.init?.keepalive, true);
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), { reports: [report], suppressed: 2 });
});
