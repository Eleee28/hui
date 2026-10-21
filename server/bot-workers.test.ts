/**
 * Bots on a remote worker end to end on one machine (HUI-18). The gateway runs
 * in this process with its routes, as in routes/bots.test.ts; the "remote" is a
 * separate home reached through `env … sh -s`, as in workers.test.ts, with this
 * checkout pre-installed as its release, so nothing is shared with the gateway
 * except what the worker protocol carries. A deterministic Anthropic-compatible
 * provider answers both, and logs what each asked.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, test, type TestContext } from "vitest";
import { fileURLToPath } from "node:url";
import { botKickoffName, type BotCatalog, type BotMemoryStatus, type BotView } from "./bots-format.ts";
import type { TranscriptEntry } from "./runtimes/types.ts";
import { GATEWAY_ONLY_TOOLS } from "./worker/gateway-tools.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "hui-bot-workers-"));
const agentDir = join(root, "gateway", "agent");
const remoteHome = join(root, "remote");
const remoteData = join(remoteHome, ".local", "share", "hui-worker");
const remoteStore = join(remoteData, "state", "durable");
const KEY = "fixture-bot-worker-key";
// The gateway's home too: nothing is read from the real user's files.
process.env["HOME"] = join(root, "gateway", "home");
process.env["XDG_CONFIG_HOME"] = join(root, "gateway", "config");
process.env["PI_CODING_AGENT_DIR"] = agentDir;
process.env["PI_OFFLINE"] = "1";
await mkdir(process.env["HOME"], { recursive: true });
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(join(remoteHome, "project"), { recursive: true });
// Asks which way to go before the message reaches the model: a question in the middle of a bot's turn.
await writeFile(join(agentDir, "extensions", "ask.ts"), `export default function (pi) {
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith("E2E_BOT_ASK")) return { action: "continue" };
    const way = await ctx.ui.select("Which way?", ["North", "South"]);
    return { action: "transform", text: "went " + way };
  });
}
`);

const log = join(root, "provider.jsonl");
const provider = spawn(process.execPath, [join(repo, "e2e", "fixtures", "pi-provider-fixture.mjs")], {
  env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: join(remoteHome, "project"), HUI_E2E_PROVIDER_LOG: log, HUI_E2E_PROVIDER_KEY: KEY },
  stdio: ["ignore", "pipe", "inherit"],
});
const [ready] = await once(provider.stdout!, "data");
const baseUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)![0];
const control = (path: string, init?: RequestInit) => fetch(`${baseUrl.replace(/\/v1$/u, "")}/control/${path}`, init);
const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fx: { baseUrl, api: "anthropic-messages", models: [model("fixture"), model("utility")] } } }));
// The key exists only in the gateway's PI login: the worker's runs and its compactor get it brokered.
await writeFile(join(agentDir, "auth.json"), JSON.stringify({ fx: { type: "api_key", key: KEY } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fx", defaultModel: "fixture" }));
await mkdir(join(root, "gateway", "config", "hui"), { recursive: true });

const { middleware } = await import("./hui.ts");
const { startBackend, stopBackend } = await import("./backend.ts");
const { workers } = await import("./workers.ts");
const { liveSessions } = await import("./sessions/live-sessions.ts");
const { readRegistry } = await import("./sessions/sessions.ts");
const { workerRelease } = await import("./worker/release.ts");
const { remoteBots } = await import("./bots/remote.ts");
const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404).end(); }));
let origin = "";
let workerId = "";

beforeAll(async () => {
  // Pre-install this checkout as the remote release (the container E2E covers the real npm install): no network.
  const release = await workerRelease();
  const dir = join(remoteData, "releases", release.id);
  for (const file of release.files) {
    await mkdir(dirname(join(dir, file.path)), { recursive: true });
    await writeFile(join(dir, file.path), file.data, { mode: file.mode });
  }
  await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, ".ready"), "");
  await startBackend();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const command = ["env", "-u", "PI_CODING_AGENT_DIR", "-u", "XDG_CONFIG_HOME", "-u", "PI_OFFLINE", `HOME=${remoteHome}`, "SHELL=/bin/sh"];
  const added = await call("/__hui/workers", "POST", { name: "devbox", command: command.map((word) => `'${word}'`).join(" ") });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  workerId = (added.body["worker"] as { id: string }).id;
  await workers.connect(workerId);
});

afterAll(async () => {
  // The backend first: its triggers' last writes settle before their directory goes.
  await stopBackend();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const exit = once(provider, "exit");
  provider.kill();
  await exit;
  // The host is durable by design; stop the one this suite started.
  try { execFileSync("pkill", ["-f", remoteHome]); } catch { /* already gone */ }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

