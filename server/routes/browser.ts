/**
 * HUI's managed browser: `GET/POST /__hui/browser` (its status, start and stop, over `browser/manager.ts`),
 * `GET /__hui/browser/tabs/:tab/preview` (an operator preview of one tab, as a data URL) and, dispatched earlier
 * with the routes no diagnostic records, `POST /__hui/sessions/:id/browser/connect` (a browser pane's one-use
 * ticket, from `browser-transport.ts`). `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { BrowserError, BrowserPreview, BrowserStatus, BrowserViewConnection } from "../api/browser.ts";
export { routeSchemas } from "../api/browser.ts";
import { browserViewTicket } from "../browser/transport.ts";
import { BrowserToolError, type ManagedBrowser } from "../browser/manager.ts";
import type { SessionRecord } from "../sessions/sessions.ts";

const BROWSER_ROUTE = "/__hui/browser";
const BROWSER_TAB_PREVIEW = /^\/__hui\/browser\/tabs\/(t\d{1,6})\/preview$/u;
const BROWSER_VIEW_ROUTE = /^\/__hui\/sessions\/([^/]+)\/browser\/connect$/u;

export function createBrowserRoutes(deps: {
  managedBrowser: ManagedBrowser;
  browserStatus(): Promise<BrowserStatus>;
  readRegistry(): Promise<SessionRecord[]>;
}) {
  async function connect(request: RouteRequest): Promise<JsonResult | undefined> {
    const browserViewRoute = request.path.match(BROWSER_VIEW_ROUTE);
    if (!browserViewRoute) return undefined;
    try {
      if (request.method !== "POST") throw new BrowserToolError("Method not allowed.", 405);
      const owner = browserViewRoute[1]!;
      if (!(await deps.readRegistry()).some((record) => record.id === owner)) throw new BrowserToolError("Conversation not found.", 404);
      return reply(BrowserViewConnection, { url: browserViewTicket(owner) });
    } catch (error) {
      return reply(BrowserError, { error: error instanceof Error ? error.message : "Browser view request failed." }, error instanceof BrowserToolError ? error.status : 500);
    }
  }

  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { managedBrowser, browserStatus } = deps;
    if (request.path === BROWSER_ROUTE) {
      try {
        if (request.method === "GET") return reply(BrowserStatus, await browserStatus());
        if (request.method !== "POST") return reply(BrowserError, { error: "method not allowed" }, 405);
        let body: unknown;
        try { body = await request.json(); } catch { throw new BrowserToolError("Browser request body must be JSON."); }
        const action = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)["action"] : undefined;
        if (action === "start") await managedBrowser.start();
        else if (action === "stop") await managedBrowser.stop();
        else throw new BrowserToolError("action must be start or stop.");
        return reply(BrowserStatus, await browserStatus());
      } catch (error) {
        return reply(BrowserError, { error: error instanceof Error ? error.message : "The browser request failed." }, error instanceof BrowserToolError ? error.status : 500);
      }
    }
    const browserPreview = request.path.match(BROWSER_TAB_PREVIEW);
    if (browserPreview) {
      if (request.method !== "GET") return reply(BrowserError, { error: "method not allowed" }, 405);
      try {
        const image = await managedBrowser.preview(browserPreview[1] ?? "");
        return reply(BrowserPreview, { image: `data:${image.mimeType};base64,${image.data}` });
      } catch (error) {
        return reply(BrowserError, { error: error instanceof Error ? error.message : "The tab could not be captured." }, error instanceof BrowserToolError ? error.status : 500);
      }
    }
    return undefined;
  }

  return { connect, handle };
}
