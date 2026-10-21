/** The raw `/__hui/settings` requests. The cache, write queue and appearance live in `lib/settings/settings-store.ts`. */
import type { Settings } from "./schema/settings.ts";
import { fetchJson } from "./request.ts";

const SETTINGS_URL = "/__hui/settings";

export function fetchSettings(): Promise<unknown> {
  return fetchJson<unknown>(SETTINGS_URL);
}

export function saveSettings(settings: Settings): Promise<unknown> {
  return fetchJson<unknown>(SETTINGS_URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
}
