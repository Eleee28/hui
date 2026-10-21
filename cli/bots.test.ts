import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { botKickoffText, type BotCatalog, type BotCatalogTool, type BotMessageResult, type BotView } from "../server/bots-format.ts";
import type { AutomationTask } from "../server/automation.ts";
import { botCommand, formatBot, formatBots, formatLook, lookColor, parseZoom, questionAnswer } from "./bots.ts";
import { findBot, parseDuration, routineSchedule, type BotIO } from "./gateway-client.ts";

function view(id: string, handle: string, extra: Partial<BotView> = {}): BotView {
  return {
    id, handle, name: handle[0]!.toUpperCase() + handle.slice(1), cwd: `/home/me/bots/${id}`, sessionId: `s-${handle}`,
    createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", status: "idle", soul: false, unread: false, routines: 0, ...extra,
  };
}

type Call = { method: string; path: string; body?: Record<string, unknown> };

const SKILLS = [
  { name: "alpha", path: "/skills/alpha/SKILL.md", description: "Writes release notes.", source: "/skills" },
  { name: "beta", path: "hui:skill:beta", description: "Triage.", source: "HUI defaults" },
];
const TOOLS: Omit<BotCatalogTool, "enabled">[] = [
  { name: "read", label: "Read files", description: "Read files and images", group: "files", source: "Durable", powerful: false },
  { name: "bash", label: "Shell", description: "Run shell commands", group: "shell", source: "Durable", powerful: true },
  { name: "echo", label: "Echo", description: "Echo text back", group: "extension", source: "user · echo.js", powerful: false },
  { name: "message_bot", label: "Message bots", description: "Message another bot", group: "bots", source: "HUI", powerful: false },
];

/** The catalog route of the stand-in gateway: its tools and skills, against what the bot's record says is off. */
function catalogFor(bot: BotView): BotCatalog {
  const disabledTools = bot.disabledTools ?? [];
  // A name stands for its skill, as the gateway resolves it.
  const disabledSkills = ((bot.disabledSkills ?? []) as Array<string | { name: string; path: string }>)
    .map((skill) => (typeof skill === "string" ? { name: skill, path: SKILLS.find((each) => each.name === skill)!.path } : skill));
  return {
    tools: TOOLS.map((tool) => ({ ...tool, enabled: !disabledTools.includes(tool.name) })),
    skills: SKILLS.map((skill) => ({ ...skill, enabled: !disabledSkills.some((ref) => ref.name === skill.name && ref.path === skill.path) })),
    alwaysOn: [{ name: "write_soul", description: "Rewrite its SOUL.md" }, { name: "request_access", description: "Ask you" }],
    disabledTools, disabledSkills, live: true,
    ...(bot.id === "id-bob" ? { request: { id: "q-1", sessionId: "s-bob", title: "Allow access to bash (powerful)?", message: "To run the checks." } } : {}),
  };
}

