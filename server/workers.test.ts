/**
 * Remote workers end to end on one machine: the "remote" is a separate home
 * directory reached through `env … sh -s`, so nothing is shared with the
 * gateway except what the protocol carries. The host, its runtimes and a
 * deterministic Anthropic-compatible provider all run for real.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { fileURLToPath } from "node:url";
import { completeLines } from "./test-support/json-lines.ts";
import { expectSchema } from "./test-support/api-schema.ts";
import { WorkerView } from "./api/workers.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "hui-workers-"));
const agentDir = join(root, "gateway", "agent");
const remoteHome = join(root, "remote");
const project = join(remoteHome, "project");
const KEY = "fixture-secret-key";
const HEADER_SECRET = "fixture-secret-header";
// The gateway's home too: nothing is read from the real user's files.
process.env["HOME"] = join(root, "gateway", "home");
process.env["PI_CODING_AGENT_DIR"] = agentDir;
process.env["XDG_CONFIG_HOME"] = join(root, "gateway", "config");
process.env["PI_OFFLINE"] = "1";

const { workers } = await import("./workers.ts");
const { remoteRuntime } = await import("./runtimes/remote.ts");
const piRuntime = remoteRuntime("pi");
const { workerRelease } = await import("./worker/release.ts");
const { registerAgentToolHandler } = await import("./agent-tools/bridge.ts");
const { GATEWAY_ONLY_TOOLS } = await import("./worker/gateway-tools.ts");
const { readRegistry, writeRegistry } = await import("./sessions/sessions.ts");
const { SecretRequests } = await import("./agent-tools/secret-requests.ts");
const durable = remoteRuntime("durable");
const control = (path: string, init?: RequestInit) => fetch(`${baseUrl.replace(/\/v1$/u, "")}/control/${path}`, init);
type Session = Awaited<ReturnType<typeof piRuntime.start>>;

let provider: ChildProcess;
let baseUrl = "";
let workerId = "";

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function settled(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = session.subscribe((event) => {
      if (event.type === "settled") { stop(); resolve(); }
      if (event.type === "error") { stop(); reject(new Error(event.message)); }
    });
  });
}

/** Everything under the remote home that is not installed code. */
async function remoteFiles(dir = remoteHome): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === "releases") continue;
    if (entry.isDirectory()) out.push(...await remoteFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Every remote file with its text, from one pass that no file vanished from. The host replaces its state files
 * (pi-runs.json) through temporary ones it renames, so a file listed can be gone when it is read, and what it became
 * may have been read before the rename: that pass is read again. */
async function remoteContents(): Promise<Array<[file: string, text: string]>> {
  return waitFor(async () => {
    try {
      const contents: Array<[string, string]> = [];
      for (const file of await remoteFiles()) contents.push([file, await readFile(file, "utf8")]);
      return contents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }, "one pass over the remote files that none was replaced during");
}

beforeAll(async () => {
  await mkdir(join(agentDir, "skills", "gateway-skill"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(root, "gateway", "package", "skills", "package-skill"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(agentDir, "skills", "gateway-skill", "SKILL.md"), "---\nname: gateway-skill\ndescription: Lives only on the gateway.\n---\nBody\n");
  await writeFile(join(root, "gateway", "package", "package.json"), JSON.stringify({ name: "local-package", version: "1.0.0", pi: { skills: ["./skills"] } }));
  await writeFile(join(root, "gateway", "package", "skills", "package-skill", "SKILL.md"), "---\nname: package-skill\ndescription: From a local PI package.\n---\nBody\n");
  await writeFile(join(agentDir, "extensions", "question.ts"), await readFile(join(repo, "e2e", "fixtures", "question-extension.ts"), "utf8"));
  await writeFile(join(agentDir, "extensions", "oauth-provider.ts"), `export default function (pi) {
  pi.registerProvider("fx-oauth", {
    baseUrl: process.env.HUI_TEST_BASE_URL, api: "anthropic-messages",
    models: [{ id: "fixture", name: "OAuth fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    oauth: {
      name: "Fixture OAuth",
      login: async () => { throw new Error("no login in tests"); },
      // The fixture's token endpoint: the rotated access token comes from the
      // environment, so no file on the remote ever holds it.
      refreshToken: async (credential) => ({ refresh: credential.refresh + "-rotated", access: process.env.HUI_TEST_ACCESS, expires: Date.now() + 3_600_000, refreshedOn: process.env.HOME }),
      getApiKey: (credential) => credential.access,
    },
  });
}
`);
  provider = spawn(process.execPath, [join(repo, "e2e/fixtures/pi-provider-fixture.mjs")], {
    env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: project, HUI_E2E_PROVIDER_LOG: join(root, "provider.jsonl"), HUI_E2E_PROVIDER_KEY: KEY },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [ready] = await once(provider.stdout!, "data");
  baseUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)![0];
  const models = [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    fx: { baseUrl, api: "anthropic-messages", models },
    // Its key and header exist only as literals here, never in a PI login.
    "fx-literal": { baseUrl, api: "anthropic-messages", apiKey: KEY, headers: { "x-e2e-token": HEADER_SECRET }, models },
    // Its key resolves on the remote, so the gateway has no credential to
    // serve for it; only its header is a literal here.
    "fx-remote-key": { baseUrl, api: "anthropic-messages", apiKey: "$HUI_TEST_REMOTE_KEY", headers: { "x-e2e-token": HEADER_SECRET }, models },
  } }));
  // The key exists only in the gateway's PI login.
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({
    fx: { type: "api_key", key: KEY },
    "fx-oauth": { type: "oauth", refresh: "refresh-1", access: "expired-token", expires: 0 },
  }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fx", defaultModel: "fixture", packages: [join(root, "gateway", "package")] }));

  // Pre-install this checkout as the remote release (the container E2E covers
  // the real npm install) so the suite needs no network.
  const release = await workerRelease();
  const dir = join(remoteHome, ".local", "share", "hui-worker", "releases", release.id);
  for (const file of release.files) {
    await mkdir(dirname(join(dir, file.path)), { recursive: true });
    await writeFile(join(dir, file.path), file.data, { mode: file.mode });
  }
  await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, ".ready"), "");
  // A lock left by a host that died, whose pid now belongs to an unrelated
  // live process (as after a container restart), must not block a new host.
  await mkdir(join(remoteHome, ".local", "share", "hui-worker", "state"), { recursive: true });
  await writeFile(join(remoteHome, ".local", "share", "hui-worker", "state", "host.pid"), String(process.pid));

  const command = ["env", "-u", "PI_CODING_AGENT_DIR", "-u", "XDG_CONFIG_HOME", "-u", "PI_OFFLINE", `HOME=${remoteHome}`, "SHELL=/bin/sh", `HUI_TEST_BASE_URL=${baseUrl}`, `HUI_TEST_ACCESS=${KEY}`, `HUI_TEST_REMOTE_KEY=${KEY}`];
  workerId = (await workers.create({ name: "test remote", command: command.map((word) => `'${word}'`).join(" ") })).id;
});

