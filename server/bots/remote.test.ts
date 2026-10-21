import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { WorkerView } from "../worker/workers.ts";
import { waitFor } from "../test-support/wait-for.ts";

// Paths are resolved at import time: never the operator's own configuration.
const config = await mkdtemp(join(tmpdir(), "hui-bot-remote-"));
process.env["XDG_CONFIG_HOME"] = config;
afterAll(() => rm(config, { recursive: true, force: true }));
const { remoteBots, reportedStatus } = await import("./remote.ts");
const { BotConflictError, BotInputError, BotWorkerOfflineError } = await import("./bots.ts");
const { BotMemoryUnavailableError } = await import("./memory.ts");
const { WorkerOfflineError } = await import("../workers.ts");
type BotWorkerLink = import("./remote.ts").BotWorkerLink;
type Frame = import("../worker/protocol.ts").Frame;

const STATUS = { messages: 3, built: 1, pending: 0, viewBytes: 120, viewLines: 2, usage: { calls: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } };

/** A worker service with one worker, devbox (w-1), whose host answers from `replies`. */
function link() {
  const frames = new Set<(id: string, frame: Frame) => void>();
  const closed = new Set<(id: string) => void>();
  const connected = new Set<(id: string) => void>();
  const removed = new Set<(id: string) => void>();
  const requests: Array<{ id: string; op: string; params: Record<string, unknown> }> = [];
  const state = { connected: true, features: ["bots"] as string[], replies: new Map<string, (params: Record<string, unknown>) => unknown>() };
  const views = [{ id: "w-1", name: "devbox" }, { id: "w-2", name: "twin" }, { id: "w-3", name: "twin" }].map((worker) => ({ ...worker, command: "ssh x", extraPaths: [], state: "connected" }) as WorkerView);
  const workers: BotWorkerLink = {
    list: async () => views,
    nameOf: (id) => views.find((worker) => worker.id === id)?.name,
    connected: () => state.connected,
    features: () => state.connected ? state.features : undefined,
    hostRequest: async <T>(id: string, op: string, params: Record<string, unknown> = {}) => {
      if (!state.connected) throw new WorkerOfflineError("HUI is not connected to devbox.");
      requests.push({ id, op, params });
      const reply = state.replies.get(op);
      return (reply ? reply(params) : {}) as T;
    },
    onHostFrame: (listener) => { frames.add(listener); return () => frames.delete(listener); },
    onClosed: (listener) => { closed.add(listener); return () => closed.delete(listener); },
    onConnected: (listener) => { connected.add(listener); return () => connected.delete(listener); },
    onRemoved: (listener) => { removed.add(listener); return () => removed.delete(listener); },
    skillPath: (_id, path) => state.connected ? `/home/remote/.local/share/hui-worker/mirror/agent${path}` : undefined,
  };
  return {
    workers, state, requests,
    remove: () => { for (const listener of removed) listener("w-1"); },
    frame: (frame: Frame) => { for (const listener of frames) listener("w-1", frame); },
    close: () => { state.connected = false; for (const listener of closed) listener("w-1"); },
    open: () => { state.connected = true; for (const listener of connected) listener("w-1"); },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

let queues = 0;
/** The ports, with a clean-up queue of their own in this test's configuration. */
const portsOf = (fake: ReturnType<typeof link>, reported: unknown[] = []) => {
  const cleanupFile = join(config, `bot-cleanup-${++queues}.json`);
  return { bots: remoteBots(fake.workers, { cleanupFile, report: (...entry) => { reported.push(entry); } }), cleanupFile };
};

test("a worker's bot ports refuse at once while HUI is not connected, naming the worker, and tell an older host apart", async () => {
  const fake = link();
  const { bots } = portsOf(fake);
  fake.state.connected = false;
  await assert.rejects(bots.conversations("w-1").create({ botId: "b", memory: { name: "B" } }),
    (error: unknown) => error instanceof BotWorkerOfflineError && error.message === "HUI is not connected to devbox. Connect it in Settings → Workers, then create the bot again.");
  for (const call of [() => bots.memory("w-1").view("durable:1"), () => bots.conversations("w-1").lastMessage("durable:1"), () => bots.souls("w-1").read("b"), () => bots.souls("w-1").remove("b")]) {
    await assert.rejects(call(), (error: unknown) => error instanceof BotWorkerOfflineError && /^devbox, where this bot runs, is offline: HUI is not connected to it\./u.test(error.message));
  }
  assert.deepEqual(fake.requests, [], "nothing was sent, and nothing connected");
  fake.state.connected = true;
  fake.state.features = [];
  await assert.rejects(bots.memory("w-1").view("durable:1"), (error: unknown) => error instanceof BotConflictError && /devbox runs an older HUI worker that cannot run bots/u.test(error.message));
  assert.deepEqual(fake.requests, []);
});

test("a worker's bot operations reach its host, and its answers are checked", async () => {
  const fake = link();
  const { bots } = portsOf(fake);
  fake.state.replies.set("bot.create", (params) => ({ reference: "durable:7", cwd: params["cwd"] === "~/src" ? "/home/remote/src" : "/home/remote/.local/share/hui-worker/bots/b" }));
  fake.state.replies.set("bot.directory", () => ({ cwd: "/home/remote/src" }));
  fake.state.replies.set("bot.last-message", () => ({ message: { role: "user", text: "hi", at: "2026-10-06T20:00:00.000Z" } }));
  fake.state.replies.set("bot.memory.view", () => ({ unavailable: "This bot's chat has no OptChat memory in this gateway." }));
  fake.state.replies.set("bot.memory.zoom", () => ({ text: "1+0|user: hi" }));
  fake.state.replies.set("bot.soul.read", (params) => ({ soul: params["botId"] === "b" ? "# Who I am\nB." : null }));
  const conversations = bots.conversations("w-1");
  assert.deepEqual(await conversations.create({ botId: "b", memory: { name: "B" }, cwd: "~/src", soul: "# Who I am\nB." }), { reference: "durable:7", cwd: "/home/remote/src" });
  assert.equal(await conversations.directory("~/src"), "/home/remote/src");
  await conversations.configure("durable:7", { cwd: "/home/remote/src" });
  assert.deepEqual(await conversations.lastMessage("durable:7"), { role: "user", text: "hi", at: "2026-10-06T20:00:00.000Z" });
  await conversations.writeCallRecord("durable:7", { call: "c", startedAt: 1, endedAt: 2, lines: [] });
  await conversations.forget("durable:7");
  const souls = bots.souls("w-1");
  assert.equal(await souls.read("b"), "# Who I am\nB.");
  assert.equal(await souls.exists("c"), false, "no SOUL.md there yet");
  await souls.write("b", "# Who I am\nB, again.");
  await souls.write("b", undefined);
  await souls.prepare("b");
  await souls.remove("b");
  await bots.memory("w-1").configure("durable:7", { name: "B" });
  assert.equal(await bots.memory("w-1").zoom("durable:7", 1, 1), "1+0|user: hi");
  await assert.rejects(bots.memory("w-1").view("durable:7"), BotMemoryUnavailableError, "the worker's own refusal is the routes' 503");
  assert.deepEqual(fake.requests.map(({ op, params }) => [op, params]), [
    ["bot.create", { botId: "b", memory: { name: "B" }, cwd: "~/src", soul: "# Who I am\nB." }],
    ["bot.directory", { cwd: "~/src" }],
    ["bot.configure", { reference: "durable:7", cwd: "/home/remote/src" }],
    ["bot.last-message", { reference: "durable:7" }],
    ["bot.call-record", { reference: "durable:7", record: { call: "c", startedAt: 1, endedAt: 2, lines: [] } }],
    ["bot.forget", { reference: "durable:7" }],
    ["bot.soul.read", { botId: "b" }],
    ["bot.soul.read", { botId: "c" }],
    ["bot.soul.write", { botId: "b", soul: "# Who I am\nB, again." }],
    ["bot.soul.write", { botId: "b" }],
    ["bot.home.prepare", { botId: "b" }],
    ["bot.remove-home", { botId: "b" }],
    ["bot.memory.configure", { reference: "durable:7", settings: { name: "B" } }],
    ["bot.memory.zoom", { reference: "durable:7", id: 1, n: 1 }],
    ["bot.memory.view", { reference: "durable:7" }],
  ]);
  fake.state.replies.set("bot.create", () => ({ reference: "/tmp/x.jsonl", cwd: "relative" }));
  await assert.rejects(conversations.create({ botId: "b", memory: { name: "B" } }), /devbox did not create the bot's conversation/u);
  // A connection that goes while a request is out reads as offline.
  fake.state.replies.set("bot.memory.html", () => { fake.state.connected = false; throw new Error("Remote worker connection closed."); });
  await assert.rejects(bots.memory("w-1").html("durable:7"), BotWorkerOfflineError);
});

test("a worker bot's lists and what can be turned off go through its host, which a host from before them refuses; offline, as every other read", async () => {
  const fake = link();
  fake.state.features = ["bots", "bot-access"];
  const { bots } = portsOf(fake);
  const conversations = bots.conversations("w-1");
  const alpha = { name: "alpha", path: "/home/remote/.local/share/hui-worker/mirror/agent/skills/alpha/SKILL.md" };
  const read = { name: "read", label: "Read files", description: "Read files and images", group: "files", source: "Durable", powerful: false };
  fake.state.replies.set("bot.access.read", () => ({ access: { disabledTools: ["bash", 3, "two words"], disabledSkills: [alpha, { name: "x" }] } }));
  fake.state.replies.set("bot.offer", (params) => ({ offer: {
    tools: [read, { name: "odd", group: "nowhere" }, "bash"],
    skills: [{ ...alpha, description: "Alpha.", source: "~/.local/share/hui-worker/mirror/agent/skills" }, { name: "pathless" }],
    alwaysOn: [{ name: "write_soul", description: "Rewrite its SOUL.md" }, {}],
    live: params["reference"] !== undefined,
  } }));
  assert.deepEqual(await conversations.access("durable:7"), { disabledTools: ["bash"], disabledSkills: [alpha] }, "what does not validate is dropped");
  await conversations.setAccess("durable:7", { disabledTools: ["read"], disabledSkills: [] });
  assert.deepEqual(await conversations.offer("durable:7", "/home/remote/src"), {
    tools: [read], skills: [{ ...alpha, description: "Alpha.", source: "~/.local/share/hui-worker/mirror/agent/skills" }],
    alwaysOn: [{ name: "write_soul", description: "Rewrite its SOUL.md" }], live: true,
  });
  assert.equal((await conversations.offer(undefined, undefined, "b")).live, false, "before its conversation: the bot's home there");
  assert.deepEqual(fake.requests.map(({ op, params }) => [op, params]), [
    ["bot.access.read", { reference: "durable:7" }],
    ["bot.access.write", { reference: "durable:7", access: { disabledTools: ["read"], disabledSkills: [] } }],
    ["bot.offer", { reference: "durable:7", cwd: "/home/remote/src" }],
    ["bot.offer", { botId: "b" }],
  ]);
  fake.state.replies.set("bot.offer", () => ({}));
  await assert.rejects(conversations.offer("durable:7", "/x"), /^Error: devbox sent nothing a bot's tools and skills could be checked against\.$/u);
  fake.state.replies.set("bot.access.read", () => ({}));
  await assert.rejects(conversations.access("durable:7"), /devbox sent no tool and skill lists/u);

  // A host from before the lists is told apart at once; an offline worker answers as every other read does.
  fake.state.features = ["bots"];
  const sent = fake.requests.length;
  for (const call of [() => conversations.access("durable:7"), () => conversations.setAccess("durable:7", { disabledTools: [], disabledSkills: [] }), () => conversations.offer("durable:7", "/x")]) {
    await assert.rejects(call(), (error: unknown) => error instanceof BotConflictError && /^devbox runs an older HUI worker that cannot turn a bot's tools and skills off\./u.test(error.message));
  }
  fake.state.connected = false;
  await assert.rejects(conversations.access("durable:7"), (error: unknown) => error instanceof BotWorkerOfflineError && /^devbox, where this bot runs, is offline/u.test(error.message));
  await assert.rejects(conversations.offer(undefined, undefined, "b"), (error: unknown) => error instanceof BotWorkerOfflineError && /then create the bot again\.$/u.test(error.message));
  assert.equal(fake.requests.length, sent, "nothing was sent");
});

test("a worker bot's own skills (an import's) are written and read through its host, which a host from before them refuses", async () => {
  const fake = link();
  fake.state.features = ["bots", "bot-access", "bot-skills"];
  const { bots } = portsOf(fake);
  assert.equal(bots.keepsSkills("w-1"), true);
  fake.state.replies.set("bot.skills.read", () => ({ skills: [{ name: "weather", text: "W" }, { name: 3 }, "x"] }));
  await bots.skills("w-1").write("b", [{ name: "weather", text: "W" }]);
  assert.deepEqual(await bots.skills("w-1").read("b"), [{ name: "weather", text: "W" }], "what does not validate is dropped");
  assert.deepEqual(fake.requests.map(({ op, params }) => [op, params]), [["bot.skills.write", { botId: "b", skills: [{ name: "weather", text: "W" }] }], ["bot.skills.read", { botId: "b" }]]);
  fake.state.features = ["bots", "bot-access"];
  assert.equal(bots.keepsSkills("w-1"), false);
  await assert.rejects(bots.skills("w-1").write("b", []), (error: unknown) => error instanceof BotConflictError && /^devbox runs an older HUI worker that cannot keep a bot's own skills\./u.test(error.message));
  fake.state.connected = false;
  assert.equal(bots.keepsSkills("w-1"), false, "offline: nothing to write to");
});

test("a worker names this gateway's skills as remote sessions' Settings do: by their mirrored paths there, only while connected", () => {
  const fake = link();
  const { bots } = portsOf(fake);
  assert.equal(bots.skillPath("w-1", "/skills/alpha/SKILL.md"), "/home/remote/.local/share/hui-worker/mirror/agent/skills/alpha/SKILL.md");
  fake.state.connected = false;
  assert.equal(bots.skillPath("w-1", "/skills/alpha/SKILL.md"), undefined);
});

test("grants a worker reports reach the listeners with the worker that sent them; anything malformed is dropped", () => {
  const fake = link();
  const { bots } = portsOf(fake);
  const heard: unknown[] = [];
  bots.onAccessRecorded((...entry) => { heard.push(entry); });
  fake.frame({ t: "bot.access", botId: "b", access: { disabledTools: ["bash", "two words"], disabledSkills: [{ name: "x" }] } });
  fake.frame({ t: "bot.access", botId: "../b", access: { disabledTools: [] } });
  fake.frame({ t: "bot.access", botId: "b" });
  fake.frame({ t: "bot.memory.status", botId: "b", access: { disabledTools: ["read"] } });
  assert.deepEqual(heard, [["w-1", "b", { disabledTools: ["bash"], disabledSkills: [] }]]);
});

test("memory status comes from what the worker reports: the first ask watches it, one request for a whole list, and a lost connection forgets it", async () => {
  const fake = link();
  const { bots } = portsOf(fake);
  const memory = bots.memory("w-1");
  assert.deepEqual(await Promise.all(["durable:1", "durable:2", "durable:3"].map((reference) => memory.status(reference))), [undefined, undefined, undefined], "nothing reported yet, and nothing awaited");
  await tick();
  assert.deepEqual(fake.requests.map(({ op, params }) => [op, params]), [["bot.memory.watch", { references: ["durable:1", "durable:2", "durable:3"] }]]);
  fake.frame({ t: "bot.memory.status", reference: "durable:2", status: { ...STATUS, waiting: true } });
  fake.frame({ t: "bot.memory.status", reference: "durable:3", status: { messages: "many" } });
  assert.deepEqual(await memory.status("durable:2"), { ...STATUS, waiting: true });
  assert.equal(await memory.status("durable:3"), undefined, "half a status is no status");
  await memory.status("durable:2");
  await tick();
  assert.equal(fake.requests.length, 1, "a watched memory is not asked for again");

  // A view brings the status it counts.
  fake.state.replies.set("bot.memory.view", () => ({ text: "<chat>\n</chat>", status: { ...STATUS, messages: 5 } }));
  await memory.view("durable:4");
  assert.equal((await memory.status("durable:4"))?.messages, 5);

  // Offline, a bot shows no memory; once back, the next ask watches again.
  fake.close();
  assert.equal(await memory.status("durable:2"), undefined);
  fake.open();
  assert.equal(await memory.status("durable:2"), undefined);
  await tick();
  assert.deepEqual(fake.requests.at(-1), { id: "w-1", op: "bot.memory.watch", params: { references: ["durable:2"] } });

  // A live view hears each report; it is watched again after a reconnect.
  const heard: number[] = [];
  const stop = memory.subscribe("durable:9", (status) => heard.push(status.messages));
  await tick();
  fake.frame({ t: "bot.memory.status", reference: "durable:9", status: STATUS });
  assert.deepEqual(heard, [3]);
  fake.close();
  fake.open();
  await tick();
  assert.deepEqual(fake.requests.at(-1)?.params, { references: ["durable:9"] });
  stop();
  fake.frame({ t: "bot.memory.status", reference: "durable:9", status: STATUS });
  assert.deepEqual(heard, [3]);
});

test("a worker is named by its id or a name only it has", async () => {
  const { bots } = portsOf(link());
  assert.deepEqual(await bots.find("w-1"), { id: "w-1", name: "devbox" });
  assert.deepEqual(await bots.find(" devbox "), { id: "w-1", name: "devbox" });
  await assert.rejects(bots.find("twin"), (error: unknown) => error instanceof BotInputError && /2 workers are named twin\. Use its id/u.test(error.message));
  await assert.rejects(bots.find("nowhere"), (error: unknown) => error instanceof BotInputError && /No worker named nowhere\. See Settings → Workers\./u.test(error.message));
});

test("only a complete status is reported", () => {
  assert.deepEqual(reportedStatus({ ...STATUS, extra: "internal", failing: { node: "2+1", error: "rate limited", since: "now" } }), { ...STATUS, failing: { node: "2+1", error: "rate limited", since: "now" } });
  assert.equal(reportedStatus({ ...STATUS, usage: undefined }), undefined);
  assert.equal(reportedStatus({ ...STATUS, viewLines: -1 }), undefined);
});

test("clean-ups for a worker that no longer exists are dropped when the gateway starts", async () => {
  const fake = link();
  const cleanupFile = join(config, "bot-cleanup-start.json");
  await writeFile(cleanupFile, JSON.stringify({ version: 1, cleanups: [
    { worker: "w-1", botId: "a", cwd: "/srv/a", at: "" }, { worker: "gone", botId: "b", cwd: "/srv/b", at: "" }, { worker: "w-1", botId: "../x", cwd: "/srv/x" },
  ] }));
  remoteBots(fake.workers, { cleanupFile });
  await waitFor("the unknown worker's clean-up to go", async () => JSON.parse(await readFile(cleanupFile, "utf8")).cleanups.length === 1, {
    state: async () => JSON.parse(await readFile(cleanupFile, "utf8")),
  });
  assert.deepEqual(JSON.parse(await readFile(cleanupFile, "utf8")).cleanups.map((entry: { botId: string }) => entry.botId), ["a"], "an invalid entry goes too");
});

test("explicit memories require a capable connected worker and never fall back to this gateway", async () => {
  const fake = link(); const { bots } = portsOf(fake); const facts = bots.facts!("w-1");
  await assert.rejects(facts.list("one"), BotMemoryUnavailableError);
  assert.equal(fake.requests.length, 0);
  fake.state.features.push("bot-facts");
  fake.state.replies.set("bot.facts.list", () => ({ facts: [] }));
  assert.deepEqual(await facts.list("one"), []);
  assert.equal(fake.requests[0]!.op, "bot.facts.list");
  fake.close();
  await assert.rejects(facts.list("one"), BotWorkerOfflineError);
});
