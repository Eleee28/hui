import assert from "node:assert/strict";
import { test } from "vitest";

import type { GitHubConnection } from "../api/schema/github.ts";
import { gitHubStatusLabel } from "./github.ts";

const base: GitHubConnection = { cli: { installed: true, version: "2.101.0" }, status: "disconnected", login: { phase: "idle" } };

test("status label prefers a missing CLI, then a running login, then the account state", () => {
  assert.deepEqual(gitHubStatusLabel(undefined), { kind: "muted", label: "Checking…" });
  assert.deepEqual(gitHubStatusLabel({ ...base, cli: { installed: false } }), { kind: "danger", label: "GitHub CLI required" });
  assert.deepEqual(gitHubStatusLabel({ ...base, login: { phase: "starting" } }), { kind: "accent", label: "Requesting code…" });
  assert.deepEqual(
    gitHubStatusLabel({ ...base, status: "connected", login: { phase: "pending", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: 1 } }),
    { kind: "accent", label: "Waiting for approval…" },
  );
  assert.deepEqual(gitHubStatusLabel({ ...base, status: "connected" }), { kind: "ok", label: "Connected" });
  assert.deepEqual(gitHubStatusLabel({ ...base, status: "invalid" }), { kind: "danger", label: "Sign-in required" });
  assert.deepEqual(gitHubStatusLabel({ ...base, status: "unknown" }), { kind: "warn", label: "Could not verify" });
  assert.deepEqual(gitHubStatusLabel(base), { kind: "muted", label: "Not connected" });
});
