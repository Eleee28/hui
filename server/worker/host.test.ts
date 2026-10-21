/**
 * The worker host's credential cache, through the stores its runtimes use and
 * a gateway connected to its socket. workers.test.ts runs whole sessions.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const root = await mkdtemp(join(tmpdir(), "hui-worker-host-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
process.env["XDG_DATA_HOME"] = join(root, "data");
process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
const { workerPaths } = await import("./paths.ts");
const { WorkerHost } = await import("./host.ts");
const { attachPeer } = await import("./protocol.ts");
const { brokeredStore, ownLogin } = await import("./credentials.ts");
const { GATEWAY_ONLY_TOOLS } = await import("./gateway-tools.ts");
const { invokeAgentTool } = await import("../agent-tools/bridge.ts");
type Store = ReturnType<typeof brokeredStore>;
type Frame = import("./protocol.ts").Frame;
type HostInfo = import("./protocol.ts").HostInfo;

const host = new WorkerHost(workerPaths());
await host.listen();
afterAll(async () => {
  await host.close();
  await rm(root, { recursive: true, force: true });
});

/** A gateway serving `credentials`; resolves once the host has accepted it. */
async function gateway(credentials: Map<string, unknown>) {
  const socket = connect(host.paths.socket);
  const peer = attachPeer(socket, socket);
  peer.handle("credential", (params) => {
    const id = String(params["providerId"]);
    if (params["op"] === "delete") credentials.delete(id);
    return credentials.get(id) ?? null;
  });
  await peer.request("hello");
  return { disconnect: () => socket.destroy() };
}

/** The remote's own login, used when the host has no answer from a gateway. */
const own = { read: async (id: string) => ({ type: "api_key", key: `own-${id}` }) } as unknown as Store;
const store = brokeredStore("pi", () => own);