/** A stand-in gateway: the bot, Automation and session routes over in-memory state, recording each request. */
async function fakeGateway(t: TestContext) {
  const bots: BotView[] = [
    view("id-ada", "ada", { title: "Researcher", routines: 1, soul: true, memory: { messages: 2, built: 3, pending: 0, viewBytes: 300, viewLines: 2, usage: { calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } } }),
    view("id-bob", "bob"), view("id-old", "old", { archived: true }),
  ];
  /** SOUL.md per bot id, as the soul route reads and writes it. */
  const souls = new Map<string, string>([["id-ada", "# Who I am\nAda, a researcher."]]);
  const tasks: AutomationTask[] = [{
    id: "task-1", name: "Morning", description: "", sessionId: "s-ada", prompt: "check", schedule: { kind: "every", everyMs: 86_400_000 },
    enabled: true, timeoutSeconds: 900, createdAt: "", updatedAt: "", nextRunAt: "2026-10-06T07:00:00.000Z",
  }];
  const calls: Call[] = [];
  const callWaiters = new Set<() => void>();
  const replies: BotMessageResult[] = [];
  const streams = new Map<string, ServerResponse>();
  const waiting = new Map<string, () => void>();
  let promptRefusal: string | undefined;
  let onPrompt: (text: string) => void = () => {};
  /** Prompts that arrived while no session stream was open. */
  const unseenPrompts: string[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url!, "http://gateway");
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    calls.push({ method: request.method!, path: url.pathname + url.search, ...(body ? { body } : {}) });
    for (const waiter of [...callWaiters]) waiter();
    const reply = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.headers["x-hui"] !== "1") return reply(403, { error: "missing x-hui header" });
    const stream = (key: string) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      // Like the gateway, a session stream begins with one coherent snapshot.
      if (key === "session") response.write(`event: snapshot\ndata: ${JSON.stringify({ status: "idle", questions: [], transcript: [] })}\n\n`);
      streams.set(key, response);
      waiting.get(key)?.();
    };
    const path = url.pathname;
    if (path === "/__hui/bots/events") return stream("bots");
    if (path === "/__hui/bots" && request.method === "GET") return reply(200, { bots: bots.filter((bot) => Boolean(bot.archived) === (url.searchParams.get("archived") === "1")) });
    if (path === "/__hui/bots" && request.method === "POST") {
      const name = typeof body?.["name"] === "string" ? body["name"] : "New Bot";
      const created = view("id-new", name.toLowerCase().replace(/\s+/gu, "-"), { name, soul: Boolean(body?.["soul"]), ...(body?.["avatar"] ? { avatar: body["avatar"] as BotView["avatar"] } : {}) });
      bots.push(created);
      return reply(201, { bot: created });
    }
    const botMatch = /^\/__hui\/bots\/([^/]+)(?:\/(.+))?$/u.exec(path);
    if (botMatch) {
      const index = bots.findIndex((bot) => bot.id === botMatch[1]);
      if (index < 0) return reply(404, { error: "No bot named that." });
      const bot = bots[index]!;
      const action = botMatch[2];
      if (!action && request.method === "GET") return reply(200, { bot });
      if (!action && request.method === "PATCH") { bots[index] = { ...bot, ...body }; return reply(200, { bot: bots[index] }); }
      if (!action && request.method === "DELETE" && url.searchParams.get("permanent") === "1") { bots.splice(index, 1); return reply(200, { ok: true }); }
      if (!action && request.method === "DELETE") { bots[index] = { ...bot, archived: true }; return reply(200, { bot: bots[index] }); }
      if (action === "restore") { const { archived: _archived, ...rest } = bot; bots[index] = rest; return reply(200, { bot: rest }); }
      if (action === "stop") { bots[index] = { ...bot, status: "idle" }; return reply(200, { bot: bots[index] }); }
      if (action === "messages") {
        const next = replies.shift() ?? { status: "sent" };
        return reply(body?.["wait"] ? 200 : 202, next);
      }
      if (action === "memory") {
        const usage = { calls: 3, input: 5_000, output: 400, cacheRead: 1_000, cacheWrite: 200, cost: 0.0123 };
        return reply(200, { status: { messages: 12, built: 11, pending: 1, viewBytes: 4096, viewLines: 9, waiting: true, usage }, view: "<chat>\n0+8|user: plans\n</chat>" });
      }
      if (action === "memory/zoom") return reply(200, { text: `${url.searchParams.get("id")}+0|user: the plan` });
      if (action === "catalog") return reply(200, catalogFor(bot));
      if (action === "soul" && request.method === "GET") return reply(200, { soul: souls.get(bot.id) ?? null });
      if (action === "soul" && request.method === "PUT") {
        const soul = String(body?.["soul"] ?? "").trim();
        if (soul) souls.set(bot.id, soul);
        else souls.delete(bot.id);
        bots[index] = { ...bot, soul: Boolean(soul) };
        return reply(200, { soul: soul || null });
      }
      if (action === "memory/html") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>memory</title>"); return; }
      return reply(405, { error: "method not allowed" });
    }
    if (path === "/__hui/automation") return reply(200, { scheduler: {}, tasks, runs: [] });
    if (path === "/__hui/automation/tasks" && request.method === "POST") {
      if ((body?.["schedule"] as { everyMs?: number } | undefined)?.everyMs === 30_000) return reply(400, { error: "Repeat interval must be at least one minute." });
      const task = { ...(body as object), id: "task-2", description: "", timeoutSeconds: 900, createdAt: "", updatedAt: "", nextRunAt: "2026-10-06T09:00:00.000Z" } as AutomationTask;
      tasks.push(task);
      return reply(201, { task, snapshot: {} });
    }
    const taskMatch = /^\/__hui\/automation\/tasks\/([^/]+)(\/run)?$/u.exec(path);
    if (taskMatch) {
      if (taskMatch[2]) return reply(202, { run: { id: "run-1", taskId: taskMatch[1], status: "queued" } });
      tasks.splice(tasks.findIndex((task) => task.id === taskMatch[1]), 1);
      return reply(200, { snapshot: {} });
    }
    const sessionMatch = /^\/__hui\/sessions\/([^/]+)\/(\w+)$/u.exec(path);
    if (sessionMatch) {
      const [, , verb] = sessionMatch;
      if (verb === "open") return reply(200, { session: {}, snapshot: { status: "idle", questions: [], transcript: [{ kind: "message", role: "user", text: "hi" }, { kind: "message", role: "assistant", text: "Last time we spoke." }] } });
      if (verb === "events") return stream("session");
      if (verb === "prompt" && promptRefusal) return reply(409, { error: promptRefusal });
      if (verb === "prompt" && !streams.has("session")) unseenPrompts.push(String(body?.["text"]));
      if (verb === "prompt") onPrompt(String(body?.["text"]));
      return reply(200, { ok: true });
    }
    reply(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => {
    for (const stream of streams.values()) stream.end();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}/`, bots, tasks, calls, replies, unseenPrompts, souls,
    /** Resolves once the CLI holds the `session` or `bots` stream open. */
    connected: (key: string) => streams.has(key) ? Promise.resolve() : new Promise<void>((resolve) => waiting.set(key, resolve)),
    push: (key: string, event: string, data: unknown) => { streams.get(key)!.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    /** A run settles as the gateway reports it: the event, the idle status, then a snapshot with the settled transcript. */
    settle: (transcript: unknown[]) => {
      const write = (event: string, data: unknown) => streams.get("session")!.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      write("event", { type: "settled", historyRefreshed: true });
      write("status", { status: "idle" });
      write("snapshot", { status: "idle", questions: [], transcript });
    },
    refusePrompts: (message: string | undefined) => { promptRefusal = message; },
    onPrompt: (listener: (text: string) => void) => { onPrompt = listener; },
    callsTo: (suffix: string) => calls.filter((call) => call.path.endsWith(suffix)),
    /** Resolves once `count` requests ending in `suffix` arrived. */
    received: (suffix: string, count = 1) => new Promise<void>((resolve) => {
      const check = () => {
        if (calls.filter((call) => call.path.endsWith(suffix)).length < count) return;
        callWaiters.delete(check);
        resolve();
      };
      callWaiters.add(check);
      check();
    }),
  };
}

/** A scripted terminal: lines the test types, Ctrl+C it presses, and everything written. */
function terminal(stdin = "", answers: string[] = [], interactive = false) {
  let out = "";
  let err = "";
  const asked: string[] = [];
  const watchers = new Set<() => void>();
  const queued: string[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  let interrupt: (() => void) | undefined;
  const written = () => { for (const watcher of watchers) watcher(); };
  const io: BotIO = {
    out: (text) => { out += text; written(); },
    err: (text) => { err += text; written(); },
    readStdin: async () => stdin,
    lines: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (!queued.length && !ended) await new Promise<void>((resolve) => { wake = resolve; });
          return queued.length ? { done: false, value: queued.shift()! } : { done: true, value: undefined };
        },
        return: async () => { ended = true; wake?.(); return { done: true, value: undefined }; },
      }),
    }),
    onInterrupt: (listener) => { interrupt = listener; return () => { interrupt = undefined; }; },
    interactive,
    ask: async (question) => { asked.push(question); return answers.shift() ?? ""; },
    cwd: "/home/me/work",
    timezone: "Europe/Madrid",
  };
  return {
    io,
    asked,
    get out() { return out; },
    get err() { return err; },
    type: (line: string) => { queued.push(line); wake?.(); },
    end: () => { ended = true; wake?.(); },
    ctrlC: () => interrupt?.(),
    /** Resolves once stdout matches. */
    until: (pattern: RegExp) => new Promise<void>((resolve) => {
      const check = () => { if (pattern.test(out)) { watchers.delete(check); resolve(); } };
      watchers.add(check);
      check();
    }),
  };
}

test("bots are found by id, handle or exact name, archived ones included, and shared names are refused", async (t) => {
  const gateway = await fakeGateway(t);
  assert.equal((await findBot(gateway.base, "id-bob")).handle, "bob");
  assert.equal((await findBot(gateway.base, "@ADA")).id, "id-ada");
  assert.equal((await findBot(gateway.base, "Bob")).id, "id-bob");
  assert.equal((await findBot(gateway.base, "old")).archived, true, "restore must find archived bots");
  gateway.bots.push(view("id-twin", "twin-a", { name: "Twin" }), view("id-twin-2", "twin-b", { name: "Twin" }));
  await assert.rejects(findBot(gateway.base, "Twin"), /2 bots are named Twin\. Use a handle or an id/u);
  await assert.rejects(findBot(gateway.base, "ghost"), /No bot named ghost\. See hui bot list\./u);
});

test("list, show, add, edit, remove, restore and stop talk to the bot routes and print for people or --json", async (t) => {
  const gateway = await fakeGateway(t);
  const dir = await mkdtemp(join(tmpdir(), "hui-cli-bots-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const term = terminal();
  term.io.cwd = dir;
  assert.equal(await botCommand(gateway.base, "list", [], {}, term.io), 0);
  assert.match(term.out, /^@ada {2}Ada {2}idle {2}Researcher {2}1 routine {2}id-ada\n@bob {2}Bob {2}idle {2}0 routines {2}id-bob\n$/u);
  const json = terminal();
  await botCommand(gateway.base, "list", [], { archived: true, json: true }, json.io);
  assert.deepEqual((JSON.parse(json.out) as BotView[]).map((bot) => bot.handle), ["old"]);

  const shown = terminal();
  await botCommand(gateway.base, "show", ["ada"], {}, shown.io);
  assert.match(shown.out, /^@ada · Ada \(Researcher\)\nstatus: idle\nlook: face · Cookie \(from its id\) · Yellow \(from its id\)\nmodel: default\nmemory: 2 messages · 3 summaries built · 0 pending · view 300 B in 2 lines · compactor 1 call, 1 token in, 1 out\nutility model: default \(Settings' utility model, else its model\)\nlanguage: auto\nroutines: 1\n/u);
  assert.match(shown.out, /\nsoul: SOUL\.md \(hui bot soul ada\)\n$/u);
  const unread = terminal();
  await botCommand(gateway.base, "show", ["bob"], {}, unread.io);
  assert.match(unread.out, /\nmemory: unavailable\n/u, "a memory the gateway cannot read");
  assert.match(unread.out, /\nsoul: none yet: it writes SOUL\.md in its first conversation\n$/u);

  await writeFile(join(dir, "soul.md"), "# Who I am\nNova, kind.\n");
  const added = terminal();
  added.io.cwd = dir;
  assert.equal(await botCommand(gateway.base, "add", [], { name: "Nova", "soul-file": "soul.md", cwd: "sub/dir", emoji: "🦊", "memory-model": "openai/mini" }, added.io), 0);
  assert.deepEqual(gateway.calls.at(-1), { method: "POST", path: "/__hui/bots", body: {
    name: "Nova", soul: "# Who I am\nNova, kind.\n", cwd: join(dir, "sub/dir"), memoryModel: "openai/mini", avatar: { emoji: "🦊" },
  } });
  assert.equal(added.out, "Added @nova (Nova) with the soul you gave it. Talk to it with hui bot chat nova.\n");
  const fresh = terminal();
  await botCommand(gateway.base, "add", [], { name: "Home", cwd: "~/bots/home" }, fresh.io);
  assert.equal(gateway.calls.at(-1)?.body?.["cwd"], "~/bots/home", "~ is left for the gateway to resolve");
  await botCommand(gateway.base, "add", [], { name: "Rover", worker: " devbox ", cwd: "/srv/rover" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { name: "Rover", worker: "devbox", cwd: "/srv/rover" }, "a folder on the worker goes as given; the worker checks it");
  assert.equal(fresh.out, "Added @home (Home). It starts by asking what you expect from it: talk with hui bot chat home.\n");
  const piped = terminal("# Who I am\nPiped.\n");
  await botCommand(gateway.base, "add", [], { name: "Piped", "soul-file": "-" }, piped.io);
  assert.equal(gateway.calls.at(-1)?.body?.["soul"], "# Who I am\nPiped.\n", "- reads the soul from stdin");
  const unnamed = terminal();
  await botCommand(gateway.base, "add", [], {}, unnamed.io);
  assert.deepEqual(gateway.calls.at(-1)?.body, {}, "no name: the gateway names it New Bot");
  assert.equal(unnamed.out, "Added @new-bot (New Bot). It starts by asking what to call it and what you expect from it: talk with hui bot chat new-bot.\n");

  await botCommand(gateway.base, "edit", ["ada"], { title: "Lead", thinking: "high" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1), { method: "PATCH", path: "/__hui/bots/id-ada", body: { title: "Lead", thinking: "high" } }, "only the given fields");
  await botCommand(gateway.base, "edit", ["ada"], { model: "", thinking: "", "memory-model": "" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { model: "", thinking: "", memoryModel: "" }, "empty values clear, back to the defaults");
  await botCommand(gateway.base, "edit", ["ada"], { "utility-model": "anthropic/claude-haiku" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { memoryModel: "anthropic/claude-haiku" }, "--utility-model is the stored memoryModel");
  await botCommand(gateway.base, "edit", ["ada"], { language: " ES " }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { voice: { language: "es" } }, "a language goes as its code");
  await botCommand(gateway.base, "edit", ["ada"], { language: "" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { voice: { language: "" } }, "an empty language goes back to Auto");
  // The look: an emoji, or the face's shape and color (palette names or #rrggbb); "" clears each, --emoji "" shows the face.
  await botCommand(gateway.base, "edit", ["ada"], { shape: "Pebble", color: "Mint" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { avatar: { shape: "round", color: "#2fc49a" } }, "a label and a palette name go as the id and hex");
  await botCommand(gateway.base, "edit", ["ada"], { emoji: "", color: "#FF6B4A" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { avatar: { emoji: "", color: "#ff6b4a" } });
  await botCommand(gateway.base, "edit", ["ada"], { shape: "", color: "" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { avatar: { shape: "", color: "" } }, "back to the id's face");
  await botCommand(gateway.base, "edit", ["ada"], { ears: "Cat ears" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { avatar: { ears: "cat" } }, "ears by their label go as the id");
  await botCommand(gateway.base, "edit", ["ada"], { ears: "" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { avatar: { ears: "" } }, "\"\" takes them off");
  await botCommand(gateway.base, "add", [], { name: "Heart", shape: "heart", color: "coral" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { name: "Heart", avatar: { shape: "heart", color: "#ff6b4a" } });
  await botCommand(gateway.base, "add", [], { name: "Lola", language: "yue" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { name: "Lola", voice: { language: "yue" } });
  const removed = terminal();
  await botCommand(gateway.base, "remove", ["bob"], {}, removed.io);
  assert.equal(gateway.calls.at(-1)?.method, "DELETE");
  assert.match(removed.out, /Archived @bob\. Its chat transcript and memory are kept and its routines are disabled; hui bot restore bob brings it back\./u);
  const restored = terminal();
  await botCommand(gateway.base, "restore", ["bob"], {}, restored.io);
  assert.match(restored.out, /Restored @bob\. Its routines stay disabled/u);
  gateway.bots[0]!.status = "running";
  const stopped = terminal();
  await botCommand(gateway.base, "stop", ["ada"], {}, stopped.io);
  assert.equal(stopped.out, "Stopped @ada's turn.\n");
  const idle = terminal();
  await botCommand(gateway.base, "stop", ["ada"], { json: true }, idle.io);
  assert.equal((JSON.parse(idle.out) as BotView).status, "idle");
});

test("list marks a bot on a worker and show names the worker and its folder there", () => {
  const rover = view("id-rover", "rover", { cwd: "/home/remote/.local/share/hui-worker/bots/id-rover", worker: { id: "w-1", name: "devbox" } });
  assert.equal(formatBots([rover, view("id-ada", "ada")]), "@rover  Rover  idle · on devbox  0 routines  id-rover\n@ada  Ada  idle  0 routines  id-ada");
  const shown = formatBot(rover);
  assert.match(shown, /\nstatus: idle\nworker: devbox \(w-1\)\nlook: /u);
  assert.match(shown, /\ncwd: devbox:\/home\/remote\/\.local\/share\/hui-worker\/bots\/id-rover\n/u);
  assert.doesNotMatch(formatBot(view("id-ada", "ada")), /worker:/u, "a bot here names no worker");
});

test("show names the look: the face's shape and color, or the emoji, and what the bot's id picked", () => {
  assert.equal(formatLook({ id: "id-ada" }), "face · Cookie (from its id) · Yellow (from its id)");
  assert.equal(formatLook({ id: "id-ada", avatar: { shape: "heart", color: "#2fc49a" } }), "face · Heart · Mint");
  assert.equal(formatLook({ id: "id-ada", avatar: { shape: "round", color: "#123456" } }), "face · Pebble · #123456", "a custom color shows as its hex");
  assert.equal(formatLook({ id: "id-ada", avatar: { shape: "ghost", ears: "horns", color: "#2fc49a" } }), "face · Ghost · Horns · Mint");
  assert.equal(formatLook({ id: "id-ada", avatar: { emoji: "🦊" } }), "emoji 🦊 · Yellow (from its id)");
  assert.equal(lookColor(" Lilac "), "#9b7cf6");
  assert.equal(lookColor("#ABCDEF"), "#abcdef");
  assert.equal(lookColor(""), "");
});

test("delete removes any bot for good once confirmed: a terminal is asked, anything else needs --yes", async (t) => {
  const gateway = await fakeGateway(t);
  await assert.rejects(botCommand(gateway.base, "delete", ["ada"], {}, terminal().io), /hui bot delete cannot ask here \(no terminal\): add --yes to delete @ada for good\./u);
  const declined = terminal("", ["n"], true);
  assert.equal(await botCommand(gateway.base, "delete", ["ada"], {}, declined.io), 1);
  assert.deepEqual(declined.asked, ["Delete @ada for good? Its chat leaves HUI and its routines, memory and folder go. [y/N] "]);
  assert.equal(declined.out, "Nothing was deleted.\n");
  assert.equal(gateway.calls.some((call) => call.method === "DELETE"), false, "nothing reached the gateway");

  const confirmed = terminal("", ["y"], true);
  assert.equal(await botCommand(gateway.base, "delete", ["ada"], {}, confirmed.io), 0, "an active bot too");
  assert.deepEqual(gateway.calls.at(-1), { method: "DELETE", path: "/__hui/bots/id-ada?permanent=1" });
  assert.equal(confirmed.out, "Deleted @ada for good: its chat left HUI, and its routines, memory and folder are gone.\n");
  const scripted = terminal();
  assert.equal(await botCommand(gateway.base, "delete", ["old"], { yes: true, json: true }, scripted.io), 0);
  assert.deepEqual(JSON.parse(scripted.out), { id: "id-old", handle: "old", deleted: true });
  assert.deepEqual(scripted.asked, [], "--yes never asks");
  assert.deepEqual(gateway.bots.map((bot) => bot.handle), ["bob"]);
});

test("soul prints SOUL.md or says the bot has none yet, and --file replaces it from a file or stdin; empty removes it", async (t) => {
  const gateway = await fakeGateway(t);
  const dir = await mkdtemp(join(tmpdir(), "hui-cli-soul-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const shown = terminal();
  assert.equal(await botCommand(gateway.base, "soul", ["ada"], {}, shown.io), 0);
  assert.equal(shown.out, "# Who I am\nAda, a researcher.\n");
  const none = terminal();
  await botCommand(gateway.base, "soul", ["bob"], {}, none.io);
  assert.equal(none.out, "@bob has no SOUL.md yet: it writes one in its first conversation with you (hui bot chat bob).\n");
  const json = terminal();
  await botCommand(gateway.base, "soul", ["bob"], { json: true }, json.io);
  assert.deepEqual(JSON.parse(json.out), { soul: null });

  await writeFile(join(dir, "bob.md"), "# Who I am\nBob, a builder.\n");
  const replaced = terminal();
  replaced.io.cwd = dir;
  await botCommand(gateway.base, "soul", ["bob"], { file: "bob.md" }, replaced.io);
  assert.deepEqual(gateway.calls.at(-1), { method: "PUT", path: "/__hui/bots/id-bob/soul", body: { soul: "# Who I am\nBob, a builder.\n" } });
  assert.equal(replaced.out, "Replaced @bob's SOUL.md (26 characters); its next turn follows it.\n");
  const piped = terminal("# Who I am\nBob, piped.");
  await botCommand(gateway.base, "soul", ["bob"], { file: "-", json: true }, piped.io);
  assert.deepEqual(JSON.parse(piped.out), { soul: "# Who I am\nBob, piped." });
  const cleared = terminal("");
  await botCommand(gateway.base, "soul", ["bob"], { file: "-" }, cleared.io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { soul: "" });
  assert.equal(cleared.out, "Removed @bob's SOUL.md. It asks what you expect from it again in its next turn (hui bot chat bob).\n");
});

test("tools and skills print what a bot has, on or off, and --deny / --allow send the whole new list", async (t) => {
  const gateway = await fakeGateway(t);
  const listed = terminal();
  assert.equal(await botCommand(gateway.base, "tools", ["ada"], {}, listed.io), 0);
  assert.equal(listed.out, [
    "@ada's tools: all 4 on. Changes apply from its next request.",
    "",
    "Files",
    "  on   read         Read files and images",
    "",
    "Shell",
    "  on   bash         Run shell commands (powerful)",
    "",
    "Extensions",
    "  on   echo         Echo text back  [user · echo.js]",
    "",
    "Bots",
    "  on   message_bot  Message another bot",
    "",
    "Always on: write_soul, request_access.",
    "",
  ].join("\n"));
  const denied = terminal();
  await botCommand(gateway.base, "tools", ["ada"], { deny: "bash, echo" }, denied.io);
  assert.deepEqual(gateway.calls.filter((call) => call.method === "PATCH").at(-1), { method: "PATCH", path: "/__hui/bots/id-ada", body: { disabledTools: ["bash", "echo"] } });
  assert.match(denied.out, /^@ada's tools: 2 of 4 off\./u);
  assert.match(denied.out, /\n {2}off  bash {9}Run shell commands \(powerful\)\n/u);
  const allowed = terminal();
  await botCommand(gateway.base, "tools", ["ada"], { allow: "bash", json: true }, allowed.io);
  assert.deepEqual(gateway.calls.filter((call) => call.method === "PATCH").at(-1)?.body, { disabledTools: ["echo"] }, "the rest stays off");
  assert.deepEqual((JSON.parse(allowed.out) as BotCatalog).disabledTools, ["echo"]);
  await assert.rejects(botCommand(gateway.base, "tools", ["ada"], { deny: "teleport" }, terminal().io), /^Error: Unknown tool: teleport\. @ada's tools: read, bash, echo, message_bot\.$/u);

  const skills = terminal();
  await botCommand(gateway.base, "skills", ["bob"], { deny: "alpha" }, skills.io);
  assert.deepEqual(gateway.calls.filter((call) => call.method === "PATCH").at(-1), { method: "PATCH", path: "/__hui/bots/id-bob", body: { disabledSkills: ["alpha"] } }, "a new one by name: the gateway resolves it");
  assert.equal(skills.out, [
    "@bob's skills: 1 of 2 off. Changes apply from its next request.",
    "",
    "  off  alpha  Writes release notes.  [/skills]",
    "  on   beta   Triage.  [HUI defaults]",
    "",
    "Waiting for you: Allow access to bash (powerful)? Answer it in hui bot chat bob or on its Tools & skills page.",
    "",
  ].join("\n"));
  await botCommand(gateway.base, "skills", ["bob"], { allow: "alpha" }, terminal().io);
  assert.deepEqual(gateway.calls.filter((call) => call.method === "PATCH").at(-1)?.body, { disabledSkills: [] });
  await assert.rejects(botCommand(gateway.base, "skills", ["bob"], { deny: "gamma" }, terminal().io), /Unknown skill: gamma\. @bob's skills: alpha, beta\./u);

  await botCommand(gateway.base, "add", [], { name: "Locked", "deny-tools": "bash", "deny-skills": "alpha, beta" }, terminal().io);
  assert.deepEqual(gateway.calls.findLast((call) => call.method === "POST" && call.path === "/__hui/bots")?.body, { name: "Locked", disabledTools: ["bash"], disabledSkills: ["alpha", "beta"] });
});

test("send reads - from stdin and exits 0 when answered, 1 on failure or timeout and 2 while the bot asks", async (t) => {
  const gateway = await fakeGateway(t);
  const piped = terminal("summarize the logs\n");
  assert.equal(await botCommand(gateway.base, "send", ["ada", "-"], {}, piped.io), 0);
  assert.deepEqual(gateway.calls.at(-1)?.body, { text: "summarize the logs\n" });
  assert.equal(piped.out, "Sent to @ada.\n");
  gateway.replies.push({ status: "queued" });
  const queued = terminal();
  await botCommand(gateway.base, "send", ["ada", "next"], {}, queued.io);
  assert.equal(queued.out, "Queued for @ada; it answers once its current turn ends.\n");

  const outcomes: Array<[BotMessageResult, number, RegExp, "out" | "err"]> = [
    [{ status: "answered", reply: "All green." }, 0, /^All green\.\n$/u, "out"],
    [{ status: "failed", error: "provider exploded" }, 1, /@ada failed: provider exploded/u, "err"],
    [{ status: "timeout" }, 1, /No answer within 90s; @ada keeps working/u, "err"],
    [{ status: "needs-input", questions: [{ id: "q1", method: "confirm", title: "Deploy", message: "Ship it?" }] }, 2, /\? Deploy\n {2}Ship it\?\n {2}Answer y or n, or \/cancel\.\n@ada needs an answer: reply with hui bot chat ada\./u, "out"],
    [{ status: "needs-input", questions: [{ id: "s1", method: "secret", title: "API key", message: "To deploy." }] }, 2, /\? Secret: API key\n {2}To deploy\.\n {2}Give it in HUI's Secret card, in this bot's chat, so it stays out of this terminal; or \/cancel\.\n@ada needs a secret: give it in HUI's Secret card, in its chat\./u, "out"],
    [{ status: "needs-input", questions: [{ id: "u1", method: "questionnaire", title: "Which auth?", options: ["Auth: Which auth?", "Scope: Which scope?"] }] }, 2, /\? Questions\n {2}1\. Auth: Which auth\?\n {2}2\. Scope: Which scope\?\n {2}Answer them in HUI, in this bot's chat; or \/cancel\.\n@ada has questions: answer them in HUI, in its chat\./u, "out"],
  ];
  for (const [result, code, pattern, stream] of outcomes) {
    gateway.replies.push(result);
    const term = terminal();
    assert.equal(await botCommand(gateway.base, "send", ["ada", "go"], { wait: true, timeout: "90" }, term.io), code, result.status);
    assert.match(term[stream], pattern);
    assert.deepEqual(gateway.calls.at(-1)?.body, { text: "go", wait: true, timeoutSeconds: 90 });
  }
  gateway.replies.push({ status: "needs-input", questions: [] });
  const json = terminal();
  assert.equal(await botCommand(gateway.base, "send", ["ada", "go"], { wait: true, json: true }, json.io), 2);
  assert.deepEqual(JSON.parse(json.out), { status: "needs-input", questions: [] });
  assert.deepEqual(gateway.calls.at(-1)?.body, { text: "go", wait: true }, "without --timeout the gateway's default applies");
});

test("memory prints the status and view, zooms a line and saves the browse page", async (t) => {
  const gateway = await fakeGateway(t);
  const dir = await mkdtemp(join(tmpdir(), "hui-cli-memory-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const term = terminal();
  await botCommand(gateway.base, "memory", ["ada"], {}, term.io);
  assert.equal(term.out, "12 messages · 11 summaries built · 1 pending · view 4 KB in 9 lines · summarizing · compactor 3 calls, 6200 tokens in, 400 out, $0.0123\n<chat>\n0+8|user: plans\n</chat>\n");
  const zoom = terminal();
  await botCommand(gateway.base, "memory", ["ada"], { zoom: "16+4" }, zoom.io);
  assert.equal(gateway.calls.at(-1)?.path, "/__hui/bots/id-ada/memory/zoom?id=16&n=4");
  assert.equal(zoom.out, "16+0|user: the plan\n");
  const html = terminal();
  html.io.cwd = dir;
  await botCommand(gateway.base, "memory", ["ada"], { html: "memory.html" }, html.io);
  assert.equal(await readFile(join(dir, "memory.html"), "utf8"), "<!doctype html><title>memory</title>");
  assert.equal(html.out, `Wrote @ada's memory to ${join(dir, "memory.html")}.\n`);
});

