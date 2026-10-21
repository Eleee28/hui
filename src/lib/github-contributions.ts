/** Browser half of the Contributions page: buckets the gateway's GitHub activity timestamps into local-time days
 * and Sunday-first weeks. The request lives in src/api/github-contributions.ts. */
export type ContributionMetric = "commits" | "pullRequests";
export type ContributionDay = { date: Date; count: number };
export type ContributionWeek = { days: ContributionDay[]; total: number };

export function metricLabel(metric: ContributionMetric, count: number): string {
  const noun = metric === "commits" ? "commit" : "pull request";
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/** Local days a view covers: the 53 weeks ending today, or one calendar year. */
export function contributionRange(year: number | undefined, today = new Date()): { start: Date; end: Date } {
  if (year === undefined) return { start: new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - 52 * 7), end: today };
  return { start: new Date(year, 0, 1), end: new Date(year, 11, 31) };
}

/** Newest first, from the current year back to the oldest account's first year. */
export function contributionYears(createdAt: readonly (string | undefined)[], today = new Date()): number[] {
  const first = Math.min(today.getFullYear(), ...createdAt.map((value) => new Date(value ?? "").getFullYear()).filter(Number.isFinite));
  return Array.from({ length: today.getFullYear() - first + 1 }, (_, index) => today.getFullYear() - index);
}

const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** Sunday-first weeks over `start..end`, counted in local time. Days outside
 * the range are left out; unparseable timestamps are ignored. */
export function contributionWeeks(timestamps: readonly string[], { start, end }: { start: Date; end: Date }): ContributionWeek[] {
  const counts = new Map<string, number>();
  for (const value of timestamps) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) counts.set(dayKey(date), (counts.get(dayKey(date)) ?? 0) + 1);
  }
  const weeks: ContributionWeek[] = [];
  for (let offset = -start.getDay(); ; offset += 7) {
    const days = Array.from({ length: 7 }, (_, weekday) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset + weekday))
      .filter((date) => date >= start && date <= end)
      .map((date) => ({ date, count: counts.get(dayKey(date)) ?? 0 }));
    if (days.length === 0) return weeks;
    weeks.push({ days, total: days.reduce((sum, day) => sum + day.count, 0) });
  }
}

/** GitHub's intensity 0–4: zero, then quarters of the busiest day. */
export function contributionLevels(counts: readonly number[]): (count: number) => number {
  const max = Math.max(1, ...counts);
  return (count) => count <= 0 ? 0 : Math.ceil((4 * count) / max);
}