test("cached gateway credentials end at their expiry or deletion; then the remote's own login answers", async () => {
  const connected = await gateway(new Map<string, unknown>([
    ["soon", { type: "oauth", access: "gateway-soon", refresh: "r", expires: Date.now() + 500 }],
    ["later", { type: "oauth", access: "gateway-later", refresh: "r", expires: Date.now() + 3_600_000 }],
    ["deleted", { type: "api_key", key: "gateway-deleted" }],
  ]));
  for (const id of ["soon", "later", "deleted"]) assert.notEqual(await store.read(id), undefined);
  await store.delete("deleted");
  connected.disconnect();
  // Once the host notices the gateway left and the short token expires.
  for (const deadline = Date.now() + 30_000; (await store.read("soon") as { key?: string }).key !== "own-soon";) {
    if (Date.now() > deadline) throw new Error("The expired credential was still served from the cache.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal((await store.read("later") as { access?: string }).access, "gateway-later");
  assert.deepEqual(await store.read("deleted"), { type: "api_key", key: "own-deleted" });
});

test("the remote's own login is only opened once it exists, so no file appears outside HUI's directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-own-login-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, ".pi", "agent", "auth.json");
  const login = ownLogin(path);
  assert.equal(await login.read("fx"), undefined);
  assert.deepEqual(await login.list(), []);
  await login.delete("fx");
  assert.equal(existsSync(path), false);
  await mkdir(join(dir, ".pi", "agent"), { recursive: true });
  await writeFile(path, JSON.stringify({ fx: { type: "api_key", key: "own-key" } }));
  assert.deepEqual(await login.read("fx"), { type: "api_key", key: "own-key" });
});

test("folder suggestions list directories on the worker, not the gateway", async () => {
  await mkdir(join(root, "remote-project"), { recursive: true });
  await writeFile(join(root, "remote-file"), "");
  const socket = connect(host.paths.socket);
  const peer = attachPeer(socket, socket);
  try {
    const { directories } = await peer.request<{ directories: string[] }>("directories", { q: "~/remote" });
    assert.deepEqual(directories, ["~/remote-project/"]);
  } finally {
    socket.destroy();
  }
});

test("transcript search reads the worker's own session files", async () => {
  const file = join(root, "remote-session.jsonl");
  await writeFile(file, [
    { type: "session", version: 3, id: "s", timestamp: "2026-10-01T10:00:00.000Z", cwd: root },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Ship the remote widget" }], timestamp: 1 } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const socket = connect(host.paths.socket);
  const peer = attachPeer(socket, socket);
  try {
    const { hits } = await peer.request<{ hits: unknown[] }>("sessions.search", { sessionFiles: [file, "durable:999999"], q: "remote WIDGET" });
    assert.deepEqual(hits, [{ sessionFile: file, snippet: "Ship the remote widget", matches: 1 }]);
  } finally {
    socket.destroy();
  }
});

/** A gateway's view of the host's bot operations: requests, and the frames the host sends it. */
async function botGateway() {
  const socket = connect(host.paths.socket);
  const peer = attachPeer(socket, socket);
  const frames: Frame[] = [];
  peer.onFrame((frame) => frames.push(frame));
  // No logins: the host's models list nothing.
  peer.handle("credential", (params) => params["op"] === "list" ? [] : null);
  const hello = await peer.request<HostInfo>("hello");
  return { peer, frames, hello, disconnect: () => socket.destroy() };
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  for (const deadline = Date.now() + 30_000; ;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a bot's conversation and memory are made in the host's own store, in its own folder there, and read back through the host", async () => {
  const gateway = await botGateway();
  const { peer, frames } = gateway;
  try {
    assert.ok(gateway.hello.features?.includes("bots"), "hello says the host runs bots");
    const created = await peer.request<{ reference: string; cwd: string }>("bot.create", { botId: "bot-ada", soul: "# Who I am\r\nAda.\n", memory: { name: "Ada" } });
    assert.match(created.reference, /^durable:\d+$/u);
    // Its home: a private folder under HUI's data directory on the worker, as the gateway makes one under its
    // configuration, with the SOUL.md it was given.
    assert.equal(created.cwd, join(host.paths.dataDir, "bots", "bot-ada"));
    assert.equal((await stat(created.cwd)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(created.cwd, "SOUL.md"), "utf8"), "# Who I am\nAda.\n");
    const reference = created.reference;

    // OptChat is on from the creating commit: an empty memory, read through the host.
    const status = await peer.request<{ status?: { messages: number; viewLines: number } }>("bot.memory.status", { reference });
    assert.equal(status.status?.messages, 0);
    const view = await peer.request<{ text: string; status?: { messages: number } }>("bot.memory.view", { reference });
    assert.equal(view.text, "<chat>\n\n</chat>");
    assert.equal(view.status?.messages, 0, "the view comes with the status it counts");
    assert.deepEqual(await peer.request("bot.memory.zoom", { reference, id: 0, n: 1 }), { text: "No line 0+1." });
    assert.match((await peer.request<{ text: string }>("bot.memory.html", { reference })).text, /<html/iu);

    // A watched memory reports its status, now and as it changes: a call's record joins the chat and its memory.
    await peer.request("bot.memory.watch", { references: [reference] });
    await until(() => frames.find((frame) => frame.t === "bot.memory.status" && frame["reference"] === reference), "the first report");
    const record = { call: "call-1", bot: "Ada", startedAt: Date.parse("2026-10-06T20:00:00Z"), endedAt: Date.parse("2026-10-06T20:03:00Z"), summary: "Talked about **trips**.", lines: [{ role: "user", text: "Hi", at: Date.parse("2026-10-06T20:00:05Z") }] };
    await peer.request("bot.call-record", { reference, record });
    await until(() => frames.find((frame) => frame.t === "bot.memory.status" && (frame["status"] as { messages?: number }).messages === 1), "the call to reach the memory");
    const last = await peer.request<{ message?: { role: string; text: string; at?: string } }>("bot.last-message", { reference });
    assert.deepEqual(last.message, { role: "assistant", text: "📞 Call · 3 min · Talked about trips.", at: "2026-10-06T20:03:00.000Z" });
    await assert.rejects(peer.request("bot.call-record", { reference, record: { call: "x" } }), /record is not valid/u);

    // The directory and the memory's settings change in place; a directory must exist there.
    await mkdir(join(root, "bot-work"), { recursive: true });
    await peer.request("bot.configure", { reference, cwd: "~/bot-work" });
    await peer.request("bot.memory.configure", { reference, settings: { name: "Ada Two", thinking: "low" } });
    await assert.rejects(peer.request("bot.configure", { reference, cwd: "~/missing" }), /No such directory on the remote/u);
    assert.deepEqual(await peer.request("bot.directory", { cwd: "~/bot-work" }), { cwd: join(root, "bot-work") });
    await assert.rejects(peer.request("bot.directory", { cwd: "bot-work" }), /absolute or start with ~\//u);

    // A bot that names a directory works there; one that does not exist creates nothing.
    const placed = await peer.request<{ reference: string; cwd: string }>("bot.create", { botId: "bot-placed", memory: { name: "Placed" }, cwd: "~/bot-work", soul: "# Who I am\nPlaced." });
    assert.equal(placed.cwd, join(root, "bot-work"));
    assert.notEqual(placed.reference, reference);
    // It still has its home, and SOUL.md lives there, never in the directory chosen for it.
    const placedHome = join(host.paths.dataDir, "bots", "bot-placed");
    assert.equal(await readFile(join(placedHome, "SOUL.md"), "utf8"), "# Who I am\nPlaced.\n");
    assert.equal(existsSync(join(root, "bot-work", "SOUL.md")), false);
    await assert.rejects(peer.request("bot.create", { botId: "bot-lost", memory: { name: "Lost" }, cwd: "~/missing" }), /No such directory on the remote/u);
    await assert.rejects(peer.request("bot.create", { botId: "bot-bad", memory: { name: "Bad" }, model: "nobody/none" }), /Unknown model: nobody\/none/u);
    assert.equal(existsSync(join(host.paths.dataDir, "bots", "bot-bad")), false, "a refused create leaves no folder behind");

    // SOUL.md read and written there: replaced atomically, removed when empty, within its limit, by a bot id only.
    await peer.request("bot.soul.write", { botId: "bot-placed", soul: "# Who I am\r\nPlaced, again.\n" });
    assert.deepEqual(await peer.request("bot.soul.read", { botId: "bot-placed" }), { soul: "# Who I am\nPlaced, again." });
    await peer.request("bot.soul.write", { botId: "bot-placed" });
    assert.deepEqual(await peer.request("bot.soul.read", { botId: "bot-placed" }), { soul: null });
    await assert.rejects(peer.request("bot.soul.write", { botId: "bot-placed", soul: "s".repeat(20_001) }), /at most 20000 characters/u);
    await assert.rejects(peer.request("bot.soul.read", { botId: "../escape" }), /A bot id is required/u);
    await peer.request("bot.home.prepare", { botId: "bot-prepared" });
    assert.equal((await stat(join(host.paths.dataDir, "bots", "bot-prepared"))).mode & 0o777, 0o700);

    // A bot's own skills (an import's) go into its home there, by skill names only.
    assert.ok(gateway.hello.features?.includes("bot-skills"), "hello says the host keeps bots' own skills");
    const skill = "---\nname: weather\ndescription: W\n---\n\nGo.\n";
    await peer.request("bot.skills.write", { botId: "bot-placed", skills: [{ name: "weather", text: skill }] });
    assert.equal(await readFile(join(placedHome, "skills", "weather", "SKILL.md"), "utf8"), skill);
    assert.deepEqual(await peer.request("bot.skills.read", { botId: "bot-placed" }), { skills: [{ name: "weather", text: skill }] });
    await assert.rejects(peer.request("bot.skills.write", { botId: "bot-placed", skills: [{ name: "../escape", text: "x" }] }), /a skill's name and its SKILL\.md/u);

    // A deleted bot's home goes with everything in it, as the gateway removes its own; the directory it worked in stays.
    await writeFile(join(created.cwd, "notes.md"), "the bot's own file");
    await peer.request("bot.remove-home", { botId: "bot-ada", cwd: join(root, "bot-work") });
    assert.equal(existsSync(created.cwd), false, "SOUL.md and every file in it");
    await peer.request("bot.remove-home", { botId: "bot-placed", cwd: join(root, "bot-work") });
    assert.equal(existsSync(placedHome), false);
    assert.equal(existsSync(join(root, "bot-work")), true, "never the directory chosen for it");
    // One chosen inside the home stays, and only SOUL.md goes.
    await peer.request("bot.create", { botId: "bot-nested", memory: { name: "Nested" }, soul: "# Who I am\nNested." });
    const nested = join(host.paths.dataDir, "bots", "bot-nested");
    await mkdir(join(nested, "work"));
    await writeFile(join(nested, "work", "file.md"), "kept");
    await peer.request("bot.remove-home", { botId: "bot-nested", cwd: join(nested, "work") });
    assert.deepEqual([existsSync(join(nested, "SOUL.md")), existsSync(join(nested, "work", "file.md"))], [false, true]);
    // A link in a home's place is removed, never followed out of the bots directory.
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.md"), "kept");
    await symlink(outside, join(host.paths.dataDir, "bots", "bot-link"));
    await peer.request("bot.remove-home", { botId: "bot-link" });
    assert.deepEqual([existsSync(join(host.paths.dataDir, "bots", "bot-link")), existsSync(join(outside, "keep.md"))], [false, true]);
    await peer.request("bot.remove-home", { botId: "bot-never" });
    await assert.rejects(peer.request("bot.remove-home", { botId: "../bots" }), /A bot id is required/u);
    // Its conversation forgotten: its memory is off and gone, so nothing reads it back.
    await peer.request("bot.forget", { reference });
    assert.equal(typeof (await peer.request<{ unavailable?: unknown }>("bot.memory.view", { reference })).unavailable, "string");

    // Only this store's references.
    await assert.rejects(peer.request("bot.memory.view", { reference: "/tmp/session.jsonl" }), /conversation reference is required/u);
  } finally {
    gateway.disconnect();
  }
});

test("a bot's tool and skill lists live in its document here: made with it, read and written through the host, and checked against what this host offers, skills at the paths found here", async () => {
  const gateway = await botGateway();
  const { peer } = gateway;
  try {
    assert.ok(gateway.hello.features?.includes("bot-access"), "hello says the host keeps bots' lists");
    // A skill of the gateway's as the mirror holds it here: this host's loader finds it there.
    const skillDir = join(host.paths.agentDir, "skills", "alpha");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: Alpha.\n---\n\n# alpha\n");
    const alpha = { name: "alpha", path: join(skillDir, "SKILL.md") };
    type Offer = { tools: Array<{ name: string; group: string; powerful: boolean }>; skills: Array<{ name: string; path: string; source: string; description: string }>; alwaysOn: Array<{ name: string }>; live: boolean };
    // Before its conversation: its home here, which asking does not make.
    const before = (await peer.request<{ offer: Offer }>("bot.offer", { botId: "bot-lists" })).offer;
    assert.equal(before.live, false);
    assert.deepEqual(["read", "bash", "message_bot"].map((name) => before.tools.some((tool) => tool.name === name)), [true, true, true]);
    assert.equal(before.tools.find((tool) => tool.name === "bash")?.powerful, true);
    assert.deepEqual(before.tools.filter((tool) => GATEWAY_ONLY_TOOLS.includes(tool.name)), [], "never what stays on the gateway's machine: the terminal, the browser and watchers");
    assert.deepEqual(before.skills.filter((skill) => skill.name === "alpha"), [{ ...alpha, description: "Alpha.", source: "~/data/hui-worker/mirror/agent/skills" }]);
    assert.deepEqual(before.alwaysOn.map((tool) => tool.name), ["write_soul", "set_profile", "request_access", "load_skill", "zoom", "date"]);
    assert.equal(existsSync(join(host.paths.dataDir, "bots", "bot-lists")), false, "asking made nothing");
    await assert.rejects(peer.request("bot.offer", { cwd: "~/missing" }), /No such directory on the remote/u);
    await assert.rejects(peer.request("bot.offer", {}), /A bot id is required/u);

    const { reference } = await peer.request<{ reference: string }>("bot.create", {
      botId: "bot-lists", memory: { name: "Lists" }, soul: "# Who I am\nLists.", access: { disabledTools: ["bash"], disabledSkills: [alpha] },
    });
    assert.deepEqual(await peer.request("bot.access.read", { reference }), { access: { disabledTools: ["bash"], disabledSkills: [alpha] } }, "in its creating commit");
    await peer.request("bot.access.write", { reference, access: { disabledTools: ["write", "write"], disabledSkills: [] } });
    assert.deepEqual(await peer.request("bot.access.read", { reference }), { access: { disabledTools: ["write"], disabledSkills: [] } });
    assert.equal((await peer.request<{ offer: Offer }>("bot.offer", { reference, cwd: join(host.paths.dataDir, "bots", "bot-lists") })).offer.live, false, "no session follows it here");
    for (const [access, pattern] of [
      [{ disabledTools: ["two words"] }, /is not a tool name/u],
      [{ disabledSkills: ["alpha"] }, /as \{ name, path \}/u],
      ["bash", /lists are required/u],
    ] as const) {
      await assert.rejects(peer.request("bot.access.write", { reference, access }), pattern);
    }
    await assert.rejects(peer.request("bot.create", { botId: "bot-bad-lists", memory: { name: "Bad" }, access: { disabledTools: [3] } }), /is not a tool name/u);
    assert.equal(existsSync(join(host.paths.dataDir, "bots", "bot-bad-lists")), false, "a refused create made nothing");
    await assert.rejects(peer.request("bot.access.read", { reference: "/tmp/session.jsonl" }), /conversation reference is required/u);
    await peer.request("bot.forget", { reference });
    await assert.rejects(peer.request("bot.access.write", { reference, access: { disabledTools: [] } }), /no bot's chat/u);
  } finally {
    gateway.disconnect();
  }
});

test("a session's secret request is answered on the gateway, written here, and its Stop reaches the gateway", async (t) => {
  const socket = connect(host.paths.socket);
  const peer = attachPeer(socket, socket);
  t.onTestFinished(() => { socket.destroy(); });
  const asked: Record<string, unknown>[] = [];
  let held: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  peer.handle("secret-request", (params, signal) => {
    asked.push(params);
    if ((params["params"] as { label?: string }).label !== "Held") return { status: "provided", label: "Token", value: "s3cr3t-on-the-worker" };
    held = signal;
    entered();
    return new Promise(() => undefined);
  });
  await peer.request("hello");

  const delivered = await invokeAgentTool({ callerSessionId: "remote-key", action: "secret_request", params: { label: "Token", reason: "Log in" } }) as { status: string; path: string };
  assert.equal(delivered.status, "provided");
  assert.equal(await readFile(delivered.path, "utf8"), "s3cr3t-on-the-worker");
  assert.equal((await stat(delivered.path)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(delivered).includes("s3cr3t"), "the agent gets the path, never the value");
  assert.deepEqual(asked[0], { key: "remote-key", params: { label: "Token", reason: "Log in" } });

  const stop = new AbortController();
  const pending = invokeAgentTool({ callerSessionId: "remote-key", action: "secret_request", params: { label: "Held", reason: "Stop me" }, signal: stop.signal });
  await started;
  stop.abort();
  await assert.rejects(pending, /cancelled/u);
  if (!held!.aborted) await new Promise((resolve) => held!.addEventListener("abort", resolve, { once: true }));
});
