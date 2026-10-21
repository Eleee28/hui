/**
 * `/__hui/workers` routes.
 *
 *   GET    /__hui/workers                       list with live state
 *   POST   /__hui/workers                       add { name, command, extraPaths? }
 *   PATCH  /__hui/workers/:id                   edit
 *   DELETE /__hui/workers/:id                   remove (no sessions may use it)
 *   POST   /__hui/workers/:id/connect           connect in the background
 *   POST   /__hui/workers/:id/sync              re-sync in the background
 *   POST   /__hui/workers/:id/disconnect
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { WorkersResponse, WorkerResponse, WorkerActionResponse, WorkerError } from "../api/workers.ts";
export { routeSchemas } from "../api/workers.ts";
import type { SessionRecord } from "../sessions/sessions.ts";
import { WorkerInputError, WorkerNotFoundError, type WorkerService } from "../workers.ts";

export const WORKERS_ROUTE = "/__hui/workers";
const ROUTE = /^\/__hui\/workers(?:\/([0-9a-f-]{36})(?:\/(connect|sync|disconnect))?)?$/u;

type Deps = {
  service: WorkerService;
  readRegistry(): Promise<SessionRecord[]>;
};

export function createWorkerRoutes(deps: Deps) {
  const { service } = deps;

  /** Background connect; the browser follows progress through the list. */
  const connectInBackground = (id: string, sync = false) => {
    void (sync ? service.sync(id) : service.connect(id)).catch(() => undefined);
  };

  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method } = request;
    const match = ROUTE.exec(request.path);
    if (!match) return undefined;
    const [, id, action] = match;
    try {
      if (!id) {
        if (method === "GET") return reply(WorkersResponse, { workers: await service.list() });
        if (method === "POST") return reply(WorkerResponse, { worker: await service.create(await request.json() as never) }, 201);
        return reply(WorkerError, { error: "method not allowed" }, 405);
      }
      if (!action) {
        if (method === "PATCH") return reply(WorkerResponse, { worker: await service.update(id, await request.json() as never) });
        if (method === "DELETE") {
          const used = (await deps.readRegistry()).filter((record) => record.worker === id).length;
          if (used) return reply(WorkerError, { error: `${used} session${used === 1 ? "" : "s"} still run${used === 1 ? "s" : ""} on this worker. Delete them first.` }, 409);
          await service.remove(id);
          return reply(WorkerActionResponse, { ok: true });
        }
        return reply(WorkerError, { error: "method not allowed" }, 405);
      }
      if (method !== "POST") return reply(WorkerError, { error: "method not allowed" }, 405);
      await service.get(id);
      if (action === "disconnect") service.disconnect(id, true);
      else connectInBackground(id, action === "sync");
      return reply(WorkerActionResponse, { ok: true }, action === "disconnect" ? 200 : 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker request failed.";
      const status = error instanceof WorkerNotFoundError ? 404 : error instanceof WorkerInputError || error instanceof SyntaxError ? 400 : 502;
      return reply(WorkerError, { error: message }, status);
    }
  }

  return { handle };
}
