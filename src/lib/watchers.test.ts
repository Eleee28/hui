import assert from "node:assert/strict";
import { test } from "vitest";
import { parseWatchers, watcherStateLabel, watcherStateNote } from "./watchers.ts";

test("parseWatchers normalizes snapshot rows and drops malformed ones", () => {
  const watchers = parseWatchers([
    { id: "a", purpose: "Wait", command: "true", startedAt: "2026-10-02T10:00:00.000Z", state: "running", pid: 12, logPath: "/tmp/a.log", keepRunning: true },
    { id: "b", purpose: "Bad state", command: "true", startedAt: "2026-10-02T10:00:00.000Z", state: "weird" },
    { id: "", purpose: "No id", command: "true", startedAt: "2026-10-02T10:00:00.000Z", state: "done" },
    "nope",
  ]);
  assert.deepEqual(watchers.map(({ id, state, keepRunning }) => ({ id, state, keepRunning })), [
    { id: "a", state: "running", keepRunning: true },
    { id: "b", state: "dead", keepRunning: undefined },
  ]);
  assert.equal(parseWatchers(undefined).length, 0);
});

test("watcher state labels and notes distinguish failures and missing processes", () => {
  assert.equal(watcherStateLabel({ state: "failed" }), "Failed");
  assert.equal(watcherStateNote({ state: "failed", exitCode: 3 }), "Exited with status 3.");
  assert.equal(watcherStateLabel({ state: "dead" }), "Dead");
  assert.match(watcherStateNote({ state: "dead" }), /recorded no exit status/u);
});
