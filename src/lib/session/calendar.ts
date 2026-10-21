/** Browser half of the Calendar tab: lays out a day or week of activity.
 * Weeks start Monday; days run from 5 AM to 5 AM, so late-night work stays
 * on the day it began. */
import type { ActivityBlock, ActivitySession, SessionActivity } from "../../api/schema/github.ts";

const MINUTE = 60_000;
const DAY_START_HOUR = 5;
/** Nearby blocks join visually; these gaps never add to recorded activity time. */
const GAP_MS = 30 * MINUTE;
/** Shortest drawn block, so a one-message stretch stays visible and clickable. */
export const MIN_DRAWN_MS = 30 * MINUTE;
/** Colors in session-calendar.css: the session palette, then a shaded set; the week's busiest session takes the first. */
const COLORS = 16;

/** What the grid draws as one color: a repository, a sidebar group or each session. */
export type CalendarGrouping = "project" | "group" | "session";
export type CalendarSession = { session: ActivitySession; ms: number; first?: string; model?: string };
type CalendarPart = { session: ActivitySession; block: ActivityBlock };
export type CalendarUnit = {
  key: string;
  label: string;
  color: number;
  /** Time in the selected period; parallel sessions counted once. */
  ms: number;
  /** Its sessions with time in the selected period, most first. */
  sessions: CalendarSession[];
};
export type CalendarBlock = {
  unit: CalendarUnit;
  /** Recorded activity within this day's part of the stretch, parallel time counted once. */
  ms: number;
  sessions: CalendarSession[];
  /** The part of the stretch inside its day. */
  start: number;
  end: number;
  /** First column, how many columns its overlapping neighbours share, and how many it spans. */
  lane: number;
  lanes: number;
  span: number;
};
export type CalendarDay = { date: Date; blocks: CalendarBlock[]; activeMs: number };
export type CalendarPeriod = {
  days: CalendarDay[];
  /** Every unit with time in the selected period, most time first. */
  units: CalendarUnit[];
  /** Sessions with time in the selected period. */
  sessions: number;
  /** Recorded session activity: parallel sessions count once; visual joining adds no time. */
  activeMs: number;
  /** Time summed per session. */
  sessionMs: number;
  /** Most sessions active at the same moment. */
  peak: number;
  /** Hours since midnight the grid shows, `[first, last)`: working hours and
   * every block. Past 24 is the next morning. */
  hours: [number, number];
};

/** Local 5 AM on or before `date`, including early mornings across DST changes. */
export function dayStart(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate(), DAY_START_HOUR);
  if (date < day) day.setDate(day.getDate() - 1);
  return day;
}

/** 5 AM on the Monday of the activity week `date` falls in. */
export function weekStart(date: Date): Date {
  const day = dayStart(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** The same wall-clock time `days` later, across daylight saving changes. */
export const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());

/** `3h 05m`, `22m`, or `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A block with time inside `[from, to)`, or a single message in it. */
const overlaps = (block: ActivityBlock, from: number, to: number) => block.start < to && (block.end > from || block.start >= from);

/** Wall-clock hours since midnight of `day`'s date, past 24 for the next morning; at most the day's end. */
export function localHour(ms: number, day: Date): number {
  const date = new Date(Math.min(ms, addDays(day, 1).valueOf()));
  const hours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  return date.getDate() === day.getDate() ? hours : hours + 24;
}

/** Merge nearby blocks for display; gap=0 is the union used for recorded time. */
function stretches(parts: readonly CalendarPart[], gap = GAP_MS): { from: number; to: number; parts: CalendarPart[] }[] {
  const merged: { from: number; to: number; parts: CalendarPart[] }[] = [];
  for (const part of [...parts].sort((a, b) => a.block.start - b.block.start)) {
    const last = merged.at(-1);
    if (last && part.block.start - last.to <= gap) {
      last.to = Math.max(last.to, part.block.end);
      last.parts.push(part);
    } else merged.push({ from: part.block.start, to: part.block.end, parts: [part] });
  }
  return merged;
}

/** Length of the stretches inside `[from, to)`. */
const within = (merged: readonly { from: number; to: number }[], from: number, to: number) =>
  merged.reduce((sum, stretch) => sum + Math.max(0, Math.min(stretch.to, to) - Math.max(stretch.from, from)), 0);

/** Session blocks do not overlap one another. Clip them to the shown range before adding. */
function sessionTimes(parts: readonly CalendarPart[], from: number, to: number): CalendarSession[] {
  const sessions = new Map<string, CalendarSession>();
  for (const { session, block } of parts) {
    if (!overlaps(block, from, to)) continue;
    const entry = sessions.get(session.id) ?? { session, ms: 0 };
    entry.ms += Math.min(block.end, to) - Math.max(block.start, from);
    entry.first ??= block.firstMessage;
    if (block.model) entry.model = block.model;
    sessions.set(session.id, entry);
  }
  return [...sessions.values()].sort((a, b) => b.ms - a.ms || a.session.title.localeCompare(b.session.title));
}

function peakOverlap(intervals: readonly (readonly [number, number])[]): number {
  // Ends sort before starts at the same instant: back-to-back is not parallel.
  const events = intervals.flatMap(([start, end]) => end > start ? [[start, 1], [end, -1]] as const : []).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, change] of events) peak = Math.max(peak, current += change);
  return peak;
}