async function call(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + path, {
    method,
    headers: { "x-hui": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

const botOf = (reply: { body: Record<string, unknown> }) => reply.body["bot"] as BotView;

async function waitFor<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type ProviderRequest = { model?: string; system?: unknown; messages?: unknown; tools?: Array<{ name?: string }> };
async function providerRequests(): Promise<ProviderRequest[]> {
  // Only the lines the provider has finished appending: one it is still writing waits for the next read.
  return (await readFile(log, "utf8")).split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as ProviderRequest);
}
const systemOf = (request: ProviderRequest | undefined) => JSON.stringify(request?.system ?? "");
const isCompactor = (request: ProviderRequest) => systemOf(request).includes("You write the memory of");
/** The chat request whose newest message holds `text` (not the compactor's). */
async function chatRequest(text: string): Promise<ProviderRequest | undefined> {
  return (await providerRequests()).find((request) => !isCompactor(request) && JSON.stringify((request.messages as unknown[] | undefined)?.at(-1) ?? "").includes(text));
}

const says = (role: "user" | "assistant", text: string) => (entries: readonly TranscriptEntry[]) =>
  entries.some((entry) => entry.kind === "message" && entry.role === role && entry.text.includes(text));
/** The chat's transcript once it is idle and `done` holds. */
const settledWith = (id: string, done: (entries: readonly TranscriptEntry[]) => boolean, label: string) =>
  waitFor(() => liveSessions.status(id) === "idle" && done(liveSessions.transcript(id)) ? liveSessions.transcript(id) : undefined, label);

/** Tool calls the fixture makes at once, in one response; its next answer quotes every result ("tool answered: …"). */
const callsOf = (calls: unknown) => `E2E_CALL:${Buffer.from(JSON.stringify(calls)).toString("base64url")}`;
/** Every gated tool at once, as `who` would have the bot call them, with the triggers tool's list. */
const gatedCalls = (who: string) => [
  { name: "set_profile", input: { title: `Retitled by ${who}` } },
  { name: "write_soul", input: { soul: `# Who I am\nRewritten by ${who}.` } },
  { name: "triggers", input: { action: "list" } },
  { name: "routines", input: { action: "add", name: `Added by ${who}`, prompt: "Look again.", every: "1h" } },
  { name: "routines", input: { action: "update", routine: "Standing", every: "2h" } },
];
/** What the tools answered in the turn of the latest message of a chat starting with `start`, once it settled. */
async function toolAnswer(sessionId: string, start: string, label: string): Promise<string> {
  const startsWith = (entry: TranscriptEntry) => entry.kind === "message" && entry.role === "user" && entry.text.startsWith(start);
  const answered = (entry: TranscriptEntry) => entry.kind === "message" && entry.role === "assistant" && entry.text.startsWith("tool answered: ");
  const entries = await settledWith(sessionId, (all) => all.some(startsWith) && all.slice(all.findLastIndex(startsWith) + 1).some(answered), label);
  const reply = entries.slice(entries.findLastIndex(startsWith) + 1).find(answered);
  return reply?.kind === "message" ? reply.text : "";
}
/** Holds an operator's turn of a bot on the worker at the provider. */
async function holdOperatorTurn(handle: string): Promise<void> {
  assert.deepEqual((await call(`/__hui/bots/${handle}/messages`, "POST", { text: "E2E_REPLAY the operator's own turn" })).body, { status: "sent" });
  await control("wait-replay-ready");
}
/** A message to a bot busy on the worker joins its run there: it waits in the worker's runtime, not in HUI's queue. */
const joining = (sessionId: string, start: string) => waitFor(() => {
  const { queue } = liveSessions.snapshot(sessionId);
  return queue.followUp.some((text) => text.startsWith(start)) && !queue.items?.length;
}, `"${start}" to wait in the worker's runtime`);

const roverProfile = async () => { const bot = botOf(await call("/__hui/bots/rover")); return [bot.name, bot.handle, bot.title]; };
const roverTrigger = async (name: string) => ((await call("/__hui/bots/rover/triggers")).body as { triggers: Array<{ name: string; filter: unknown }> }).triggers.find((each) => each.name === name);
/** A listener trigger of Rover's; the function it returns reports a new event to it, `summary` its summary. */
async function roverListener(name: string, prompt: string): Promise<(summary?: string) => Promise<void>> {
  const made = await call("/__hui/bots/rover/triggers", "POST", { name, prompt, cooldownSeconds: 0 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  let reported = 0;
  return async (summary = "something happened") => {
    reported += 1;
    const body = JSON.stringify({ events: [{ id: `${name}-${reported}`, summary }] });
    const fired = await fetch(origin + (made.body["hook"] as { path: string }).path, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.deepEqual([fired.status, await fired.json()], [202, { status: "fired" }]);
  };
}
/** An operator's routine of Rover's, for the routines tool to try to change; it and the routines named here go once the
 * test ends. */
async function standingRoutine(t: TestContext, sessionId: string, ...names: string[]): Promise<void> {
  const made = await call("/__hui/automation/tasks", "POST", { name: "Standing", sessionId, prompt: "E2E_STANDING look", schedule: { kind: "every", everyMs: 3_600_000 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  t.onTestFinished(async () => {
    const { tasks } = (await call("/__hui/automation")).body as { tasks: Array<{ id: string; name: string; sessionId: string }> };
    for (const task of tasks.filter((each) => each.sessionId === sessionId && ["Standing", ...names].includes(each.name))) {
      await call(`/__hui/automation/tasks/${task.id}`, "DELETE");
    }
  });
}
const routineOf = async (sessionId: string, name: string) => ((await call("/__hui/automation")).body as { tasks: Array<{ name: string; sessionId: string; schedule: unknown }> }).tasks.find((task) => task.sessionId === sessionId && task.name === name);
/** Once the test ends, however it went: Rover's triggers named here go, and its title and SOUL.md are as they were. */
async function restoreRoverAfter(t: TestContext, ...triggers: string[]): Promise<void> {
  const [, , title] = await roverProfile();
  const soul = (await call("/__hui/bots/rover/soul")).body["soul"];
  t.onTestFinished(async () => {
    for (const name of triggers) await call(`/__hui/bots/rover/triggers/${encodeURIComponent(name)}`, "DELETE");
    await call("/__hui/bots/rover", "PATCH", { title: title ?? "" });
    await call("/__hui/bots/rover/soul", "PUT", { soul });
  });
}

async function memoryOf(handle: string): Promise<{ status: BotMemoryStatus; view: string }> {
  const reply = await call(`/__hui/bots/${handle}/memory`);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body as { status: BotMemoryStatus; view: string };
}

const EMPTY_MEMORY = { messages: 0, built: 0, pending: 0, viewBytes: 0, viewLines: 0, usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };

test("a bot made on the worker keeps its conversation and memory there, answers there with the bots section, and summarizes with its utility model", { timeout: 180_000 }, async () => {
  // With a soul of its own: no first conversation, so this chat's exchanges are only the ones below.
  const created = await call("/__hui/bots", "POST", { name: "Rover", title: "Explorer", worker: "devbox", memoryModel: "fx/utility", soul: "# Who I am\nROVER_SOUL: I map ridges." });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rover = botOf(created);
  assert.deepEqual([rover.worker, rover.soul], [{ id: workerId, name: "devbox" }, true]);
  assert.equal(rover.cwd, join(remoteData, "bots", rover.id), "its home: a private folder under HUI's data directory on the worker");
  assert.equal(await readFile(join(rover.cwd, "SOUL.md"), "utf8"), "# Who I am\nROVER_SOUL: I map ridges.\n", "its SOUL.md in that home");
  assert.ok(!existsSync(join(root, "gateway", "config", "hui", "bots", rover.id)), "and nothing of it here");
  const record = (await readRegistry()).find((entry) => entry.id === rover.sessionId)!;
  assert.deepEqual([record.worker, record.tool, record.bot], [workerId, "durable", rover.id], "its chat is a Durable session on the worker");
  const conversation = record.piSessionFile!.replace(/^durable:/u, "");
  // The conversation and its OptChat memory are in the worker's store: the gateway's store never held them.
  assert.ok(existsSync(join(remoteStore, "harness.sqlite")));
  assert.deepEqual(await memoryOf("rover"), { status: EMPTY_MEMORY, view: "<chat>\n\n</chat>" }, "OptChat is on from the creating commit");
  assert.ok((await readdir(join(remoteStore, "optchat"))).includes(conversation), "its memory's files are on the worker");
  assert.ok(!existsSync(join(root, "gateway", "config", "hui", "durable", "optchat", conversation)));
  const sessions = (await call("/__hui/sessions")).body["groups"] as Array<{ sessions: Array<{ id: string; displayCwd: string; worker?: unknown }> }>;
  const chat = sessions.flatMap((group) => group.sessions).find((session) => session.id === rover.sessionId);
  assert.deepEqual([chat?.worker, chat?.displayCwd], [{ id: workerId, name: "devbox" }, `devbox:${rover.cwd}`]);

  // Over 512 bytes, so the compactor writes a line for it.
  const answered = await call("/__hui/bots/rover/messages", "POST", { text: `hello from the gateway: OPT_ROVER ${"the north ridge is mapped at dawn ".repeat(20).trim()}`, wait: true, timeoutSeconds: 120 });
  assert.deepEqual([answered.status, answered.body], [200, { status: "answered", reply: "Fixture response." }]);
  // The worker's host asked this gateway for the bots section, so the chat on the worker knows who it is.
  const request = await chatRequest("hello from the gateway");
  assert.match(systemOf(request), /You are @rover \(Rover\), one of the bots of this HUI\./u);
  // Its soul section, read from its home on the worker.
  assert.ok(systemOf(request).includes(JSON.stringify(`<soul>\nYour soul is ${join(rover.cwd, "SOUL.md")}`).slice(1, -1)));
  assert.match(systemOf(request), /ROVER_SOUL: I map ridges\./u);
  assert.doesNotMatch(systemOf(request), /You have no soul yet/u);
  assert.equal(request?.model, "fixture");
  // OptChat summarizes beside the chat on the worker, with the bot's utility model.
  const status = await waitFor(async () => {
    const memory = await memoryOf("rover");
    return memory.status.messages === 2 && memory.status.pending === 0 ? memory : undefined;
  }, "the worker's memory to log the exchange");
  assert.match(status.view, /FIXTURE_MEMORY OPT_ROVER/u, "the compactor's line for the long message");
  const compactor = (await providerRequests()).filter(isCompactor);
  assert.ok(compactor.length > 0, "the compactor ran");
  assert.deepEqual([...new Set(compactor.map((entry) => entry.model))], ["utility"], "always on the bot's utility model");
  const view = botOf(await call("/__hui/bots/rover"));
  assert.equal(view.memory?.messages, 2, "the list's memory comes from what the worker reports");
  assert.equal(view.lastMessage?.text, "Fixture response.");
});

test("a bot on the worker without a utility model of its own summarizes with the Settings' one, mirrored there", { timeout: 180_000 }, async () => {
  // Settings' utility model reaches the worker with the mirrored settings.
  await writeFile(join(root, "gateway", "config", "hui", "settings.json"), JSON.stringify({ models: { utility: "fx/utility" } }));
  await workers.sync(workerId);
  const sparrow = botOf(await call("/__hui/bots", "POST", { name: "Sparrow", worker: "devbox", soul: "# Who I am\nSparrow." }));
  assert.equal(sparrow.memoryModel, undefined, "no utility model of its own");
  const text = `OPT_SPARROW ${"the south valley floods every spring ".repeat(20).trim()}`;
  assert.deepEqual((await call("/__hui/bots/sparrow/messages", "POST", { text, wait: true, timeoutSeconds: 120 })).body, { status: "answered", reply: "Fixture response." });
  await waitFor(async () => {
    const memory = await memoryOf("sparrow");
    return memory.status.messages === 2 && memory.status.pending === 0 ? memory : undefined;
  }, "the worker's memory to summarize the message");
  const compactor = (await providerRequests()).filter((request) => isCompactor(request) && JSON.stringify(request.messages).includes("OPT_SPARROW"));
  assert.ok(compactor.length > 0, "the compactor summarized it on the worker");
  assert.deepEqual([...new Set(compactor.map((request) => request.model))], ["utility"], "Settings' utility model, not the chat's own");
  assert.equal((await chatRequest("OPT_SPARROW"))?.model, "fixture", "the chat itself stays on its model");
});

test("message_bot crosses both ways between a bot here and the bot on the worker", { timeout: 180_000 }, async () => {
  const home = botOf(await call("/__hui/bots", "POST", { name: "Home", soul: "# Who I am\nHome." }));
  assert.equal(home.worker, undefined);
  const rover = botOf(await call("/__hui/bots/rover"));
  // From the worker: its host calls message_bot on this gateway as the bot's session.
  const out = await call("/__hui/bots/rover/messages", "POST", { text: "E2E_MESSAGE_BOT @home", wait: true, timeoutSeconds: 120 });
  assert.deepEqual(out.body, { status: "answered", reply: "message_bot answered: Queued for @home." });
  await settledWith(home.sessionId, (entries) => says("user", "[from @rover] hello from the fixture")(entries) && says("assistant", "Fixture response.")(entries), "Home to answer Rover");
  // And to the worker: the bot here reaches the chat that runs there.
  const back = await call("/__hui/bots/home/messages", "POST", { text: "E2E_MESSAGE_BOT @rover", wait: true, timeoutSeconds: 120 });
  assert.deepEqual(back.body, { status: "answered", reply: "message_bot answered: Queued for @rover." });
  await settledWith(rover.sessionId, (entries) => says("user", "[from @home] hello from the fixture")(entries), "Rover to get Home's message");
  await waitFor(async () => await chatRequest("[from @home] hello from the fixture"), "Rover's run on the worker");
  assert.match(systemOf(await chatRequest("[from @home] hello from the fixture")), /- @home \(Home\)/u, "its roster on the worker lists the bot here");
});

test("sessions and bots exchange attributed handoffs and agent replies across the worker connection", { timeout: 180_000 }, async () => {
  const home = botOf(await call("/__hui/bots/home"));
  const created = await call("/__hui/sessions", "POST", { cwd: join(remoteHome, "project"), worker: workerId, tool: "durable", title: "Survey the ridge" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const session = created.body["session"] as { id: string };
  // Its runtime starts on the worker before it takes a prompt.
  await waitFor(() => liveSessions.status(session.id) === "idle", "the session on the worker to start");
  const prompted = await call(`/__hui/sessions/${session.id}/prompt`, "POST", { text: "E2E_MESSAGE_BOT @home SURVEY_TAG" });
  assert.equal(prompted.status, 200, JSON.stringify(prompted.body));
  await settledWith(session.id, says("assistant", "message_bot answered: Queued for @home."), "the session's tag to be accepted");
  await settledWith(home.sessionId, says("user", `[from agent: Survey the ridge · reply-to agent:${session.id}] hello from the fixture`), "Home to get the session's tag");
  // Its host asked this gateway for the list, as a bot there does, and offered message_bot alone.
  const request = await chatRequest("SURVEY_TAG");
  assert.match(systemOf(request), /This HUI has bots: persistent assistants/u);
  assert.match(systemOf(request), /- @home \(Home\)/u);
  assert.doesNotMatch(systemOf(request), /You are @/u, "not a bot's chat");
  assert.deepEqual(request?.tools?.filter((tool) => ["message_bot", "write_soul", "set_profile"].includes(tool.name ?? "")).map((tool) => tool.name), ["message_bot"]);
  const reply = (id: string, message: string) => callsOf({ name: "message_bot", input: { to: `agent:${id}`, message } });
  await call("/__hui/bots/home/messages", "POST", { text: reply(session.id, "Decide how to address the ridge review."), wait: true, timeoutSeconds: 120 });
  await settledWith(session.id, says("user", "[from @home] Decide how to address the ridge review."), "the originating agent on the worker to receive Home's decision request");

  // The reverse direction also needs the worker bot's received-message history available at the gateway.
  const rover = botOf(await call("/__hui/bots/rover"));
  const local = await call("/__hui/sessions", "POST", { cwd: root, tool: "durable", title: "Survey the valley" });
  assert.equal(local.status, 200, JSON.stringify(local.body));
  const localId = (local.body["session"] as { id: string }).id;
  await waitFor(() => liveSessions.status(localId) === "idle", "the local agent to start");
  await call(`/__hui/sessions/${localId}/prompt`, "POST", { text: "E2E_MESSAGE_BOT @rover VALLEY_TAG" });
  await settledWith(rover.sessionId, says("user", `[from agent: Survey the valley · reply-to agent:${localId}] hello from the fixture`), "Rover on the worker to receive the local agent's handoff");
  await call("/__hui/bots/rover/messages", "POST", { text: reply(localId, "Decide how to address the valley review."), wait: true, timeoutSeconds: 120 });
  await settledWith(localId, says("user", "[from @rover] Decide how to address the valley review."), "the originating local agent to receive Rover's decision request");
  await call(`/__hui/sessions/${localId}`, "DELETE");
  await call(`/__hui/sessions/${session.id}`, "DELETE");
});

test("a bot on the worker schedules its own temporary routine: its routines tool crosses to this gateway as the bot's session, and that routine's turn there removes it", { timeout: 180_000 }, async () => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const added = await call("/__hui/bots/rover/messages", "POST", { text: "E2E_ROUTINE_ADD watch PR #82", wait: true, timeoutSeconds: 120 });
  assert.match(String(added.body["reply"]), /^routines answered: Added the routine "Watch #82" \(id [\w-]+\): every 5m, first run \S+; until \S+, 3 runs left, then HUI deletes it\./u, JSON.stringify(added.body));
  const tasks = async () => (await call("/__hui/automation")).body["tasks"] as Array<{ id: string; name: string; sessionId: string; createdBy?: unknown; runsLeft?: number }>;
  const watch = (await tasks()).find((task) => task.name === "Watch #82")!;
  assert.deepEqual([watch.sessionId, watch.createdBy, watch.runsLeft], [rover.sessionId, { kind: "bot", botId: rover.id, handle: "rover" }, 3], "on this gateway's scheduler, made by the bot on the worker");
  assert.equal((await call(`/__hui/automation/tasks/${watch.id}/run`, "POST", {})).status, 202);
  // The routine's turn runs on the worker; this gateway's record of it says a routine started it, so it may remove itself.
  await settledWith(rover.sessionId, says("assistant", "routines answered: Removed the routine \"Watch #82\": this turn is its last."), "the routine's turn on the worker to remove it");
  assert.equal((await tasks()).some((task) => task.id === watch.id), false);
  assert.equal(botOf(await call("/__hui/bots/rover")).routines, 0);
});

test("a bot made on the worker without a soul speaks first there, writes SOUL.md in its home there, names itself only when the operator says, and its delete takes that home", { timeout: 240_000 }, async () => {
  // Grok-style: no name, no soul. HUI starts its first turn through the remote session, like any message.
  const created = await call("/__hui/bots", "POST", { worker: "devbox" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const fresh = botOf(created);
  assert.deepEqual([fresh.name, fresh.handle, fresh.soul, fresh.worker?.name], ["New Bot", "new-bot", false, "devbox"]);
  const home = join(remoteData, "bots", fresh.id);
  const soulPath = join(home, "SOUL.md");
  assert.equal(fresh.cwd, home);
  // The fixture asks for a name only when the prompt says the bot has none, as a model told so would.
  const opened = await settledWith(fresh.sessionId, says("assistant", "What would you like to call me?"), "its opener, from the worker");
  const users = opened.filter((entry) => entry.kind === "message" && entry.role === "user");
  assert.deepEqual(users.map((entry) => entry.kind === "message" ? botKickoffName(entry.text) : undefined), ["New Bot"], "nobody typed anything: HUI's kickoff");
  const kickoff = (await providerRequests()).find((request) => !isCompactor(request) && JSON.stringify(request.messages).includes("[HUI bot created]\\nname: New Bot\\n"));
  assert.ok(kickoff, "the kickoff reached the model from the worker");
  assert.ok(systemOf(kickoff).includes(JSON.stringify(`<soul>\nYou have no soul yet: ${soulPath} does not exist.`).slice(1, -1)), "its first conversation, with SOUL.md's place in its home on the worker");
  assert.match(systemOf(kickoff), /You have no name yet/u, "the worker's host knows it is still New Bot");
  assert.equal(botOf(await call(`/__hui/bots/${fresh.id}`)).lastMessage?.text, "Hi, I'm new here and I don't have a name yet. What would you like to call me?", "the list previews the opener, not the kickoff");
  assert.deepEqual((await call(`/__hui/bots/${fresh.id}/soul`)).body, { soul: null });

  // set_profile crosses to this gateway as the bot's session, whose record holds the turn's origin: a routine's turn
  // is refused, the operator's renames it.
  const task = (await call("/__hui/automation/tasks", "POST", { name: "Rename", sessionId: fresh.sessionId, prompt: "E2E_SET_PROFILE call yourself Echo", schedule: { kind: "every", everyMs: 3_600_000 } })).body["task"] as { id: string };
  assert.equal((await call(`/__hui/automation/tasks/${task.id}/run`, "POST", {})).status, 202);
  await settledWith(fresh.sessionId, says("assistant", "Only the operator changes your name, title or look"), "the routine's set_profile to be refused");
  assert.equal(botOf(await call(`/__hui/bots/${fresh.id}`)).name, "New Bot");
  const named = await call(`/__hui/bots/${fresh.id}/messages`, "POST", { text: "E2E_SET_PROFILE call yourself Echo", wait: true, timeoutSeconds: 120 });
  assert.deepEqual(named.body, { status: "answered", reply: "set_profile answered: Saved: you are Echo (@echo), Fixture tester. Tell the operator." });

  // write_soul runs on the worker: SOUL.md lands in the bot's home there, and nothing of it on this machine.
  const wrote = await call("/__hui/bots/echo/messages", "POST", { text: "E2E_WRITE_SOUL keep the trail notes", wait: true, timeoutSeconds: 120 });
  assert.deepEqual(wrote.body, { status: "answered", reply: "I wrote my SOUL.md. To change it, just tell me." });
  assert.equal(await readFile(soulPath, "utf8"), "# Who I am\nE2E_SOUL_TEXT: a terse fixture bot.\n");
  assert.ok(!existsSync(join(root, "gateway", "config", "hui", "bots", fresh.id)));
  assert.deepEqual((await call("/__hui/bots/echo/soul")).body, { soul: "# Who I am\nE2E_SOUL_TEXT: a terse fixture bot." }, "the soul route reads it from the worker");
  await waitFor(async () => botOf(await call("/__hui/bots/echo")).soul || undefined, "the list to see it, read on the worker in the background");
  // The operator's edit is written there too, and the next request there reads it.
  assert.deepEqual((await call("/__hui/bots/echo/soul", "PUT", { soul: "# Who I am\r\nOPERATOR_SOUL on devbox.\n" })).body, { soul: "# Who I am\nOPERATOR_SOUL on devbox." });
  assert.equal(await readFile(soulPath, "utf8"), "# Who I am\nOPERATOR_SOUL on devbox.\n");
  await call("/__hui/bots/echo/messages", "POST", { text: "SOUL_AFTER_PUT_REMOTE", wait: true, timeoutSeconds: 120 });
  const next = systemOf(await chatRequest("SOUL_AFTER_PUT_REMOTE"));
  assert.match(next, /OPERATOR_SOUL on devbox\./u);
  assert.match(next, /You are @echo \(Echo\)/u);
  assert.doesNotMatch(next, /You have no (soul|name) yet/u);

  // Deleting it, active, takes its whole home on the worker (SOUL.md and every file in it) and its memory there.
  await writeFile(join(home, "trail-notes.md"), "north ridge: safe path down the east gully");
  const conversation = (await readRegistry()).find((entry) => entry.id === fresh.sessionId)!.piSessionFile!.replace(/^durable:/u, "");
  assert.ok(existsSync(join(remoteStore, "optchat", conversation)));
  const deleted = await call(`/__hui/bots/${fresh.id}?permanent=1`, "DELETE");
  assert.deepEqual([deleted.status, deleted.body], [200, { ok: true }]);
  assert.equal(existsSync(home), false, "its home on the worker, with everything in it");
  assert.equal(existsSync(join(remoteStore, "optchat", conversation)), false, "its memory, deleted on the worker");
  assert.equal((await call("/__hui/bots/echo")).status, 404);
});

test("a routine, a queued message, steering, a question and Stop all reach the bot on the worker", { timeout: 240_000 }, async () => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const created = await call("/__hui/automation/tasks", "POST", { name: "Survey", sessionId: rover.sessionId, prompt: "map the ridge", schedule: { kind: "every", everyMs: 3_600_000 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const task = created.body["task"] as { id: string };
  assert.equal(botOf(await call("/__hui/bots/rover")).routines, 1);
  assert.equal((await call(`/__hui/automation/tasks/${task.id}/run`, "POST", {})).status, 202);
  await settledWith(rover.sessionId, (entries) => {
    const index = entries.findIndex((entry) => entry.kind === "message" && entry.role === "user" && entry.text === "[routine: Survey] map the ridge");
    return index >= 0 && entries.slice(index + 1).some((entry) => entry.kind === "message" && entry.role === "assistant");
  }, "the routine's turn on the worker");

  // A held turn: a message queues behind it, and steering joins it.
  assert.deepEqual((await call("/__hui/bots/rover/messages", "POST", { text: "E2E_REPLAY please" })).body, { status: "sent" });
  await control("wait-replay-ready");
  assert.deepEqual((await call("/__hui/bots/rover/messages", "POST", { text: "queued behind the replay" })).body, { status: "queued" });
  assert.equal((await call(`/__hui/sessions/${rover.sessionId}/steer`, "POST", { text: "steer toward the ridge" })).status, 200);
  await control("release-replay", { method: "POST" });
  await settledWith(rover.sessionId, (entries) => says("user", "queued behind the replay")(entries) && says("user", "steer toward the ridge")(entries)
    && entries.findLastIndex((entry) => entry.kind === "message" && entry.role === "assistant") > entries.findIndex((entry) => entry.kind === "message" && entry.text === "queued behind the replay"),
  "the queued message's turn");

  // A question asked in the middle of a turn on the worker comes back to the waiting caller; the answer goes there.
  const asked = await call("/__hui/bots/rover/messages", "POST", { text: "E2E_BOT_ASK which way", wait: true, timeoutSeconds: 120 });
  assert.equal(asked.body["status"], "needs-input", JSON.stringify(asked.body));
  const [question] = asked.body["questions"] as Array<{ id: string; title: string; options?: string[] }>;
  assert.deepEqual([question?.title, question?.options], ["Which way?", ["North", "South"]]);
  assert.equal((await call(`/__hui/sessions/${rover.sessionId}/question`, "POST", { id: question!.id, value: "North" })).status, 200);
  await settledWith(rover.sessionId, says("user", "went North"), "the answered turn");

  // Stop ends a turn that runs on the worker.
  const before = (await providerRequests()).length;
  assert.deepEqual((await call("/__hui/bots/rover/messages", "POST", { text: "E2E_ABORT now" })).body, { status: "sent" });
  await waitFor(async () => (await providerRequests()).slice(before).some((entry) => JSON.stringify(entry.messages).includes("E2E_ABORT now")) || undefined, "the turn to reach the provider");
  assert.equal((await call("/__hui/bots/rover/stop", "POST", {})).status, 200);
  await waitFor(() => liveSessions.status(rover.sessionId) === "idle" || undefined, "the turn to stop");
});

test("a trigger wakes the bot on the worker through its remote session, and its triggers tool reaches the gateway from there", { timeout: 180_000 }, async () => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const report = await roverListener("Ridge hook", "E2E_WORKER_TRIGGER look");
  await report("rockfall on the ridge");
  // The listener reports to the gateway; the delivery runs on the worker, as any message to the bot.
  await settledWith(rover.sessionId, (entries) => {
    const index = entries.findIndex((entry) => entry.kind === "message" && entry.role === "user" && entry.text.startsWith("[trigger: Ridge hook · rockfall on the ridge] E2E_WORKER_TRIGGER look"));
    return index >= 0 && entries.slice(index + 1).some((entry) => entry.kind === "message" && entry.role === "assistant");
  }, "the trigger's turn on the worker");
  assert.ok(await chatRequest("E2E_WORKER_TRIGGER look"), "the worker's run asked the provider");
  const reply = await call("/__hui/bots/rover/messages", "POST", { text: callsOf({ name: "triggers", input: { action: "list" } }), wait: true, timeoutSeconds: 120 });
  assert.match(String(reply.body["reply"]), /^tool answered: You have 1 trigger:\n- Ridge hook \([0-9a-f]{8}\) · Listener · Any event · cooldown none · on · last fired /u, JSON.stringify(reply.body));
});

test("on the worker too, write_soul refuses a turn that a routine, a trigger or another bot started, and a trigger that joins the operator's running turn there; the operator's own turn writes", { timeout: 240_000 }, async () => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const soulPath = join(rover.cwd, "SOUL.md");
  const before = await readFile(soulPath, "utf8");
  const writeSoul = (soul: string) => `E2E_CALL:${Buffer.from(JSON.stringify({ name: "write_soul", input: { soul } })).toString("base64url")}`;
  const refused = "tool answered: Only the operator changes your soul, and this turn was started by a routine, a trigger, another bot, a session or your import. Ask the operator instead.";
  const startsWith = (start: string) => (entry: TranscriptEntry) => entry.kind === "message" && entry.role === "user" && entry.text.startsWith(start);
  const toolAnswer = (entry: TranscriptEntry) => entry.kind === "message" && entry.role === "assistant" && entry.text.startsWith("tool answered: ");
  /** What write_soul told Rover in the turn of the latest message starting with `start`, once that turn on the worker
   * settled. */
  const answerTo = async (start: string, label: string) => {
    const entries = await settledWith(rover.sessionId, (all) => all.some(startsWith(start)) && all.slice(all.findLastIndex(startsWith(start)) + 1).some(toolAnswer), label);
    const reply = entries.slice(entries.findLastIndex(startsWith(start)) + 1).find(toolAnswer);
    return reply?.kind === "message" ? reply.text : undefined;
  };

  // A routine's turn.
  const made = await call("/__hui/automation/tasks", "POST", { name: "Soul routine", sessionId: rover.sessionId, prompt: writeSoul("# Who I am\nRewritten by a routine."), schedule: { kind: "every", everyMs: 3_600_000 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const task = made.body["task"] as { id: string };
  assert.equal((await call(`/__hui/automation/tasks/${task.id}/run`, "POST", {})).status, 202);
  assert.equal(await answerTo("[routine: Soul routine] ", "the routine's turn on the worker"), refused);
  // Its run ends just after the turn that answered it; then the routine goes.
  await waitFor(async () => {
    const automation = (await call("/__hui/automation")).body as { scheduler: { activeRuns: number }; runs: Array<{ taskId: string; finishedAt?: string }> };
    return automation.scheduler.activeRuns === 0 && automation.runs.some((run) => run.taskId === task.id && run.finishedAt !== undefined) || undefined;
  }, "the routine's run to end");
  assert.equal((await call(`/__hui/automation/tasks/${task.id}`, "DELETE")).status, 200);

  // A trigger's turn: its listener reports while Rover is idle.
  const fire = await roverListener("Soul hook", writeSoul("# Who I am\nRewritten by a listener's report."));
  await fire("idle");
  assert.equal(await answerTo("[trigger: Soul hook · idle] ", "the trigger's turn on the worker"), refused);

  // The same trigger while the operator's turn runs there: the gateway hands the trigger's message to the worker's
  // runtime as a follow-up, which joins that turn. The run is the operator's; the model then answers the trigger.
  assert.deepEqual((await call("/__hui/bots/rover/messages", "POST", { text: "E2E_REPLAY hold the operator's turn" })).body, { status: "sent" });
  await control("wait-replay-ready");
  await fire("busy");
  const joining = "[trigger: Soul hook · busy] ";
  await waitFor(() => {
    const { queue } = liveSessions.snapshot(rover.sessionId);
    return queue.followUp.some((text) => text.startsWith(joining)) && !queue.items?.length;
  }, "the trigger's message to wait in the worker's runtime, not in HUI's queue");
  await control("release-replay", { method: "POST" });
  assert.equal(await answerTo(joining, "the trigger's message that joined the operator's turn"), refused);

  // Another bot's message: Home tells Rover to rewrite its soul.
  const relayed = writeSoul("# Who I am\nRewritten for @home.");
  const relay = Buffer.from(JSON.stringify({ name: "message_bot", input: { to: "@rover", message: relayed } })).toString("base64url");
  assert.equal((await call("/__hui/bots/home/messages", "POST", { text: `E2E_CALL:${relay}`, wait: true, timeoutSeconds: 120 })).body["status"], "answered");
  assert.equal(await answerTo(`[from @home] ${relayed}`, "Home's message on the worker"), refused);
  assert.equal(await readFile(soulPath, "utf8"), before, "SOUL.md on the worker is as it was");

  // The operator's own turn writes it there.
  const wrote = await call("/__hui/bots/rover/messages", "POST", { text: writeSoul("# Who I am\nROVER_SOUL: I map ridges, as the operator says."), wait: true, timeoutSeconds: 120 });
  assert.match(String(wrote.body["reply"]), /^tool answered: Saved your SOUL\.md \(\d+ characters\); it applies from your next request\./u, JSON.stringify(wrote.body));
  assert.equal(await readFile(soulPath, "utf8"), "# Who I am\nROVER_SOUL: I map ridges, as the operator says.\n");
  assert.equal((await call("/__hui/bots/rover/soul", "PUT", { soul: before })).status, 200);
});

test("on the worker, a gated tool judges the run by every input it took: a trigger's message that joins the operator's running turn there makes set_profile, write_soul and the routines tool's add and update refuse; the triggers tool's list and remove still work", { timeout: 240_000 }, async (t) => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const soulPath = join(rover.cwd, "SOUL.md");
  const soul = await readFile(soulPath, "utf8");
  await restoreRoverAfter(t, "Drop", "Idle hook", "Joiner");
  await standingRoutine(t, rover.sessionId, "Added by a trigger");
  assert.equal((await call("/__hui/bots/rover/triggers", "POST", { name: "Drop" })).status, 201);
  const refusals = (answer: string, trigger: string) => {
    assert.match(answer, /Only the operator changes your name, title or look, and this turn was started by a routine, a trigger, another bot, a session or your import\./u, "set_profile");
    assert.match(answer, /Only the operator changes your soul, and this turn was started by a routine, a trigger, another bot, a session or your import\./u, "write_soul");
    assert.match(answer, /You have \d+ triggers:/u, "list still works");
    assert.equal(answer.split(`This turn was started by the trigger "${trigger}", whose event comes from outside HUI: it can't make you add or change routines.`).length, 3, "the routines tool's add and update");
  };

  // A trigger's own turn, while Rover is idle, is refused as it always was.
  const idle = await roverListener("Idle hook", callsOf(gatedCalls("a trigger")));
  await idle();
  refusals(await toolAnswer(rover.sessionId, "[trigger: Idle hook · ", "the idle trigger's turn"), "Idle hook");

  // While the operator's turn runs on the worker, a trigger's message joins it there: the gateway's record still names the
  // operator's message as the run's, but the host saw the trigger's come in, and every gated tool refuses.
  const joiner = await roverListener("Joiner", callsOf([...gatedCalls("a trigger"), { name: "triggers", input: { action: "remove", trigger: "Drop" } }]));
  await holdOperatorTurn("rover");
  await joiner();
  await joining(rover.sessionId, "[trigger: Joiner · ");
  await control("release-replay", { method: "POST" });
  const answer = await toolAnswer(rover.sessionId, "[trigger: Joiner · ", "the trigger's message that joined the operator's turn");
  refusals(answer, "Joiner");
  assert.match(answer, /Removed the trigger "Drop"\./u, "removing still works");
  assert.deepEqual(await roverProfile(), [rover.name, rover.handle, rover.title], "Rover's name and title are as they were");
  assert.equal(await readFile(soulPath, "utf8"), soul, "and its SOUL.md on the worker");
  assert.equal(await roverTrigger("Drop"), undefined);
  assert.equal(await routineOf(rover.sessionId, "Added by a trigger"), undefined);
  assert.deepEqual((await routineOf(rover.sessionId, "Standing"))?.schedule, { kind: "every", everyMs: 3_600_000 });
});

test("on the worker too, another bot's message that joins the operator's turn makes every gated tool refuse, and a routine's, which may add and change routines, neither retitles the bot nor rewrites its soul", { timeout: 240_000 }, async (t) => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const soulPath = join(rover.cwd, "SOUL.md");
  const soul = await readFile(soulPath, "utf8");
  await restoreRoverAfter(t);
  await standingRoutine(t, rover.sessionId, "Added by @home", "Added by a routine");

  // Home, the bot on this machine, tells Rover to change itself while the operator's turn runs there.
  await holdOperatorTurn("rover");
  const relay = { name: "message_bot", input: { to: "@rover", message: callsOf(gatedCalls("@home")) } };
  assert.equal((await call("/__hui/bots/home/messages", "POST", { text: callsOf(relay), wait: true, timeoutSeconds: 120 })).body["status"], "answered");
  await joining(rover.sessionId, "[from @home] ");
  await control("release-replay", { method: "POST" });
  const relayed = await toolAnswer(rover.sessionId, "[from @home] ", "Home's message that joined the operator's turn");
  assert.match(relayed, /Only the operator changes your name, title or look/u);
  assert.match(relayed, /Only the operator changes your soul/u);
  assert.match(relayed, /You have \d+ triggers?:/u);
  assert.equal(relayed.split("This turn answers a message from @home: another bot can't make you add or change routines.").length, 3);
  assert.equal(await routineOf(rover.sessionId, "Added by @home"), undefined);

  // A routine's message joins it the same way.
  const task = (await call("/__hui/automation/tasks", "POST", { name: "Survey again", sessionId: rover.sessionId, prompt: callsOf(gatedCalls("a routine")), schedule: { kind: "every", everyMs: 3_600_000 } })).body["task"] as { id: string };
  t.onTestFinished(async () => {
    await waitFor(async () => ((await call("/__hui/automation")).body as { runs: Array<{ taskId: string; finishedAt?: string }> }).runs.every((run) => run.taskId !== task.id || run.finishedAt !== undefined) || undefined, "the routine's run to end");
    await call(`/__hui/automation/tasks/${task.id}`, "DELETE");
  });
  await holdOperatorTurn("rover");
  assert.equal((await call(`/__hui/automation/tasks/${task.id}/run`, "POST", {})).status, 202);
  await joining(rover.sessionId, "[routine: Survey again] ");
  await control("release-replay", { method: "POST" });
  const routine = await toolAnswer(rover.sessionId, "[routine: Survey again] ", "the routine's message that joined the operator's turn");
  assert.match(routine, /Only the operator changes your name, title or look/u, "a routine can't retitle it");
  assert.match(routine, /Only the operator changes your soul/u, "nor rewrite its soul");
  assert.match(routine, /Added the routine "Added by a routine"/u, "the routines tool takes a routine's turn");
  assert.match(routine, /Updated the routine "Standing"/u);
  assert.deepEqual(await roverProfile(), [rover.name, rover.handle, rover.title]);
  assert.equal(await readFile(soulPath, "utf8"), soul);
});

test("on the worker, a run stays tainted to its end: the operator's message after a trigger's in the same run is refused too; an operator-only run is allowed, and so is the operator's next run", { timeout: 240_000 }, async (t) => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const soulPath = join(rover.cwd, "SOUL.md");
  const soul = await readFile(soulPath, "utf8");
  await restoreRoverAfter(t, "Ping");
  await standingRoutine(t, rover.sessionId, "Tainted", "Clean");
  const ping = await roverListener("Ping", "E2E_PING look around");
  const mine = (title: string) => callsOf([
    { name: "set_profile", input: { title } },
    { name: "write_soul", input: { soul: `# Who I am\n${title}.` } },
    { name: "routines", input: { action: "add", name: title, prompt: "Look again.", every: "1h" } },
  ]);

  // The operator, then a trigger, then the operator again, all in one run there.
  await holdOperatorTurn("rover");
  await ping();
  await joining(rover.sessionId, "[trigger: Ping · ");
  assert.deepEqual((await call("/__hui/bots/rover/messages", "POST", { text: mine("Tainted") })).body, { status: "queued" });
  await control("release-replay", { method: "POST" });
  const tainted = await toolAnswer(rover.sessionId, mine("Tainted"), "the operator's message after the trigger's");
  assert.match(tainted, /Only the operator changes your name, title or look/u);
  assert.match(tainted, /Only the operator changes your soul/u);
  assert.deepEqual(await roverProfile(), [rover.name, rover.handle, rover.title]);
  assert.equal(await readFile(soulPath, "utf8"), soul);
  assert.match(tainted, /This turn was started by the trigger "Ping", whose event comes from outside HUI: it can't make you add or change routines\./u);
  assert.equal(await routineOf(rover.sessionId, "Tainted"), undefined);

  // That run ended: the operator's next one, with a message of theirs joining it, may.
  await holdOperatorTurn("rover");
  assert.deepEqual((await call("/__hui/bots/rover/messages", "POST", { text: mine("Clean") })).body, { status: "queued" });
  await control("release-replay", { method: "POST" });
  const clean = await toolAnswer(rover.sessionId, mine("Clean"), "the operator's own run");
  assert.match(clean, /Saved: you are Rover \(@rover\), Clean\./u, clean);
  assert.match(clean, /Saved your SOUL\.md/u);
  assert.match(clean, /Added the routine "Clean"/u);
  assert.equal(await readFile(soulPath, "utf8"), "# Who I am\nClean.\n");
});

test("a bot on the worker asks for a secret as a worker session does: its chat shows the card here, the worker writes the file", { timeout: 180_000 }, async () => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const value = "rover-only-SECRET-73";
  const asked = await call("/__hui/bots/rover/messages", "POST", { text: "E2E_SECRET_REQUEST for the ridge", wait: true, timeoutSeconds: 120 });
  assert.equal(asked.body["status"], "needs-input", JSON.stringify(asked.body));
  const [question] = asked.body["questions"] as Array<{ id: string; method: string; title: string }>;
  assert.deepEqual([question?.method, question?.title], ["secret", "Fixture API key"]);
  // Its chat waits on the card as a session's does: the same question, here on the gateway.
  assert.equal(liveSessions.status(rover.sessionId), "waiting");
  assert.deepEqual(liveSessions.snapshot(rover.sessionId).questions.map((entry) => entry.id), [question!.id]);
  assert.equal((await call(`/__hui/sessions/${rover.sessionId}/question`, "POST", { id: question!.id, value })).status, 200);
  const entries = await settledWith(rover.sessionId, says("assistant", "I used the secret in a command without seeing it"), "the turn that used the secret");
  const transcript = JSON.stringify(entries);
  assert.match(transcript, new RegExp(`Secret length: ${value.length}`, "u"), "its command on the worker read the file");
  const pid = Number(/hui-secret-(\d+)-/u.exec(transcript)?.[1]);
  assert.ok(pid && pid !== process.pid, "the worker host wrote the file, not this gateway");
  assert.ok(!transcript.includes(value), "the value never enters the chat");
  assert.ok(!(await readFile(log, "utf8")).includes(value), "nor reaches the model");
});

test("a call's record joins the worker bot's chat and memory, which its helper reads", { timeout: 120_000 }, async () => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const reference = (await readRegistry()).find((entry) => entry.id === rover.sessionId)!.piSessionFile!;
  // What BotService.recordCall does for a bot on a worker, through the same ports.
  const ports = remoteBots(workers, { cleanupFile: join(root, "ports-cleanup.json") });
  await ports.conversations(workerId).writeCallRecord(reference, {
    call: "call-1", bot: "Rover", startedAt: Date.parse("2026-10-06T20:00:00Z"), endedAt: Date.parse("2026-10-06T20:02:00Z"),
    summary: "Agreed to map the north ridge.", lines: [{ role: "user", text: "Map the north ridge tomorrow.", at: Date.parse("2026-10-06T20:00:10Z") }],
  });
  // Settled: the compactor summarizes the call's entries beside the reads, so compare views once nothing is pending.
  const memory = await waitFor(async () => {
    const read = await memoryOf("rover");
    return read.view.includes("Map the north ridge tomorrow.") && read.status.pending === 0 ? read : undefined;
  }, "the call to reach the memory, summarized");
  assert.match(memory.view, /\[call\]/u);
  assert.equal(await ports.memory(workerId).view(reference), memory.view, "the call helper's view is the memory route's");
});

test("archiving, restoring and deleting a bot on the worker", { timeout: 120_000 }, async () => {
  const rover = botOf(await call("/__hui/bots/rover"));
  const archived = await call("/__hui/bots/rover", "DELETE");
  assert.deepEqual([archived.status, botOf(archived).archived], [200, true]);
  assert.equal((await readRegistry()).find((entry) => entry.id === rover.sessionId)?.archived, true);
  assert.equal((await call("/__hui/bots/rover/messages", "POST", { text: "still there?" })).status, 409);
  assert.equal(botOf(await call("/__hui/bots/rover/restore", "POST", {})).archived, undefined);
  assert.deepEqual((await call("/__hui/bots/rover/messages", "POST", { text: "back again", wait: true, timeoutSeconds: 120 })).body, { status: "answered", reply: "Fixture response." });
  assert.equal((await call("/__hui/bots/rover", "DELETE")).status, 200);
  const conversation = (await readRegistry()).find((entry) => entry.id === rover.sessionId)!.piSessionFile!.replace(/^durable:/u, "");
  const deleted = await call(`/__hui/bots/${rover.id}?permanent=1`, "DELETE");
  assert.deepEqual([deleted.status, deleted.body], [200, { ok: true }]);
  assert.equal((await readRegistry()).some((entry) => entry.id === rover.sessionId), false, "its chat's record is gone");
  assert.equal(existsSync(rover.cwd), false, "its home on the worker went, SOUL.md with it, through the worker");
  assert.equal(existsSync(join(remoteStore, "optchat", conversation)), false, "its memory was deleted there");
  assert.ok(existsSync(join(remoteStore, "harness.sqlite")), "the conversation itself stays in the worker's store, which cannot delete one");
  assert.equal((await call("/__hui/bots/rover")).status, 404);
});

test("a bot on the worker has the tools and skills a session there has until the operator turns some off: its lists live there, its request is answered here, and the roster follows", { timeout: 240_000 }, async () => {
  // A skill of the gateway's: once mirrored, the worker finds it at its mirrored path, and names it so.
  await mkdir(join(agentDir, "skills", "atlas"), { recursive: true });
  await writeFile(join(agentDir, "skills", "atlas", "SKILL.md"), "---\nname: atlas\ndescription: Read the survey maps.\n---\n\n# atlas\n\nRead the survey maps.\n");
  await workers.sync(workerId);
  const atlas = { name: "atlas", path: join(remoteData, "mirror", "agent", "skills", "atlas", "SKILL.md") };
  const tools = (request: ProviderRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name);

  // Created with tools and that skill off: checked against the worker's own offer, in the creating commit there.
  const created = await call("/__hui/bots", "POST", { name: "Surveyor", worker: "devbox", soul: "# Who I am\nSURVEYOR.", disabledTools: ["bash", "write"], disabledSkills: ["atlas"] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const surveyor = botOf(created);
  assert.deepEqual([surveyor.disabledTools, surveyor.disabledSkills], [["bash", "write"], [atlas]]);
  const refused = await call("/__hui/bots", "POST", { name: "Mapless", worker: "devbox", disabledSkills: ["no-such-skill"] });
  assert.equal(refused.status, 400);
  assert.match(String(refused.body["error"]), /^Unknown skill: no-such-skill\. Skills of its directory: .*atlas/u);

  // Its catalog comes from the worker: the tools a session there is offered, the skill at its mirrored path.
  let catalog = (await call("/__hui/bots/surveyor/catalog")).body as unknown as BotCatalog;
  assert.equal(catalog.live, true, JSON.stringify(catalog));
  assert.deepEqual(catalog.tools.filter((tool) => !tool.enabled).map((tool) => tool.name).sort(), ["bash", "write"]);
  assert.deepEqual(catalog.tools.filter((tool) => GATEWAY_ONLY_TOOLS.includes(tool.name)), [], "the terminal, the browser and watchers stay on this machine: not listed, so never counted");
  assert.deepEqual(catalog.skills.find((skill) => skill.name === "atlas"), { ...atlas, description: "Read the survey maps.", source: "~/.local/share/hui-worker/mirror/agent/skills", enabled: false });

  // What is off leaves the request the chat on the worker makes, and the skill its prompt.
  assert.equal((await call("/__hui/bots/surveyor/messages", "POST", { text: "SURVEYOR_FIRST look around", wait: true, timeoutSeconds: 120 })).body["status"], "answered");
  const first = await chatRequest("SURVEYOR_FIRST");
  assert.deepEqual(["read", "bash", "write", "request_access"].map((name) => tools(first).includes(name)), [true, false, false, true]);
  assert.deepEqual(tools(first).filter((name) => name !== undefined && GATEWAY_ONLY_TOOLS.includes(name)), [], "nor offered to the chat on the worker, so it never calls them");
  assert.doesNotMatch(systemOf(first), /<name>atlas<\/name>/u, "not among its skills");
  assert.match(systemOf(first), /Skills:\\n- atlas: Read the survey maps\./u, "but named as off, so it can ask for it");

  // It asks for bash: the question comes here, the operator allows it, and the worker's chat has it from its next step.
  const asked = await call("/__hui/bots/surveyor/messages", "POST", { text: "E2E_REQUEST_ACCESS please", wait: true, timeoutSeconds: 120 });
  assert.equal(asked.body["status"], "needs-input", JSON.stringify(asked.body));
  const [question] = asked.body["questions"] as Array<{ id: string; title: string; options?: string[] }>;
  assert.deepEqual([question?.title, question?.options], ["Allow access to bash (powerful)?", ["Allow", "Deny"]]);
  catalog = (await call("/__hui/bots/surveyor/catalog")).body as unknown as BotCatalog;
  assert.equal(catalog.request?.id, question!.id, "the Tools & skills page sees the same request");
  assert.equal((await call(`/__hui/sessions/${surveyor.sessionId}/question`, "POST", { id: question!.id, value: "Allow" })).status, 200);
  await settledWith(surveyor.sessionId, says("assistant", "you now have bash"), "the granted turn on the worker");
  const granted = (await providerRequests()).filter((request) => !isCompactor(request) && JSON.stringify(request.messages).includes("tool-e2e-request-access")).at(-1);
  assert.ok(tools(granted).includes("bash"), "its next request there offers bash");
  // The worker reported the grant: the roster follows with no catalog read.
  await waitFor(async () => botOf(await call("/__hui/bots/surveyor")).disabledTools?.join() === "write" || undefined, "the roster to follow the worker's grant");

  // A list can't name what stays on this machine, at creation or later: there is nothing to turn off.
  const termless = await call("/__hui/bots", "POST", { name: "Termless", worker: "devbox", disabledTools: ["terminal", "bash"] });
  assert.deepEqual([termless.status, termless.body["error"]], [400, "terminal stays on this machine, so a bot on devbox can't use it and there is nothing to turn off: leave it out."]);
  const watched = await call("/__hui/bots/surveyor", "PATCH", { disabledTools: ["watcher", "browser"] });
  assert.deepEqual([watched.status, watched.body["error"]], [400, "watcher, browser stay on this machine, so a bot on devbox can't use them and there is nothing to turn off: leave them out."]);

  // Edited from here, written there: a skill named by this gateway's own path finds its mirrored one.
  const edited = await call("/__hui/bots/surveyor", "PATCH", { disabledTools: [], disabledSkills: [{ name: "atlas", path: join(agentDir, "skills", "atlas", "SKILL.md") }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([botOf(edited).disabledTools, botOf(edited).disabledSkills], [undefined, [atlas]]);
  catalog = (await call("/__hui/bots/surveyor/catalog")).body as unknown as BotCatalog;
  assert.deepEqual([catalog.disabledTools, catalog.disabledSkills], [[], [atlas]], "read back from the worker");
  assert.equal((await call(`/__hui/bots/${surveyor.id}?permanent=1`, "DELETE")).status, 200);
});

test("a disconnected worker: creating there, its bot's memory and messages fail naming it, and the list stays fast", { timeout: 180_000 }, async () => {
  const crow = botOf(await call("/__hui/bots", "POST", { name: "Crow", worker: workerId, soul: "# Who I am\nCrow." }));
  assert.equal(crow.worker?.name, "devbox");
  assert.equal((await call("/__hui/bots/crow/messages", "POST", { text: "before the disconnect", wait: true, timeoutSeconds: 120 })).body["status"], "answered");
  assert.equal((await call(`/__hui/workers/${workerId}/disconnect`, "POST", {})).status, 200);
  await waitFor(() => liveSessions.status(crow.sessionId) === "disconnected" || undefined, "the chat to show the disconnect");

  const late = await call("/__hui/bots", "POST", { name: "Late", worker: "devbox" });
  assert.deepEqual([late.status, late.body["error"]], [503, "HUI is not connected to devbox. Connect it in Settings → Workers, then create the bot again."]);
  const memory = await call("/__hui/bots/crow/memory");
  assert.equal(memory.status, 503);
  assert.match(String(memory.body["error"]), /^devbox, where this bot runs, is offline: HUI is not connected to it\./u);
  const message = await call("/__hui/bots/crow/messages", "POST", { text: "are you there?" });
  assert.equal(message.status, 503);
  assert.match(String(message.body["error"]), /runs on devbox, which HUI is disconnected from/u);
  // Its soul route cannot read or write SOUL.md, which is on the worker.
  for (const reply of [await call("/__hui/bots/crow/soul"), await call("/__hui/bots/crow/soul", "PUT", { soul: "# Who I am\nElsewhere." })]) {
    assert.equal(reply.status, 503);
    assert.match(String(reply.body["error"]), /^devbox, where this bot runs, is offline/u);
  }
  // Nor its Tools & skills page its lists, which are in its document there.
  const catalog = await call("/__hui/bots/crow/catalog");
  assert.equal(catalog.status, 503);
  assert.match(String(catalog.body["error"]), /^devbox, where this bot runs, is offline/u);
  const lists = await call("/__hui/bots/crow", "PATCH", { disabledTools: ["bash"] });
  assert.equal(lists.status, 503);
  assert.match(String(lists.body["error"]), /devbox/u);
  const started = Date.now();
  const listed = await call("/__hui/bots");
  assert.equal(listed.status, 200);
  assert.ok(Date.now() - started < 2_000, "the list never waits on the worker");
  const view = (listed.body["bots"] as BotView[]).find((bot) => bot.id === crow.id)!;
  assert.deepEqual([view.status, view.memory, view.lastMessage?.text], ["disconnected", undefined, "Fixture response."], "its state and the newest message HUI saw");
  assert.equal((await call("/__hui/bots", "POST", { name: "Late", worker: "devbox" })).status, 503, "nothing was left behind by the refused create");

  // Connected again, its memory reads as before.
  await workers.connect(workerId);
  assert.equal((await memoryOf("crow")).status.messages >= 2, true);

  // Deleted while devbox is away: the bot goes at once, and what it left there waits on this machine.
  assert.equal((await call(`/__hui/workers/${workerId}/disconnect`, "POST", {})).status, 200);
  await waitFor(() => liveSessions.status(crow.sessionId) === "disconnected" || undefined, "the chat to show the disconnect again");
  const queueFile = join(root, "gateway", "config", "hui", "bot-cleanup.json");
  const before = Date.now();
  const deleted = await call(`/__hui/bots/${crow.id}?permanent=1`, "DELETE");
  assert.deepEqual([deleted.status, deleted.body], [200, { ok: true, queued: true }]);
  assert.ok(Date.now() - before < 2_000, "the delete never waits on the worker");
  assert.equal((await call("/__hui/bots/crow")).status, 404);
  assert.equal(((await call("/__hui/bots")).body["bots"] as BotView[]).some((bot) => bot.id === crow.id), false, "off the roster at once");
  const waiting = JSON.parse(await readFile(queueFile, "utf8")) as { cleanups: Array<{ worker: string; botId: string; cwd: string }> };
  assert.deepEqual(waiting.cleanups.map(({ worker, botId, cwd }) => [worker, botId, cwd]), [[workerId, crow.id, crow.cwd]]);
  assert.ok(existsSync(join(crow.cwd, "SOUL.md")), "its home is still on the worker");
  // At the next connection the worker removes it, and the note goes.
  await workers.connect(workerId);
  await waitFor(() => !existsSync(crow.cwd) || undefined, "the worker to remove its home");
  await waitFor(async () => (JSON.parse(await readFile(queueFile, "utf8")) as { cleanups: unknown[] }).cleanups.length === 0 || undefined, "the note to go");
});

test("explicit memories stay on the worker and its next request reads edits and deletes", { timeout: 180_000 }, async () => {
  const created = await call("/__hui/bots", "POST", { name: "FactsWorker", worker: "devbox", soul: "I keep explicit knowledge." });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const bot = botOf(created);
  const path = `/__hui/bots/${bot.id}/facts`;
  const added = await call(path, "POST", { kind: "decision", text: "WORKER_EXPLICIT_ORIGINAL" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const fact = (added.body["facts"] as Array<{ id: string; revision: number }>)[0]!;
  assert.match(await readFile(join(bot.cwd, "facts.json"), "utf8"), /WORKER_EXPLICIT_ORIGINAL/u);
  assert.ok(!existsSync(join(root, "gateway", "config", "hui", "bots", bot.id, "facts.json")));
  const edited = await call(`${path}/${fact.id}`, "PATCH", { revision: 1, text: "WORKER_EXPLICIT_CORRECTED", pinned: true });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal((await call(`${path}/${fact.id}`, "PATCH", { revision: 1, text: "STALE" })).status, 409);
  await call(`/__hui/bots/${bot.id}/messages`, "POST", { text: "WORKER_FACTS_REQUEST", wait: true });
  const request = await chatRequest("WORKER_FACTS_REQUEST");
  assert.match(JSON.stringify(request?.system), /WORKER_EXPLICIT_CORRECTED/u);
  assert.doesNotMatch(JSON.stringify(request?.system), /WORKER_EXPLICIT_ORIGINAL/u);
  assert.equal((await call(`${path}/${fact.id}?revision=2`, "DELETE")).status, 200);
  assert.deepEqual((await call(path)).body["facts"], []);
  const saves = Array.from({ length: 10 }, (_, index) => call(path, "POST", { kind: "fact", text: `Pending worker deletion ${index}` }));
  assert.equal((await call(`/__hui/bots/${bot.id}?permanent=1`, "DELETE")).status, 200);
  const results = await Promise.all(saves);
  assert.ok(results.every((reply) => reply.status === 201 || reply.status === 404), JSON.stringify(results.map((reply) => reply.status)));
  assert.ok(!existsSync(join(remoteData, "bots", bot.id)), "late writes never recreate a deleted worker bot's home");
});
