import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import type { SessionSnapshot } from "./sessions/live-sessions.ts";

// HUI's configuration directory (and the Durable store in it) and PI's agent
// directory are resolved at import time; never read the operator's own.
const dir = await mkdtemp(join(tmpdir(), "hui-backend-restart-"));
const agentDir = join(dir, "agent");
const workspace = join(dir, "workspace");
await mkdir(agentDir);
await mkdir(workspace);
// The gateway's home, HUI's directory and PI's agent directory: never the operator's own.
process.env["HOME"] = dir;
process.env["XDG_CONFIG_HOME"] = join(dir, "config");
process.env["PI_CODING_AGENT_DIR"] = agentDir;
// No gh: startup would run the operator's in the background, writing into this home while it is removed.
process.env["HUI_GITHUB_CLI"] = join(dir, "no-gh");
for (const name of ["HUI_CONFIG_DIR", "HUI_DURABLE_DIR", "HUI_SESSION_RUNTIME"]) delete process.env[name];

const { middleware } = await import("./hui.ts");
const { startBackend, stopBackend } = await import("./backend.ts");
const { liveSessions } = await import("./sessions/live-sessions.ts");
const { readRegistry } = await import("./sessions/sessions.ts");
const { DURABLE_DIR } = await import("./runtimes/durable-host.ts");

/** Resolves once the live session satisfies `ready`; a session that fails instead rejects with its error. */
function sessionWhere(id: string, ready: (snapshot: SessionSnapshot) => boolean): Promise<SessionSnapshot> {
  return new Promise((resolve, reject) => {
    let failure = "The session runtime failed.";
    const check = (): void => {
      const snapshot = liveSessions.snapshot(id);
      if (snapshot.status === "error") { watched.unsubscribe(); reject(new Error(failure)); }
      else if (ready(snapshot)) { watched.unsubscribe(); resolve(snapshot); }
    };
    const watched = liveSessions.watch(id, (message) => {
      if (message.kind === "event" && message.event.type === "error") failure = message.event.message;
      check();
    });
    check();
  });
}

const answers = (snapshot: SessionSnapshot) =>
  snapshot.transcript.filter((entry) => entry.kind === "message" && entry.role === "assistant").length;

/** A settled turn's registry write is asynchronous; resolves once its run marker is cleared. */
function runRecorded(id: string): Promise<void> {
  return new Promise((resolve) => {
    const inspect = async () => {
      if (!(await readRegistry()).find((session) => session.id === id)?.runStartedAt) resolve();
      else setImmediate(() => void inspect());
    };
    void inspect();
  });
}

test("the backend stops and restarts in-process, and its Durable sessions open again", { timeout: 60_000 }, async (t) => {
  const provider = spawn(process.execPath, [fileURLToPath(new URL("../e2e/fixtures/pi-provider-fixture.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: workspace, HUI_E2E_PROVIDER_LOG: join(dir, "requests.jsonl") },
  });
  const [ready] = await once(provider.stdout!, "data");
  const baseUrl = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(ready))?.[0];
  assert(baseUrl, String(ready));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
    baseUrl, api: "anthropic-messages", apiKey: "fixture", models: [{
      id: "fixture", name: "fixture", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));

  await startBackend();
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  t.onTestFinished(async () => {
    await stopBackend();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const exited = once(provider, "exit");
    provider.kill();
    await exited;
    await rm(dir, { recursive: true, force: true });
  });
  const route = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST", headers: { "x-hui": "1", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(json));
    return json;
  };

  const { session } = await route("/__hui/sessions", { cwd: workspace, title: "Restart" }) as { session: { id: string } };
  await sessionWhere(session.id, (snapshot) => snapshot.status === "idle");
  await route(`/__hui/sessions/${session.id}/prompt`, { text: "Before the restart" });
  await sessionWhere(session.id, (snapshot) => answers(snapshot) === 1 && snapshot.status === "idle");
  await runRecorded(session.id);

  // A development server restarts the backend in its own process. Stopping
  // releases the Durable store, so the next backend can own it at once.
  await stopBackend();
  assert.equal(existsSync(join(DURABLE_DIR, "harness.lock")), false, "the stopped backend released the Durable store");
  await startBackend();

  await route(`/__hui/sessions/${session.id}/open`);
  const reopened = await sessionWhere(session.id, (snapshot) => snapshot.status === "idle");
  assert.equal(answers(reopened), 1, "the conversation from before the restart");
  await route(`/__hui/sessions/${session.id}/prompt`, { text: "After the restart" });
  await sessionWhere(session.id, (snapshot) => answers(snapshot) === 2 && snapshot.status === "idle");
  await runRecorded(session.id);
});
