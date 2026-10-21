import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "vitest";
import type { BotView } from "../server/bots-format.ts";
import type { AutomationRun, AutomationTask } from "../server/automation.ts";
import type { BotIO } from "./gateway-client.ts";
import { HELP, parseCli } from "./main.ts";
import { formatSchedules, scheduleCommand, taskFacts, type ScheduleSession } from "./schedules.ts";

function bot(id: string, handle: string): BotView {
  return {
    id, handle, name: handle[0]!.toUpperCase() + handle.slice(1), cwd: `/home/me/bots/${id}`, sessionId: `s-${handle}`,
    createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", status: "idle", soul: true, unread: false, routines: 0,
  };
}

function task(id: string, name: string, sessionId: string, extra: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id, name, description: "", sessionId, prompt: `${name} prompt`, schedule: { kind: "every", everyMs: 86_400_000 }, enabled: true,
    timeoutSeconds: 900, createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", nextRunAt: "2026-10-08T07:00:00.000Z", ...extra,
  };
}

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** A stand-in gateway: the session list, the bot list and the Automation routes over in-memory state. */
async function fakeGateway(t: TestContext) {
  const bots = [bot("id-ada", "ada"), bot("id-bob", "bob")];
  const sessions: ScheduleSession[] = [
    { id: "s-docs", title: "Docs cleanup", group: "hui" },
    { id: "s-twin-1", title: "Twin", group: "hui" }, { id: "s-twin-2", title: "Twin", group: "hui" },
    { id: "s-ada", title: "Ada", group: "bots", bot: { id: "id-ada", handle: "ada", name: "Ada" } },
    { id: "s-bob", title: "Bob", group: "bots", bot: { id: "id-bob", handle: "bob", name: "Bob" } },
  ];
  const tasks: AutomationTask[] = [
    task("t-morning", "Morning", "s-ada", { schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Madrid" }, createdBy: { kind: "operator" } }),
    task("t-watch", "Watch #82", "s-ada", { schedule: { kind: "every", everyMs: 300_000 }, nextRunAt: "2026-10-07T12:05:00.000Z", createdBy: { kind: "bot", botId: "id-ada", handle: "ada" }, until: "2026-10-07T16:00:00.000Z", runsLeft: 3 }),
    task("t-nightly", "Nightly review", "s-docs", { schedule: { kind: "cron", expression: "0 2 * * *", timezone: "UTC" }, enabled: false, nextRunAt: null }),
    task("t-inbox", "Inbox", "s-bob"),
  ];
  const runs: AutomationRun[] = [
    { id: "r-1", taskId: "t-watch", taskName: "Watch #82", sessionId: "s-ada", source: "scheduled", status: "completed", createdAt: "2026-10-07T12:00:00.000Z", startedAt: "2026-10-07T12:00:00.000Z", summary: "Still red." },
  ];
  const calls: Call[] = [];
  let next = 1;
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url!, "http://gateway");
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    calls.push({ method: request.method!, path: url.pathname + url.search, ...(body ? { body } : {}) });
    const reply = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.headers["x-hui"] !== "1") return reply(403, { error: "missing x-hui header" });
    const path = url.pathname;
    if (path === "/__hui/sessions") return reply(200, { revision: 1, groups: [{ label: "hui", sessions: sessions.filter((each) => !each.bot) }, { label: "bots", sessions: sessions.filter((each) => each.bot) }] });
    if (path === "/__hui/bots") return reply(200, { bots: url.searchParams.get("archived") === "1" ? [] : bots });
    if (path === "/__hui/automation") return reply(200, { scheduler: { enabled: true, activeRuns: 0, nextWakeAt: null }, tasks, runs });
    if (path === "/__hui/automation/tasks" && request.method === "POST") {
      const { runs: count, until, ...fields } = body as Record<string, unknown>;
      const created = { ...task(`t-new-${next++}`, "", ""), ...fields, createdBy: { kind: "operator" }, nextRunAt: fields["enabled"] === false ? null : "2026-10-07T13:00:00.000Z",
        ...(typeof until === "string" ? { until } : {}), ...(typeof count === "number" ? { runsLeft: count } : {}) } as AutomationTask;
      tasks.push(created);
      return reply(201, { task: created, snapshot: {} });
    }
    const match = /^\/__hui\/automation\/tasks\/([^/]+)(\/run)?$/u.exec(path);
    const index = match ? tasks.findIndex((each) => each.id === decodeURIComponent(match[1]!)) : -1;
    if (match && index < 0) return reply(404, { error: "Unknown automation task." });
    if (match?.[2]) return reply(202, { run: { id: "r-new", taskId: tasks[index]!.id, taskName: tasks[index]!.name, sessionId: tasks[index]!.sessionId, source: "manual", status: "queued", createdAt: "" } });
    if (match && request.method === "DELETE") { tasks.splice(index, 1); return reply(200, { snapshot: { tasks } }); }
    if (match && request.method === "PUT") {
      // As the gateway: absent limits stay, null clears them.
      const { runs: count, until, ...fields } = body as Record<string, unknown>;
      const { until: _until, runsLeft: _runsLeft, ...kept } = tasks[index]!;
      const keptUntil = until === undefined ? tasks[index]!.until : until ?? undefined;
      const keptRuns = count === undefined ? tasks[index]!.runsLeft : count ?? undefined;
      tasks[index] = { ...kept, ...fields, nextRunAt: fields["enabled"] === false ? null : "2026-10-07T14:00:00.000Z",
        ...(typeof keptUntil === "string" ? { until: keptUntil } : {}), ...(typeof keptRuns === "number" ? { runsLeft: keptRuns } : {}) } as AutomationTask;
      return reply(200, { snapshot: { tasks } });
    }
    reply(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(() => resolve())); });
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, tasks, calls, sessions: new Map(sessions.map((each) => [each.id, each])) };
}

