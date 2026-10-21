/**
 * `GET/POST /__hui/update` (the installed release's status, and installing the stable version an update check
 * returned) and `GET/POST /__hui/update/check`, over `updates.ts`. `hui.ts` applies the `x-hui` guard before
 * dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { UpdateSnapshot, UpdateError } from "../api/updates.ts";
export { routeSchemas } from "../api/updates.ts";
import { updates, UpdateConflict } from "../updates.ts";

const UPDATE_ROUTE = "/__hui/update";
const UPDATE_CHECK_ROUTE = "/__hui/update/check";

export function createUpdateRoutes() {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    if (path !== UPDATE_ROUTE && path !== UPDATE_CHECK_ROUTE) return undefined;
    try {
      if (method === "GET" && path === UPDATE_ROUTE) return reply(UpdateSnapshot, await updates.status());
      if ((method === "GET" || method === "POST") && path === UPDATE_CHECK_ROUTE) return reply(UpdateSnapshot, await updates.check(method === "GET"));
      if (method !== "POST" || path !== UPDATE_ROUTE) return reply(UpdateError, { error: "method not allowed" }, 405);
      let body: { version?: unknown } | null;
      try { body = await request.json() as { version?: unknown } | null; }
      catch { return reply(UpdateError, { error: "Invalid update request body." }, 400); }
      if (!body || typeof body.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(body.version) || Object.keys(body).some((key) => key !== "version")) {
        return reply(UpdateError, { error: "Provide only the stable version returned by the update check." }, 400);
      }
      return reply(UpdateSnapshot, await updates.start(body.version), 202);
    } catch (error) {
      return reply(UpdateError, { error: error instanceof UpdateConflict ? error.message : "Update request failed. Check the gateway log and retry." }, error instanceof UpdateConflict ? 409 : 500);
    }
  }

  return { handle };
}
