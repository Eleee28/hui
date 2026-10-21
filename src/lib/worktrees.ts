/**
 * Helpers for the worktree inventory in Settings: sizes and the worktrees only the given sessions use. Its requests
 * live in src/api/worktrees.ts.
 */
import type { WorktreeRow } from "../api/schema/worktrees.ts";

export type { WorktreeInventory, WorktreeRemovalResult, WorktreeRisk, WorktreeRow } from "../api/schema/worktrees.ts";

export function isMergedCleanupCandidate(row: WorktreeRow): boolean {
  return row.managed && row.merged && row.sessions.every((session) => session.archived) && row.dirty === false && row.risks.length === 0;
}



/** Binary units, one decimal from MiB up, matching `du -h` intuition. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit >= 2 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Worktrees whose every linked session is in `ids`, so removing them strands no other session. */
export function worktreesOnlyUsedBy(rows: readonly WorktreeRow[], ids: ReadonlySet<string>): string[] {
  return rows.filter((row) => row.sessions.length > 0 && row.sessions.every((session) => ids.has(session.id))).map((row) => row.path);
}