afterAll(async () => {
  workers.disconnectAll();
  provider?.kill();
  // The host is durable by design; stop the one this suite started.
  try { execFileSync("pkill", ["-f", remoteHome]); } catch { /* already gone */ }
  await rm(root, { recursive: true, force: true });
});

test("a remote session runs with gateway credentials and mirrored resources, leaving no secret on the remote", async () => {
  const session = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-basic" });
  try {
    // No run of this session was interrupted on the worker.
    assert.equal(session.resumesInterruptedRuns, true);
    assert.ok(session.sessionFile?.startsWith(remoteHome), String(session.sessionFile));
    const inspection = await session.inspect!();
    assert.match(inspection.prompt, /gateway-skill/u);
    assert.match(inspection.prompt, /package-skill/u);
    assert.ok(!inspection.tools.some((tool) => tool.name === "browser"), "the gateway's browser is not offered remotely");
    const done = settled(session);
    await session.prompt("hello from the gateway");
    await done;
    assert.deepEqual(session.transcript().filter((entry) => entry.kind === "message").map((entry) => entry.kind === "message" && entry.text), ["hello from the gateway", "Fixture response."]);
    for (const [file, text] of await remoteContents()) {
      assert.ok(!text.includes(KEY), `${file} holds the provider key`);
    }
    const view = (await workers.list()).find((worker) => worker.id === workerId)!;
    expectSchema(WorkerView, view);
    assert.equal(view.state, "connected");
    assert.ok(view.sync && view.sync.files > 0 && view.sync.errors.length === 0, JSON.stringify(view.sync));
  } finally {
    session.dispose();
  }
});

test("reloading a remote session picks up resources just changed on the gateway", async () => {
  const session = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-reload" });
  try {
    assert.doesNotMatch((await session.inspect!()).prompt, /fresh-skill/u);
    await mkdir(join(agentDir, "skills", "fresh-skill"), { recursive: true });
    await writeFile(join(agentDir, "skills", "fresh-skill", "SKILL.md"), "---\nname: fresh-skill\ndescription: Written after the session started.\n---\nBody\n");
    await session.reload!();
    assert.match((await session.inspect!()).prompt, /fresh-skill/u);
  } finally {
    session.dispose();
    await rm(join(agentDir, "skills", "fresh-skill"), { recursive: true, force: true });
  }
});

test("an OAuth refresh runs on the remote while the gateway holds the lock, and is stored only on the gateway", async () => {
  const session = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-oauth", model: "fx-oauth/fixture" });
  try {
    const done = settled(session);
    await session.prompt("hello with oauth");
    await done;
    assert.equal(session.transcript().at(-1)?.kind === "message" && (session.transcript().at(-1) as { text: string }).text, "Fixture response.");
    const stored = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))["fx-oauth"];
    assert.equal(stored.refresh, "refresh-1-rotated");
    assert.equal(stored.access, KEY);
    assert.equal(stored.refreshedOn, remoteHome, "the refresh callback ran on the remote");
    assert.ok(!existsSync(join(remoteHome, ".pi", "agent", "auth.json")));
  } finally {
    session.dispose();
  }
});

