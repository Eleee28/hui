/** Browser client for the VS Code routes: the gateway's VS Code status, its actions and the one-use frame URL for a
 * conversation's folder. lib/vscode-store.ts remembers the last status for every screen. */
import { CLIENT_HEADERS, fetchJson, fetchWithResponseDeadline, trackedFetch } from "./request.ts";
import type { VscodeAction, VscodeConnection, VscodeErrorCode, VscodeStatus, VscodeTheme } from "./schema/vscode.ts";

export const VSCODE_STATUS_ROUTE = "/__hui/vscode-server";

export function fetchVscodeStatus(): Promise<VscodeStatus> {
  return fetchJson<VscodeStatus>(VSCODE_STATUS_ROUTE);
}

export function postVscodeAction(action: VscodeAction): Promise<VscodeStatus> {
  return fetchJson<VscodeStatus>(VSCODE_STATUS_ROUTE, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
  });
}

/** A refusal with the gateway's reason and what kind it is, so the view can show its setup card or explain the
 * conversation. */
export class VscodeConnectError extends Error {
  code: VscodeErrorCode;
  status: number;
  constructor(message: string, code: VscodeErrorCode, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ERROR_CODES = new Set<VscodeErrorCode>(["setup", "remote", "folder", "failed", "busy"]);

export async function postVscodeConnect(sessionId: string, theme: VscodeTheme | undefined): Promise<VscodeConnection | { pending: VscodeStatus }> {
  const response = await fetchWithResponseDeadline(trackedFetch, `/__hui/sessions/${encodeURIComponent(sessionId)}/vscode/connect`, {
    method: "POST",
    headers: { ...CLIENT_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(theme ? { theme } : {}),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => undefined)) as (Partial<VscodeConnection> & { error?: string; code?: string; pending?: boolean; status?: VscodeStatus }) | undefined;
  if (response.status === 202 && body?.pending && body.status) return { pending: body.status };
  if (!response.ok || typeof body?.url !== "string") {
    const code = ERROR_CODES.has(body?.code as VscodeErrorCode) ? body?.code as VscodeErrorCode : "failed";
    throw new VscodeConnectError(body?.error ?? `VS Code could not open (HTTP ${response.status}).`, code, response.status);
  }
  const folder = String(body.folder ?? "");
  return { url: body.url, folder, label: String(body.label ?? folder), instance: Number(body.instance ?? 0) };
}
