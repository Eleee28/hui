/** Normalizes watcher snapshot rows and formats their state labels and failure notes. */
import type { Watcher, WatcherState } from "../api/schema/watchers.ts";
export type { Watcher, WatcherState } from "../api/schema/watchers.ts";

const WATCHER_LIMITS = {
  purpose: 200,
  target: 500,
  outcome: 200,
  command: 4_000,
  perSession: 10,
  logLines: 400,
  logLine: 500,
} as const;

const STATE_SET = new Set<string>(["running", "done", "failed", "stopped", "dead"]);

function text(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

/** Browser-side normalization of the snapshot field; drops malformed rows. */
export function parseWatchers(value: unknown): Watcher[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, WATCHER_LIMITS.perSession).flatMap((item): Watcher[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const state = text(row["state"], 20);
    const pid = row["pid"];
    const exitCode = row["exitCode"];
    const watcher: Watcher = {
      id: text(row["id"], 100),
      purpose: text(row["purpose"], WATCHER_LIMITS.purpose),
      target: text(row["target"], WATCHER_LIMITS.target),
      outcome: text(row["outcome"], WATCHER_LIMITS.outcome),
      command: text(row["command"], WATCHER_LIMITS.command),
      logPath: text(row["logPath"], 4_096),
      state: (STATE_SET.has(state) ? state : "dead") as WatcherState,
      pid: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      ...(typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
      startedAt: text(row["startedAt"], 40),
      ...(text(row["endedAt"], 40) ? { endedAt: text(row["endedAt"], 40) } : {}),
      lastLine: text(row["lastLine"], WATCHER_LIMITS.logLine),
      ...(row["keepRunning"] === true ? { keepRunning: true as const } : {}),
    };
    return watcher.id && watcher.purpose && watcher.command && watcher.startedAt ? [watcher] : [];
  });
}

const STATE_LABELS: Record<WatcherState, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  dead: "Dead",
};

/** One word for the compact row. */
export function watcherStateLabel(watcher: Pick<Watcher, "state">): string {
  return STATE_LABELS[watcher.state];
}

/** Why a watcher failed or died, for its opened row; "" otherwise. */
export function watcherStateNote(watcher: Pick<Watcher, "state" | "exitCode">): string {
  if (watcher.state === "failed" && watcher.exitCode !== undefined) return `Exited with status ${watcher.exitCode}.`;
  if (watcher.state === "dead") return "The process is gone and recorded no exit status, for example after a restart.";
  return "";
}
