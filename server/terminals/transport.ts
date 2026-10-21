/**
 * The WebSocket transport for terminals. Upgrades are accepted only with a short-lived, single-use ticket
 * minted through a guarded request, from the same origin and an allowed host; the socket then streams terminal
 * output out as binary messages (a burst of small PTY chunks batched into fewer messages), metadata as JSON
 * text, and takes input and resize messages in (JSON control schema: server/api/terminals.ts).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { terminals, TerminalService, TerminalError, TERMINAL_INPUT_BYTES, type TerminalStreamEvent } from "./terminals.ts";
import type { TerminalControlFrame } from "../api/terminals.ts";

/** A client this far behind is dropped; it reconnects and replays instead of queueing unbounded output. */
export const TERMINAL_MAX_BUFFERED_BYTES = 1024 * 1024;

/** How long output following a sent chunk is gathered before the next message, and the most one message holds. */
export const TERMINAL_BATCH_MS = 4;
export const TERMINAL_BATCH_BYTES = 64 * 1024;

export type OutputBatcher = { push(chunk: Buffer): void; flush(): void; dispose(): void };

/**
 * A fast shell is read in many small chunks, and each WebSocket message costs the browser a task and a terminal
 * write. The first chunk after a quiet period is sent at once, so keystroke echo is never delayed; chunks arriving
 * within the next TERMINAL_BATCH_MS are joined, up to TERMINAL_BATCH_BYTES per message so none takes long to parse.
 */
export function createOutputBatcher(send: (bytes: Buffer) => void, schedule: (flush: () => void, ms: number) => () => void = (flush, ms) => { const timer = setTimeout(flush, ms); return () => clearTimeout(timer); }): OutputBatcher {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let cancel: (() => void) | undefined;
  const take = () => {
    const out = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    return out;
  };
  const tick = () => {
    cancel = undefined;
    if (!pendingBytes) return;
    send(take());
    cancel = schedule(tick, TERMINAL_BATCH_MS);
  };
  return {
    push(chunk) {
      if (!cancel) { send(chunk); cancel = schedule(tick, TERMINAL_BATCH_MS); return; }
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes >= TERMINAL_BATCH_BYTES) send(take());
    },
    flush() { if (pendingBytes) send(take()); },
    dispose() { cancel?.(); cancel = undefined; pending = []; pendingBytes = 0; },
  };
}

/** Sends one non-output service event as its JSON text frame; a snapshot is followed by its binary replay. */
export function sendTerminalControl(ws: WebSocket, event: Exclude<TerminalStreamEvent, { type: "data" }>): void {
  if (event.type === "state") { ws.send(JSON.stringify(event satisfies TerminalControlFrame)); return; }
  const frame: TerminalControlFrame = { type: "snapshot", terminal: event.terminal, sequence: event.sequence, truncated: event.truncated, replayBytes: event.replay.length };
  ws.send(JSON.stringify(frame));
  if (event.replay.length) ws.send(event.replay, { binary: true });
}

const tickets = new Map<string, { owner: string; id: string; expires: number }>();
export function terminalTicket(owner: string, id: string): string {
  terminals.read(owner, id);
  for (const [key, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(key);
  if (tickets.size >= 128) throw new TerminalError("Too many pending terminal connections.", 429);
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { owner, id, expires: Date.now() + 15_000 });
  return `/__hui/terminal-stream?ticket=${ticket}`;
}

export function validTerminalOrigin(request: IncomingMessage, allowedHosts?: ReadonlySet<string>): boolean {
  try {
    const origin = new URL(request.headers.origin ?? "");
    return ["http:", "https:"].includes(origin.protocol) && origin.host === request.headers.host && (!allowedHosts || allowedHosts.has(origin.hostname.toLowerCase()));
  } catch { return false; }
}

/** WebSocket cannot carry x-hui. A guarded POST mints a short-lived, single-use
 * capability; same-origin and Host checks also apply to the upgrade path. */
export function attachTerminalTransport(server: EventEmitter, allowedHosts?: ReadonlySet<string>, service: TerminalService = terminals): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_INPUT_BYTES * 6 + 1024, perMessageDeflate: false });
  // Named handler permits detaching from Vite without owning its other sockets.
  const onUpgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/__hui/terminal-stream") return;
    const reject = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
    if (!validTerminalOrigin(request, allowedHosts) || wss.clients.size >= 64) { reject(); return; }
    const token = url.searchParams.get("ticket") ?? "";
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket || ticket.expires <= Date.now()) { reject(); return; }
    try { service.read(ticket.owner, ticket.id); } catch { reject(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let alive = true;
      ws.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 30_000);
      heartbeat.unref();
      const output = createOutputBatcher((bytes) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > TERMINAL_MAX_BUFFERED_BYTES) { ws.close(1013, "Reconnect for terminal replay"); return; }
        ws.send(bytes, { binary: true });
      });
      const unsubscribe = service.subscribe(ticket.owner, ticket.id, (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (event.type === "data") { output.push(event.data); return; }
        // Output already read precedes a later resize or exit.
        output.flush();
        if (ws.readyState === WebSocket.OPEN) sendTerminalControl(ws, event);
      });
      ws.on("message", (data, binary) => {
        try {
          if (binary) throw new TerminalError("Terminal messages must be JSON text.");
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message?.["action"] === "input") service.input(ticket.owner, ticket.id, message["data"]);
          else if (message?.["action"] === "resize") service.resize(ticket.owner, ticket.id, message["cols"], message["rows"]);
          else throw new TerminalError("Unknown terminal message.");
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : "Terminal request failed." } satisfies TerminalControlFrame));
        }
      });
      ws.on("error", () => ws.terminate());
      ws.once("close", () => { clearInterval(heartbeat); output.dispose(); unsubscribe(); });
    });
  };
  server.on("upgrade", onUpgrade);
  return () => { server.off("upgrade", onUpgrade); for (const client of wss.clients) client.terminate(); wss.close(); tickets.clear(); };
}