test("a run keeps going without the gateway and is reattached, not recovered", async () => {
  const first = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-durable" });
  await first.prompt("E2E_REPLAY please");
  await fetch(`${baseUrl.replace(/\/v1$/u, "")}/control/wait-replay-ready`);
  const sessionFile = first.sessionFile!;
  workers.disconnect(workerId);
  // The gateway is gone; the provider finishes the answer on the remote.
  await fetch(`${baseUrl.replace(/\/v1$/u, "")}/control/release-replay`, { method: "POST" });
  await waitFor(async () => (await readFile(sessionFile, "utf8").catch(() => "")).includes("replay suffix") || undefined, "the remote to persist the answer");
  first.dispose();
  const second = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-durable", sessionFile });
  try {
    assert.equal(second.resumesInterruptedRuns, true);
    assert.equal(second.sessionFile, sessionFile);
    const answer = second.transcript().filter((entry) => entry.kind === "message").at(-1);
    assert.equal(answer?.kind === "message" && answer.text, "Replay prefix — replay suffix");
  } finally {
    second.dispose();
  }
});

test("a transcript too large to ride along with an event is read in pages", async () => {
  const session = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-large" });
  try {
    // Larger than one transcript page, so `settled` cannot carry it.
    const large = `large ${"x".repeat(9 * 1024 * 1024)}`;
    const done = settled(session);
    await session.prompt(large);
    await done;
    const texts = session.transcript().filter((entry) => entry.kind === "message").map((entry) => entry.kind === "message" ? entry.text : "");
    assert.deepEqual(texts.map((text) => text.length), [large.length, "Fixture response.".length]);
    assert.equal(texts[1], "Fixture response.");
  } finally {
    session.dispose();
  }
});

const piRunsFile = join(remoteHome, ".local", "share", "hui-worker", "state", "pi-runs.json");
const hostPid = async () => Number(await readFile(join(remoteHome, ".local", "share", "hui-worker", "state", "host.pid"), "utf8"));

/** Kills the host and its PI workers, as a crash or reboot would, and connects a new one. */
async function restartHost(session: Session): Promise<void> {
  const pid = await hostPid();
  const lost = new Promise<void>((resolve) => session.onExit!(() => resolve()));
  execFileSync("pkill", ["-KILL", "-f", remoteHome]);
  await lost;
  session.dispose();
  await workers.connect(workerId);
  assert.notEqual(await hostPid(), pid);
}

test("a PI run that finished while no gateway watched is not recovered by a later, fresh runtime", async () => {
  const key = "remote-pi-finished";
  const first = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: key });
  await first.prompt("E2E_REPLAY please");
  await control("wait-replay-ready");
  workers.disconnect(workerId);
  first.dispose();
  await control("release-replay", { method: "POST" });
  await waitFor(async () => !(await readFile(piRunsFile, "utf8")).includes(key) || undefined, "the host to see the run settle");
  const second = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: key, sessionFile: first.sessionFile! });
  await restartHost(second);
  const third = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: key, sessionFile: first.sessionFile! });
  try {
    assert.equal(third.resumesInterruptedRuns, true);
    assert.equal(lastAnswer(third), "Replay prefix — replay suffix");
  } finally {
    third.dispose();
  }
});

test("a PI run cut off by a host restart is reported for HUI to recover, once", async () => {
  const key = "remote-pi-interrupted";
  const first = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: key });
  await first.prompt("E2E_REPLAY please");
  // Recorded before the run started, so a crash at any point leaves the record.
  assert.ok((await readFile(piRunsFile, "utf8")).includes(key));
  await control("wait-replay-ready");
  await restartHost(first);
  const second = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: key, sessionFile: first.sessionFile! });
  try {
    assert.equal(second.resumesInterruptedRuns, false);
    // The recovery run settles, after which nothing is left to recover.
    const done = settled(second);
    await second.prompt("continue");
    await done;
    assert.equal(lastAnswer(second), "Fixture response.");
  } finally {
    second.dispose();
  }
  const third = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: key, sessionFile: first.sessionFile! });
  try {
    assert.equal(third.resumesInterruptedRuns, true);
  } finally {
    third.dispose();
  }
});

test("a follow-up that reaches the worker after its PI run settled starts the next run", async () => {
  const session = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-late-follow-up" });
  try {
    const done = settled(session);
    await session.prompt("first turn");
    await done;
    await session.followUp!("arrived after the run");
    const texts = () => session.transcript().filter((entry) => entry.kind === "message").map((entry) => entry.kind === "message" && entry.text);
    await waitFor(() => !session.isStreaming && texts().length === 4 || undefined, "the follow-up to run");
    assert.deepEqual(texts(), ["first turn", "Fixture response.", "arrived after the run", "Fixture response."]);
  } finally {
    session.dispose();
  }
});

test("closing a session stops its remote process, so reopening starts a fresh one", async () => {
  const first = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-close" });
  const asked = new Promise<void>((resolve) => first.subscribe((event) => { if (event.type === "question") resolve(); }));
  await first.prompt("/hui-e2e-question select");
  await asked;
  first.dispose();
  const second = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-close", sessionFile: first.sessionFile! });
  try {
    // The question lived only in the stopped process.
    assert.deepEqual(second.pendingQuestions!(), []);
    const done = settled(second);
    await second.prompt("still answering after a reopen");
    await done;
    assert.equal(second.transcript().at(-1)?.kind === "message" && (second.transcript().at(-1) as { text: string }).text, "Fixture response.");
  } finally {
    second.dispose();
  }
});

