import assert from "node:assert/strict";
import { test } from "vitest";
import type { ActivityBlock, ActivitySession } from "../../api/schema/github.ts";
import { addDays, calendarPeriod, dayStart, formatDuration, weekStart } from "./calendar.ts";

const MONDAY = new Date(2026, 8, 28, 5);
const HOUR = 3_600_000;
/** Local time on a day of the week of Sep 28, 2026. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, 28 + day, hour, minute).valueOf();
const block = (start: number, end: number, extra: Partial<ActivityBlock> = {}): ActivityBlock => ({ start, end, ...extra });
const session = (id: string, blocks: ActivityBlock[], project = id, group = ""): ActivitySession => ({ id, title: id, group, project, blocks });

test("weeks start at 5 AM on Monday, so the small hours belong to the day before", () => {
  assert.equal(weekStart(new Date(2026, 9, 4, 23, 30)).valueOf(), MONDAY.valueOf(), "Sunday belongs to the week before");
  assert.equal(weekStart(new Date(2026, 9, 5, 4, 59)).valueOf(), MONDAY.valueOf(), "Monday before 5 AM is still Sunday night");
  assert.equal(weekStart(new Date(2026, 8, 28, 5)).valueOf(), MONDAY.valueOf());
  assert.equal(weekStart(new Date(2026, 9, 5, 8)).valueOf(), new Date(2026, 9, 5, 5).valueOf());
});

test("day navigation uses local 5 AM across week, year and daylight-saving boundaries", () => {
  assert.equal(dayStart(new Date(2027, 0, 1, 4, 59)).valueOf(), new Date(2026, 11, 31, 5).valueOf());
  assert.equal(dayStart(new Date(2027, 0, 1, 5)).valueOf(), new Date(2027, 0, 1, 5).valueOf());
  const sunday = dayStart(new Date(2026, 9, 4, 23));
  const monday = addDays(sunday, 1);
  assert.equal(monday.valueOf(), new Date(2026, 9, 5, 5).valueOf());
  assert.equal(weekStart(monday).valueOf(), monday.valueOf());
  // Run this file under America/New_York too: these days are 23h and 25h long there.
  for (const [month, date] of [[2, 7], [9, 31]]) {
    const start = new Date(2026, month!, date!, 5);
    const next = addDays(start, 1);
    assert.equal(next.valueOf(), new Date(2026, month!, date! + 1, 5).valueOf());
    assert.equal(dayStart(new Date(2026, month!, date! + 1, 4, 30)).valueOf(), start.valueOf());
  }
});

test("day view clips overnight work and computes its own counts, totals and parallelism", () => {
  const activity = { sessions: [
    session("checkout", [block(at(1, 23), at(2, 5, 30)), block(at(2, 9), at(2, 11)), block(at(3, 4, 30), at(3, 5, 30))], "api", "Payments"),
    session("review", [block(at(2, 10), at(2, 12))], "api", "Payments"),
    session("ends-before", [block(at(2, 4), at(2, 5))]),
    session("starts-after", [block(at(3, 5), at(3, 6))]),
    session("other-day", [block(at(0, 9), at(0, 12))]),
  ] };
  const start = addDays(MONDAY, 2);
  for (const grouping of ["project", "group", "session"] as const) {
    const day = calendarPeriod(activity, start, grouping, 1);
    assert.equal(day.days.length, 1);
    assert.equal(day.days[0]!.date.valueOf(), at(2, 5));
    assert.equal(day.sessions, 2);
    assert.equal(day.peak, 2);
    assert.equal(day.activeMs, 4 * HOUR);
    assert.equal(day.sessionMs, 5 * HOUR);
    assert.equal(day.days[0]!.activeMs, 4 * HOUR);
    assert.deepEqual([...new Set(day.units.flatMap((unit) => unit.sessions.map(({ session }) => session.id)))].sort(), ["checkout", "review"]);
    assert.equal(day.days[0]!.blocks[0]!.start, at(2, 5));
    assert.equal(day.days[0]!.blocks.at(-1)!.end, at(3, 5));
    assert.equal(day.days[0]!.blocks.at(-1)!.sessions[0]!.ms, HOUR / 2);
  }
  const next = calendarPeriod(activity, addDays(start, 1), "session", 1);
  assert.equal(next.activeMs, HOUR, "Thursday counts only 5–6 AM");
  assert.equal(next.units.find(({ key }) => key === "checkout")!.ms, HOUR / 2);
  const empty = calendarPeriod(activity, addDays(start, 2), "project", 1);
  assert.deepEqual(empty.units, []);
  assert.equal(empty.activeMs, 0);
  assert.deepEqual(empty.hours, [9, 18]);
});

test("durations read as hours and zero-padded minutes", () => {
  assert.deepEqual([0, 29_000, 22 * 60_000, 3 * HOUR + 5 * 60_000, 43 * HOUR + 6 * 60_000].map(formatDuration), ["<1m", "<1m", "22m", "3h 05m", "43h 06m"]);
});

test("parallel sessions count once in the week's working time and per day, and once each per session", () => {
  const week = calendarPeriod({ sessions: [
    session("checkout", [block(at(0, 9), at(0, 12)), block(at(2, 22), at(3, 1)), block(at(3, 4), at(3, 6))]),
    session("evals", [block(at(0, 10), at(0, 11))]),
    session("infra", [block(at(0, 11, 30), at(0, 13))]),
  ] }, MONDAY, "session");
  assert.deepEqual(week.units.map(({ key, ms, color }) => ({ key, hours: ms / HOUR, color })), [
    { key: "checkout", hours: 8, color: 0 },
    { key: "infra", hours: 1.5, color: 1 },
    { key: "evals", hours: 1, color: 2 },
  ]);
  assert.equal(week.sessions, 3);
  assert.equal(week.activeMs, 9 * HOUR, "Monday 9–13, Wednesday night 22–1 and Thursday 4–6");
  assert.equal(week.sessionMs, 10.5 * HOUR);
  assert.equal(week.peak, 2);
  // Wednesday's night stays on Wednesday; a block across 5 AM is split there.
  assert.deepEqual(week.days.map((day) => day.activeMs / HOUR), [4, 0, 4, 1, 0, 0, 0]);
  assert.deepEqual(week.days[2]!.blocks.map(({ start, end }) => [start, end]), [[at(2, 22), at(3, 1)], [at(3, 4), at(3, 5)]]);
  assert.deepEqual(week.days[3]!.blocks.map(({ start, end }) => [start, end]), [[at(3, 5), at(3, 6)]]);
  assert.equal(week.days[3]!.blocks[0]!.sessions[0]!.ms, HOUR, "the detail card counts only the part shown on Thursday");
  assert.deepEqual(week.hours, [5, 29], "from 5 AM to 5 AM the next morning");
});

test("a project draws its sessions as one block wherever they are under 30 minutes apart", () => {
  const sessions = [
    session("retry", [block(at(0, 9), at(0, 10)), block(at(0, 14), at(0, 15))], "checkout-api", "Payments"),
    session("webhook", [block(at(0, 9, 30), at(0, 11))], "checkout-api", "Payments"),
    session("pricing", [block(at(0, 11, 20), at(0, 12))], "marketing-site", "Payments"),
  ];
  const projects = calendarPeriod({ sessions }, MONDAY, "project");
  assert.deepEqual(projects.days[0]!.blocks.map(({ unit, start, end, sessions }) => [unit.label, start, end, sessions.map(({ session }) => session.id)]), [
    ["checkout-api", at(0, 9), at(0, 11), ["webhook", "retry"]],
    ["marketing-site", at(0, 11, 20), at(0, 12), ["pricing"]],
    ["checkout-api", at(0, 14), at(0, 15), ["retry"]],
  ]);
  assert.deepEqual(projects.units.map(({ label, ms, sessions: own }) => [label, ms / HOUR, own.map(({ session: { id }, ms: time }) => [id, time / HOUR])]), [
    ["checkout-api", 3, [["retry", 2], ["webhook", 1.5]]],
    ["marketing-site", 2 / 3, [["pricing", 2 / 3]]],
  ]);
  // Grouped by sidebar group, the 20-minute pause before Pricing joins the morning.
  const groups = calendarPeriod({ sessions }, MONDAY, "group");
  assert.deepEqual(groups.days[0]!.blocks.map(({ unit, start, end }) => [unit.label, start, end]), [["Payments", at(0, 9), at(0, 12)], ["Payments", at(0, 14), at(0, 15)]]);
  for (const grouping of ["project", "group", "session"] as const) {
    assert.equal(calendarPeriod({ sessions }, MONDAY, grouping).activeMs, 220 * 60_000, "changing grouping must not add the 20-minute pause to activity");
  }
  assert.equal(groups.units[0]!.ms, 220 * 60_000);
  assert.equal(groups.days[0]!.blocks[0]!.ms, 160 * 60_000, "a 3-hour drawn stretch contains 2h 40m of activity");
  assert.equal(calendarPeriod({ sessions: [session("x", [block(at(0, 9), at(0, 10))])] }, MONDAY, "group").units[0]!.label, "Other");
});

test("joining stretches at exactly 30 minutes does not invent work between projects", () => {
  const sessions = [
    session("a", [block(at(0, 10), at(0, 10, 10))], "api", "Payments"),
    session("b", [block(at(0, 10, 40), at(0, 10, 50))], "web", "Payments"),
  ];
  for (const grouping of ["project", "group", "session"] as const) {
    const week = calendarPeriod({ sessions }, MONDAY, grouping);
    assert.equal(week.activeMs, 20 * 60_000);
    assert.equal(week.sessionMs, 20 * 60_000);
    assert.equal(week.days[0]!.activeMs, 20 * 60_000);
    assert.equal(week.days[0]!.blocks.length, grouping === "group" ? 1 : 2);
  }
});

test("overlapping blocks share their day in lanes and widen into lanes free beside them", () => {
  const week = calendarPeriod({ sessions: [
    session("a", [block(at(1, 9), at(1, 12))]),
    session("b", [block(at(1, 10), at(1, 11))]),
    session("c", [block(at(1, 10, 30), at(1, 11, 30))]),
    session("d", [block(at(1, 11, 45), at(1, 12, 30))]),
    session("e", [block(at(1, 18), at(1, 18))]),
  ] }, MONDAY, "session");
  const lanes = Object.fromEntries(week.days[1]!.blocks.map(({ unit, lane, lanes: count, span }) => [unit.key, [lane, count, span]]));
  // Three lanes at 10:30; once b and c end, d takes lane 1 and widens over the free lane 2; e stands alone.
  assert.deepEqual(lanes, { a: [0, 3, 1], b: [1, 3, 1], c: [2, 3, 1], d: [1, 3, 2], e: [0, 1, 1] });
  assert.deepEqual(week.hours, [9, 19], "working hours, and a one-message block drawn for 30 minutes");
});

test("blocks outside the week, or ending as it starts, are left out", () => {
  const week = calendarPeriod({ sessions: [
    session("before", [block(at(-1, 22), at(0, 5))]),
    session("after", [block(at(7, 9), at(7, 10))]),
  ] }, MONDAY);
  assert.deepEqual(week.units, []);
  assert.equal(week.activeMs, 0);
  assert.deepEqual(week.hours, [9, 18], "an empty week shows working hours");
});
