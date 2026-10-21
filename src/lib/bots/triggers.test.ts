import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  BOT_TRIGGER_LIMITS, botTriggerFilterSummary, cooldownLabel, parseTrigger, parseTriggersList, TriggerFormError, triggerFormInput, type TriggerFormFields,
} from "./triggers.ts";

test("trigger limits and labels match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./triggers.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(BOT_TRIGGER_LIMITS, fixture.limits);
  for (const item of fixture.cooldowns) assert.equal(cooldownLabel(item.input), item.expected, String(item.input));
  for (const item of fixture.filters) assert.equal(botTriggerFilterSummary({ filter: item.input }), item.expected);
});

const FIELDS: TriggerFormFields = { name: "Reviews", prompt: "  Review it.  ", cooldown: "300", matchField: "", matchOp: "equals", matchValue: "", prLinks: false, external: false, bots: false };

test("the add form becomes a listener trigger's body", () => {
  assert.deepEqual(triggerFormInput(FIELDS), { name: "Reviews", source: "listener", prompt: "Review it.", cooldownSeconds: 300, filter: {} });
  assert.equal(triggerFormInput({ ...FIELDS, steer: true }).delivery, "steer");
  assert.deepEqual(triggerFormInput({ ...FIELDS, prompt: "", cooldown: "0", matchField: " fields.channel ", matchValue: " G01M4T1JFLK ", prLinks: true, bots: true }),
    { name: "Reviews", source: "listener", cooldownSeconds: 0, filter: { match: { field: "fields.channel", op: "equals", value: "G01M4T1JFLK" }, prLinks: true, bots: true } });
  assert.deepEqual(triggerFormInput({ ...FIELDS, matchField: "summary", matchOp: "contains", matchValue: "review", external: true }).filter, { match: { field: "summary", op: "contains", value: "review" }, external: true });
  assert.deepEqual(triggerFormInput({ ...FIELDS, matchField: "fields.channel", matchValue: "  " }).filter, {}, "a field without a value matches nothing in particular");
  for (const [change, message] of [[{ name: " " }, /Name the trigger/u], [{ name: "a [b]" }, /can't hold/u]] as const) {
    assert.throws(() => triggerFormInput({ ...FIELDS, ...change }), (error: unknown) => error instanceof TriggerFormError && message.test(error.message));
  }
});

const TRIGGER = {
  id: "t1", botId: "id-ada", name: "Reviews", source: "listener", filter: { match: { field: "fields.channel", op: "equals", value: "C0" }, prLinks: true, external: "yes" },
  enabled: true, cooldownSeconds: 300, createdBy: "bot", createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", tokenHint: "AbCd",
  pending: { events: 2, until: "2026-10-07T10:05:00.000Z" }, watch: { polledAt: "2026-10-07T10:01:00.000Z" },
};

test("the routes' answers are narrowed: unknown sources, bad entries and missing fields don't reach the view", () => {
  const parsed = parseTrigger(TRIGGER);
  assert.deepEqual(parsed?.filter, { match: { field: "fields.channel", op: "equals", value: "C0" }, prLinks: true }, "a switch that isn't true is left out");
  assert.deepEqual([parsed?.createdBy, parsed?.tokenHint, parsed?.pending], ["bot", "AbCd", { events: 2, until: "2026-10-07T10:05:00.000Z" }]);
  assert.equal(parseTrigger({ ...TRIGGER, delivery: "steer" })?.delivery, "steer");
  assert.equal(parseTrigger({ ...TRIGGER, source: "github" }), undefined, "a kind HUI no longer has");
  assert.deepEqual(parseTrigger({ ...TRIGGER, filter: { match: { field: "a", op: "regex", value: "x" } } })?.filter, {}, "a match it can't read is left out");
  assert.deepEqual(parseTrigger({ ...TRIGGER, filter: undefined })?.filter, {});
  const list = parseTriggersList({ triggers: [TRIGGER, { id: "broken" }], runs: [{ id: "r", triggerId: "t1", triggerName: "Reviews", at: "2026-10-07T10:00:00Z", status: "coalesced", events: 3, summary: "3 events", catchUp: true }, { id: "x", status: "exploded" }], deliveries: { lastHour: 2, perHour: 12 } });
  assert.equal(list.triggers.length, 1);
  assert.deepEqual(list.runs.map((run) => [run.status, run.events, run.catchUp]), [["coalesced", 3, true]]);
  assert.deepEqual(list.deliveries, { lastHour: 2, perHour: 12 });
  assert.throws(() => parseTriggersList({}), /did not come back/u);
});