test("deleting a session stops its remote process even when no gateway is attached", async () => {
  const first = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-forget" });
  workers.disconnect(workerId);
  first.dispose();
  await workers.connect(workerId);
  await workers.forget(workerId, ["remote-forget"]);
  const second = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-forget" });
  try {
    // A new process starts a new conversation; the old one would have kept its own.
    assert.notEqual(second.sessionId, first.sessionId);
  } finally {
    second.dispose();
  }
});

test("a question asked while no gateway is attached is shown again on reattach", async () => {
  const first = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-question" });
  const asked = new Promise<string>((resolve) => first.subscribe((event) => { if (event.type === "question") resolve(event.question.id); }));
  await first.prompt("/hui-e2e-question select");
  const questionId = await asked;
  workers.disconnect(workerId);
  first.dispose();
  const second = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-question", sessionFile: first.sessionFile! });
  try {
    assert.equal(second.resumesInterruptedRuns, true);
    const pending = await waitFor(() => second.pendingQuestions!().find((question) => question.id === questionId), "the replayed question");
    assert.equal(pending.title, "HUI E2E choice");
    const answered = new Promise<string>((resolve) => second.subscribe((event) => { if (event.type === "notice") resolve(event.message); }));
    await second.respondQuestion!(questionId, { value: "Second option" });
    assert.equal(await answered, "Question answered: Second option");
  } finally {
    second.dispose();
  }
});

test("a Durable session runs on the worker, keeps going without the gateway and catches up on reattach", async () => {
  const durable = remoteRuntime("durable");
  const first = await durable.start({ cwd: project, worker: workerId, huiSessionId: "remote-durable-runtime" });
  assert.equal(first.resumesInterruptedRuns, true);
  assert.equal(first.processId, undefined);
  assert.match(first.sessionFile ?? "", /^durable:\d+$/u);
  const done = settled(first);
  await first.prompt("hello durable worker");
  await done;
  assert.deepEqual(first.transcript().filter((entry) => entry.kind === "message").map((entry) => entry.kind === "message" && entry.text), ["hello durable worker", "Fixture response."]);
  // The conversation lives in the worker's store, not the gateway's.
  assert.ok(existsSync(join(remoteHome, ".local", "share", "hui-worker", "state", "durable", "harness.sqlite")));
  assert.ok(!existsSync(join(root, "gateway", "config", "hui", "durable")));

  await first.prompt("E2E_REPLAY please");
  await control("wait-replay-ready");
  workers.disconnect(workerId);
  first.dispose();
  // The answer reaches the worker's store before any gateway is back.
  const store = join(remoteHome, ".local", "share", "hui-worker", "state", "durable", "harness.sqlite");
  const stored = async () => Buffer.concat(await Promise.all([store, `${store}-wal`].map((file) => readFile(file).catch(() => Buffer.alloc(0))))).includes("replay suffix");
  assert.equal(await stored(), false);
  await control("release-replay", { method: "POST" });
  await waitFor(stored, "the worker to store the answer");
  const second = await durable.start({ cwd: project, worker: workerId, huiSessionId: "remote-durable-runtime", sessionFile: first.sessionFile! });
  try {
    assert.equal(second.sessionFile, first.sessionFile);
    const answer = await waitFor(async () => {
      if (second.isStreaming) return undefined;
      const last = second.transcript().filter((entry) => entry.kind === "message").at(-1);
      return last?.kind === "message" && last.role === "assistant" && last.text.includes("replay suffix") ? last.text : undefined;
    }, "the run finished on the worker");
    assert.equal(answer, "Replay prefix — replay suffix");
  } finally {
    second.dispose();
  }
});

test("a worker's tracked routine receipt survives disconnection and reacquires its original answer without another prompt", async () => {
  const key = "remote-tracked-routine";
  const first = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
  assert.equal(typeof first.waitForTrackedPrompt, "function");
  assert.equal(typeof first.cancelTrackedPrompt, "function");
  await first.prompt("E2E_REPLAY tracked routine", undefined, { requestId: "worker-run-1" });
  await control("wait-replay-ready");
  await first.followUp!("withdrawn queued routine", undefined, { requestId: "worker-run-2" });
  await first.cancelTrackedPrompt!("worker-run-2");
  await assert.rejects(first.waitForTrackedPrompt!("worker-run-2"), /not answered/u);
  assert.equal(first.isStreaming, true, "withdrawing its queued receipt does not abort the preceding run");
  workers.disconnect(workerId);
  first.dispose();
  await control("release-replay", { method: "POST" });
  const second = await durable.start({ cwd: project, worker: workerId, huiSessionId: key, sessionFile: first.sessionFile! });
  try {
    const result = await second.waitForTrackedPrompt!("worker-run-1");
    assert.deepEqual(result, { summary: "Replay prefix — replay suffix" });
    await waitFor(() => !second.isStreaming || undefined, "the accepted tracked run to settle");
    const before = second.transcript();
    await second.prompt("E2E_REPLAY tracked routine", undefined, { requestId: "worker-run-1" });
    assert.deepEqual(second.transcript(), before, "the same request identity is deduplicated on the worker");
    assert.equal(second.transcript().filter((entry) => entry.kind === "message" && entry.role === "user").length, 1);
  } finally {
    second.dispose();
  }
});

