/** Watcher tool integration, guarded HTTP controls, log tails and session-deletion cleanup. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { waitFor } from "../test-support/wait-for.ts";
import { WatcherLog, WatchersResponse } from "../api/watchers.ts";
import { expectSchema } from "../test-support/api-schema.ts";

test("the watcher tool starts HUI-run processes and the guarded routes control them", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-watcher-routes-"));
  // The gateway's home, HUI's directory and PI's agent directory: never the operator's own.
  process.env["HOME"] = dir;
  process.env["XDG_CONFIG_HOME"] = dir;
  process.env["PI_CODING_AGENT_DIR"] = join(dir, "agent");
  // No gh: startup would run the operator's in the background, writing into this home while it is removed.
  process.env["HUI_GITHUB_CLI"] = join(dir, "no-gh");
  await mkdir(join(dir, "hui"));
  const now = new Date().toISOString();
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "alpha", title: "Alpha", tool: "pi", cwd: dir, createdAt: now, updatedAt: now },
    { id: "beta", title: "Beta", tool: "pi", cwd: dir, createdAt: now, updatedAt: now },
  ], groups: [] }));
  const { middleware } = await import("../hui.ts");
  const { startBackend, stopBackend } = await import("../backend.ts");
  const { agentToolEnvironment } = await import("../agent-tools/bridge.ts");
  const { liveSessions } = await import("../sessions/live-sessions.ts");
  await startBackend();
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => {
    await stopBackend();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const env = await agentToolEnvironment("alpha");
  const tool = async (action: string, params: Record<string, unknown>) => {
    const response = await fetch(`${env["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${env["HUI_AGENT_BRIDGE_TOKEN"]}`, "content-type": "application/json" },
      body: JSON.stringify({ callerSessionId: "alpha", action: "watcher", params: { action, ...params } }),
    });
    return { status: response.status, body: await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: string } };
  };
  const route = (path: string, method = "GET", guard = true) => fetch(origin + path, {
    method, headers: guard ? { "x-hui": "1", "content-type": "application/json" } : { "content-type": "application/json" },
  });

  const bad = await tool("start", { purpose: "No command" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error ?? "", /command must be text/u);

  const started = await tool("start", {
    purpose: "Wait for #21532 approval",
    target: "https://github.com/ddoghq/web-ui/pull/21532",
    outcome: "post /merge",
    command: "printf 'posted /merge\\n'; sleep 30",
  });
  assert.equal(started.status, 200);
  const id = started.body.result?.["id"] as string;
  assert.ok(id);
  assert.equal(started.body.result?.["state"], "running");
  assert.equal((started.body.result?.["logPath"] as string).startsWith(join(dir, "hui", "watchers")), true);
  assert.equal(liveSessions.snapshot("alpha").watchers?.[0]?.id, id);
  assert.equal(liveSessions.snapshot("beta").watchers, undefined);

  const base = `/__hui/sessions/alpha/watchers/${id}`;
  assert.equal((await route(base, "GET", false)).status, 403);
  assert.equal((await route(base, "PUT")).status, 405);
  assert.equal((await route("/__hui/sessions/missing/watchers/" + id, "DELETE")).status, 404);
  // Watchers are scoped to the conversation that started them.
  assert.equal((await route(`/__hui/sessions/beta/watchers/${id}/log`)).status, 404);
  assert.equal((await route(`/__hui/sessions/beta/watchers/${id}/stop`, "POST")).status, 404);

  // The detached shell writes its first line asynchronously; wait for it.
  let logBody: { id: string; lines: string[]; truncated: boolean } | undefined;
  await waitFor("the watcher's first log line", async () => {
    const log = await route(`${base}/log?lines=10`);
    assert.equal(log.status, 200);
    logBody = await log.json() as typeof logBody;
    return logBody?.lines.length;
  }, { state: () => logBody });
  expectSchema(WatcherLog, logBody);
  assert.deepEqual(logBody, { id, lines: ["posted /merge"], truncated: false });
  assert.equal((await route(`${base}/log?lines=0`)).status, 400);

  const running = await tool("start", { purpose: "Hold the door", command: "sleep 30" });
  const runningId = running.body.result?.["id"] as string;
  const stopped = await route(`/__hui/sessions/alpha/watchers/${runningId}/stop`, "POST");
  assert.equal(stopped.status, 200);
  const stoppedWatchers: unknown = await stopped.json();
  expectSchema(WatchersResponse, stoppedWatchers);
  assert.equal(stoppedWatchers.watchers.find((watcher) => watcher.id === runningId)?.state, "stopped");
  assert.ok(stoppedWatchers.watchers.find((watcher) => watcher.id === runningId)?.endedAt);

  const restarted = await route(`/__hui/sessions/alpha/watchers/${runningId}/restart`, "POST");
  assert.equal(restarted.status, 200);
  const restartedWatchers: unknown = await restarted.json();
  expectSchema(WatchersResponse, restartedWatchers);
  assert.equal(restartedWatchers.watchers.find((watcher) => watcher.id === runningId)?.state, "running");
  assert.equal((await route(`/__hui/sessions/alpha/watchers/${runningId}/restart`, "POST")).status, 409);
  assert.equal((await route(`/__hui/sessions/alpha/watchers/${runningId}`, "DELETE")).status, 409);
  await route(`/__hui/sessions/alpha/watchers/${runningId}/stop`, "POST");

  const settled = await route(`${base}/stop`, "POST");
  assert.equal(settled.status, 200);
  const removed = await route(base, "DELETE");
  assert.equal(removed.status, 200);
  const remaining: unknown = await removed.json();
  expectSchema(WatchersResponse, remaining);
  assert.deepEqual(remaining.watchers.map((watcher) => watcher.id), [runningId]);
  assert.equal((await route(base, "DELETE")).status, 404);
  const listed = await tool("list", {});
  assert.equal((listed.body.result as { watchers: unknown[] }).watchers.length, 1);

  // Deleting a conversation stops and forgets its watchers.
  const betaEnv = await agentToolEnvironment("beta");
  const betaStart = await fetch(`${betaEnv["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${betaEnv["HUI_AGENT_BRIDGE_TOKEN"]}`, "content-type": "application/json" },
    body: JSON.stringify({ callerSessionId: "beta", action: "watcher", params: { action: "start", purpose: "Deleted with its conversation", command: "sleep 30" } }),
  });
  const betaWatcher = (await betaStart.json() as { result: { id: string; pid: number } }).result;
  const deleted = await fetch(`${origin}/__hui/sessions/beta`, { method: "DELETE", headers: { "x-hui": "1" } });
  assert.equal(deleted.status, 200);
  await waitFor("the deleted conversation's watcher to stop", () => !processGroupAlive(betaWatcher.pid), { state: () => betaWatcher });
  assert.equal((await route(`/__hui/sessions/beta/watchers/${betaWatcher.id}/log`)).status, 404);
});

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}
