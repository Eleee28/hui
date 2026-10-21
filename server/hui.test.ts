import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

import type { SessionStreamMessage } from "./sessions/live-sessions.ts";
import type { SessionRecord } from "./sessions/sessions.ts";

// HUI's directory resolves at import time and hui.ts reads it as it loads: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-gateway-home-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
afterAll(() => rm(root, { recursive: true, force: true }));
const { sessionGroupPatch } = await import("./routes/sessions.ts");
const { waitForAutomationRun } = await import("./automation.ts");
const { markBackgroundWork } = await import("./sessions/views.ts");
const { createSessionLifecycle, sessionText } = await import("./sessions/lifecycle.ts");
const { waitForSessionReady } = createSessionLifecycle({
  views: { pendingView: () => { throw new Error("No pending sessions here."); } },
  readAttachments: async () => ({ attachments: [], cleanupRejected: async () => undefined }),
  subagents: () => ({ forgetSessions: () => undefined }),
  taskSuggestions: () => ({ forget: () => undefined }),
  watchers: () => ({ forget: async () => undefined }),
  managedBrowser: () => ({ closeOwner: () => undefined }),
});

test("group defaults patch validates modes and bounded refs", async () => {
  await assert.rejects(sessionGroupPatch({ tool: "pi" }), /Nothing to change/, "groups no longer carry a runtime");
  assert.deepEqual(await sessionGroupPatch({ workspaceMode: "worktree", baseRef: " release/1.0 " }), { workspaceMode: "worktree", baseRef: "release/1.0" });
  assert.deepEqual(await sessionGroupPatch({ workspaceMode: "branch" }), { workspaceMode: "branch" });
  assert.deepEqual(await sessionGroupPatch({ workspaceMode: "", baseRef: "" }), { workspaceMode: "", baseRef: "" });
  for (const workspaceMode of [null, true, {}, "worktrees"]) {
    await assert.rejects(sessionGroupPatch({ workspaceMode }), /Environment/);
  }
  await assert.rejects(sessionGroupPatch({ baseRef: 123 }), /must be text/);
  await assert.rejects(sessionGroupPatch({ baseRef: "x".repeat(201) }), /at most 200/);
});

test("a session text error names the field that failed", () => {
  const required = { optional: true, allowEmpty: false };
  assert.throws(() => sessionText({ initialPrompt: " " }, "initialPrompt", 4_000, required), /^Error: An initial prompt must be 1-4000 characters\.$/u);
  assert.throws(() => sessionText({ initialPrompt: "x".repeat(4_001) }, "initialPrompt", 4_000, required), /^Error: An initial prompt must be 1-4000 characters\.$/u);
  assert.throws(() => sessionText({ initialPrompt: 1 }, "initialPrompt", 4_000, required), /^Error: Initial prompt must be text\.$/u);
});

/** One session's stream, driven by the test. */
function watchedSession(status = "running") {
  let listener!: (message: SessionStreamMessage) => void;
  const sessions = {
    watch: (_id: string, next: (message: SessionStreamMessage) => void) => {
      listener = next;
      return { snapshot: { status }, unsubscribe: () => undefined };
    },
    transcript: () => [{ kind: "message", role: "assistant", text: "Done there." }],
    abort: async () => undefined,
  } as unknown as Parameters<typeof waitForAutomationRun>[2];
  return { sessions, emit: (message: SessionStreamMessage) => listener(message) };
}

const automationTarget = { id: "target", title: "Target", group: "", cwd: "/tmp", tool: "durable", worker: "w", createdAt: "", updatedAt: "" } satisfies SessionRecord;

test("an automation run ends when its session settles, and fails once HUI is disconnected from its machine", async () => {
  const settling = watchedSession();
  const done = waitForAutomationRun(automationTarget, new AbortController().signal, settling.sessions);
  settling.emit({ kind: "status", status: "reconnecting" });
  settling.emit({ kind: "event", event: { type: "settled" } });
  assert.deepEqual(await done, { summary: "Done there." });

  const disconnecting = watchedSession();
  const failed = waitForAutomationRun(automationTarget, new AbortController().signal, disconnecting.sessions);
  disconnecting.emit({ kind: "status", status: "disconnected" });
  await assert.rejects(failed, /disconnected/u);
});

test("a new session HUI is disconnected from fails at once instead of taking its first prompt later", async () => {
  const session = watchedSession("starting");
  const ready = waitForSessionReady("target", 2_000, session.sessions);
  session.emit({ kind: "status", status: "disconnected" });
  await assert.rejects(ready, /disconnected/u);
  const already = waitForSessionReady("target", 2_000, watchedSession("disconnected").sessions);
  await assert.rejects(already, /disconnected/u);
});

test("a running watcher or subagent marks its session and every ancestor as busy", () => {
  const view = (id: string, status: string, parentId?: string) => ({ id, status, ...(parentId ? { parentId } : {}) }) as never as Parameters<typeof markBackgroundWork>[0][number];
  const views = [view("root", "idle"), view("child", "idle", "root"), view("grandchild", "running", "child"), view("watched", "idle"), view("calm", "idle"), view("loop", "running", "loop")];
  markBackgroundWork(views, (id) => id === "watched");
  assert.deepEqual(views.filter((v) => v.background).map((v) => v.id), ["root", "child", "watched"]);
});