test("a Durable session on the worker honors HUI's settings and providers, whose keys stay on the gateway", async () => {
  const hui = join(root, "gateway", "config", "hui");
  const managedKey = "gateway-only-openai-key";
  await mkdir(join(hui, "providers"), { recursive: true });
  await writeFile(join(hui, "providers", "models.json"), JSON.stringify({ openai: { models: ["gpt-4o"] } }));
  await writeFile(join(hui, "providers", "auth.json"), JSON.stringify({ openai: { type: "api_key", key: managedKey } }));
  await writeFile(join(hui, "settings.json"), JSON.stringify({ disabledSkills: [
    { name: "gateway-skill", path: join(agentDir, "skills", "gateway-skill", "SKILL.md") },
    { name: "create-verification-skill", path: "hui:skill:create-verification-skill" },
  ] }));
  // A directory no earlier session loaded resources for.
  const cwd = join(remoteHome, "parity");
  await mkdir(cwd, { recursive: true });
  await workers.sync(workerId);
  const session = await remoteRuntime("durable").start({ cwd, worker: workerId, huiSessionId: "remote-durable-parity" });
  try {
    const { prompt, tools } = await session.inspect!();
    assert.doesNotMatch(prompt, /gateway-skill/u);
    assert.match(prompt, /package-skill/u);
    assert.doesNotMatch(prompt, /create-verification-skill/u);
    assert.match(prompt, /git-selective-staging/u);
    assert.ok(!tools.some((tool) => tool.name === "browser"), "the gateway's browser is not offered remotely");
    assert.ok((await session.listModels!()).some((model) => model.provider === "openai" && model.id === "gpt-4o"), "the HUI-managed model is available with its brokered key");
    for (const [file, text] of await remoteContents()) {
      assert.ok(!text.includes(managedKey), `${file} holds the HUI provider key`);
    }
  } finally {
    session.dispose();
    await rm(join(hui, "settings.json"), { force: true });
    await rm(join(hui, "providers"), { recursive: true, force: true });
    await workers.sync(workerId);
  }
});

test("agent shells on the worker do not inherit the host's HUI and PI directories or the secrets it holds", async () => {
  const shellEnv = async (session: Session) => {
    const done = settled(session);
    await session.prompt("E2E_PRINT_ENV");
    await done;
    const tool = session.transcript().find((entry) => entry.kind === "tool" && entry.name === "bash");
    assert.ok(tool?.kind === "tool" && tool.output?.includes("env-done"), JSON.stringify(tool));
    return tool.output!.replace("env-done", "").trim();
  };
  // Their runs need the header the host holds, so their processes hold it.
  const model = "fx-remote-key/fixture";
  const durableSession = await durable.start({ cwd: project, worker: workerId, huiSessionId: "remote-env-durable", model });
  try {
    assert.equal(await shellEnv(durableSession), "");
  } finally {
    durableSession.dispose();
  }
  const piSession = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-env-pi", model });
  try {
    // PI and its extensions read their agent directory from it, as in a local PI worker.
    assert.equal(await shellEnv(piSession), `PI_CODING_AGENT_DIR=${join(remoteHome, ".local", "share", "hui-worker", "mirror", "agent")}`);
  } finally {
    piSession.dispose();
  }
});

