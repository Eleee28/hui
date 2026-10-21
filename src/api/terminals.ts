/**
 * Browser client for a session's terminals: listing, opening and closing them, and connecting to one over a
 * WebSocket. The gateway owns the PTYs; the browser only holds the socket.
 */
import { fetchJson } from "./request.ts";
import type { TerminalView, TerminalControlFrame, TerminalSnapshotFrame, TerminalsResponse, TerminalResponse, TerminalConnectResponse } from "./schema/terminals.ts";
export type { TerminalView, TerminalSnapshotFrame, TerminalControlFrame, TerminalInput } from "./schema/terminals.ts";

const url = (owner: string, id?: string) => `/__hui/sessions/${encodeURIComponent(owner)}/terminals${id ? `/${encodeURIComponent(id)}` : ""}`;
const post = (body: unknown = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export async function listTerminals(owner: string): Promise<TerminalView[]> {
  return (await fetchJson<TerminalsResponse>(url(owner))).terminals;
}
export async function createTerminal(owner: string): Promise<TerminalView> {
  return (await fetchJson<TerminalResponse>(url(owner), post())).terminal;
}
export async function endTerminal(owner: string, id: string): Promise<void> {
  await fetchJson(url(owner, id), post({ action: "close" }));
}
export async function connectTerminal(owner: string, id: string): Promise<WebSocket> {
  const result = await fetchJson<TerminalConnectResponse>(`${url(owner, id)}/connect`, post());
  const address = new URL(result.url, location.href);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(address);
  socket.binaryType = "arraybuffer";
  return socket;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const view = (value: unknown): value is TerminalView => record(value) && typeof value["id"] === "string" && Number.isInteger(value["cols"]) && Number.isInteger(value["rows"]) && (value["status"] === "running" || value["status"] === "exited");

/** Parses a server text message; anything else, including a malformed frame, is undefined. */
export function parseTerminalControlFrame(text: string): TerminalControlFrame | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!record(value)) return undefined;
  if (value["type"] === "snapshot") {
    const { terminal, sequence, truncated, replayBytes } = value;
    return view(terminal) && Number.isInteger(sequence) && typeof truncated === "boolean" && Number.isInteger(replayBytes) && (replayBytes as number) >= 0
      ? { type: "snapshot", terminal, sequence: sequence as number, truncated, replayBytes: replayBytes as number }
      : undefined;
  }
  if (value["type"] === "state") return view(value["terminal"]) ? { type: "state", terminal: value["terminal"] } : undefined;
  if (value["type"] === "error") return typeof value["error"] === "string" ? { type: "error", error: value["error"] } : undefined;
  return undefined;
}

export type TerminalStreamHandlers = {
  snapshot(frame: TerminalSnapshotFrame, replay: Uint8Array): void;
  output(bytes: Uint8Array): void;
  state(terminal: TerminalView): void;
  error(message: string): void;
};

const empty = new Uint8Array(0);

/** Returns the socket message handler; set `binaryType = "arraybuffer"` on the socket. */
export function createTerminalStreamReader(handlers: TerminalStreamHandlers): (data: unknown) => void {
  let awaitingReplay: TerminalSnapshotFrame | undefined;
  return (data) => {
    if (typeof data !== "string") {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : undefined;
      if (!bytes) { handlers.error("Unsupported terminal message."); return; }
      const snapshot = awaitingReplay;
      awaitingReplay = undefined;
      if (snapshot) handlers.snapshot(snapshot, bytes);
      else if (bytes.length) handlers.output(bytes);
      return;
    }
    const frame = parseTerminalControlFrame(data);
    if (!frame) { handlers.error("Malformed terminal message."); return; }
    if (awaitingReplay) {
      // The replay must directly follow its snapshot; anything else means the stream cannot be trusted.
      awaitingReplay = undefined;
      handlers.error("Terminal replay was interrupted.");
    }
    if (frame.type === "snapshot") {
      if (frame.replayBytes > 0) awaitingReplay = frame;
      else handlers.snapshot(frame, empty);
    } else if (frame.type === "state") handlers.state(frame.terminal);
    else handlers.error(frame.error);
  };
}
