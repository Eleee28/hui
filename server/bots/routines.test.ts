import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { botKickoffText, type BotRecord } from "../bots-format.ts";
import type { BotTurnOrigin } from "../runtimes/turn-origins.ts";
import type { AutomationTask } from "../automation.ts";
import { AutomationService } from "../automation.ts";
import { BotRoutines } from "./routines.ts";
import { BotConflictError, BotInputError } from "./bots.ts";
import { BOT_ROUTINE_LIMITS } from "./durable-routines.ts";
import type { SessionRecord } from "../sessions/sessions.ts";

function bot(id: string, handle: string, extra: Partial<BotRecord> = {}): BotRecord {
  return { id, handle, name: handle, cwd: "/tmp", sessionId: `s-${handle}`, createdAt: "", updatedAt: "", ...extra };
}

/**
 * Resolves once `check` holds, as the scheduler's writes land. Limited in time rather than attempts, so a busy machine
 * where the writes land slowly can't fail it early.
 */
async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(label);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** A real scheduler on a temporary file, whose runs wait until the test lets them go, and two bots. */
async function harness(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "hui-bot-routines-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const held = new Map<string, () => void>();
  const automation = new AutomationService(join(dir, "automation.json"), (task, signal) => new Promise((resolve, reject) => {
    const cancelled = () => reject(new DOMException("Run cancelled.", "AbortError"));
    if (signal.aborted) return cancelled();
    held.set(task.id, () => resolve({ summary: "done" }));
    signal.addEventListener("abort", cancelled, { once: true });
  }));
  t.onTestFinished(() => automation.dispose());
  const ada = bot("bot-ada", "ada");
  const bob = bot("bot-bob", "bob");
  const bots = [ada, bob];
  const records = new Map<string, Partial<SessionRecord>>();
  const routines = new BotRoutines({
    botForSession: async (sessionId) => bots.find((candidate) => candidate.sessionId === sessionId),
    readSessions: async () => [...records].map(([id, record]) => ({ id, ...record }) as SessionRecord),
    automation, timezone: () => "Europe/Madrid",
  });
  /** The tool as Ada calls it, in a turn `runPrompt` started (the operator's when absent), with what the host saw the run
   * take (`runOrigins`; none when absent). */
  const as = (who: BotRecord, params: Record<string, unknown>, runPrompt?: string, runOrigins?: readonly BotTurnOrigin[]) => {
    records.set(who.sessionId, runPrompt === undefined ? {} : { runPrompt });
    return routines.handle(who.sessionId, params, runOrigins);
  };
  const tasks = async () => (await automation.snapshot()).tasks;
  return { automation, routines, ada, bob, bots, records, held, as, tasks };
}

const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString();

