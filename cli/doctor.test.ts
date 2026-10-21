import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

// HUI's directory, the Durable store and PI's agent directory resolve at import time, and PI finds skills in
// ~/.agents/skills: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-doctor-"));
const config = join(root, "config", "hui");
const store = join(root, "durable");
const agentDir = join(root, "agent");
const workspace = join(root, "workspace");
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
process.env["HUI_DURABLE_DIR"] = store;
process.env["PI_CODING_AGENT_DIR"] = agentDir;
afterAll(() => rm(root, { recursive: true, force: true }));
await mkdir(agentDir, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
  baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", apiKey: "fixture-key", models: [{
    id: "fixture", name: "fixture", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
} } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));
const { normalizeSettings } = await import("../server/hui-settings.ts");
const { formatDoctorReport, runDoctor } = await import("./doctor.ts");
const { readRegistry, writeRegistry } = await import("../server/sessions/sessions.ts");
const { DurableHost } = await import("../server/runtimes/durable-host.ts");
const { startDurable } = await import("../server/runtimes/durable.ts");

const TIME = "2026-10-01T10:00:00.000Z";
const registryFile = join(config, "sessions.json");
const files = { moves: join(root, "moves.jsonl"), interrupted: join(root, "interrupted.jsonl") };

function piSession(prompt: string): string {
  return [
    { type: "session", version: 3, id: prompt, timestamp: TIME, cwd: workspace },
    { type: "message", id: "u1", parentId: null, timestamp: TIME, message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: TIME, message: {
      role: "assistant", content: [{ type: "text", text: "PI answer" }], api: "anthropic-messages", provider: "hui-e2e", model: "fixture",
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 2,
    } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

const record = (id: string, title: string, extra: Record<string, unknown> = {}) =>
  ({ id, title, group: "", cwd: workspace, tool: "pi", createdAt: TIME, updatedAt: TIME, ...extra }) as never;

/** Fresh state: a PI session to move, one never started, one interrupted, one whose file is gone, a Durable one
 * and one on a remote worker, whose transcript lives there. */
async function setup(): Promise<void> {
  await rm(store, { recursive: true, force: true });
  await rm(join(config, "backups"), { recursive: true, force: true });
  await writeFile(files.moves, piSession("PI_MOVES hello"));
  await writeFile(files.interrupted, piSession("PI_INTERRUPTED"));
  await writeRegistry([
    record("moves-session", "Moves to Durable", { piSessionFile: files.moves, model: "hui-e2e/fixture", thinking: "high" }),
    record("fresh-session", "Never started"),
    record("interrupted-session", "Interrupted run", { piSessionFile: files.interrupted, runStartedAt: TIME, runPrompt: "keep going" }),
    record("missing-session", "Lost transcript", { piSessionFile: join(root, "gone.jsonl") }),
    record("durable-session", "Already on Durable", { tool: "durable" }),
    record("worker-session", "On a worker", { worker: "devbox", piSessionFile: "/home/dev/.pi/sessions/remote.jsonl" }),
  ]);
}

const piCheck = (report: Awaited<ReturnType<typeof runDoctor>>) => report.checks.find((check) => check.id === "pi-sessions")!;
const statuses = (report: Awaited<ReturnType<typeof runDoctor>>) => piCheck(report).items.map((item) => [item.id, item.status]);

function inspector() {
  const host = new DurableHost({
    dir: store, agentDir, readSettings: async () => normalizeSettings(undefined),
    invokeTool: async () => ({}), lookupCaller: async () => undefined, resume: false,
  });
  host.configureDurableBots(null);
  return host;
}

test("the report lists sessions still on PI, changes nothing, and --fix waits for the gateway to stop", async () => {
  await setup();
  const registry = await readFile(registryFile, "utf8");
  const report = await runDoctor();
  assert.equal(report.ok, false);
  assert.equal(piCheck(report).status, "issue");
  assert.deepEqual(statuses(report), [
    ["moves-session", "issue"], ["fresh-session", "issue"], ["interrupted-session", "blocked"], ["missing-session", "blocked"],
  ]);
  const text = formatDoctorReport(report);
  assert.match(text, /^✗ PI sessions: 4 sessions still run on PI's worker$/mu);
  assert.match(text, /! "Interrupted run" \(interrup\): it has an interrupted run/u);
  assert.match(text, /! "Lost transcript" \(missing-\): its PI transcript is missing/u);
  assert.match(text, /hui doctor --fix moves the 2 sessions marked • to Pi Durable while the gateway is stopped/u);
  await assert.rejects(runDoctor({ fix: true, gatewayStatus: async () => ({ status: "running" }) }), /Stop the gateway before hui doctor --fix/u);
  assert.equal(await readFile(registryFile, "utf8"), registry, "neither the report nor a refused fix writes the registry");
  assert.equal(existsSync(store), false, "nor opens the Durable store");
});

test("--fix moves sessions to Durable, keeps PI's transcripts and backs up the registry", async () => {
  await setup();
  const registry = await readFile(registryFile, "utf8");
  const transcript = await readFile(files.moves, "utf8");
  const report = await runDoctor({ fix: true });
  assert.equal(report.ok, false, "the blocked sessions remain");
  assert.deepEqual(statuses(report), [
    ["moves-session", "fixed"], ["fresh-session", "fixed"], ["interrupted-session", "blocked"], ["missing-session", "blocked"],
  ]);
  const check = piCheck(report);
  assert.equal(check.summary, "moved 2 sessions to Pi Durable; 2 sessions still run on PI");
  assert.equal(check.items[0]!.detail, "2 messages, continues on hui-e2e/fixture");
  assert.equal(check.items[1]!.detail, "never started; it starts on Pi Durable");
  const sessions = new Map((await readRegistry()).map((session) => [session.id, session]));
  const moved = sessions.get("moves-session")!;
  assert.equal(moved.tool, "durable");
  assert.match(moved.piSessionFile ?? "", /^durable:\d+$/u);
  assert.deepEqual([moved.model, moved.thinking], ["hui-e2e/fixture", "high"]);
  assert.equal(sessions.get("fresh-session")!.tool, "durable");
  assert.equal(sessions.get("fresh-session")!.piSessionFile, undefined);
  assert.equal(sessions.get("interrupted-session")!.tool, "pi");
  assert.equal(sessions.get("interrupted-session")!.runStartedAt, TIME, "an interrupted run stays for the gateway to recover");
  assert.equal(sessions.get("worker-session")!.tool, "pi", "a worker's session stays on PI there");
  assert.equal(await readFile(files.moves, "utf8"), transcript, "PI's transcript is unchanged");
  const backup = check.notes.find((note) => note.startsWith("Registry backup: "))!.slice("Registry backup: ".length);
  assert.equal(await readFile(backup, "utf8"), registry);

  const host = inspector();
  const session = await startDurable({ cwd: workspace, sessionFile: moved.piSessionFile }, host);
  assert.deepEqual(session.transcript().flatMap((entry) => entry.kind === "message" ? [`${entry.role}:${entry.text}`] : []), ["user:PI_MOVES hello", "assistant:PI answer"]);
  session.dispose();
  await host.close();

  // Only blocked sessions are left: nothing to change, so a running gateway is no obstacle.
  const rerun = await runDoctor({ fix: true, gatewayStatus: async () => ({ status: "running" }) });
  assert.deepEqual(statuses(rerun), [["interrupted-session", "blocked"], ["missing-session", "blocked"]]);
});

test("a rerun after a fix that never reached the registry reuses the earlier copy", async () => {
  await setup();
  await runDoctor({ fix: true });
  const reference = (await readRegistry()).find((session) => session.id === "moves-session")!.piSessionFile;
  // As if the gateway had been killed between Durable's commit and the registry write.
  await writeRegistry((await readRegistry()).map((session) =>
    session.id === "moves-session" ? { ...session, tool: "pi", piSessionFile: files.moves } : session));
  const report = await runDoctor({ fix: true });
  assert.match(piCheck(report).items[0]!.detail ?? "", /copied by an earlier run/u);
  assert.equal((await readRegistry()).find((session) => session.id === "moves-session")!.piSessionFile, reference);
});

test("--fix refuses a store another gateway owns and changes nothing", async (t) => {
  await setup();
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  t.onTestFinished(() => { owner.kill(); });
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "harness.lock"), String(owner.pid));
  const registry = await readFile(registryFile, "utf8");
  await assert.rejects(runDoctor({ fix: true }), new RegExp(`already open in another HUI gateway \\(pid ${owner.pid}\\)`, "u"));
  assert.equal(await readFile(registryFile, "utf8"), registry);
  assert.equal(existsSync(join(config, "backups")) ? (await readdir(join(config, "backups"))).length : 0, 0, "no backup without a change");
});

test("a state with every session on Durable is healthy", async () => {
  await rm(store, { recursive: true, force: true });
  await writeRegistry([record("durable-session", "Already on Durable", { tool: "durable" })]);
  const report = await runDoctor({ fix: true, gatewayStatus: async () => ({ status: "running" }) });
  assert.deepEqual(report, { ok: true, checks: [
    { id: "pi-sessions", title: "PI sessions", status: "ok", summary: "every session runs on Pi Durable", items: [], notes: [] },
    { id: "triggers", title: "Triggers", status: "ok", summary: "nothing left of GitHub, Sessions, Webhook or Slack triggers", items: [], notes: [] },
  ] });
  assert.equal(formatDoctorReport(report), "✓ PI sessions: every session runs on Pi Durable\n✓ Triggers: nothing left of GitHub, Sessions, Webhook or Slack triggers");
});
