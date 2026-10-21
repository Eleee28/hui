/** Task-suggestion tool integration, session scoping and guarded HTTP dismiss/start actions. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskSuggestionsResponse } from "../api/task-suggestions.ts";
import { expectSchema } from "../test-support/api-schema.ts";

test("suggest_task bridge calls feed guarded dismiss and start routes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-suggestion-routes-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  await mkdir(join(dir, "hui"));
  const now = new Date().toISOString();
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "alpha", title: "Alpha", tool: "pi", cwd: dir, createdAt: now, updatedAt: now },
    { id: "beta", title: "Beta", tool: "pi", cwd: dir, createdAt: now, updatedAt: now },
  ], groups: [] }));
  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const { agentToolEnvironment } = await import("../agent-tools/bridge.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => { await stopBackend(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });

  const env = await agentToolEnvironment("alpha");
  const tool = async (action: string, params: Record<string, unknown>) => {
    const response = await fetch(`${env["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${env["HUI_AGENT_BRIDGE_TOKEN"]}`, "content-type": "application/json" },
      body: JSON.stringify({ callerSessionId: "alpha", action, params }),
    });
    return { status: response.status, body: await response.json() as { ok: boolean; result?: { taskId: string; cwd: string }; error?: string } };
  };
  const route = (path: string, method: string, guard = true) => fetch(origin + path, {
    method, headers: { ...(guard ? { "x-hui": "1" } : {}), "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}),
  });

  const rejected = await tool("suggest_task", { title: "Fix", problem: "Broken", cwd: "relative" });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error ?? "", /absolute/);
  const first = await tool("suggest_task", { title: "Fix the picker", problem: "It differs.", fix: "Use the picker." });
  assert.equal(first.status, 200);
  assert.equal(first.body.result?.cwd, dir);
  const second = await tool("suggest_task", { title: "Second", problem: "Unknown cause." });
  const firstId = first.body.result!.taskId;
  const secondId = second.body.result!.taskId;

  const base = "/__hui/sessions/alpha/suggestions";
  assert.equal((await route(`${base}/${firstId}`, "DELETE", false)).status, 403);
  assert.equal((await route(`${base}/${firstId}`, "GET")).status, 405);
  assert.equal((await route(`${base}/${firstId}/start`, "DELETE")).status, 405);
  assert.equal((await route(`/__hui/sessions/missing/suggestions/${firstId}`, "DELETE")).status, 404);
  // Suggestions are scoped to the session that recorded them.
  assert.equal((await route(`/__hui/sessions/beta/suggestions/${firstId}`, "DELETE")).status, 404);
  assert.equal((await route(`/__hui/sessions/beta/suggestions/${firstId}/start`, "POST")).status, 404);

  const badMode = await fetch(`${origin}${base}/${firstId}/start`, { method: "POST", headers: { "x-hui": "1", "content-type": "application/json" }, body: JSON.stringify({ mode: "cloud" }) });
  assert.equal(badMode.status, 400);
  assert.match((await badMode.json() as { error: string }).error, /session, worktree or current/);

  const dismissed = await route(`${base}/${firstId}`, "DELETE");
  assert.equal(dismissed.status, 200);
  const dismissedBody: unknown = await dismissed.json();
  expectSchema(TaskSuggestionsResponse, dismissedBody);
  const { suggestions } = dismissedBody;
  assert.deepEqual(suggestions.map(({ id, title }) => ({ id, title })), [{ id: secondId, title: "Second" }]);
  assert.equal((await route(`${base}/${firstId}`, "DELETE")).status, 404);

  const agentDismiss = await tool("dismiss_task", { task_id: secondId });
  assert.deepEqual(agentDismiss.body.result, { taskId: secondId, status: "dismissed" });
  assert.equal((await tool("dismiss_task", { task_id: secondId })).status, 400);
});