/** Side-by-side columns for blocks whose drawn extents overlap, like a day view;
 * a block widens into the columns to its right that nothing beside it uses. */
function assignLanes(blocks: CalendarBlock[]): void {
  const drawnEnd = (block: CalendarBlock) => Math.max(block.end, block.start + MIN_DRAWN_MS);
  const beside = (a: CalendarBlock, b: CalendarBlock) => a.start < drawnEnd(b) && b.start < drawnEnd(a);
  // At the same start, the busier unit takes the left column.
  blocks.sort((a, b) => a.start - b.start || a.unit.color - b.unit.color);
  let cluster: CalendarBlock[] = [];
  let laneEnds: number[] = [];
  const close = () => {
    for (const block of cluster) {
      block.lanes = laneEnds.length;
      let span = 1;
      while (block.lane + span < block.lanes && !cluster.some((other) => other.lane === block.lane + span && beside(block, other))) span++;
      block.span = span;
    }
    cluster = [];
    laneEnds = [];
  };
  for (const block of blocks) {
    if (cluster.length && laneEnds.every((end) => end <= block.start)) close();
    const free = laneEnds.findIndex((end) => end <= block.start);
    block.lane = free < 0 ? laneEnds.length : free;
    laneEnds[block.lane] = drawnEnd(block);
    cluster.push(block);
  }
  close();
}

const unitOf: Record<CalendarGrouping, (session: ActivitySession) => [key: string, label: string]> = {
  project: (session) => [session.project, session.project],
  group: (session) => [session.group, session.group || "Other"],
  session: (session) => [session.id, session.title],
};

export function calendarPeriod(activity: SessionActivity, start: Date, grouping: CalendarGrouping = "project", length: 1 | 7 = 7): CalendarPeriod {
  const days = Array.from({ length }, (_, index) => ({ date: addDays(start, index), next: addDays(start, index + 1).valueOf() }));
  const rangeStart = start.valueOf();
  const rangeEnd = addDays(start, length).valueOf();
  const parts = activity.sessions.flatMap((session) => session.blocks.filter((block) => overlaps(block, rangeStart, rangeEnd)).map((block) => ({ session, block })));

  const units = new Map<string, { label: string; parts: typeof parts }>();
  for (const part of parts) {
    const [key, label] = unitOf[grouping](part.session);
    const unit = units.get(key) ?? { label, parts: [] };
    unit.parts.push(part);
    units.set(key, unit);
  }
  const ranked = [...units].map(([key, { label, parts: own }]) => {
    const merged = stretches(own);
    const sessions = sessionTimes(own, rangeStart, rangeEnd);
    return { unit: { key, label, color: 0, ms: within(stretches(own, 0), rangeStart, rangeEnd), sessions }, merged };
  }).sort((a, b) => b.unit.ms - a.unit.ms || a.unit.label.localeCompare(b.unit.label));
  ranked.forEach(({ unit }, index) => { unit.color = index % COLORS; });

  const all = stretches(parts, 0);
  let first = 9;
  let last = 18;
  const calendarDays = days.map(({ date, next }) => {
    const from = date.valueOf();
    const blocks: CalendarBlock[] = ranked.flatMap(({ unit, merged }) => merged
      .filter((stretch) => overlaps({ start: stretch.from, end: stretch.to }, from, next))
      .map((stretch) => ({
        unit,
        start: Math.max(stretch.from, from), end: Math.min(stretch.to, next),
        ms: within(stretches(stretch.parts, 0), from, next),
        sessions: sessionTimes(stretch.parts, from, next), lane: 0, lanes: 1, span: 1,
      })));
    assignLanes(blocks);
    for (const block of blocks) {
      first = Math.min(first, Math.floor(localHour(block.start, date)));
      last = Math.max(last, Math.ceil(localHour(Math.max(block.end, block.start + MIN_DRAWN_MS), date)));
    }
    return { date, blocks, activeMs: within(all, from, next) };
  });
  const sessionMs = ranked.reduce((sum, { unit }) => sum + unit.sessions.reduce((total, { ms }) => total + ms, 0), 0);
  return {
    days: calendarDays,
    units: ranked.map(({ unit }) => unit),
    sessions: new Set(parts.map(({ session }) => session)).size,
    activeMs: within(all, rangeStart, rangeEnd),
    sessionMs,
    peak: peakOverlap(parts.map(({ block }) => [Math.max(block.start, rangeStart), Math.min(block.end, rangeEnd)] as const)),
    hours: [first, last],
  };
}
