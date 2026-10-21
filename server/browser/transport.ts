/**
 * Live view of a conversation's managed-browser tabs for its browser pane.
 *
 * Same capability model as shared terminals: WebSocket cannot carry x-hui, so
 * a guarded POST mints a short-lived, single-use ticket bound to one
 * conversation, and the upgrade also enforces same-origin and Host checks.
 * The stream is view-only; the only client message picks which tab to watch.
 * Frames go out in the binary layout `encodeBrowserFrame` writes.
 */
import { randomBytes } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserViewMessage } from "../api/browser.ts";
import { BrowserToolError, type BrowserViewFrame, type BrowserViewHandle, type BrowserViewListener } from "./manager.ts";
import { validTerminalOrigin } from "../terminals/transport.ts";

export const BROWSER_STREAM_PATH = "/__hui/browser-stream";
/** A slow client skips frames instead of queueing them; the newest frame is
 * sent once it catches up, so an idle page never stays stale. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const CATCH_UP_MS = 100;
const MAX_CLIENTS = 32;
const TICKET_MS = 15_000;

export type BrowserViewSource = { watch(owner: string, listener: BrowserViewListener): BrowserViewHandle };

const tickets = new Map<string, { owner: string; expires: number }>();

export function browserViewTicket(owner: string): string {
  const now = Date.now();
  for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
  if (tickets.size >= 128) throw new BrowserToolError("Too many pending browser view connections.", 429);
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(ticket, { owner, expires: now + TICKET_MS });
  return `${BROWSER_STREAM_PATH}?ticket=${ticket}`;
}

export function attachBrowserTransport(server: EventEmitter, source: BrowserViewSource, allowedHosts?: ReadonlySet<string>): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024, perMessageDeflate: false });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== BROWSER_STREAM_PATH) return;
    const reject = () => { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); };
    if (!validTerminalOrigin(request, allowedHosts) || wss.clients.size >= MAX_CLIENTS) { reject(); return; }
    const token = url.searchParams.get("ticket") ?? "";
    const ticket = tickets.get(token);
    tickets.delete(token);
    if (!ticket || ticket.expires <= Date.now()) { reject(); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let alive = true;
      ws.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 30_000);
      heartbeat.unref();
      let pending: BrowserViewFrame | undefined;
      let catchUp: ReturnType<typeof setTimeout> | undefined;
      const sendText = (message: BrowserViewMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
      const sendFrame = (frame: BrowserViewFrame) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          pending = frame;
          catchUp ??= setTimeout(() => {
            catchUp = undefined;
            const latest = pending;
            pending = undefined;
            if (latest) sendFrame(latest);
          }, CATCH_UP_MS);
          return;
        }
        ws.send(encodeBrowserFrame({ tabId: frame.tabId, width: frame.width, height: frame.height, seq: frame.seq }, frame.image));
      };
      const view = source.watch(ticket.owner, {
        state: (state) => sendText({ type: "state", ...state }),
        action: (action) => sendText({ type: "action", ...action }),
        frame: sendFrame,
      });
      ws.on("message", (data, binary) => {
        if (binary) return;
        try {
          const message = JSON.parse(data.toString()) as unknown;
          if (typeof message === "object" && message !== null && (message as Record<string, unknown>)["action"] === "select") {
            const tabId = (message as Record<string, unknown>)["tabId"];
            view.select(typeof tabId === "string" ? tabId : null);
          }
        } catch {
          // Malformed control messages are ignored; the view stays as it is.
        }
      });
      ws.on("error", () => ws.terminate());
      ws.once("close", () => {
        clearInterval(heartbeat);
        if (catchUp) clearTimeout(catchUp);
        view.close();
      });
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

export type BrowserFrameHeader = { tabId: string; width: number; height: number; seq: number };

export function encodeBrowserFrame(header: BrowserFrameHeader, image: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + image.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(image, 4 + json.length);
  return out;
}
