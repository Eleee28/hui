/**
 * `GET /__hui/sessions/:id/attachments/:message/(files/)?:index`: a prompt attachment from a conversation's history,
 * an image the runtime holds or a file from the attachment store (`sessions/attachments.ts`). An `<img>` cannot send
 * `x-hui`, so `hui.ts` dispatches here before its guard, and this route accepts that header or a browser-attested
 * same-origin fetch and refuses everything cross-site.
 */
import { CLIENT_HEADER, type RouteRequest, type RouteResult } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import type { LiveSessions } from "../sessions/live-sessions.ts";
import { readStoredAttachment } from "../sessions/attachments.ts";

export const routeSchemas: RouteSchema[] = [];

export const ATTACHMENT_ROUTE = /^\/__hui\/sessions\/([^/]+)\/attachments\/(\d{1,9})\/(files\/)?(\d{1,4})$/u;

type Deps = {
  session(id: string): Promise<object | undefined>;
  liveSessions: Pick<LiveSessions, "attachmentFile" | "attachmentImage">;
};

export function createAttachmentRoutes(deps: Deps) {
  async function handle(request: RouteRequest): Promise<RouteResult | undefined> {
    const match = ATTACHMENT_ROUTE.exec(request.path);
    if (!match) return undefined;
    const site = request.headers["sec-fetch-site"];
    if (request.headers[CLIENT_HEADER] !== "1" && site !== "same-origin") {
      return { status: 403, body: { error: `missing ${CLIENT_HEADER} header` } };
    }
    if (request.method !== "GET") return { status: 405, body: { error: "method not allowed" } };
    const id = decodeURIComponent(match[1] ?? "");
    if (!await deps.session(id)) return { status: 404, body: { error: `unknown session: ${id}` } };
    const message = Number(match[2]);
    const index = Number(match[4]);
    const filePath = match[3] ? deps.liveSessions.attachmentFile(id, message, index) : undefined;
    const fileData = filePath ? await readStoredAttachment(filePath) : undefined;
    const attachment = match[3]
      ? fileData && { mimeType: "application/octet-stream", data: fileData }
      : await deps.liveSessions.attachmentImage(id, message, index);
    if (!attachment) return { status: 404, body: { error: "attachment not found" } };
    return { status: 200, file: { ...attachment, headers: { "cross-origin-resource-policy": "same-origin" } } };
  }

  return { handle };
}
