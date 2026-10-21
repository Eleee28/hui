import assert from "node:assert/strict";
import { test } from "vitest";
import { FINISHED_BATCH_VISIBLE_MS, formatElapsed, latestSubagentBatch, subagentElapsed, subagentVisualState } from "./subagent-activity.ts";

test("formatElapsed matches OpenClaw duration style", () => {
  assert.equal(formatElapsed(6_400), "6s");
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed((34 * 60 + 25) * 1000), "34m 25s");
  assert.equal(formatElapsed(5 * 60_000), "5m");
  assert.equal(formatElapsed((62 * 60 + 9) * 1000), "1h 2m");
  assert.equal(formatElapsed(2 * 3_600_000), "2h");
});

test("subagentElapsed uses endedAt when finished and now while running", () => {
  const startedAt = "2026-09-25T09:00:00.000Z";
  assert.equal(subagentElapsed({ status: "completed", startedAt, endedAt: "2026-09-25T09:00:06.000Z" }), "6s");
  assert.equal(subagentElapsed({ status: "running", startedAt, endedAt: "2026-09-25T09:00:06.000Z" }, Date.parse("2026-09-25T09:01:30.000Z")), "1m 30s");
  assert.equal(subagentElapsed({ status: "failed", startedAt, updatedAt: "2026-09-25T09:00:10.000Z" }), "10s");
  assert.equal(subagentElapsed({ status: "completed", startedAt: "nope" }), undefined);
});

test("subagentVisualState collapses terminal failures", () => {
  assert.equal(subagentVisualState("queued"), "queued");
  assert.equal(subagentVisualState("starting"), "running");
  assert.equal(subagentVisualState("completed"), "completed");
  assert.equal(subagentVisualState("timed_out"), "failed");
  assert.equal(subagentVisualState("interrupted"), "failed");
  assert.equal(subagentVisualState("cancelled"), "cancelled");
});

test("latestSubagentBatch keeps the children spawned while one was active, until an hour after they all ended", () => {
  const at = (minute: number) => `2026-09-25T09:${String(minute).padStart(2, "0")}:00.000Z`;
  const tasks = [
    { id: "old", status: "completed", startedAt: at(0), endedAt: at(1) },
    { id: "long", status: "completed", startedAt: at(2), endedAt: at(9) },
    { id: "joins", status: "failed", startedAt: at(5), endedAt: at(6) },
    { id: "still", status: "queued", startedAt: at(8) },
  ];
  const ids = (now: string, list = tasks) => latestSubagentBatch(list, Date.parse(now)).map((task) => task.id);
  assert.deepEqual(ids(at(10)), ["long", "joins", "still"]);
  const finished = tasks.map((task) => task.id === "still" ? { ...task, status: "completed", endedAt: at(12) } : task);
  assert.deepEqual(ids(at(12), finished), ["long", "joins", "still"]);
  assert.deepEqual(latestSubagentBatch(finished, Date.parse(at(12)) + FINISHED_BATCH_VISIBLE_MS), []);
});
