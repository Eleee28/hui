/** Browser client for the session calendar: the gateway's session activity between two times. */
import type { SessionActivity } from "./schema/github.ts";
import { fetchJson } from "./request.ts";

export function loadSessionActivity(start: Date, end: Date): Promise<SessionActivity> {
  return fetchJson<SessionActivity>(`/__hui/session-activity?from=${start.valueOf()}&to=${end.valueOf()}`);
}