/** The gateway's registry row a worker session's HUI tool calls are checked against. */
async function registerRemote(id: string): Promise<void> {
  await writeRegistry([...(await readRegistry()).filter((record) => record.id !== id), { id, title: id, group: "", cwd: project, tool: "durable", worker: workerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
}

const lastAnswer = (session: Session) => {
  const last = session.transcript().filter((entry) => entry.kind === "message").at(-1);
  return last?.kind === "message" && last.role === "assistant" ? last.text : undefined;
};

/** A reattached view once its run has settled on the worker. */
async function reattach(key: string, sessionFile: string, until: (session: Session) => boolean, label: string): Promise<Session> {
  const session = await durable.start({ cwd: project, worker: workerId, huiSessionId: key, sessionFile });
  try {
    await waitFor(() => !session.isStreaming && until(session) || undefined, label);
  } catch (error) {
    session.dispose();
    throw new Error(`${(error as Error).message} ${JSON.stringify(session.transcript())}`);
  }
  return session;
}

test("a Durable session on the worker calls HUI tools on the gateway as itself, and stops on abort", async () => {
  const key = "remote-durable-tools";
  await registerRemote(key);
  const calls: string[] = [];
  registerAgentToolHandler(async ({ callerSessionId, action }) => { calls.push(`${callerSessionId}:${action}`); return { ok: true }; });
  const session = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
  try {
    const done = settled(session);
    await session.prompt("E2E_SUGGEST_TASK please");
    await done;
    assert.deepEqual(calls, [`${key}:suggest_task`, `${key}:suggest_task`]);
    assert.equal(lastAnswer(session), "I flagged two follow-ups as suggestion cards instead of doing them now.");

    const requests = async () => (await readFile(join(root, "provider.jsonl"), "utf8")).split("\n").filter((line) => line.includes("E2E_ABORT now")).length;
    const before = await requests();
    await session.prompt("E2E_ABORT now");
    await waitFor(async () => await requests() > before || undefined, "the provider to stream the answer");
    await session.abort!();
    await waitFor(() => !session.isStreaming || undefined, "the run to stop");
    assert.ok(session.transcript().some((entry) => entry.kind === "message" && entry.text === "E2E_ABORT now"));
  } finally {
    session.dispose();
  }
});

test("the gateway refuses a worker session's calls to the tools that stay on its machine, before HUI's tool handler sees them", async () => {
  // The list a bot's chat on a worker isn't offered, too. The browser is already off there (Settings mirrored to the
  // worker turn it off), so the model can't call it; terminal and watcher are still offered to an ordinary session.
  assert.deepEqual(GATEWAY_ONLY_TOOLS, ["terminal", "browser", "watcher"]);
  const key = "remote-durable-gateway-only";
  await registerRemote(key);
  const calls: string[] = [];
  registerAgentToolHandler(async ({ action }) => { calls.push(action); return { ok: true }; });
  const session = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
  try {
    const done = settled(session);
    await session.prompt(`E2E_CALL:${Buffer.from(JSON.stringify([{ name: "terminal", input: { action: "list" } }, { name: "watcher", input: { action: "list" } }])).toString("base64url")}`);
    await done;
    const answer = lastAnswer(session) ?? "";
    for (const name of ["terminal", "watcher"]) assert.ok(answer.includes(`The ${name} tool is not available to sessions on a remote worker yet.`), answer);
    assert.deepEqual(calls, [], "refused at the bridge");
  } finally {
    session.dispose();
  }
});

test("a worker session's secret request is answered on the gateway and read from a private file on the worker", async () => {
  const key = "remote-durable-secret";
  const value = "worker-only-SECRET-61";
  await registerRemote(key);
  const requests = new SecretRequests();
  const carriers: (string | undefined)[] = [];
  // As the gateway answers a worker's session: the answer goes back, the host writes the file.
  registerAgentToolHandler(async ({ callerSessionId, action, params, signal, fromWorker }) => {
    if (action !== "secret_request") return { ok: true };
    carriers.push(fromWorker);
    return requests.request(callerSessionId, params, signal);
  });
  const session = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
  try {
    const done = settled(session);
    await session.prompt("E2E_SECRET_REQUEST please");
    const question = await waitFor(() => requests.questions(key)[0], "the secret card on the gateway");
    requests.answer(key, question.id, { value });
    await done;
    assert.deepEqual(carriers, [workerId], "the request came over this worker's connection");
    assert.match(JSON.stringify(session.transcript()), new RegExp(`Secret length: ${value.length}`, "u"), "the agent's command on the worker read the file");
    assert.equal(lastAnswer(session), "I used the secret in a command without seeing it, then deleted its file.");
    assert.ok(!JSON.stringify(session.transcript()).includes(value));
    assert.ok(!(await readFile(join(root, "provider.jsonl"), "utf8")).includes(value), "the model never sees it");
    for (const [file, text] of await remoteContents()) assert.ok(!text.includes(value), `${file} holds the secret`);

    await session.prompt("E2E_SECRET_REQUEST again");
    await waitFor(() => requests.questions(key)[0], "a second card");
    await session.abort!();
    await waitFor(() => requests.questions(key).length === 0 || undefined, "Stop on the worker to cancel the card");
  } finally {
    session.dispose();
  }
});

test("losing the gateway during a HUI tool call fails that call, and the run settles on the worker", async () => {
  const key = "remote-durable-lost-tool";
  await registerRemote(key);
  let entered!: () => void;
  const inTool = new Promise<void>((resolve) => { entered = resolve; });
  // The gateway never answers: only the lost connection can end the call.
  registerAgentToolHandler(() => { entered(); return new Promise(() => undefined); });
  const first = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
  await first.prompt("E2E_SUGGEST_TASK please");
  await inTool;
  workers.disconnect(workerId);
  first.dispose();
  registerAgentToolHandler(async () => ({ ok: true }));
  const second = await reattach(key, first.sessionFile!, (session) => lastAnswer(session) !== undefined, "the run to settle");
  try {
    const tools = second.transcript().filter((entry) => entry.kind === "tool");
    assert.equal(tools.length, 2);
    for (const tool of tools) assert.ok(tool.kind === "tool" && tool.failed, JSON.stringify(tool));
    assert.equal(lastAnswer(second), "I flagged two follow-ups as suggestion cards instead of doing them now.");
  } finally {
    second.dispose();
  }
});

test("a dropped connection leaves a session reconnecting, and HUI's own reconnect catches it up", async () => {
  const { LiveSessions } = await import("./sessions/live-sessions.ts");
  const key = "remote-durable-reconnect";
  await registerRemote(key);
  const record = async () => (await readRegistry()).find((item) => item.id === key)!;
  const manager = new LiveSessions();
  // As the gateway does: sessions the loss interrupted reattach once the worker is back.
  const stop = workers.onConnected((id) => { if (id === workerId) void record().then((item) => manager.ensure(item, true)); });
  try {
    manager.ensure(await record());
    await waitFor(() => manager.status(key) === "idle" || undefined, "the session to start");
    await manager.prompt(key, "E2E_REPLAY please");
    await control("wait-replay-ready");
    // Only the connection dies, as when the network drops; the host lives on.
    const host = await hostPid();
    execFileSync("pkill", ["-KILL", "-f", `${remoteHome}/.*worker/main\\.[jt]s connect`]);
    await waitFor(() => manager.status(key) === "reconnecting" || undefined, "the session to show the reconnect");
    assert.equal(manager.blockingWorkCount, 0);
    await control("release-replay", { method: "POST" });
    // The reconnect HUI scheduled, without waiting out its backoff.
    await workers.connect(workerId);
    const answer = await waitFor(() => {
      const last = manager.transcript(key).filter((entry) => entry.kind === "message").at(-1);
      return manager.status(key) === "idle" && last?.kind === "message" && last.role === "assistant" ? last.text : undefined;
    }, "the reconnect to catch up on the run", 60_000);
    assert.equal(answer, "Replay prefix — replay suffix");
    assert.equal(await hostPid(), host);
    assert.ok(!manager.transcript(key).some((entry) => entry.kind === "error"), JSON.stringify(manager.transcript(key)));
  } finally {
    stop();
    manager.disposeAll();
  }
});

test("a session whose worker was disconnected or removed is disconnected, and no open reconnects it", async () => {
  const { LiveSessions } = await import("./sessions/live-sessions.ts");
  const key = "remote-durable-disconnected";
  await registerRemote(key);
  const manager = new LiveSessions();
  try {
    manager.ensure((await readRegistry()).find((item) => item.id === key)!);
    await waitFor(() => manager.status(key) === "idle" || undefined, "the session to start");
    // As Settings → Workers → Disconnect does.
    workers.disconnect(workerId, true);
    await waitFor(() => manager.status(key) === "disconnected" || undefined, "the session to show the disconnect");
    manager.ensure((await readRegistry()).find((item) => item.id === key)!);
    assert.equal(manager.status(key), "disconnected");
    // Nor does opening it afresh, after a gateway restart say.
    const fresh = new LiveSessions();
    try {
      fresh.ensure((await readRegistry()).find((item) => item.id === key)!);
      await waitFor(() => fresh.status(key) === "disconnected" || undefined, "a fresh open to show the disconnect");
    } finally {
      fresh.disposeAll();
    }
    assert.equal((await workers.list()).find((worker) => worker.id === workerId)?.state, "disconnected", "opening the session left the worker alone");
    const gone = { ...(await readRegistry()).find((item) => item.id === key)!, id: `${key}-gone`, worker: "removed-worker" };
    manager.ensure(gone);
    await waitFor(() => manager.status(gone.id) === "disconnected" || undefined, "a removed worker's session to show the disconnect");
  } finally {
    manager.disposeAll();
    // The user's reconnect; later tests open sessions on the worker again.
    await workers.connect(workerId);
  }
});

test("a follow-up queued before the gateway leaves runs on the worker with the credentials it brokered", async () => {
  const key = "remote-durable-follow-up";
  const first = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
  await first.prompt("E2E_REPLAY please");
  await control("wait-replay-ready");
  await first.followUp!("queued while away");
  workers.disconnect(workerId);
  first.dispose();
  // The remote has no PI login of its own: only the cached gateway key can answer.
  assert.ok(!existsSync(join(remoteHome, ".pi", "agent", "auth.json")));
  await control("release-replay", { method: "POST" });
  const second = await reattach(key, first.sessionFile!, (session) => session.transcript().some((entry) => entry.kind === "message" && entry.text === "queued while away") && lastAnswer(session) === "Fixture response.", "the follow-up to run");
  try {
    assert.deepEqual(second.transcript().filter((entry) => entry.kind === "message").map((entry) => entry.kind === "message" && entry.text),
      ["E2E_REPLAY please", "Replay prefix — replay suffix", "queued while away", "Fixture response."]);
    for (const [file, text] of await remoteContents()) assert.ok(!text.includes(KEY), `${file} holds the provider key`);
  } finally {
    second.dispose();
  }
});

test("a key and header written literally in the gateway's models.json reach the worker from memory, with the gateway or without it", async () => {
  const key = "remote-literal-models";
  const first = await durable.start({ cwd: project, worker: workerId, huiSessionId: key, model: "fx-literal/fixture" });
  const done = settled(first);
  await first.prompt("literal key with the gateway");
  await done;
  assert.equal(lastAnswer(first), "Fixture response.");
  await first.prompt("E2E_REPLAY please");
  await control("wait-replay-ready");
  await first.followUp!("literal key without the gateway");
  workers.disconnect(workerId);
  first.dispose();
  await control("release-replay", { method: "POST" });
  const log = () => readFile(join(root, "provider.jsonl"), "utf8");
  // Answered before any gateway is back: only the host's memory had the key.
  await waitFor(async () => (await log()).includes("literal key without the gateway") || undefined, "the follow-up to reach the provider");
  const second = await reattach(key, first.sessionFile!, (session) => session.transcript().some((entry) => entry.kind === "message" && entry.text === "literal key without the gateway") && lastAnswer(session) === "Fixture response.", "the follow-up to run");
  try {
    const requests = completeLines(await log()).map((line) => JSON.parse(line) as { messages: unknown; header?: string });
    for (const prompt of ["literal key with the gateway", "literal key without the gateway"]) {
      const request = requests.find((entry) => JSON.stringify(entry.messages).includes(prompt));
      assert.equal(request?.header, HEADER_SECRET, `the request for "${prompt}" carried the literal header`);
    }
    for (const [file, text] of await remoteContents()) {
      assert.ok(!text.includes(KEY) && !text.includes(HEADER_SECRET), `${file} holds a models.json secret`);
    }
  } finally {
    second.dispose();
  }
});

test("a literal header of a provider whose key resolves on the remote reaches the worker from memory, with the gateway or without it", async () => {
  const log = () => readFile(join(root, "provider.jsonl"), "utf8");
  const headerOf = async (prompt: string) => completeLines(await log()).map((line) => JSON.parse(line) as { messages: unknown; header?: string })
    .find((entry) => JSON.stringify(entry.messages).includes(prompt))?.header;
  // A PI worker gets the values from the host when it starts.
  const pi = await piRuntime.start({ cwd: project, worker: workerId, huiSessionId: "remote-header-pi", model: "fx-remote-key/fixture" });
  try {
    const done = settled(pi);
    await pi.prompt("remote key on PI");
    await done;
    assert.equal(lastAnswer(pi), "Fixture response.", JSON.stringify(pi.transcript()));
    assert.equal(await headerOf("remote key on PI"), HEADER_SECRET);
  } finally {
    pi.dispose();
  }
  const key = "remote-header-durable";
  const first = await durable.start({ cwd: project, worker: workerId, huiSessionId: key, model: "fx-remote-key/fixture" });
  const done = settled(first);
  await first.prompt("remote key with the gateway");
  await done;
  assert.equal(lastAnswer(first), "Fixture response.", JSON.stringify(first.transcript()));
  await first.prompt("E2E_REPLAY please");
  await control("wait-replay-ready");
  await first.followUp!("remote key without the gateway");
  workers.disconnect(workerId);
  first.dispose();
  await control("release-replay", { method: "POST" });
  const second = await reattach(key, first.sessionFile!, (session) => session.transcript().some((entry) => entry.kind === "message" && entry.text === "remote key without the gateway") && lastAnswer(session) === "Fixture response.", "the follow-up to run");
  try {
    assert.equal(await headerOf("remote key with the gateway"), HEADER_SECRET);
    assert.equal(await headerOf("remote key without the gateway"), HEADER_SECRET);
    for (const [file, text] of await remoteContents()) {
      assert.ok(!text.includes(KEY) && !text.includes(HEADER_SECRET), `${file} holds a models.json secret`);
    }
  } finally {
    second.dispose();
  }
});

test("the Durable conversation a rewind moves to answers to the same HUI session after a host restart", async () => {
  const key = "remote-durable-rewind";
  const session = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
  try {
    const done = settled(session);
    await session.prompt("before the rewind");
    await done;
    const before = session.sessionFile;
    await session.rewind!({ userFromEnd: 0 });
    assert.notEqual(session.sessionFile, before);
    // What a restarted host reads to know who a resumed run calls tools as.
    const saved = JSON.parse(await readFile(join(remoteHome, ".local", "share", "hui-worker", "state", "conversations.json"), "utf8")) as Record<string, string>;
    assert.equal(saved[session.sessionFile!.replace(/^durable:/u, "")], key);
  } finally {
    session.dispose();
  }
});

test("a host restarted mid-run resumes Durable work, whose HUI tool calls still reach the gateway as their session", async () => {
  const key = "remote-durable-restart";
  await registerRemote(key);
  const calls: string[] = [];
  registerAgentToolHandler(async ({ callerSessionId, action }) => { calls.push(`${callerSessionId}:${action}`); return { ok: true }; });
  // The restarted host resumes before any gateway connects: the remote's own login answers.
  await mkdir(join(remoteHome, ".pi", "agent"), { recursive: true });
  await writeFile(join(remoteHome, ".pi", "agent", "auth.json"), JSON.stringify({ fx: { type: "api_key", key: KEY } }));
  try {
    const first = await durable.start({ cwd: project, worker: workerId, huiSessionId: key });
    await first.prompt("E2E_REPLAY please");
    await control("wait-replay-ready");
    await first.followUp!("E2E_SUGGEST_TASK after the restart");
    const pidFile = join(remoteHome, ".local", "share", "hui-worker", "state", "host.pid");
    const pid = Number(await readFile(pidFile, "utf8"));
    const lost = new Promise<void>((resolve) => first.onExit!(() => resolve()));
    process.kill(pid, "SIGKILL");
    await lost;
    // Its store lock now names a live, unrelated process, as after a container restart.
    await writeFile(join(remoteHome, ".local", "share", "hui-worker", "state", "durable", "harness.lock"), String(process.pid));
    first.dispose();
    workers.disconnect(workerId);
    // Connecting starts a new host, which resumes the interrupted run on its own.
    await workers.connect(workerId);
    assert.notEqual(Number(await readFile(pidFile, "utf8")), pid);
    await control("wait-replay-ready");
    await control("release-replay", { method: "POST" });
    await waitFor(() => calls.length === 2 || undefined, "the resumed run's HUI tool calls");
    assert.deepEqual(calls, [`${key}:suggest_task`, `${key}:suggest_task`]);
    const second = await reattach(key, first.sessionFile!, (session) => lastAnswer(session) === "I flagged two follow-ups as suggestion cards instead of doing them now.", "the resumed run to finish");
    try {
      const texts = second.transcript().filter((entry) => entry.kind === "message").map((entry) => entry.kind === "message" && entry.text);
      assert.ok(texts.includes("Replay prefix — replay suffix") && texts.includes("E2E_SUGGEST_TASK after the restart"), JSON.stringify(texts));
    } finally {
      second.dispose();
    }
  } finally {
    await rm(join(remoteHome, ".pi"), { recursive: true, force: true });
  }
});
