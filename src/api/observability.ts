/**
 * Browser client for the gateway's diagnostics: recent activity and logs, usage totals and runtime details,
 * plus a download of the redacted diagnostics export. The gateway collects and retains the events in memory.
 */
import type { ObservabilitySnapshot } from "./schema/diagnostics.ts";
export type { DiagnosticEvent, ObservabilitySnapshot } from "./schema/diagnostics.ts";
import { fetchJson } from "./request.ts";

export function loadObservability(): Promise<ObservabilitySnapshot> {
  return fetchJson<ObservabilitySnapshot>("/__hui/observability");
}

export async function downloadDiagnostics(): Promise<void> {
  const snapshot = await fetchJson<ObservabilitySnapshot>("/__hui/diagnostics/export");
  const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `hui-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
