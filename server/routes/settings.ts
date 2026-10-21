/**
 * `GET/PUT /__hui/settings`: the gateway's HUI settings. Saving goes through `services.ts`'s `writeSettings`, which also
 * applies the changed settings to the running services. `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { Settings, SettingsError } from "../api/settings.ts";
export { routeSchemas } from "../api/settings.ts";
import { readHuiSettings } from "../hui-settings.ts";

const SETTINGS_ROUTE = "/__hui/settings";

export function createSettingsRoutes(deps: { writeSettings(raw: unknown): Promise<Settings> }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    if (request.path !== SETTINGS_ROUTE) return undefined;
    if (request.method === "GET") return reply(Settings, await readHuiSettings());
    if (request.method === "PUT") return reply(Settings, await deps.writeSettings(await request.json()));
    return reply(SettingsError, { error: "method not allowed" }, 405);
  }

  return { handle };
}
