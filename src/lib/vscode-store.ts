/**
 * The VS Code view's shared status: the last status any screen loaded (what can run here, what a first open must ask,
 * an install's progress), told to every listener, and the settings re-read after a license action. Requests go through
 * src/api/vscode.ts; HUI's colors for it come from theme/vscode-theme.ts. The gateway runs and guards the server
 * (server/vscode/vscode.ts).
 */
import { refreshSettings } from "./settings/settings-store.ts";
import { fetchVscodeStatus, postVscodeAction, postVscodeConnect } from "../api/vscode.ts";
import type { VscodeAction, VscodeConnection, VscodeStatus, VscodeTheme } from "../api/schema/vscode.ts";

let known: VscodeStatus | undefined;
const listeners = new Set<(status: VscodeStatus) => void>();

function remember(status: VscodeStatus): VscodeStatus {
  known = status;
  for (const listener of listeners) listener(status);
  return status;
}

/** The last status any screen loaded; undefined before the first. */
export function knownVscodeStatus(): VscodeStatus | undefined {
  return known;
}

export function onVscodeStatus(listener: (status: VscodeStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadVscodeStatus(): Promise<VscodeStatus> {
  return remember(await fetchVscodeStatus());
}

/** One of the gateway's VS Code actions; the license ones change HUI's settings, which this screen then re-reads. */
export async function vscodeAction(action: VscodeAction): Promise<VscodeStatus> {
  const status = remember(await postVscodeAction(action));
  if (action === "accept-license" || action === "revoke-license") await refreshSettings();
  return status;
}

export function stopVscode(): Promise<VscodeStatus> {
  return vscodeAction("stop");
}

/** Starts the shared server if needed and returns a one-use frame URL on the conversation's folder, or the status
 * while it is still starting (serve-web's first start downloads Microsoft's server build). */
export async function connectVscode(sessionId: string, theme: VscodeTheme | undefined): Promise<VscodeConnection | { pending: VscodeStatus }> {
  const connection = await postVscodeConnect(sessionId, theme);
  return "pending" in connection ? { pending: remember(connection.pending) } : connection;
}
