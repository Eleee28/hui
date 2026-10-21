/**
 * Browser client for the tools catalog and the tools available to one session. The gateway and PI decide
 * what is available; this module only reads it.
 */
import { fetchJson } from "./request.ts";
import type { SessionTools, ToolsCatalog } from "./schema/tools.ts";

export function loadToolsCatalog(): Promise<ToolsCatalog> {
  return fetchJson("/__hui/tools");
}

export function inspectSessionTools(id: string): Promise<SessionTools> {
  return fetchJson(`/__hui/sessions/${encodeURIComponent(id)}/tools`, { signal: AbortSignal.timeout(7_000) });
}
