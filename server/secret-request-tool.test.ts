import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

test("a secret request is only answered over the connection of the machine its session runs on", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-secret-tool-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  await mkdir(join(dir, "hui"));
  const now = new Date().toISOString();
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "local", title: "Local", tool: "durable", cwd: dir, createdAt: now, updatedAt: now },
    { id: "remote", title: "Remote", tool: "durable", cwd: "/home/remote", worker: "w1", createdAt: now, updatedAt: now },
  ], groups: [] }));
  const { stopBackend } = await import("./backend.ts");
  const { invokeAgentTool } = await import("./agent-tools/bridge.ts");
  t.onTestFinished(async () => { await stopBackend(); await rm(dir, { recursive: true, force: true }); });
  // Already stopped, so an accepted request ends at once, cancelled.
  const ask = (callerSessionId: string, fromWorker?: string) => invokeAgentTool({
    callerSessionId, action: "secret_request", params: { label: "Token", reason: "Log in" }, signal: AbortSignal.abort(), ...(fromWorker ? { fromWorker } : {}),
  });
  for (const [caller, worker] of [["remote", undefined], ["remote", "w2"], ["local", "w1"]] as const) {
    await assert.rejects(ask(caller, worker), /must come from the machine its session runs on/u, `${caller} via ${worker ?? "the gateway"}`);
  }
  assert.deepEqual(await ask("remote", "w1"), { status: "cancelled", label: "Token" });
  assert.deepEqual(await ask("local"), { status: "cancelled", label: "Token" });
});