test("routines are the bot's Automation tasks: list, add on a schedule, run and remove by name", async (t) => {
  const gateway = await fakeGateway(t);
  const list = terminal();
  await botCommand(gateway.base, "routine list", ["ada"], {}, list.io);
  assert.equal(list.out, "Morning  every 1d  next 2026-10-06T07:00:00.000Z  task-1\n");
  const none = terminal();
  await botCommand(gateway.base, "routine list", ["bob"], {}, none.io);
  assert.match(none.out, /@bob has no routines/u);
  const added = terminal();
  await botCommand(gateway.base, "routine add", ["ada"], { name: "Standup", prompt: "Summarize yesterday", cron: "0 9 * * 1-5" }, added.io);
  assert.deepEqual(gateway.calls.at(-1)?.body, {
    name: "Standup", sessionId: "s-ada", prompt: "Summarize yesterday", schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Madrid" }, enabled: true,
  });
  assert.match(added.out, /Added routine Standup for @ada; first run 2026-10-06T09:00:00\.000Z\./u);
  await assert.rejects(botCommand(gateway.base, "routine add", ["ada"], { name: "Tick", prompt: "tick", every: "30s" }, terminal().io), /Repeat interval must be at least one minute\./u, "Automation's own minimum is surfaced");
  const ran = terminal();
  await botCommand(gateway.base, "routine run", ["ada", "Morning"], {}, ran.io);
  assert.equal(gateway.calls.at(-1)?.path, "/__hui/automation/tasks/task-1/run");
  assert.match(ran.out, /Started routine Morning; @ada answers in its chat\./u);
  await assert.rejects(botCommand(gateway.base, "routine run", ["bob", "Morning"], {}, terminal().io), /@bob has no routine named Morning/u, "another bot's routine is not this one's");
  const removed = terminal();
  await botCommand(gateway.base, "routine remove", ["ada", "Standup"], { json: true }, removed.io);
  assert.deepEqual(JSON.parse(removed.out), { removed: "Standup", id: "task-2" });
  assert.deepEqual(gateway.tasks.map((task) => task.name), ["Morning"]);
});

