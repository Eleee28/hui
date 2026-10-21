/**
 * Memory readings for runtime processes: the resident size of each runtime root plus all of its descendants,
 * from one `ps` call cached for a few seconds. Best effort and POSIX-only; Windows and failed reads report
 * nothing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_MS = 2_500;

type ProcessRow = { pid: number; parentPid: number; rssBytes: number };
let cached: { key: string; at: number; value: Map<number, number> } | undefined;

/** Parse portable `ps` PID/PPID/RSS output. RSS is reported in KiB. */
export function parseProcessRows(output: string): ProcessRow[] {
  return output.split("\n").flatMap((line) => {
    const [pidText, parentText, rssText] = line.trim().split(/\s+/, 3);
    const pid = Number(pidText);
    const parentPid = Number(parentText);
    const rssKiB = Number(rssText);
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0
      && Number.isFinite(rssKiB) && rssKiB >= 0
      ? [{ pid, parentPid, rssBytes: Math.round(rssKiB * 1024) }]
      : [];
  });
}

/** Sum each runtime root and every descendant currently below it. */
export function processTreeMemory(rows: readonly ProcessRow[], roots: readonly number[]): Map<number, number> {
  const children = new Map<number, number[]>();
  const memory = new Map(rows.map((row) => [row.pid, row.rssBytes]));
  for (const row of rows) children.set(row.parentPid, [...(children.get(row.parentPid) ?? []), row.pid]);
  const result = new Map<number, number>();
  for (const root of new Set(roots.filter((pid) => Number.isInteger(pid) && pid > 0))) {
    if (!memory.has(root)) continue;
    let total = 0;
    const pending = [root];
    const seen = new Set<number>();
    while (pending.length) {
      const pid = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += memory.get(pid) ?? 0;
      pending.push(...(children.get(pid) ?? []));
    }
    result.set(root, total);
  }
  return result;
}

/** Best-effort POSIX process-tree RSS. Unsupported hosts return no readings. */
export async function runtimeMemoryByPid(roots: readonly number[]): Promise<Map<number, number>> {
  const unique = [...new Set(roots.filter((pid) => Number.isInteger(pid) && pid > 0))].toSorted((a, b) => a - b);
  if (!unique.length || process.platform === "win32") return new Map();
  const key = unique.join(",");
  const now = Date.now();
  if (cached?.key === key && now - cached.at < CACHE_MS) return new Map(cached.value);
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="], {
      timeout: 1_500,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
    });
    const value = processTreeMemory(parseProcessRows(stdout), unique);
    cached = { key, at: now, value };
    return new Map(value);
  } catch {
    return new Map();
  }
}
