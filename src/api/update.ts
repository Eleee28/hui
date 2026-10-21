/**
 * Browser client for HUI's self-update: reading the current state, checking for a release and starting an
 * install. Downloading and activating releases happen in the gateway.
 */
import { fetchJson } from "./request.ts";
import type { UpdateSnapshot } from "./schema/updates.ts";

export const loadUpdate = () => fetchJson<UpdateSnapshot>("/__hui/update");
export const checkUpdate = () => fetchJson<UpdateSnapshot>("/__hui/update/check", { method: "POST", signal: AbortSignal.timeout(30_000) });
export const checkUpdateInBackground = () => fetchJson<UpdateSnapshot>("/__hui/update/check", { signal: AbortSignal.timeout(30_000) });
export const installUpdate = (version: string) => fetchJson<UpdateSnapshot>("/__hui/update", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version }), signal: AbortSignal.timeout(15_000),
});