test("parsers turn durations, zoom lines, schedules and typed answers into requests", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  assert.throws(() => parseDuration("1w"), /30s, 5m, 2h or 1d/u);
  assert.deepEqual(parseZoom("2184+8"), { id: 2184, n: 8 });
  assert.throws(() => parseZoom("2184"), /id\+n/u);
  assert.deepEqual(routineSchedule({ at: "2026-10-06T09:00:00+02:00" }, "UTC"), { kind: "at", at: "2026-10-06T07:00:00.000Z" });
  assert.deepEqual(routineSchedule({ every: "2h" }, "UTC"), { kind: "every", everyMs: 7_200_000 });
  assert.deepEqual(routineSchedule({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }, "UTC"), { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Tokyo" });
  const select = { id: "q", method: "select" as const, title: "Pick", options: ["Alpha", "Beta"] };
  assert.deepEqual(questionAnswer(select, "2"), { id: "q", value: "Beta" });
  assert.deepEqual(questionAnswer(select, "alpha"), { id: "q", value: "Alpha" });
  assert.throws(() => questionAnswer(select, "3"), /number from 1 to 2/u);
  assert.deepEqual(questionAnswer({ id: "q", method: "confirm", title: "Sure?" }, "Y"), { id: "q", confirmed: true });
  assert.deepEqual(questionAnswer({ id: "q", method: "confirm", title: "Sure?" }, "no"), { id: "q", confirmed: false });
  assert.deepEqual(questionAnswer({ id: "q", method: "input", title: "Name" }, " Ada "), { id: "q", value: " Ada " }, "typed input is kept as typed");
  assert.deepEqual(questionAnswer({ id: "q", method: "editor", title: "Text" }, "/cancel"), { id: "q", cancelled: true });
  const secret = { id: "q", method: "secret" as const, title: "API key", message: "To deploy." };
  assert.throws(() => questionAnswer(secret, "sk-typed-here"), /HUI's Secret card/u, "a secret is never sent from the terminal");
  assert.deepEqual(questionAnswer(secret, " /cancel "), { id: "q", cancelled: true }, "but the request can be cancelled there");
  const questionnaire = { id: "q", method: "questionnaire" as const, title: "Which auth?", options: ["Auth: Which auth?"] };
  assert.throws(() => questionAnswer(questionnaire, "1"), /Answer these questions in HUI/u);
  assert.deepEqual(questionAnswer(questionnaire, "/cancel"), { id: "q", cancelled: true });
  assert.match(formatBots([]), /No bots\. Add one with hui bot add --name <name>\./u);
});

test("chat streams replies, prompts when idle and steers a running turn, answers questions inline and stops on Ctrl+C", async (t) => {
  const gateway = await fakeGateway(t);
  const term = terminal();
  const ada = gateway.bots[0]!;
  gateway.onPrompt((text) => {
    // The bot starts working on the prompt; the test decides when it ends.
    gateway.push("session", "status", { status: "running" });
    gateway.push("session", "event", { type: "turn_start" });
    gateway.push("session", "event", { type: "text", delta: `On it: ${text}` });
  });
  const exit = botCommand(gateway.base, "chat", ["ada"], {}, term.io);
  await term.until(/Chatting with @ada \(Ada\)\. Type a message and press Enter\. Ctrl\+C stops a turn; twice exits\.\n@ada: Last time we spoke\.\n/u);
  await gateway.connected("session");
  await gateway.connected("bots");

  term.type("hello");
  await term.until(/@ada: On it: hello/u);
  assert.deepEqual(gateway.callsTo("/prompt").map((call) => call.body), [{ text: "hello" }]);
  gateway.push("session", "event", { type: "tool_start", id: "t1", name: "read" });
  await term.until(/On it: hello\n· read\n/u);
  gateway.push("bots", "bots", { revision: 2, upserts: [{ ...ada, status: "running", memory: { messages: 3, built: 2, pending: 1, viewBytes: 10, waiting: true } }] });
  await term.until(/Summarizing memory…\n/u);
  term.type("also run the tests");
  await gateway.received("/steer");
  assert.deepEqual(gateway.callsTo("/steer").map((call) => call.body), [{ text: "also run the tests" }], "a running turn is steered, not prompted");
  gateway.push("session", "event", { type: "text", delta: "Tests pass." });
  await term.until(/@ada: Tests pass\./u);

  term.ctrlC();
  await term.until(/Stopping… \(Ctrl\+C again to exit\)\n/u);
  await gateway.received("/abort");
  gateway.settle([
    { kind: "message", role: "user", text: "hello" },
    { kind: "message", role: "assistant", text: "On it: hello" },
    { kind: "tool", id: "t1", name: "read" },
    { kind: "message", role: "user", text: "also run the tests" },
    { kind: "message", role: "assistant", text: "Tests pass." },
  ]);

  gateway.push("session", "event", { type: "question", question: { id: "q1", method: "select", title: "Which branch?", options: ["main", "dev"] } });
  await term.until(/\? Which branch\?\n {2}1\. main\n {2}2\. dev\n {2}Answer with a number, or \/cancel\.\n/u);
  term.type("7");
  await term.until(/error: Answer with a number from 1 to 2 \(or \/cancel\)\./u);
  term.type("2");
  await gateway.received("/question");
  assert.deepEqual(gateway.callsTo("/question").map((call) => call.body), [{ id: "q1", value: "dev" }]);

  // A turn that started meanwhile (a routine) refuses the prompt: the line steers it instead.
  gateway.refusePrompts("That session is already working on a prompt.");
  term.type("one more thing");
  await gateway.received("/steer", 2);
  assert.deepEqual(gateway.callsTo("/steer").at(-1)?.body, { text: "one more thing" });

  term.ctrlC();
  assert.equal(await exit, 130, "Ctrl+C on an idle chat exits");
  assert.equal(gateway.callsTo("/abort").length, 1, "nothing was running to stop");
});

test("chat sends nothing typed before its live stream is attached, so no reply finishes unseen", async (t) => {
  const gateway = await fakeGateway(t);
  const term = terminal();
  term.type("typed at once");
  gateway.onPrompt((text) => {
    gateway.push("session", "status", { status: "running" });
    gateway.push("session", "event", { type: "text", delta: `Reply to ${text}` });
    gateway.settle([{ kind: "message", role: "user", text }, { kind: "message", role: "assistant", text: `Reply to ${text}` }]);
  });
  const done = botCommand(gateway.base, "chat", ["ada"], {}, term.io);
  await term.until(/@ada: Reply to typed at once\n/u);
  assert.deepEqual(gateway.unseenPrompts, []);
  term.end();
  assert.equal(await done, 0);
  assert.equal(term.out.split("Reply to typed at once").length, 2, "a streamed reply is not repeated from the settled transcript");
});

test("chat prints what a settled run said without streaming it, and only the unstreamed tail of a partial stream", async (t) => {
  const gateway = await fakeGateway(t);
  const term = terminal();
  const history = [{ kind: "message", role: "user", text: "hi" }, { kind: "message", role: "assistant", text: "Last time we spoke." }];
  let turn = 0;
  gateway.onPrompt((text) => {
    turn += 1;
    gateway.push("session", "status", { status: "running" });
    if (turn === 1) {
      // Durable committed the quick reply whole: no deltas at all.
      gateway.settle([...history, { kind: "message", role: "user", text }, { kind: "tool", id: "t9", name: "bash" }, { kind: "message", role: "assistant", text: "Whole reply, never streamed." }]);
    } else {
      gateway.push("session", "event", { type: "text", delta: "Hello wor" });
      gateway.settle([...history, { kind: "message", role: "user", text: "first" }, { kind: "tool", id: "t9", name: "bash" }, { kind: "message", role: "assistant", text: "Whole reply, never streamed." }, { kind: "message", role: "user", text }, { kind: "message", role: "assistant", text: "Hello world." }]);
    }
  });
  const done = botCommand(gateway.base, "chat", ["ada"], {}, term.io);
  await gateway.connected("session");
  term.type("first");
  await term.until(/· bash\n@ada: Whole reply, never streamed\.\n/u);
  term.type("second");
  await term.until(/@ada: Hello world\.\n/u);
  term.end();
  assert.equal(await done, 0);
  assert.equal(term.out.split("Whole reply").length, 2, "printed once");
});

test("chat prints what the bot gets from elsewhere as > lines before the reply, and never what was typed here", async (t) => {
  const gateway = await fakeGateway(t);
  const term = terminal();
  const done = botCommand(gateway.base, "chat", ["ada"], {}, term.io);
  await gateway.connected("session");
  await term.until(/@ada: Last time we spoke\.\n$/u);
  const user = (text: string) => ({ kind: "message", role: "user", text });
  const reply = (text: string) => ({ kind: "message", role: "assistant", text });

  // A routine starts a turn: the snapshot that accepts its message comes before the reply streams.
  gateway.push("session", "status", { status: "running" });
  gateway.push("session", "snapshot", { status: "running", questions: [], transcript: [user("[routine: Morning] status report")] });
  await term.until(/> \[routine: Morning\] status report\n$/u);
  gateway.push("session", "event", { type: "text", delta: "All green." });
  let transcript = [user("[routine: Morning] status report"), reply("All green.")];
  gateway.settle(transcript);
  await term.until(/> \[routine: Morning\] status report\n@ada: All green\.\n$/u);

  // What is typed here is on screen already, prompt or steering: the snapshots that show it print nothing.
  gateway.onPrompt((text) => {
    transcript = [...transcript, user(text)];
    gateway.push("session", "status", { status: "running" });
    gateway.push("session", "snapshot", { status: "running", questions: [], transcript });
    gateway.push("session", "event", { type: "text", delta: `Got ${text}.` });
  });
  term.type("thanks");
  await term.until(/@ada: Got thanks\.$/u);
  term.type("and one more");
  await gateway.received("/steer");
  transcript = [...transcript, reply("Got thanks."), user("and one more")];
  gateway.push("session", "snapshot", { status: "running", questions: [], transcript });
  gateway.push("session", "event", { type: "text", delta: " Noted." });
  await term.until(/@ada: Got thanks\. Noted\.$/u);
  transcript = [...transcript.slice(0, -2), reply("Got thanks. Noted."), user("and one more")];
  gateway.settle(transcript);
  await term.until(/Noted\.\n$/u);

  // A message only the settled transcript shows (from the Bots tab, say): printed in its place, every line marked.
  gateway.push("session", "status", { status: "running" });
  gateway.settle([...transcript, user("from the tab\nsecond line"), reply("Seen it.")]);
  await term.until(/> from the tab\n> second line\n@ada: Seen it\.\n$/u);

  // HUI's kickoff of a new bot is a note, never the operator's words.
  const settled = [...transcript, user("from the tab\nsecond line"), reply("Seen it.")];
  gateway.push("session", "status", { status: "running" });
  gateway.push("session", "snapshot", { status: "running", questions: [], transcript: [...settled, user(botKickoffText("Ada"))] });
  await term.until(/· Ada was created\n$/u);
  gateway.settle([...settled, user(botKickoffText("Ada")), reply("What should I look after?")]);
  await term.until(/· Ada was created\n@ada: What should I look after\?\n$/u);
  term.end();
  assert.equal(await done, 0);
  assert.doesNotMatch(term.out, /> thanks|> and one more/u, "lines typed here are never printed again");
  assert.doesNotMatch(term.out, /HUI bot created/u);
  assert.equal(term.out.split("> [routine: Morning]").length, 2, "an announced message is not printed again at the settle");
});

test("chat ends cleanly when stdin closes, and reports a runtime that exits", async (t) => {
  const gateway = await fakeGateway(t);
  const closing = terminal();
  const done = botCommand(gateway.base, "chat", ["bob"], {}, closing.io);
  await gateway.connected("session");
  closing.end();
  assert.equal(await done, 0);

  const gateway2 = await fakeGateway(t);
  const crashed = terminal();
  const failed = botCommand(gateway2.base, "chat", ["bob"], {}, crashed.io);
  await gateway2.connected("session");
  gateway2.push("session", "closed", {});
  assert.equal(await failed, 1);
  assert.match(crashed.out, /@bob's chat runtime exited\./u);
});

test("show names a bot's language, auto when it has none", () => {
  const base: BotView = { id: "id-vox", handle: "vox", name: "Vox", cwd: "/tmp", sessionId: "s", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", status: "idle", soul: false, unread: false, routines: 0 };
  assert.match(formatBot(base), /\nlanguage: auto\n/u);
  const spanish = formatBot({ ...base, voice: { language: "es" } });
  assert.match(spanish, /\nlanguage: es \(Spanish\)\n/u);
  assert.doesNotMatch(spanish, /\nvoice:/u, "no VoiceStudio voice line");
  assert.match(formatBot({ ...base, voice: { language: "haw" } }), /\nlanguage: haw \(Hawaiian\)\n/u);
});


test("--call-voice sets the bot's GPT-Live voice, \"\" goes back to Settings' default, and show names it", async (t) => {
  const gateway = await fakeGateway(t);
  await botCommand(gateway.base, "edit", ["ada"], { "call-voice": " Ember " }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { voice: { live: "ember" } });
  await botCommand(gateway.base, "edit", ["ada"], { "call-voice": "", language: "es" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { voice: { language: "es", live: "" } });
  await botCommand(gateway.base, "add", [], { name: "Lola", "call-voice": "sol" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { name: "Lola", voice: { live: "sol" } });
  const base: BotView = { id: "id-vox", handle: "vox", name: "Vox", cwd: "/tmp", sessionId: "s", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", status: "idle", soul: false, unread: false, routines: 0 };
  assert.match(formatBot({ ...base, voice: { language: "es", live: "juniper" } }), /\nlanguage: es \(Spanish\)\ncall voice: Juniper\nroutines: /u);
  assert.doesNotMatch(formatBot(base), /call voice:/u, "without one it follows Settings");
});

test("--description says what a bot does and when to tag it, --tagging who may, and show says both", async (t) => {
  const gateway = await fakeGateway(t);
  await botCommand(gateway.base, "edit", ["ada"], { description: "Release notes. Tag her when a PR merges.", tagging: " Mention " }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { description: "Release notes. Tag her when a PR merges.", tagging: "mention" });
  await botCommand(gateway.base, "add", [], { name: "Lola", tagging: "nobody" }, terminal().io);
  assert.deepEqual(gateway.calls.at(-1)?.body, { name: "Lola", tagging: "nobody" });
  const base: BotView = { id: "id-vox", handle: "vox", name: "Vox", cwd: "/tmp", sessionId: "s", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", status: "idle", soul: false, unread: false, routines: 0 };
  assert.match(formatBot({ ...base, description: "Finds sources.", tagging: "mention" }), /\ndescription: Finds sources\.\ntagging: only when your message tags it\n/u);
  assert.match(formatBot(base), /\ntagging: anyone, when a task fits its description\n/u);
});
