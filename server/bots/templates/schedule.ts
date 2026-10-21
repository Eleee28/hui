/**
 * A routine's schedule as a template wrote it ("every 2h", "daily at 9:00", "weekdays at 8am", "every monday and
 * friday at 10:30", a cron expression, "at <ISO time>") as an Automation schedule. What it doesn't say is assumed (09:00,
 * Mondays, the 1st) and what it can't be read as stands in as every day at 09:00; either way `guessed` says so, and the
 * routine starts disabled until the operator checks it.
 */
import type { AutomationSchedule } from "../../automation.ts";
import { parseCron, validateTimezone } from "../../automation.ts";

export type ReadSchedule = { schedule: AutomationSchedule; guessed: boolean };

const MINUTE = 60_000;
const UNITS: Readonly<Record<string, number>> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: 60 * MINUTE, hr: 60 * MINUTE, hrs: 60 * MINUTE, hour: 60 * MINUTE, hours: 60 * MINUTE,
  d: 1_440 * MINUTE, day: 1_440 * MINUTE, days: 1_440 * MINUTE,
  w: 10_080 * MINUTE, week: 10_080 * MINUTE, weeks: 10_080 * MINUTE,
};
const WEEKDAYS: readonly [RegExp, number][] = [
  [/\bsun(?:day)?s?\b/u, 0], [/\bmon(?:day)?s?\b/u, 1], [/\btue(?:s|sday)?s?\b/u, 2], [/\bwed(?:nesday)?s?\b/u, 3],
  [/\bthu(?:r|rs|rsday)?s?\b/u, 4], [/\bfri(?:day)?s?\b/u, 5], [/\bsat(?:urday)?s?\b/u, 6],
];
const DAYPARTS: readonly [RegExp, number][] = [[/\bmidnight\b/u, 0], [/\bmorning\b/u, 8], [/\b(?:noon|midday|lunch(?:time)?)\b/u, 12], [/\bafternoon\b/u, 15], [/\bevening\b/u, 18], [/\bnight\b/u, 21]];
const CRON_FIELD = /^(?:[\d*?]+(?:[/,-][\d*]+)*)$/u;
const ZONE = /^(?:UTC|GMT|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/u;

function cron(expression: string, timezone: string): AutomationSchedule | undefined {
  try {
    parseCron(expression);
    return { kind: "cron", expression, timezone: validateTimezone(timezone) };
  } catch {
    return undefined;
  }
}

/** The time of day a phrase names (`at 9`, `9:30 pm`, `21h`, `morning`), or undefined. */
function timeOfDay(text: string): { hour: number; minute: number } | undefined {
  const clock = /\b(\d{1,2})(?:[:.h](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$|[,;)])/u.exec(text.replace(/\b(?:every|each)\s+\d+\s*\w+/gu, ""));
  if (clock && (clock[2] !== undefined || clock[3] !== undefined || /\bat\s+\d/u.test(text))) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const half = clock[3]?.replace(/\./gu, "");
    if (half === "pm" && hour < 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) return { hour, minute };
  }
  for (const [pattern, hour] of DAYPARTS) if (pattern.test(text)) return { hour, minute: 0 };
  return undefined;
}

export function readSchedule(raw: string | undefined, timezone: string, now: number = Date.now()): ReadSchedule {
  const fallback: ReadSchedule = { schedule: { kind: "cron", expression: "0 9 * * *", timezone }, guessed: true };
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  const lower = text.toLowerCase().replace(/\s+/gu, " ");
  // cron <expression> [zone], or a bare five-field expression with an optional zone after it.
  const words = text.replace(/^cron\s+/iu, "").split(/\s+/u);
  const zone = words.length === 6 && ZONE.test(words[5]!) ? words[5]! : undefined;
  if (/^cron\s/iu.test(text) || (words.length === 5 || zone) && words.slice(0, 5).every((field) => CRON_FIELD.test(field))) {
    const exact = cron(words.slice(0, 5).join(" "), zone ?? timezone);
    return exact ? { schedule: exact, guessed: false } : fallback;
  }
  const at = /^(?:at|on|once at)\s+(.+)$/iu.exec(text)?.[1] ?? (/^\d{4}-\d{2}-\d{2}/u.test(text) ? text : undefined);
  if (at !== undefined && Number.isFinite(Date.parse(at))) {
    const when = Date.parse(at);
    return when > now ? { schedule: { kind: "at", at: new Date(when).toISOString() }, guessed: false } : fallback;
  }
  const time = timeOfDay(lower);
  const weekdays = WEEKDAYS.filter(([pattern]) => pattern.test(lower)).map(([, day]) => day);
  const daily = /\b(?:daily|every ?day|each day|every morning|every evening|every night|every afternoon|nightly)\b/u.test(lower);
  const workdays = /\b(?:weekdays?|work ?days?|business days?|mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?)\b/u.test(lower);
  const weekends = /\bweekends?\b/u.test(lower);
  const weekly = /\b(?:weekly|every week|each week)\b/u.test(lower);
  const monthly = /\b(?:monthly|every month|each month)\b/u.test(lower);
  if (time || weekdays.length || daily || workdays || weekends || weekly || monthly) {
    const clock = time ?? { hour: 9, minute: 0 };
    let days = "*";
    let dayOfMonth = "*";
    if (workdays) days = "1-5";
    else if (weekends) days = "0,6";
    else if (weekdays.length) days = [...new Set(weekdays)].sort((a, b) => a - b).join(",");
    else if (weekly) days = "1";
    else if (monthly) dayOfMonth = /\b(\d{1,2})(?:st|nd|rd|th)\b/u.exec(lower)?.[1] ?? "1";
    const assumed = !time || (weekly && !weekdays.length) || (monthly && !/\b\d{1,2}(?:st|nd|rd|th)\b/u.test(lower));
    // A phrase with a time but no day at all ("at 9am") runs daily; one with an interval too is an interval.
    if (!(time && !daily && !workdays && !weekends && !weekdays.length && !weekly && !monthly && /\bevery\s+\d/u.test(lower))) {
      const exact = cron(`${clock.minute} ${clock.hour} ${dayOfMonth} * ${days}`, timezone);
      if (exact) return { schedule: exact, guessed: assumed };
    }
  }
  const interval = /\b(?:every|each)\s+(?:(\d+(?:\.\d+)?)\s*)?([a-z]+)\b/u.exec(lower) ?? /^(\d+(?:\.\d+)?)\s*([a-z]+)$/u.exec(lower);
  const hourly = /\bhourly\b/u.test(lower);
  if (interval || hourly) {
    const unit = hourly ? UNITS["hour"]! : UNITS[interval![2]!];
    const count = hourly ? 1 : Number(interval![1] ?? 1);
    if (unit !== undefined && Number.isFinite(count) && count > 0) {
      const everyMs = Math.round(count * unit);
      return everyMs >= MINUTE ? { schedule: { kind: "every", everyMs }, guessed: false } : { schedule: { kind: "every", everyMs: MINUTE }, guessed: true };
    }
  }
  return fallback;
}
