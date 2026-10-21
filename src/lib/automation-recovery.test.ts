import assert from "node:assert/strict";
import { test } from "vitest";
import { automationRunLabel, automationRunRecoveryDetail } from "./automation-recovery.ts";
import type { AutomationRun } from "../api/schema/automation.ts";

const run = (extra: Partial<AutomationRun> = {}): AutomationRun => ({
  id: "r1", taskId: "t1", taskName: "Digest", sessionId: "s1", source: "scheduled", status: "queued",
  createdAt: "2026-10-18T08:00:00.000Z", ...extra,
});
const time = (value: string) => `local(${value})`;

test("ordinary and legacy runs keep their outcomes without invented recovery state", () => {
  for (const status of ["queued", "running", "completed", "failed", "skipped", "cancelled"] as const) {
    const each = run({ status, error: "Connection error; retry tomorrow" });
    assert.equal(automationRunLabel(each), status[0]!.toUpperCase() + status.slice(1));
    assert.equal(automationRunRecoveryDetail(each, time), "");
  }
});

test("a scheduled retry names its actual next attempt time and current attempt", () => {
  const retry = run({ attempt: 1, retryAt: "2026-10-18T08:00:30.000Z", failure: { kind: "connection", needsAttention: false } });
  assert.equal(automationRunLabel(retry), "Retry scheduled");
  assert.equal(automationRunRecoveryDetail(retry, time), "Attempt 1/3 · Next retry local(2026-10-18T08:00:30.000Z)");
  assert.equal(automationRunRecoveryDetail(run({ retryAt: retry.retryAt }), time), automationRunRecoveryDetail(retry, time));
});

test("a finished, cancelled or underway run never promises a stale retry", () => {
  for (const status of ["running", "completed", "failed", "skipped", "cancelled"] as const) {
    const each = run({ status, retryAt: "2026-10-18T08:00:30.000Z", attempt: 2 });
    assert.notEqual(automationRunLabel(each), "Retry scheduled");
    assert.equal(automationRunRecoveryDetail(each, time), "Attempt 2/3");
  }
});

test("intervention gives guidance for the recorded cause without hiding its error", () => {
  const guidance = {
    connection: /Reconnect the target machine or session/,
    "rate-limit": /provider's quota or billing/,
    configuration: /target session, model and credentials/,
    transient: /service is available/,
    interrupted: /actions already taken before running again/,
    timeout: /actions already taken.*task or timeout/,
    unknown: /error and chat/,
  };
  for (const kind of Object.keys(guidance) as Array<keyof typeof guidance>) {
    const each = run({ status: "failed", error: "Original failure", failure: { kind, needsAttention: true } });
    assert.equal(automationRunLabel(each), "Needs attention");
    assert.match(automationRunRecoveryDetail(each, time), guidance[kind]);
    assert.equal(each.error, "Original failure");
    assert.equal(automationRunLabel({ ...each, status: "cancelled" }), "Cancelled");
    assert.equal(automationRunRecoveryDetail({ ...each, status: "cancelled" }, time), "");
  }
});
