/**
 * When the UI offers a HUI update and how often it checks. The page's lifetime owns the timer, not the
 * gateway or a host scheduler, and failed background checks stay silent.
 */
import type { ReleaseInfo, UpdateSnapshot } from "../api/schema/updates.ts";

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;

/** No optimistic notifications, nor a stale offer during/after activation. */
export function availableUpdate(snapshot: UpdateSnapshot | null, dismissedVersion: string): ReleaseInfo | null {
  const check = snapshot?.check;
  const latest = check?.latest;
  if (!latest || check?.status !== "available" || latest.version === dismissedVersion
    || latest.version === snapshot?.currentVersion || snapshot?.job?.status === "running") return null;
  return latest;
}

/** The UI's lifetime owns this timer, not the gateway or a host scheduler.
 * Hidden/offline pages pause; resume events only check once the interval is due. */
export function watchUpdateAvailability(options: {
  check(): Promise<UpdateSnapshot>; receive(snapshot: UpdateSnapshot): void; enabled(): boolean;
}) {
  let stopped = false;
  let checking = false;
  let nextCheckAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    clearTimeout(timer);
    if (stopped || checking || !options.enabled()) return;
    if (Date.now() < nextCheckAt) {
      timer = setTimeout(() => void refresh(), nextCheckAt - Date.now());
      return;
    }
    checking = true;
    try {
      const snapshot = await options.check();
      if (!stopped) options.receive(snapshot);
    } catch {
      // Background failures stay quiet. The explicit dialog reports errors.
    } finally {
      checking = false;
      nextCheckAt = Date.now() + UPDATE_CHECK_INTERVAL_MS;
      if (!stopped) void refresh();
    }
  };
  void refresh();
  return { refresh: () => void refresh(), stop: () => { stopped = true; clearTimeout(timer); } };
}