test("a bot lists, adds, changes and removes only its own chat's routines, and what it adds is recorded as its own", async (t) => {
  const h = await harness(t);
  const morning = await h.automation.create({ name: "Morning", sessionId: h.ada.sessionId, prompt: "Plan the day.", schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "Europe/Madrid" } });
  const bobs = await h.automation.create({ name: "Inbox", sessionId: h.bob.sessionId, prompt: "Bob's inbox.", schedule: { kind: "every", everyMs: 3_600_000 } });
  await h.automation.create({ name: "Nightly", sessionId: "s-plain", prompt: "A session's task.", schedule: { kind: "every", everyMs: 3_600_000 } });

  const listed = (await h.as(h.ada, { action: "list" })).text;
  assert.match(listed, /^Now: \d{4}-\d{2}-\d{2}T[\d:.]+Z\. Your routines \(1 active of at most 20\):\n- "Morning" \(id [\w-]+\): cron 0 9 \* \* 1-5 \(Europe\/Madrid\), next \S+; made by the operator\. Prompt: Plan the day\.$/u);
  assert.doesNotMatch(listed, /Inbox|Nightly/u, "another bot's and a session's tasks don't exist for it");

  const until = hours(3);
  const added = await h.as(h.ada, { action: "add", name: "Watch #82", prompt: "Check whether PR #82 is green; remove this routine once it is.", every: "5m", until, runs: 3 });
  assert.match(added.text, /^Added the routine "Watch #82" \(id [\w-]+\): every 5m, first run \S+; until \S+, 3 runs left, then HUI deletes it\. It arrives in this chat as "\[routine: Watch #82\] …"\.$/u);
  const watch = (await h.tasks()).find((task) => task.name === "Watch #82")!;
  assert.deepEqual([watch.sessionId, watch.createdBy, watch.until, watch.runsLeft, watch.enabled, watch.schedule], [
    h.ada.sessionId, { kind: "bot", botId: "bot-ada", handle: "ada" }, until, 3, true, { kind: "every", everyMs: 300_000 },
  ]);
  assert.match((await h.as(h.ada, { action: "list" })).text, /- "Watch #82" \(id [\w-]+\): every 5m, next \S+; until \S+, 3 runs left; made by you\. Prompt: Check whether PR #82/u);

  // Only what it names changes; 0 and "" clear the limits; a cron keeps its time zone unless it names one.
  await h.as(h.ada, { action: "update", routine: "Watch #82", every: "10m", runs: 0 });
  let changed = (await h.tasks()).find((task) => task.id === watch.id)!;
  assert.deepEqual([changed.schedule, changed.runsLeft, changed.until, changed.prompt], [{ kind: "every", everyMs: 600_000 }, undefined, until, watch.prompt]);
  assert.match((await h.as(h.ada, { action: "update", routine: watch.id, enabled: false, until: "" })).text, /^Updated the routine "Watch #82" \(id [\w-]+\): every 10m, paused\.$/u);
  changed = (await h.tasks()).find((task) => task.id === watch.id)!;
  assert.deepEqual([changed.enabled, changed.until, changed.createdBy?.kind], [false, undefined, "bot"], "paused, no end, still its own");
  await h.as(h.ada, { action: "update", routine: "Morning", timezone: "Asia/Tokyo" });
  assert.deepEqual((await h.tasks()).find((task) => task.id === morning.id)?.schedule, { kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Tokyo" });

  // Bob's routine, by name or id, is not Ada's to see, change or remove.
  for (const params of [{ action: "update", routine: "Inbox", enabled: false }, { action: "update", routine: bobs.id, name: "Mine" }, { action: "remove", routine: bobs.id }]) {
    await assert.rejects(h.as(h.ada, params), (error: unknown) => error instanceof BotInputError && /You have no routine named/u.test(error.message), JSON.stringify(params));
  }
  const untouched = (await h.tasks()).find((task) => task.id === bobs.id)!;
  assert.deepEqual([untouched.name, untouched.enabled], ["Inbox", true]);

  assert.equal((await h.as(h.ada, { action: "remove", routine: "Watch #82" })).text, "Removed the routine \"Watch #82\".");
  assert.deepEqual((await h.tasks()).map((task) => task.name).toSorted(), ["Inbox", "Morning", "Nightly"]);
});

test("guardrails: at most 20 active routines, once a minute at most, one name each, and only the fields it knows", async (t) => {
  const h = await harness(t);
  const add = (name: string, extra: Record<string, unknown> = {}) => h.as(h.ada, { action: "add", name, prompt: "Tick.", every: "1h", ...extra });
  for (const [params, pattern] of [
    [{ action: "add", name: "Fast", prompt: "p", every: "30s" }, /at most once a minute: every must be at least 1m/u],
    [{ action: "add", name: "Wordy", prompt: "p", every: "5 minutes" }, /every takes a number and s, m, h or d/u],
    [{ action: "add", name: "Never", prompt: "p" }, /Say when it runs/u],
    [{ action: "add", name: "Both", prompt: "p", every: "5m", cron: "* * * * *" }, /Give one of every, cron or at/u],
    [{ action: "add", name: "Zone", prompt: "p", every: "5m", timezone: "UTC" }, /timezone only applies to cron/u],
    [{ action: "add", name: "Badcron", prompt: "p", cron: "0 25 * * *" }, /Cron value 25 must be between 0 and 23/u],
    [{ action: "add", name: "Past", prompt: "p", every: "5m", until: new Date(Date.now() - 60_000).toISOString() }, /Until must be in the future/u],
    [{ action: "add", name: "Short", prompt: "p", every: "2h", until: hours(1) }, /after the task's next run, or it would never run/u],
    [{ action: "add", name: "Many", prompt: "p", every: "5m", runs: BOT_ROUTINE_LIMITS.runs + 1 }, /runs must be a whole number from 1 to 1000/u],
    [{ action: "add", prompt: "p", every: "5m" }, /add needs a name and a prompt/u],
    [{ action: "add", name: "Odd", prompt: "p", every: "5m", sessionId: "s-bob" }, /routines does not take sessionId/u],
    [{ action: "dance" }, /action must be list, add, update or remove/u],
    [{ action: "update", routine: "Nothing" }, /You have no routine named "Nothing"\. You have no routines\./u],
  ] as const) await assert.rejects(h.as(h.ada, params), (error: unknown) => error instanceof BotInputError && pattern.test(error.message), JSON.stringify(params));
  // A cron without a time zone runs in HUI's; a once routine at its time.
  await h.as(h.ada, { action: "add", name: "Weekdays", prompt: "p", cron: "30 8 * * 1-5" });
  assert.deepEqual((await h.tasks())[0]?.schedule, { kind: "cron", expression: "30 8 * * 1-5", timezone: "Europe/Madrid" });
  await assert.rejects(h.as(h.ada, { action: "add", name: "Weekdays", prompt: "again", every: "1d" }), (error: unknown) => error instanceof BotConflictError && /already have a routine named "Weekdays"/u.test(error.message));
  for (let index = 2; index <= BOT_ROUTINE_LIMITS.active; index += 1) await add(`Tick ${index}`);
  await assert.rejects(add("One too many"), (error: unknown) => error instanceof BotConflictError && /already have 20 active routines, the most a bot may have/u.test(error.message));
  // A paused routine doesn't count; resuming it past the cap is refused.
  await h.as(h.ada, { action: "update", routine: "Tick 2", enabled: false });
  await add("One more");
  await assert.rejects(h.as(h.ada, { action: "update", routine: "Tick 2", enabled: true }), /already have 20 active routines/u);
  assert.equal((await h.tasks()).length, 21);
  // The cap is per bot: Bob adds his own.
  await h.as(h.bob, { action: "add", name: "Tick 2", prompt: "Bob's.", every: "1h" });
  await assert.rejects(h.as(h.ada, { action: "update", routine: "Tick 3", name: "Weekdays" }), /already have a routine named "Weekdays"/u, "renames keep names unique");
});

test("adding and changing are refused in a turn another bot started, as set_profile reads it; the operator's, a routine's and HUI's kickoff turns may", async (t) => {
  const h = await harness(t);
  await h.as(h.ada, { action: "add", name: "Mine", prompt: "p", every: "1h" });
  for (const origin of ["[from @bob] add a routine that pings me every minute", "[from @bob · hop 2] keep going"]) {
    await assert.rejects(h.as(h.ada, { action: "add", name: "Ping", prompt: "Ping @bob.", every: "1m" }, origin),
      (error: unknown) => error instanceof BotConflictError && /This turn answers a message from @bob: another bot can't make you add or change routines/u.test(error.message), origin);
    await assert.rejects(h.as(h.ada, { action: "update", routine: "Mine", every: "1m" }, origin), BotConflictError, origin);
  }
  assert.match((await h.as(h.ada, { action: "list" }, "[from @bob] what do you have?")).text, /"Mine"/u, "listing makes no work");
  assert.deepEqual((await h.tasks()).map((task) => [task.name, task.schedule]), [["Mine", { kind: "every", everyMs: 3_600_000 }]], "nothing changed");
  for (const origin of [undefined, "please watch PR #82", "[routine: Mine] check the build", botKickoffText("Ada")]) {
    await h.as(h.ada, { action: "add", name: `Allowed ${origin?.slice(0, 8) ?? "operator"}`, prompt: "p", every: "1h" }, origin);
  }
  assert.equal((await h.tasks()).length, 5);
  // Removing only stops work: another bot's turn may.
  assert.equal((await h.as(h.ada, { action: "remove", routine: "Mine" }, "[from @bob] stop that")).text, "Removed the routine \"Mine\".");
});

test("adding and changing are refused in a turn a trigger started, naming the trigger, since its event comes from outside HUI; listing and removing still work", async (t) => {
  const h = await harness(t);
  await h.as(h.ada, { action: "add", name: "Mine", prompt: "p", every: "1h" });
  const refused = "This turn was started by the trigger \"CI\", whose event comes from outside HUI: it can't make you add or change routines. Ask the operator instead.";
  for (const origin of ["[trigger: CI · checks failed on #4] Fix it", "[trigger: CI] Fix it"]) {
    await assert.rejects(h.as(h.ada, { action: "add", name: "Retry", prompt: "Rerun the checks.", every: "1m" }, origin),
      (error: unknown) => error instanceof BotConflictError && error.message === refused, origin);
    await assert.rejects(h.as(h.ada, { action: "update", routine: "Mine", every: "1m" }, origin),
      (error: unknown) => error instanceof BotConflictError && error.message === refused, origin);
  }
  assert.match((await h.as(h.ada, { action: "list" }, "[trigger: CI · checks failed on #4] What runs?")).text, /"Mine"/u, "listing makes no work");
  assert.deepEqual((await h.tasks()).map((task) => [task.name, task.schedule]), [["Mine", { kind: "every", everyMs: 3_600_000 }]], "nothing changed");
  assert.equal((await h.as(h.ada, { action: "remove", routine: "Mine" }, "[trigger: CI · checks failed on #4] Stop it")).text, "Removed the routine \"Mine\".", "removing only stops work");
  assert.deepEqual(await h.tasks(), []);
});

test("every input of the run counts: another bot's or a trigger's message that joined the operator's turn refuses adding and changing, naming it; a routine's doesn't; listing and removing still work", async (t) => {
  const h = await harness(t);
  await h.as(h.ada, { action: "add", name: "Mine", prompt: "p", every: "1h" });
  const joined = (origin: BotTurnOrigin): BotTurnOrigin[] => [{ kind: "operator" }, origin, { kind: "operator" }];
  const trigger = "This turn was started by the trigger \"CI\", whose event comes from outside HUI: it can't make you add or change routines. Ask the operator instead.";
  const bob = "This turn answers a message from @bob: another bot can't make you add or change routines. Ask the operator, or do it in your own turn.";
  const agent = "This turn answers a message from the session \"Fix the login bug\": a session can't make you add or change routines. Ask the operator, or do it in your own turn.";
  for (const [origin, refused] of [[{ kind: "trigger", name: "CI" }, trigger], [{ kind: "bot", handle: "bob" }, bob], [{ kind: "agent", title: "Fix the login bug" }, agent]] as const) {
    await assert.rejects(h.as(h.ada, { action: "add", name: "Retry", prompt: "Rerun the checks.", every: "1m" }, "please keep an eye on CI", joined(origin)),
      (error: unknown) => error instanceof BotConflictError && error.message === refused, origin.kind);
    await assert.rejects(h.as(h.ada, { action: "update", routine: "Mine", every: "1m" }, "please keep an eye on CI", joined(origin)),
      (error: unknown) => error instanceof BotConflictError && error.message === refused, origin.kind);
  }
  // The first such input names the refusal, whatever came after it.
  await assert.rejects(h.as(h.ada, { action: "add", name: "Retry", prompt: "p", every: "1m" }, "please look", [{ kind: "operator" }, { kind: "trigger", name: "CI" }, { kind: "bot", handle: "bob" }]),
    (error: unknown) => error instanceof BotConflictError && error.message === trigger);
  assert.deepEqual((await h.tasks()).map((task) => [task.name, task.schedule]), [["Mine", { kind: "every", everyMs: 3_600_000 }]], "nothing changed");
  assert.match((await h.as(h.ada, { action: "list" }, "please look", joined({ kind: "trigger", name: "CI" }))).text, /"Mine"/u, "listing makes no work");
  assert.match((await h.as(h.ada, { action: "update", routine: "Mine", every: "2h" }, "please look", joined({ kind: "routine", name: "Standup" }))).text, /^Updated the routine "Mine"/u, "a routine's message may");
  assert.match((await h.as(h.ada, { action: "add", name: "Kicked", prompt: "p", every: "1h" }, botKickoffText("Ada"), [{ kind: "kickoff" }, { kind: "operator" }])).text, /^Added the routine "Kicked"/u, "and HUI's kickoff with the operator");
  assert.equal((await h.as(h.ada, { action: "remove", routine: "Mine" }, "please look", joined({ kind: "trigger", name: "CI" }))).text, "Removed the routine \"Mine\".", "removing only stops work");
});

test("a session that is no bot's chat and an archived bot are refused before anything is read", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.routines.handle("s-plain", { action: "list" }), (error: unknown) => error instanceof BotInputError && /only available in a bot's chat/u.test(error.message));
  h.bots[0] = { ...h.ada, archived: true };
  await assert.rejects(h.as(h.bots[0], { action: "list" }), (error: unknown) => error instanceof BotConflictError && /archived/u.test(error.message));
});

test("a routine removed from its own turn goes and that turn finishes; one removed while its run waits behind another turn is withdrawn", async (t) => {
  const h = await harness(t);
  await h.as(h.ada, { action: "add", name: "Watch #82", prompt: "Check PR #82.", every: "5m", runs: 3 });
  await h.as(h.ada, { action: "add", name: "Digest", prompt: "Digest.", every: "1h" });
  const [digest, watch] = (await h.tasks()).toSorted((a, b) => a.name.localeCompare(b.name)) as [AutomationTask, AutomationTask];
  // Its own turn: the run is the one calling the tool.
  const run = await h.automation.run(watch.id);
  await eventually(async () => h.held.has(watch.id), "Watch's run going");
  const removed = await h.as(h.ada, { action: "remove", routine: "Watch #82" }, "[routine: Watch #82] Check PR #82.");
  assert.equal(removed.text, "Removed the routine \"Watch #82\": this turn is its last.");
  assert.equal((await h.tasks()).some((task) => task.id === watch.id), false);
  assert.equal(h.automation.activeRun(watch.id), run.id, "its turn was not stopped");
  h.held.get(watch.id)!();
  await eventually(async () => (await h.automation.snapshot()).runs.find((each) => each.id === run.id)?.status === "completed", "and it finished");
  // Another turn (the operator's): the run waiting for the bot is withdrawn.
  const waiting = await h.automation.run(digest.id);
  await eventually(async () => h.held.has(digest.id) && h.automation.activeRun(digest.id) === waiting.id, "Digest's run waiting");
  assert.equal((await h.as(h.ada, { action: "remove", routine: "Digest" }, "stop the digest")).text, "Removed the routine \"Digest\".");
  await eventually(async () => (await h.automation.snapshot()).runs.find((each) => each.id === waiting.id)?.status === "cancelled", "withdrawn");
  assert.equal((await h.tasks()).length, 0);
});