function terminal() {
  let out = "";
  const io: BotIO = {
    out: (text) => { out += text; }, err: () => {}, readStdin: async () => "", lines: async function* () { /* no typing here */ }, onInterrupt: () => () => {},
    interactive: false, ask: async () => "", cwd: "/home/me", timezone: "Europe/Madrid",
  };
  return { io, get out() { return out; } };
}

/** Runs one command the way `hui` parses it. */
async function hui(base: string, args: string[]) {
  const parsed = parseCli(args);
  const term = terminal();
  const code = await scheduleCommand(base, parsed.command.slice("schedule ".length), parsed.operands ?? [], parsed.values, term.io);
  return { code, out: term.out };
}

test("hui schedule parses every command, accepting schedule and schedules, with only its own flags", () => {
  assert.equal(parseCli(["schedule"]).command, "schedule list");
  assert.equal(parseCli(["schedules", "list", "--bot", "ada"]).values.bot, "ada");
  assert.deepEqual(parseCli(["schedule", "show", "Watch #82", "--json"]).operands, ["Watch #82"]);
  const added = parseCli(["schedule", "add", "--name", "Watch", "--prompt", "Check #82", "--every", "5m", "--bot", "ada", "--until", "2026-10-07T18:00:00+02:00", "--runs", "3", "--timeout", "120", "--description", "CI", "--disabled"]);
  assert.deepEqual([added.command, added.operands, added.values.every, added.values.until, added.values.runs, added.values.timeout, added.values.disabled], ["schedule add", [], "5m", "2026-10-07T18:00:00+02:00", "3", "120", true]);
  assert.deepEqual(parseCli(["schedule", "edit", "t-1", "--until", "", "--runs", ""]).values.until, "", "on edit an empty limit clears it");
  assert.equal(parseCli(["schedule", "edit", "Nightly", "--timezone", "Asia/Tokyo"]).values.timezone, "Asia/Tokyo", "a cron's time zone alone");
  for (const verb of ["pause", "resume", "run", "remove"]) assert.deepEqual(parseCli(["schedule", verb, "Nightly"]).command, `schedule ${verb}`);
  for (const [args, message] of [
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5m"], /needs --bot <bot> or --session <session>/u],
    [["schedule", "add", "--name", "x", "--every", "5m", "--bot", "ada"], /needs --name and --prompt/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--bot", "ada"], /needs one of --at, --every or --cron/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5m", "--cron", "* * * * *", "--bot", "ada"], /Use one of --at, --every or --cron/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5m", "--bot", "ada", "--session", "s-1"], /Use either --bot or --session/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5m", "--bot", "ada", "--timezone", "UTC"], /--timezone only applies to --cron/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5 minutes", "--bot", "ada"], /duration such as 30s/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--at", "tomorrow", "--bot", "ada"], /--at takes an ISO date and time/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5m", "--bot", "ada", "--until", ""], /--until takes an ISO date and time, such as/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5m", "--bot", "ada", "--runs", "0"], /--runs takes 1-1000 runs\./u],
    [["schedule", "edit", "x", "--runs", "1001"], /--runs takes 1-1000 runs; "" clears it/u],
    [["schedule", "add", "--name", "x", "--prompt", "y", "--every", "5m", "--bot", "ada", "--timeout", "5"], /--timeout takes 10-86400 seconds/u],
    [["schedule", "add", "--name", " ", "--prompt", "y", "--every", "5m", "--bot", "ada"], /--name can't be empty/u],
    [["schedule", "add", "Extra", "--name", "x", "--prompt", "y", "--every", "5m", "--bot", "ada"], /schedule add takes no operands/u],
    [["schedule", "edit", "x"], /schedule edit needs at least one of/u],
    [["schedule", "edit", "--name", "y"], /schedule edit needs <schedule>/u],
    [["schedule", "show"], /schedule show needs <schedule>/u],
    [["schedule", "list", "--name", "x"], /--name is not valid for schedule list/u],
    [["schedule", "run", "x", "--every", "5m"], /--every is not valid for schedule run/u],
    [["schedule", "dance"], /Unknown command/u],
    [["schedule", "list", "extra"], /schedule list takes no operands/u],
  ] as const) assert.throws(() => parseCli([...args]), message, args.join(" "));
});

