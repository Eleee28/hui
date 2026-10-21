/**
 * Server-sent events: writing one event, the heartbeat interval that keeps an idle stream alive, and forwarding a live
 * session's messages as named events (the SSE routes and the session WebSocket both use it).
 */
import type { ServerResponse } from "node:http";
import { liveSessions } from "../sessions/live-sessions.ts";

/** How long an event stream may sit idle before a comment proves it is alive. */
export const HEARTBEAT_MS = 15_000;

export function writeEvent(response: ServerResponse, event: string, data: unknown): void {
  if (!response.writableEnded) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * Paints the session once, then forwards everything that happens to it until
 * the returned unsubscribe runs. The caller has already ensured the runtime.
 */
export function watchSessionEvents(
  id: string,
  send: (event: string, data: unknown) => void,
  sessions: Pick<typeof liveSessions, "watch"> = liveSessions,
): () => void {
  const watched = sessions.watch(id, (message) => {
    switch (message.kind) {
      case "snapshot":
        send("snapshot", message.snapshot);
        break;
      case "transcript":
        send("transcript", message.entries);
        break;
      case "status":
        send("status", { status: message.status });
        break;
      case "event":
        send("event", message.event);
        break;
      case "model":
        send("model", message.model);
        break;
      case "thinking":
        send("thinking_level", { level: message.level });
        break;
      case "fast":
        send("fast", { fast: message.fast });
        break;
      case "closed":
        send("closed", {});
        break;
    }
  }, { reader: true });
  send("snapshot", watched.snapshot);
  return watched.unsubscribe;
}
