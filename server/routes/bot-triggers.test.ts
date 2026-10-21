import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test, type TestContext } from "vitest";
import { BotTriggerCreated, BotTriggersList } from "../api/bot-triggers.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import type { BotView } from "../bots-format.ts";
import type { BotIO } from "../../cli/gateway-client.ts";

// One isolated gateway: its home, HUI's directory, PI's agent directory, a deterministic provider and a fake GitHub
// behind a fake gh, which reads the pull requests deliveries link to, all temporary.
const dir = await mkdtemp(join(tmpdir(), "hui-check-trigger-routes-"));
const agentDir = join(dir, "agent");
const workspace = join(dir, "workspace");
const ghDir = join(dir, "gh");
await mkdir(agentDir);
await mkdir(workspace);
await mkdir(ghDir);
process.env["HOME"] = dir;
process.env["XDG_CONFIG_HOME"] = join(dir, "config");
process.env["PI_CODING_AGENT_DIR"] = agentDir;
process.env["HUI_GITHUB_CLI"] = fileURLToPath(new URL("../../e2e/fixtures/github-triggers-fixture.mjs", import.meta.url));
process.env["HUI_FAKE_GH_DIR"] = ghDir;
const log = join(dir, "requests.jsonl");
const provider = spawn(process.execPath, [fileURLToPath(new URL("../../e2e/fixtures/pi-provider-fixture.mjs", import.meta.url))], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: workspace, HUI_E2E_PROVIDER_LOG: log },
});
const [ready] = await once(provider.stdout!, "data");
const providerUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
assert(providerUrl, String(ready));
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
  baseUrl: providerUrl, api: "anthropic-messages", apiKey: "***", models: [{ id: "fixture", name: "fixture", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", defaultThinkingLevel: "low" }));
await mkdir(join(dir, "config", "hui"), { recursive: true });
const PAST = "2026-09-01T10:00:00Z";
const pull = (number: number, author: string, created: string) => ({
  number, title: `Pull request ${number}`, html_url: `https://github.com/acme/widgets/pull/${number}`, state: "open", draft: false, user: { login: author },
  head: { ref: `feature-${number}`, sha: String(number).repeat(40).slice(0, 40) }, base: { ref: "main" }, labels: [], created_at: created, updated_at: created, merged_at: null, body: "",
});
const github = { login: "operator", repos: { "acme/widgets": { pulls: [pull(1, "alice", PAST)] } } };
await writeFile(join(ghDir, "github.json"), JSON.stringify(github));

const { middleware } = await import("../hui.ts");
const { startBackend, stopBackend } = await import("../backend.ts");
const { triggerCommand } = await import("../../cli/bot-triggers.ts");
const { liveSessions } = await import("../sessions/live-sessions.ts");
let origin = "";
const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404).end(); }));

