/**
 * Live session events for browser views. Each view used to hold an SSE fetch,
 * and browsers allow only six HTTP/1.1 connections per origin, so five open
 * views stalled every other request. WebSockets have a separate, far larger
 * limit. Same capability model as terminals: a guarded POST mints a
 * short-lived, single-use ticket bound to one session.
 */
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { validTerminalOrigin } from "../terminals/transport.ts";

export const SESSION_STREAM_PATH = "/__hui/session-stream";
/** Close code for a session that is gone; the browser stops retrying. */
export const SESSION_STREAM_GONE = 4404;
const MAX_CLIENTS = 128;
const TICKET_MS = 15_000;

/** Starts forwarding `id`'s frames to `send` and returns its unsubscribe, or
 * undefined when the session no longer exists. */
export type SessionEventSource = (id: string, send: (event: string, data: unknown) => void) => Promise<(() => void) | undefined>;

const tickets = new Map<string, { id: string; expires: number }>();

export function sessionStreamTicket(id: string): string | undefined {
  const now = Date.now();
  for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
  if (tickets.size >= 128) return undefined;
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { id, expires: now + TICKET_MS });
  return `${SESSION_STREAM_PATH}?ticket=${ticket}`;
}

export function attachSessionTransport(server: EventEmitter, source: SessionEventSource, allowedHosts?: ReadonlySet<string>): () => void {
  // A view's first frame is the whole transcript, megabytes of JSON for a long
  // session; deflate makes it a fraction of that over a slow link. Small frames
  // (streamed deltas) go as they are. No context carries between messages:
  // each frame compresses alone, which keeps a view's memory flat.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: {
    threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 4,
  } });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== SESSION_STREAM_PATH) return;
    const reject = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
    if (!validTerminalOrigin(request, allowedHosts) || wss.clients.size >= MAX_CLIENTS) { reject(); return; }
    const token = url.searchParams.get("ticket") ?? "";
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket || ticket.expires <= Date.now()) { reject(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let alive = true;
      let stop: (() => void) | undefined;
      ws.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 30_000);
      heartbeat.unref();
      ws.on("error", () => ws.terminate());
      ws.once("close", () => { clearInterval(heartbeat); stop?.(); });
      void source(ticket.id, (event, data) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ event, data }));
        if (event === "closed") ws.close(1000);
      }).then((unsubscribe) => {
        if (!unsubscribe) ws.close(SESSION_STREAM_GONE, "unknown session");
        else if (ws.readyState === WebSocket.OPEN) stop = unsubscribe;
        else unsubscribe();
      }, () => ws.close(1011, "session stream failed"));
    });
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
    tickets.clear();
  };
}
