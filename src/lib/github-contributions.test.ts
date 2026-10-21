import assert from "node:assert/strict";
import { test } from "vitest";

import { contributionLevels, contributionRange, contributionWeeks, contributionYears } from "./github-contributions.ts";

test("buckets timestamps into the 53 local Sunday-first weeks ending today", () => {
  const today = new Date(2026, 8, 30, 15); // Wednesday
  const at = (month: number, day: number, hour: number) => new Date(2026, month, day, hour).toISOString();
  const weeks = contributionWeeks([
    at(8, 30, 0), at(8, 30, 23), at(8, 27, 0), at(0, 1, 12),
    new Date(2025, 8, 27, 23).toISOString(), // the Saturday before the first week
    new Date(2026, 9, 1, 9).toISOString(), // tomorrow
    "not a date",
  ], contributionRange(undefined, today));
  assert.equal(weeks.length, 53);
  assert.deepEqual(weeks[0]?.days[0]?.date, new Date(2025, 8, 28));
  assert.ok(weeks.slice(0, -1).every((week) => week.days.length === 7 && week.days[0]?.date.getDay() === 0));
  assert.deepEqual(weeks.at(-1)?.days.map((day) => day.count), [1, 0, 0, 2]);
  assert.equal(weeks.reduce((sum, week) => sum + week.total, 0), 4);
});

test("a calendar year starts and ends mid-week and keeps only its own days", () => {
  const weeks = contributionWeeks([new Date(2025, 11, 31, 23).toISOString(), new Date(2026, 0, 1, 0).toISOString()], contributionRange(2026));
  assert.equal(weeks.length, 53);
  assert.deepEqual(weeks[0]?.days.map((day) => [day.date.getDate(), day.count]), [[1, 1], [2, 0], [3, 0]]);
  assert.deepEqual(weeks.at(-1)?.days.map((day) => day.date.getDate()), [27, 28, 29, 30, 31]);
});

test("years run from the oldest account's creation to today", () => {
  assert.deepEqual(contributionYears(["2023-05-01T00:00:00Z", undefined, "2024-01-01T12:00:00Z"], new Date(2026, 8, 30)), [2026, 2025, 2024, 2023]);
  assert.deepEqual(contributionYears([], new Date(2026, 8, 30)), [2026]);
});

test("intensity levels are quarters of the busiest day", () => {
  assert.deepEqual([0, 1, 2, 3, 5, 6, 8].map(contributionLevels([0, 8])), [0, 1, 1, 2, 3, 3, 4]);
  assert.equal(contributionLevels([1, 1, 0])(1), 4);
});