test("HELP lists every hui schedule command and says how temporary schedules work", () => {
  for (const line of [
    "hui schedule list [--bot <bot> | --session <session>] [--json]",
    "hui schedule show <schedule> [--json]",
    "hui schedule add --name <name> --prompt <text> (--at <ISO time> | --every <duration> | --cron <expr> [--timezone <tz>])",
    "(--bot <bot> | --session <session>) [--description <text>] [--timeout <seconds>]",
    "[--until <ISO time>] [--runs <n>] [--disabled] [--json]",
    "hui schedule edit <schedule> [same flags as add] [--json]",
    "hui schedule pause|resume|run|remove <schedule> [--json]",
    "\"schedules\"\nworks as \"schedule\"",
    "A temporary schedule ends by\nitself",
  ]) assert.ok(HELP.includes(line), line);
});

test("list shows every schedule with its target, maker and limits; --bot and --session narrow it, by handle or title; --json prints the tasks", async (t) => {
  const gateway = await fakeGateway(t);
  const all = await hui(gateway.base, ["schedule", "list"]);
  assert.equal(all.out, [
    "Morning  cron 0 9 * * 1-5 (Europe/Madrid)  next 2026-10-08T07:00:00.000Z  @ada  t-morning",
    "Watch #82  every 5m  next 2026-10-07T12:05:00.000Z  @ada  made by @ada · until 2026-10-07T16:00:00.000Z · 3 runs left  t-watch",
    "Nightly review  cron 0 2 * * * (UTC)  paused  session \"Docs cleanup\"  t-nightly",
    "Inbox  every 1d  next 2026-10-08T07:00:00.000Z  @bob  t-inbox",
    "",
  ].join("\n"));
  const ada = await hui(gateway.base, ["schedules", "list", "--bot", "@ada", "--json"]);
  assert.deepEqual((JSON.parse(ada.out) as AutomationTask[]).map((each) => each.id), ["t-morning", "t-watch"]);
  assert.match((await hui(gateway.base, ["schedule", "list", "--session", "Docs cleanup"])).out, /^Nightly review {2}.* {2}t-nightly\n$/u);
  await assert.rejects(hui(gateway.base, ["schedule", "list", "--session", "Twin"]), /2 sessions are titled Twin: use an id \(s-twin-1, s-twin-2\)/u);
  assert.equal((await hui(gateway.base, ["schedule", "list", "--session", "s-twin-1"])).out, "session \"Twin\" has no schedules.\n");
  const shown = await hui(gateway.base, ["schedule", "show", "Watch #82"]);
  assert.equal(shown.out, [
    "Watch #82",
    "target: @ada (Ada), a bot's routine",
    "schedule: every 5m",
    "state: on · next run 2026-10-07T12:05:00.000Z",
    "until: 2026-10-07T16:00:00.000Z (HUI deletes it then)",
    "runs left: 3 (HUI deletes it after the last)",
    "made by: @ada (its routines tool)",
    "timeout: 900s",
    "last run: completed · scheduled · 2026-10-07T12:00:00.000Z",
    "prompt: Watch #82 prompt",
    "id: t-watch",
    "",
  ].join("\n"));
  assert.match((await hui(gateway.base, ["schedule", "show", "t-nightly"])).out, /\nstate: paused\nmade by: not recorded \(made before HUI recorded it\)\n/u);
  await assert.rejects(hui(gateway.base, ["schedule", "show", "Ghost"]), /No schedule named Ghost\. See hui schedule list\./u);
});

