/**
 * `GET/PUT /__hui/power`: the Mac's sleep prevention status and its lid-awake switch, over `power.ts` (`null` and
 * 404 off macOS). `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { PowerError, PowerResponse, routeSchemas as powerRouteSchemas } from "../api/power.ts";
import type { RouteSchema } from "../api/index.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { MacPower } from "../power.ts";

export const routeSchemas: RouteSchema[] = powerRouteSchemas;

const POWER_ROUTE = "/__hui/power";

export function createPowerRoutes(deps: { macPower: MacPower | undefined }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    if (request.path !== POWER_ROUTE) return undefined;
    const { macPower } = deps;
    if (request.method === "GET") return reply(PowerResponse, { power: macPower?.status() ?? null });
    if (request.method === "PUT") {
      const body = await request.json();
      const lidAwake = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["lidAwake"] : undefined;
      if (typeof lidAwake !== "boolean") return reply(PowerError, { error: "lidAwake must be a boolean" }, 400);
      if (!macPower) return reply(PowerError, { error: "sleep prevention is only available on macOS" }, 404);
      // Not awaited: turning it on waits on a macOS password dialog.
      void macPower.setLidAwake(lidAwake);
      return reply(PowerResponse, { power: macPower.status() });
    }
    return reply(PowerError, { error: "method not allowed" }, 405);
  }

  return { handle };
}
