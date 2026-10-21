/**
 * `/__hui/sessions/:id/watchers/:wid…`: stop, restart or dismiss a conversation's watcher and read its bounded log
 * tail. Processes and persistence stay in `watchers.ts`; `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { WatcherError, WatcherLog, WatchersResponse } from "../api/watchers.ts";
export { routeSchemas } from "../api/watchers.ts";
import type { readRegistry } from "../sessions/sessions.ts";
import { WATCHER_LIMITS, WatcherConflictError, WatcherNotFoundError, type WatcherService } from "../agent-tools/watchers.ts";

const SESSION_WATCHER = /^\/__hui\/sessions\/([^/]+)\/watchers\/([^/]+?)(?:\/(stop|restart|log))?$/;

export function createWatcherRoutes(deps: { watchers: WatcherService; readRegistry: typeof readRegistry }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { path } = request;
    const { watchers, readRegistry } = deps;
    const watcherRoute = path.match(SESSION_WATCHER);
    if (watcherRoute) {
      const verb = watcherRoute[3] ?? "";
      const method = verb === "log" ? "GET" : verb === "stop" || verb === "restart" ? "POST" : "DELETE";
      if (request.method !== method) {
        return reply(WatcherError, { error: "method not allowed" }, 405);
      }
      const id = decodeURIComponent(watcherRoute[1] ?? "");
      const watcherId = decodeURIComponent(watcherRoute[2] ?? "");
      if (!(await readRegistry()).some((session) => session.id === id)) {
        return reply(WatcherError, { error: `unknown session: ${id}` }, 404);
      }
      try {
        if (verb === "log") {
          const requested = request.query.get("lines");
          const lines = requested === null ? 100 : Number(requested);
          if (!Number.isInteger(lines) || lines < 1 || lines > WATCHER_LIMITS.logLines) {
            return reply(WatcherError, { error: `lines must be between 1 and ${WATCHER_LIMITS.logLines}` }, 400);
          }
          return reply(WatcherLog, await watchers.log(id, watcherId, lines));
        }
        if (verb === "stop") await watchers.stop(id, watcherId);
        else if (verb === "restart") await watchers.restart(id, watcherId);
        else await watchers.remove(id, watcherId);
        return reply(WatchersResponse, { watchers: watchers.list(id) });
      } catch (error) {
        const status = error instanceof WatcherNotFoundError ? 404 : error instanceof WatcherConflictError ? 409 : 400;
        return reply(WatcherError, {
          error: error instanceof Error ? error.message : "The watcher request failed.",
        }, status);
      }
    }
    return undefined;
  }

  return { handle };
}