test("add aims one task at a bot's chat or a session with its limits; edit changes only what it names and moves it; pause, resume, run and remove act on it", async (t) => {
  const gateway = await fakeGateway(t);
  const added = await hui(gateway.base, ["schedule", "add", "--name", "Release check", "--prompt", "Is v0.2 out?", "--cron", "0 18 * * 5", "--session", "Docs cleanup", "--until", "2026-10-31T00:00:00+01:00", "--runs", "4", "--timeout", "120", "--description", "Fridays"]);
  assert.deepEqual(gateway.calls.at(-1)?.body, {
    name: "Release check", description: "Fridays", sessionId: "s-docs", prompt: "Is v0.2 out?", schedule: { kind: "cron", expression: "0 18 * * 5", timezone: "Europe/Madrid" },
    enabled: true, timeoutSeconds: 120, until: "2026-10-30T23:00:00.000Z", runs: 4,
  });
  assert.equal(added.out, "Added schedule Release check for session \"Docs cleanup\"; first run 2026-10-07T13:00:00.000Z. Temporary: until 2026-10-30T23:00:00.000Z · 4 runs left; HUI deletes it after either.\n");
  const routine = await hui(gateway.base, ["schedule", "add", "--name", "Tea", "--prompt", "Remind me.", "--every", "2h", "--bot", "bob", "--disabled"]);
  assert.equal(routine.out, "Added schedule Tea for @bob, paused.\n");
  assert.equal(gateway.calls.at(-1)?.body?.["sessionId"], "s-bob");

  // Edit: only what it names. The limits stay unless named; "" clears them.
  await hui(gateway.base, ["schedule", "edit", "Watch #82", "--every", "10m"]);
  let body = gateway.calls.at(-1)!.body!;
  assert.deepEqual([body["schedule"], body["prompt"], "until" in body, "runs" in body, body["sessionId"]], [{ kind: "every", everyMs: 600_000 }, "Watch #82 prompt", false, false, "s-ada"]);
  assert.deepEqual([gateway.tasks.find((each) => each.id === "t-watch")?.until, gateway.tasks.find((each) => each.id === "t-watch")?.runsLeft], ["2026-10-07T16:00:00.000Z", 3]);
  const edited = await hui(gateway.base, ["schedule", "edit", "t-watch", "--until", "", "--runs", "", "--session", "s-docs", "--prompt", "Check #83"]);
  body = gateway.calls.at(-1)!.body!;
  assert.deepEqual([body["until"], body["runs"], body["sessionId"], body["prompt"]], [null, null, "s-docs", "Check #83"]);
  assert.equal(edited.out, "Updated schedule Watch #82, now for session \"Docs cleanup\"; next run 2026-10-07T14:00:00.000Z.\n");
  await hui(gateway.base, ["schedule", "edit", "Morning", "--timezone", "Asia/Tokyo"]);
  assert.deepEqual(gateway.calls.at(-1)?.body?.["schedule"], { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Tokyo" }, "a cron's time zone alone");
  await hui(gateway.base, ["schedule", "edit", "Morning", "--cron", "0 10 * * *"]);
  assert.deepEqual(gateway.calls.at(-1)?.body?.["schedule"], { kind: "cron", expression: "0 10 * * *", timezone: "Asia/Tokyo" }, "a new cron keeps the task's time zone");
  await assert.rejects(hui(gateway.base, ["schedule", "edit", "Inbox", "--timezone", "UTC"]), /--timezone only applies to a cron schedule, and Inbox runs every 1d/u);
  await hui(gateway.base, ["schedule", "edit", "Inbox", "--bot", "ada", "--disabled"]);
  assert.deepEqual([gateway.calls.at(-1)?.body?.["sessionId"], gateway.calls.at(-1)?.body?.["enabled"]], ["s-ada", false]);

  assert.equal((await hui(gateway.base, ["schedule", "resume", "Nightly review"])).out, "Resumed schedule Nightly review; next run 2026-10-07T14:00:00.000Z.\n");
  assert.equal(gateway.calls.at(-1)?.body?.["enabled"], true);
  assert.equal((await hui(gateway.base, ["schedule", "pause", "Nightly review"])).out, "Paused schedule Nightly review.\n");
  const requests = gateway.calls.length;
  assert.equal((await hui(gateway.base, ["schedule", "pause", "Nightly review"])).out, "Nightly review was already paused.\n");
  assert.equal(gateway.calls.filter((call) => call.method === "PUT").length, gateway.calls.slice(0, requests).filter((call) => call.method === "PUT").length, "nothing to change, nothing sent");
  assert.equal((await hui(gateway.base, ["schedule", "run", "Morning"])).out, "Started Morning; @ada answers in its chat.\n");
  assert.equal(gateway.calls.at(-1)?.path, "/__hui/automation/tasks/t-morning/run");
  assert.equal((await hui(gateway.base, ["schedule", "run", "Release check"])).out, "Started Release check; it runs in session \"Docs cleanup\".\n");
  assert.deepEqual(JSON.parse((await hui(gateway.base, ["schedule", "remove", "Tea", "--json"])).out), { removed: "Tea", id: "t-new-2" });
  assert.equal(gateway.tasks.some((each) => each.name === "Tea"), false);
});

test("the facts a schedule shows: who made it, until when and how many runs it has left", () => {
  assert.equal(taskFacts({}), "");
  assert.equal(taskFacts({ createdBy: { kind: "operator" }, runsLeft: 1 }), "1 run left");
  assert.equal(taskFacts({ createdBy: { kind: "bot", botId: "b", handle: "ada" }, until: "2026-10-07T16:00:00.000Z", runsLeft: 0 }), "made by @ada · until 2026-10-07T16:00:00.000Z · last run");
  assert.equal(formatSchedules([], new Map(), "None."), "None.");
  assert.equal(formatSchedules([task("t-1", "Gone", "s-missing")], new Map(), ""), "Gone  every 1d  next 2026-10-08T07:00:00.000Z  session s-missing (gone)  t-1");
});
