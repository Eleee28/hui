/**
 * Browser client for a session's watchers: stopping, restarting or dismissing one and reading its log. The
 * gateway runs the watchers; the browser normalizes their snapshot rows.
 */
import { parseWatchers } from "../lib/watchers.ts";
import type { Watcher, WatcherLog } from "./schema/watchers.ts";
import { fetchJson } from "./request.ts";

export { parseWatchers, watcherStateLabel, watcherStateNote } from "../lib/watchers.ts";
export type { Watcher, WatcherState, WatcherLog } from "./schema/watchers.ts";

function watcherUrl(sessionId: string, watcherId: string): string {
  return `/__hui/sessions/${encodeURIComponent(sessionId)}/watchers/${encodeURIComponent(watcherId)}`;
}

async function mutate(sessionId: string, watcherId: string, action: "stop" | "restart"): Promise<Watcher[]> {
  const { watchers } = await fetchJson<{ watchers: unknown }>(`${watcherUrl(sessionId, watcherId)}/${action}`, { method: "POST" });
  return parseWatchers(watchers);
}

export async function stopWatcher(sessionId: string, watcherId: string): Promise<Watcher[]> {
  return mutate(sessionId, watcherId, "stop");
}

export async function restartWatcher(sessionId: string, watcherId: string): Promise<Watcher[]> {
  return mutate(sessionId, watcherId, "restart");
}

export async function dismissWatcher(sessionId: string, watcherId: string): Promise<Watcher[]> {
  const { watchers } = await fetchJson<{ watchers: unknown }>(watcherUrl(sessionId, watcherId), { method: "DELETE" });
  return parseWatchers(watchers);
}

export async function readWatcherLog(sessionId: string, watcherId: string, lines = 200): Promise<WatcherLog> {
  return fetchJson<WatcherLog>(`${watcherUrl(sessionId, watcherId)}/log?lines=${lines}`);
}
