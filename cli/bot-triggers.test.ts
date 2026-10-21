import assert from "node:assert/strict";
import { test } from "vitest";
import type { BotTriggersList } from "../server/bots/triggers-format.ts";
import { checkTriggerAdd, formatTriggers, parseCooldown, parseMatch, triggerBody } from "./bot-triggers.ts";
import { HELP, parseCli } from "./main.ts";

test("hui bot trigger parses list, add, remove and test with their operands and only their own flags", () => {
  assert.equal(parseCli(["bot", "trigger", "list", "ada"]).command, "bot trigger list");
  assert.equal(parseCli(["bots", "triggers", "list", "ada", "--json"]).command, "bot trigger list");
  const reviews = parseCli(["bot", "trigger", "add", "ada", "--name", "Reviews", "--match", "fields.channel=G01M4T1JFLK", "--pr-links", "--allow-external", "--cooldown", "0", "--prompt", "Review these."]);
  assert.deepEqual([reviews.command, reviews.operands], ["bot trigger add", ["ada"]]);
  assert.deepEqual(triggerBody(reviews.values),
    { name: "Reviews", prompt: "Review these.", cooldownSeconds: 0, source: "listener", filter: { match: { field: "fields.channel", op: "equals", value: "G01M4T1JFLK" }, prLinks: true, external: true } });
  assert.deepEqual(triggerBody(parseCli(["bot", "trigger", "add", "ada", "--name", "Anything", "--allow-bots"]).values), { name: "Anything", source: "listener", filter: { bots: true } });
  assert.deepEqual(parseCli(["bot", "trigger", "remove", "ada", "CI", "--json"]).operands, ["ada", "CI"]);
  assert.deepEqual(parseCli(["bot", "trigger", "test", "ada", "CI"]).operands, ["ada", "CI"]);
  for (const [args, message] of [
    [["bot", "trigger", "add", "ada", "--pr-links"], /needs --name/u],
    [["bot", "trigger", "add", "ada", "--name", "x", "--match", "nothing"], /field=value/u],
    [["bot", "trigger", "add", "ada", "--name", "x", "--cooldown", "soon"], /--cooldown takes 0 or a duration/u],
    [["bot", "trigger", "add", "ada", "--name", "x", "--github", "a/b"], /Unknown option '--github'/u],
    [["bot", "trigger", "add", "ada", "--name", "x", "--slack"], /Unknown option '--slack'/u],
    [["bot", "trigger", "add", "ada", "--name", "x", "--session", "kids"], /--session is not valid for bot trigger add/u],
    [["bot", "trigger", "remove", "ada"], /needs <bot> <trigger>/u],
    [["bot", "trigger", "test", "ada", "CI", "--match", "a=b"], /--match is not valid for bot trigger test/u],
    [["bot", "trigger", "pause", "ada"], /Unknown command/u],
    [["slack", "status"], /Unknown command/u],
  ] as const) {
    assert.throws(() => parseCli([...args]), message, args.join(" "));
  }
});

test("cooldowns and matches read as the help says", () => {
  assert.equal(parseCooldown("0"), 0);
  assert.equal(parseCooldown("45"), 45);
  assert.equal(parseCooldown("45s"), 45);
  assert.equal(parseCooldown("5m"), 300);
  assert.equal(parseCooldown("2h"), 7_200);
  assert.equal(parseCooldown("1d"), 86_400);
  assert.deepEqual(parseMatch("action~open"), { field: "action", op: "contains", value: "open" });
  assert.deepEqual(parseMatch("=ping"), { field: "", op: "equals", value: "ping" });
  assert.deepEqual(parseMatch("url=https://x.test/?a=b"), { field: "url", op: "equals", value: "https://x.test/?a=b" }, "the first = splits");
  assert.doesNotThrow(() => checkTriggerAdd({ name: "x", match: "fields.channel=C0123" }));
});

test("the list says what each trigger watches, how it stands, and the hour's deliveries", () => {
  const empty: BotTriggersList = { triggers: [], runs: [], deliveries: { lastHour: 0, perHour: 12 } };
  assert.match(formatTriggers({ handle: "ada" }, empty), /@ada has no triggers\. Add one with hui bot trigger add ada/u);
  const list: BotTriggersList = {
    triggers: [{
      id: "3f2a1b2c-0000", botId: "id-ada", name: "Reviews", source: "listener", filter: { match: { field: "fields.channel", op: "equals", value: "C0123" }, prLinks: true }, enabled: true, cooldownSeconds: 300,
      createdBy: "operator", createdAt: "", updatedAt: "", lastFiredAt: "2026-10-07T10:00:00.000Z", pending: { events: 2, until: "2026-10-07T10:05:00.000Z" }, watch: { error: "No report from the listener for 7 min." },
    }],
    runs: [],
    deliveries: { lastHour: 1, perHour: 12 },
  };
  assert.equal(formatTriggers({ handle: "ada" }, list), [
    "Reviews (3f2a1b2c) · Listener · fields.channel equals \"C0123\" · PR links only · cooldown 5 min · on · last fired 2026-10-07T10:00:00.000Z · 2 waiting until 2026-10-07T10:05:00.000Z · Listener: No report from the listener for 7 min.",
    "Deliveries in the last hour: 1 of 12.",
  ].join("\n"));
});

test("HELP lists the trigger commands and what a listener sends", () => {
  for (const line of [
    "hui bot trigger list <bot> [--json]",
    "hui bot trigger add <bot> --name <name> [--match <field=value|field~value>] [--pr-links] [--allow-bots]",
    "hui bot trigger remove <bot> <trigger> [--json]",
    "hui bot trigger test <bot> <trigger> [--json]",
  ]) assert.ok(HELP.includes(line), line);
  assert.match(HELP, /Triggers wake a bot when a program you run \(a listener\) reports something/u);
  assert.doesNotMatch(HELP, /hui slack|--github|--webhook/u);
});
