import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { availableUpdate, watchUpdateAvailability } from "./update-notice.ts";
import type { UpdateSnapshot } from "../api/schema/updates.ts";
import { UPDATE_CHECK_INTERVAL_MS } from "./update-notice.ts";

const available: UpdateSnapshot = { currentVersion: "0.1.1", job: null, check: {
  currentVersion: "0.1.1", latest: { version: "0.1.2", tag: "v0.1.2", url: "https://github.com/DaniFdz/hui/releases/tag/v0.1.2" },
  status: "available", canInstall: true, message: "A new HUI release is ready to install.",
} };

test("notices require a confirmed newer release and dismiss only that version", () => {
  assert.equal(availableUpdate(null, ""), null);
  assert.equal(availableUpdate({ ...available, check: null }, ""), null);
  for (const status of ["current", "unpublished", "unavailable"] as const) {
    assert.equal(availableUpdate({ ...available, check: { ...available.check!, status } }, ""), null);
  }
  assert.equal(availableUpdate(available, "")?.version, "0.1.2");
  assert.equal(availableUpdate(available, "0.1.2"), null);
  assert.equal(availableUpdate(available, "0.1.0")?.version, "0.1.2");
  // Managed installs may still discover releases; their dialog explains ownership.
  assert.equal(availableUpdate({ ...available, check: { ...available.check!, canInstall: false } }, "")?.version, "0.1.2");
});

test("a running update or the installed version suppresses stale offers", () => {
  assert.equal(availableUpdate({ ...available, job: { id: "test", pid: 1, version: "0.1.2", status: "running", message: "Updating" } }, ""), null);
  assert.equal(availableUpdate({ ...available, currentVersion: "0.1.2" }, ""), null);
  assert.equal(availableUpdate({ ...available, job: { id: "test", pid: 1, version: "0.1.2", status: "failed", message: "Failed" } }, "")?.version, "0.1.2");
});

test("background checks are bounded across focus events, pause while hidden and resume when due", async (t) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  t.onTestFinished(() => { vi.useRealTimers(); });
  let enabled = true;
  let checks = 0;
  const received: UpdateSnapshot[] = [];
  const watcher = watchUpdateAvailability({ check: async () => { checks++; return available; },
    receive: (snapshot) => received.push(snapshot), enabled: () => enabled });
  t.onTestFinished(watcher.stop);
  await Promise.resolve();
  assert.equal(checks, 1);
  assert.equal(received.length, 1);
  watcher.refresh(); watcher.refresh();
  vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1);
  assert.equal(checks, 1);
  enabled = false;
  watcher.refresh();
  vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 2);
  assert.equal(checks, 1);
  enabled = true;
  watcher.refresh(); watcher.refresh();
  await Promise.resolve();
  assert.equal(checks, 2);
  watcher.stop();
  vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 2);
  watcher.refresh();
  assert.equal(checks, 2);
});

test("errors stay quiet and retry on cadence; disposal ignores late responses", async (t) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1000 });
  t.onTestFinished(() => { vi.useRealTimers(); });
  let checks = 0;
  let resolve!: (snapshot: UpdateSnapshot) => void;
  const received: UpdateSnapshot[] = [];
  const watcher = watchUpdateAvailability({ check: async () => {
    checks++;
    if (checks === 1) throw new Error("offline");
    return new Promise<UpdateSnapshot>((done) => { resolve = done; });
  }, receive: (snapshot) => received.push(snapshot), enabled: () => true });
  t.onTestFinished(watcher.stop);
  await Promise.resolve();
  assert.equal(received.length, 0);
  watcher.refresh();
  assert.equal(checks, 1);
  vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(checks, 2);
  watcher.refresh();
  assert.equal(checks, 2);
  watcher.stop();
  resolve(available);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(received.length, 0);
});