beforeAll(async () => {
  await startBackend();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  // The backend first: its triggers' last writes settle before their directory goes.
  await stopBackend();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const exit = once(provider, "exit");
  provider.kill();
  await exit;
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function call(path: string, method = "GET", body?: unknown, guard = true): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + path, {
    method,
    headers: { ...(guard ? { "x-hui": "1" } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: response.status, body: parsed };
}

/** A call to a trigger's URL as a listener makes it: no x-hui, a body of its own. */
async function hook(path: string, body: string, type = "application/json", method = "POST"): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + path, { method, headers: { "content-type": type }, ...(method === "GET" ? {} : { body }) });
  return { status: response.status, body: JSON.parse(await response.text() || "{}") as Record<string, unknown> };
}

async function until<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The lines another process has finished appending to a log: one it is still writing waits for the next read. */
const completeLines = (text: string): string[] => text.split("\n").slice(0, -1).filter(Boolean);

/** Whether a provider request's newest message contains `text` (compared as the JSON the request carries it in). */
async function asked(text: string): Promise<boolean> {
  const lines = completeLines(await readFile(log, "utf8").catch(() => ""));
  const needle = JSON.stringify(text).slice(1, -1);
  return lines.some((line) => {
    const request = JSON.parse(line) as { messages?: unknown[] };
    return JSON.stringify(request.messages?.at(-1) ?? "").includes(needle);
  });
}

const call64 = (calls: unknown) => `E2E_CALL:${Buffer.from(JSON.stringify(calls)).toString("base64url")}`;
let ada: BotView;

/** The provider's controls: `E2E_REPLAY` holds an answer until it is released. */
const control = (path: string, init?: RequestInit) => fetch(`${providerUrl}/control/${path}`, init);

/** Every gated tool at once, as `who` would have the bot call them, with the triggers tool's list. */
const gated = (who: string) => [
  { name: "set_profile", input: { title: `Retitled by ${who}` } },
  { name: "write_soul", input: { soul: `# Ada\nRewritten by ${who}.` } },
  { name: "triggers", input: { action: "list" } },
  { name: "routines", input: { action: "add", name: `Added by ${who}`, prompt: "Look again.", every: "1h" } },
  { name: "routines", input: { action: "update", routine: "Standing", every: "2h" } },
];

/** An operator's routine of Ada's, for the routines tool to try to change; it and the routines named here go once the
 * test ends. */
async function standingRoutine(t: TestContext, ...names: string[]): Promise<void> {
  const made = await call("/__hui/automation/tasks", "POST", { name: "Standing", sessionId: ada.sessionId, prompt: "E2E_STANDING look", schedule: { kind: "every", everyMs: 3_600_000 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  t.onTestFinished(async () => {
    const { tasks } = (await call("/__hui/automation")).body as { tasks: Array<{ id: string; name: string; sessionId: string }> };
    for (const task of tasks.filter((each) => each.sessionId === ada.sessionId && ["Standing", ...names].includes(each.name))) {
      await call(`/__hui/automation/tasks/${task.id}`, "DELETE");
    }
  });
}
const routineNamed = async (name: string) => ((await call("/__hui/automation")).body as { tasks: Array<{ name: string; sessionId: string; schedule: unknown }> }).tasks.find((task) => task.sessionId === ada.sessionId && task.name === name);

/** What the tools told Ada in the turn of the latest message starting with `start`, once her chat is idle. */
async function answerTo(start: string): Promise<string> {
  return until(`the answer to "${start}"`, async () => {
    if (liveSessions.status(ada.sessionId) !== "idle") return undefined;
    const entries = liveSessions.transcript(ada.sessionId);
    const index = entries.findLastIndex((entry) => entry.kind === "message" && entry.role === "user" && entry.text.startsWith(start));
    const reply = index < 0 ? undefined : entries.slice(index + 1).find((entry) => entry.kind === "message" && entry.role === "assistant" && entry.text.startsWith("tool answered: "));
    return reply?.kind === "message" ? reply.text : undefined;
  }, 60_000);
}

/** Holds an operator's turn of Ada's at the provider. */
async function holdOperatorTurn(): Promise<void> {
  assert.deepEqual((await call(`/__hui/bots/${ada.id}/messages`, "POST", { text: "E2E_REPLAY the operator's own turn" })).body, { status: "sent" });
  await control("wait-replay-ready");
}

/** Here a message to a busy bot waits in HUI's queue; the operator steers the one starting with `start` into the turn. */
async function steerQueued(start: string): Promise<void> {
  const item = await until(`"${start}" in HUI's queue`, async () => liveSessions.snapshot(ada.sessionId).queue.items?.find((each) => each.text.startsWith(start)));
  assert.equal((await call(`/__hui/sessions/${ada.sessionId}/queue`, "POST", { operation: "steer", itemId: item.id })).status, 200);
}

const soulOf = async () => (await call(`/__hui/bots/${ada.id}/soul`)).body["soul"];
const profileOf = async () => {
  const bot = (await call(`/__hui/bots/${ada.id}`)).body["bot"] as BotView;
  return { name: bot.name, handle: bot.handle, title: bot.title };
};
/** A listener trigger of Ada's, its prompt `prompt`, and its URL. */
async function listenerTrigger(name: string, prompt?: string): Promise<string> {
  const made = await call(`/__hui/bots/${ada.id}/triggers`, "POST", { name, ...(prompt ? { prompt } : {}), cooldownSeconds: 0 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return (made.body as unknown as BotTriggerCreated).hook.path;
}
/** The trigger's listener reports one event, `id`. */
const reportOne = (path: string, id: string) => hook(path, JSON.stringify({ events: [{ id, summary: `something happened (${id})` }] }));
const triggerNamed = async (name: string) => ((await call(`/__hui/bots/${ada.id}/triggers`)).body as unknown as BotTriggersList).triggers.find((each) => each.name === name);
/** Once the test ends, however it went: Ada's triggers named here go, and her title and SOUL.md are as they were. */
function restoreAfter(t: TestContext, ...triggers: string[]): void {
  const before = Promise.all([profileOf(), soulOf()]);
  t.onTestFinished(async () => {
    for (const name of triggers) await call(`/__hui/bots/${ada.id}/triggers/${encodeURIComponent(name)}`, "DELETE");
    const [profile, soul] = await before;
    await call(`/__hui/bots/${ada.id}`, "PATCH", { title: profile.title ?? "" });
    await call(`/__hui/bots/${ada.id}/soul`, "PUT", { soul });
  });
}

test("a listener trigger: another program's reports reach the bot through the gateway, each event once, with its pull request read; the URL checks the token, method, size and body, and the trigger shows the last report", { timeout: 120_000 }, async () => {
  const created = await call("/__hui/bots", "POST", { name: "Ada", soul: "# Ada\nA fixture bot." });
  assert.equal(created.status, 201);
  ada = created.body["bot"] as BotView;
  assert.equal((await call(`/__hui/bots/${ada.id}/triggers`, "GET", undefined, false)).status, 403, "the trigger routes keep the local-client guard");
  const refused = await call(`/__hui/bots/${ada.id}/triggers`, "POST", { name: "x", source: "github", filter: { repos: ["acme/widgets"], events: ["pr_opened"] } });
  assert.equal(refused.status, 400);
  assert.match(String(refused.body["error"]), /^source must be listener/u);
  const made = await call(`/__hui/bots/${ada.handle}/triggers`, "POST", { name: "Pings", prompt: "E2E_LISTENER_PROMPT review it", filter: { match: { field: "fields.channel", op: "equals", value: "G01REVIEWS" } }, cooldownSeconds: 0 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  expectSchema(BotTriggerCreated, made.body);
  const { hook: token, trigger } = made.body;
  const pings = async () => ((await call(`/__hui/bots/${ada.id}/triggers`)).body as unknown as BotTriggersList).triggers.find((each) => each.name === "Pings");
  const listed = (await call(`/__hui/bots/${ada.id}/triggers`)).body;
  expectSchema(BotTriggersList, listed);
  assert.ok(!JSON.stringify(listed).includes(token.token), "the token is shown once, never listed");
  assert.equal(listed.triggers[0]?.tokenHint, token.token.slice(0, 4));
  assert.deepEqual(listed.triggers[0]?.watch, { error: "No report from the listener since the gateway started." });

  assert.equal((await hook(`/__hui/hooks/${"x".repeat(43)}`, "{}")).status, 404, "a token no trigger has");
  assert.equal((await hook("/__hui/hooks/short", "{}")).status, 404);
  assert.equal((await hook(token.path, "", "application/json", "GET")).status, 405);
  assert.equal((await hook(token.path, JSON.stringify({ events: [], blob: "x".repeat(70 * 1024) }))).status, 413, "a body over 64 KiB");
  assert.equal((await hook(token.path, "{not json")).status, 400);
  assert.equal((await hook(token.path, "not a report", "text/plain")).status, 400, "a listener reports JSON");
  assert.deepEqual(await hook(token.path, JSON.stringify({ events: [] })), { status: 202, body: { status: "ignored" } }, "a check-in");
  const checked = await pings();
  assert.ok(checked?.watch?.polledAt && !checked.watch.error, "the trigger shows the listener's last report");
  const ping = { id: "G01REVIEWS:1791481674.389319", summary: "@rodrigo in #team-reviews: acme/widgets#1", details: "From Rodrigo, in #team-reviews\n  > could you review it?", links: ["https://github.com/acme/widgets/pull/1"], fields: { channel: "G01REVIEWS" } };
  assert.deepEqual(await hook(token.path, JSON.stringify({ events: [ping, { ...ping, id: "C0RANDOM:1", fields: { channel: "C0RANDOM" } }] })), { status: 202, body: { status: "fired" } });
  const header = "[trigger: Pings · @rodrigo in #team-reviews: acme/widgets#1] E2E_LISTENER_PROMPT review it";
  await until("the listener's event in the bot's chat", async () => (await asked(header)) || undefined);
  assert.equal(await asked("Pull request acme/widgets#1 \"Pull request 1\" by @alice"), true, "the pull request it links to, read through gh");
  assert.deepEqual(await hook(token.path, JSON.stringify({ events: [ping] })), { status: 202, body: { status: "ignored" } }, "the same event again");
  const bad = await hook(token.path, JSON.stringify({ events: [{ ...ping, id: undefined }] }));
  assert.equal(bad.status, 400);
  assert.match(String(bad.body["error"]), /events\[0\]\.id must be/u);
  // A run is recorded once the bot's chat took the delivery: wait for it rather than read it once.
  const after = await until("the delivery's run", async () => {
    const result = (await call(`/__hui/bots/${ada.id}/triggers`)).body as unknown as BotTriggersList;
    return result.runs.some((run) => run.triggerName === "Pings") ? result : undefined;
  });
  assert.deepEqual(after.runs.map((run) => [run.status, run.events, run.summary]), [["fired", 1, "@rodrigo in #team-reviews: acme/widgets#1"]], "one delivery, the other channel's left out");
  assert.equal(after.triggers[0]?.id, trigger.id);
  assert.ok(after.triggers[0]?.lastFiredAt);
  assert.equal(after.deliveries.lastHour, 1);
});

test("the bot's triggers tool lists its triggers; even the operator's own turn can't add one", { timeout: 120_000 }, async () => {
  const tools = [{ name: "triggers", input: { action: "list" } }, { name: "triggers", input: { action: "add", name: "Mine", source: "listener" } }];
  const reply = await call(`/__hui/bots/${ada.id}/messages`, "POST", { text: call64(tools), wait: true, timeoutSeconds: 60 });
  assert.equal(reply.status, 200);
  assert.match(String(reply.body["reply"]), /^tool answered: You have 1 trigger:\n- Pings \([0-9a-f]{8}\) · Listener · fields\.channel equals "G01REVIEWS" · cooldown none · on · last fired [^|]+\| [^|]*Validation failed for tool "triggers"/u, "the tool offers only list and remove");
  assert.equal(await triggerNamed("Mine"), undefined);
});

test("hui bot trigger lists and tests a bot's triggers through the gateway", { timeout: 60_000 }, async () => {
  let out = "";
  const io = { out: (text: string) => { out += text; }, err: (text: string) => { out += text; }, readStdin: async () => "", lines: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }) }) }), onInterrupt: () => () => {}, interactive: false, ask: async () => "", cwd: dir, timezone: "UTC" } satisfies BotIO;
  assert.equal(await triggerCommand(`${origin}/`, "list", ["ada"], {}, io), 0);
  assert.match(out, /Pings \([0-9a-f]{8}\) · Listener · fields\.channel equals "G01REVIEWS" · cooldown none · on · last fired /u);
  out = "";
  assert.equal(await triggerCommand(`${origin}/`, "test", ["ada", "Pings"], {}, io), 0);
  assert.match(out, /Sent a test event to @ada: test: a sample event\./u);
  await until("the test in the bot's chat", async () => (await asked("[trigger: Pings · test: a sample event] E2E_LISTENER_PROMPT review it")) || undefined);
});

test("a gated tool judges the run by every input it took: a trigger's message steered into the operator's running turn makes set_profile, write_soul and the routines tool's add and update refuse; the triggers tool's list and remove still work", { timeout: 120_000 }, async (t) => {
  restoreAfter(t, "Drop", "Joiner");
  await standingRoutine(t, "Added by a trigger");
  await listenerTrigger("Drop");
  const joiner = await listenerTrigger("Joiner", call64([...gated("a trigger"), { name: "triggers", input: { action: "remove", trigger: "Drop" } }]));
  const patched = await call(`/__hui/bots/${ada.id}/triggers/Joiner`, "PATCH", { delivery: "steer" });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const before = { profile: await profileOf(), soul: await soulOf() };

  await holdOperatorTurn();
  const link = "https://github.com/acme/widgets/pull/1";
  assert.deepEqual(await hook(joiner, JSON.stringify({ events: [{ id: "joiner-1", summary: "PR 1 feedback changed", details: `RAW SNAPSHOT ${"x".repeat(4_000)}`, links: [link] }] })), { status: 202, body: { status: "fired" } });
  const notice = await until("the compact trigger in the active turn's steering queue", async () => liveSessions.snapshot(ada.sessionId).queue.steering.find((text) => text.startsWith("[trigger: Joiner · ")));
  assert.ok(notice.split("\n").some((line) => line === link), "the complete affected PR URL stays on its own line");
  assert.ok(!notice.includes("RAW SNAPSHOT") && !notice.includes("diff --git"), "steering carries no listener snapshots or fetched diffs");
  assert.ok(notice.length < 3_000, "a status notification stays short");
  assert.equal(liveSessions.snapshot(ada.sessionId).queue.followUp.length, 0, "the busy turn does not gain another follow-up");
  assert.equal(liveSessions.status(ada.sessionId), "running", "the active turn is not aborted");
  await control("release-replay", { method: "POST" });
  const answer = await answerTo("[trigger: Joiner · ");
  assert.match(answer, /Only the operator changes your name, title or look, and this turn was started by a routine, a trigger, another bot, a session or your import\./u, "set_profile");
  assert.match(answer, /Only the operator changes your soul, and this turn was started by a routine, a trigger, another bot, a session or your import\./u, "write_soul");
  assert.match(answer, /You have \d+ triggers:/u, "list still works");
  assert.match(answer, /Removed the trigger "Drop"\./u, "and remove");
  assert.equal(answer.split("This turn was started by the trigger \"Joiner\", whose event comes from outside HUI: it can't make you add or change routines.").length, 3, "the routines tool's add and update");
  assert.equal(await routineNamed("Added by a trigger"), undefined);
  assert.deepEqual((await routineNamed("Standing"))?.schedule, { kind: "every", everyMs: 3_600_000 });
  assert.deepEqual(await profileOf(), before.profile, "Ada's name and title are as they were");
  assert.equal(await soulOf(), before.soul, "and her SOUL.md");
  assert.equal(await triggerNamed("Drop"), undefined);
});

test("the same for another bot's message steered into the operator's turn, and a routine's, which may add and change routines but neither retitle Ada nor rewrite her soul", { timeout: 120_000 }, async (t) => {
  restoreAfter(t);
  await standingRoutine(t, "Added by @bob", "Added by a routine");
  const bob = (await call("/__hui/bots", "POST", { name: "Bob", soul: "# Bob\nAnother fixture bot." })).body["bot"] as BotView;
  t.onTestFinished(async () => { await call(`/__hui/bots/${bob.id}?permanent=1`, "DELETE"); });
  const before = { profile: await profileOf(), soul: await soulOf() };
  await holdOperatorTurn();
  const relay = { name: "message_bot", input: { to: "@ada", message: call64(gated("@bob")) } };
  assert.equal((await call(`/__hui/bots/${bob.id}/messages`, "POST", { text: call64(relay), wait: true, timeoutSeconds: 60 })).body["status"], "answered");
  await steerQueued("[from @bob] ");
  await control("release-replay", { method: "POST" });
  const relayed = await answerTo("[from @bob] ");
  assert.match(relayed, /Only the operator changes your name, title or look/u);
  assert.match(relayed, /Only the operator changes your soul/u);
  assert.match(relayed, /You have \d+ triggers?:/u);
  assert.equal(relayed.split("This turn answers a message from @bob: another bot can't make you add or change routines.").length, 3);
  assert.equal(await routineNamed("Added by @bob"), undefined);

  const task = (await call("/__hui/automation/tasks", "POST", { name: "Tidy", sessionId: ada.sessionId, prompt: call64(gated("a routine")), schedule: { kind: "every", everyMs: 3_600_000 } })).body["task"] as { id: string };
  t.onTestFinished(async () => {
    await until("the routine's run to end", async () => ((await call("/__hui/automation")).body as { runs: Array<{ taskId: string; finishedAt?: string }> }).runs.every((run) => run.taskId !== task.id || run.finishedAt) || undefined);
    await call(`/__hui/automation/tasks/${task.id}`, "DELETE");
  });
  await holdOperatorTurn();
  const started = await call(`/__hui/automation/tasks/${task.id}/run`, "POST", {});
  assert.equal(started.status, 202);
  const run = started.body["run"] as { id: string };
  // Identified routines now wait durably in the runtime's inbox, not HUI's editable queue. Withdraw that exact
  // occurrence before steering its original marked input into this same operator turn: it must retain its origin
  // restrictions, and neither cancellation nor the test may dispatch the routine a second time later.
  const queued = await until("the routine in the durable inbox", async () => liveSessions.snapshot(ada.sessionId).queue.followUp.find((text) => text.startsWith("[routine: Tidy] ")));
  assert.equal(liveSessions.snapshot(ada.sessionId).queue.items?.some((item) => item.text === queued) ?? false, false);
  assert.equal((await call(`/__hui/automation/runs/${run.id}/cancel`, "POST", {})).status, 200);
  await until("the exact routine input to be withdrawn", async () => !liveSessions.snapshot(ada.sessionId).queue.followUp.includes(queued) || undefined);
  assert.equal(liveSessions.status(ada.sessionId), "running", "withdrawing the queued receipt leaves the operator's turn running");
  assert.equal((await call(`/__hui/sessions/${ada.sessionId}/steer`, "POST", { text: queued })).status, 200);
  await control("release-replay", { method: "POST" });
  const routine = await answerTo("[routine: Tidy] ");
  assert.match(routine, /Only the operator changes your name, title or look/u, "a routine's message can't retitle her");
  assert.match(routine, /Only the operator changes your soul/u, "nor rewrite her soul");
  assert.match(routine, /Added the routine "Added by a routine"/u, "the routines tool takes a routine's turn");
  assert.match(routine, /Updated the routine "Standing"/u);
  assert.deepEqual(await profileOf(), before.profile);
  assert.equal(await soulOf(), before.soul);
});

test("a run stays tainted to its end: the operator's message after a trigger's in the same run is refused too; an operator-only run is allowed, and so is the operator's next run", { timeout: 120_000 }, async (t) => {
  restoreAfter(t, "Ping");
  await standingRoutine(t, "Tainted", "Clean");
  const ping = await listenerTrigger("Ping", "E2E_PING look around");
  const mine = (title: string) => call64([
    { name: "set_profile", input: { title } },
    { name: "write_soul", input: { soul: `# Ada\n${title}.` } },
    { name: "routines", input: { action: "add", name: title, prompt: "Look again.", every: "1h" } },
  ]);
  const before = { profile: await profileOf(), soul: await soulOf() };

  // The operator, then a trigger, then the operator again, all in one run.
  await holdOperatorTurn();
  assert.deepEqual(await reportOne(ping, "ping-1"), { status: 202, body: { status: "fired" } });
  await steerQueued("[trigger: Ping · ");
  assert.equal((await call(`/__hui/sessions/${ada.sessionId}/steer`, "POST", { text: mine("Tainted") })).status, 200);
  await control("release-replay", { method: "POST" });
  const tainted = await answerTo(mine("Tainted"));
  assert.match(tainted, /Only the operator changes your name, title or look/u);
  assert.match(tainted, /Only the operator changes your soul/u);
  assert.deepEqual(await profileOf(), before.profile);
  assert.equal(await soulOf(), before.soul);
  assert.match(tainted, /This turn was started by the trigger "Ping", whose event comes from outside HUI: it can't make you add or change routines\./u);
  assert.equal(await routineNamed("Tainted"), undefined);

  // That run ended: the operator's next one, with a message of theirs joining it, may.
  await holdOperatorTurn();
  assert.equal((await call(`/__hui/sessions/${ada.sessionId}/steer`, "POST", { text: mine("Clean") })).status, 200);
  await control("release-replay", { method: "POST" });
  const clean = await answerTo(mine("Clean"));
  assert.match(clean, /Saved: you are Ada \(@ada\), Clean\./u, clean);
  assert.match(clean, /Saved your SOUL\.md/u);
  assert.match(clean, /Added the routine "Clean"/u);
  assert.equal(await soulOf(), "# Ada\nClean.");
});
