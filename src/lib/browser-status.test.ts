import assert from "node:assert/strict";
import { test } from "vitest";
import { normalizeBrowserStatus } from "./browser-status.ts";
import type { BrowserStatus } from "../api/schema/browser.ts";
import { browserStatusLabel, browserVersionLabel } from "./browser-status.ts";

const base: BrowserStatus = normalizeBrowserStatus({
  enabled: true, headless: true, executablePath: "", executable: { path: "/usr/bin/brave", name: "Brave", source: "detected" },
  executableError: "", state: "stopped", profileDir: "/home/d/.config/hui/browser/profile", lastError: "", tabs: [],
});

test("status normalization keeps valid fields and drops malformed rows", () => {
  const status = normalizeBrowserStatus({
    enabled: false, headless: false, executablePath: "/x", executable: { path: "/x", source: "configured" },
    state: "exploded", mode: "sideways", version: 7, profileDir: "/p", lastError: "boom",
    tabs: [{ id: "t1", ownerSessionId: "a", ownerTitle: "A", title: "T", url: "https://e.x/" }, { id: 2 }, "junk"],
  });
  assert.deepEqual(status, {
    enabled: false, headless: false, executablePath: "/x",
    executable: { path: "/x", name: "Browser", source: "configured" },
    executableError: "", state: "stopped", profileDir: "/p", lastError: "boom",
    tabs: [{ id: "t1", ownerSessionId: "a", ownerTitle: "A", title: "T", url: "https://e.x/" }],
  });
  assert.equal(normalizeBrowserStatus(undefined).enabled, true);
  assert.equal(normalizeBrowserStatus(null).executable, null);
});

test("the header pill reports what the operator must act on first", () => {
  assert.deepEqual(browserStatusLabel(undefined), { kind: "muted", label: "Checking…" });
  assert.deepEqual(browserStatusLabel({ ...base, enabled: false, state: "running" }), { kind: "muted", label: "Off" });
  assert.deepEqual(browserStatusLabel({ ...base, state: "running", mode: "headless" }), { kind: "ok", label: "Running · headless" });
  assert.deepEqual(browserStatusLabel({ ...base, state: "running", mode: "windowed" }), { kind: "ok", label: "Running · visible window" });
  assert.deepEqual(browserStatusLabel({ ...base, state: "starting" }), { kind: "accent", label: "Starting…" });
  assert.deepEqual(browserStatusLabel({ ...base, executable: null }), { kind: "danger", label: "Browser not found" });
  assert.deepEqual(browserStatusLabel({ ...base, lastError: "exited" }), { kind: "warn", label: "Stopped after an error" });
  assert.deepEqual(browserStatusLabel(base), { kind: "muted", label: "Stopped" });
});

test("the version label names the browser once", () => {
  assert.equal(browserVersionLabel({ ...base, version: "Chrome/153.0.8010.53" }), "Brave · Chrome/153.0.8010.53");
  assert.equal(browserVersionLabel({ ...base, executable: { path: "/c", name: "Chrome", source: "detected" }, version: "Chrome/153" }), "Chrome/153");
  assert.equal(browserVersionLabel(base), "Brave");
});
