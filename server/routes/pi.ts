/**
 * PI's configuration as HUI shows it: `GET /__hui/pi` (the refreshed view), package install and remove and skill
 * install (`pi-mutations.ts`, which delegates to PI's own CLI or a short-lived PI installer agent, so PI remains the
 * writer), `GET /__hui/tools` and `GET /__hui/pi/resources/:kind/:id` (a skill's or plugin's document). `hui.ts`
 * applies the `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { PiError, PiMutationResult, PiResourceDocument, PiSnapshot, routeSchemas as piRouteSchemas } from "../api/pi.ts";
import { ToolsCatalog, ToolsError, routeSchemas as toolsRouteSchemas } from "../api/tools.ts";

import { readPiConfig } from "../pi/config.ts";
import {
  PiMutationBusyError,
  PiMutationCommandError,
  PiMutationInputError,
  type PiMutationService,
} from "../pi/mutations.ts";
import { PiResourceNotFoundError, readPiResourceDocument } from "../pi/resource-reader.ts";
import { readToolsCatalog } from "../agent-tools/tools.ts";

export const routeSchemas = [...piRouteSchemas, ...toolsRouteSchemas.filter((route) => route.path === "/__hui/tools")];

const PI_ROUTE = "/__hui/pi";
const PI_PACKAGE_INSTALL_ROUTE = `${PI_ROUTE}/packages/install`;
const PI_PACKAGE_REMOVE_ROUTE = `${PI_ROUTE}/packages/remove`;
const PI_SKILL_INSTALL_ROUTE = `${PI_ROUTE}/skills/install`;
const PI_RESOURCE_READ_ROUTE = /^\/__hui\/pi\/resources\/(skill|plugin)\/([a-f0-9]{24})$/;
const TOOLS_ROUTE = "/__hui/tools";

export function createPiRoutes(deps: { piMutations: PiMutationService }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    if (path === PI_PACKAGE_INSTALL_ROUTE || path === PI_PACKAGE_REMOVE_ROUTE || path === PI_SKILL_INSTALL_ROUTE) {
      if (method !== "POST") return reply(PiError, { error: "method not allowed" }, 405);
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const result = path === PI_PACKAGE_INSTALL_ROUTE
          ? await deps.piMutations.installPackage(typeof body["url"] === "string" ? body["url"] : "")
          : path === PI_PACKAGE_REMOVE_ROUTE
            ? await deps.piMutations.removePackage(typeof body["source"] === "string" ? body["source"] : "")
            : await deps.piMutations.installSkill(typeof body["url"] === "string" ? body["url"] : "");
        return reply(PiMutationResult, result);
      } catch (error) {
        const status = error instanceof PiMutationBusyError
          ? 409
          : error instanceof PiMutationInputError
            ? 400
            : error instanceof PiMutationCommandError
              ? 502
              : 500;
        return reply(PiError, { error: error instanceof Error ? error.message : "PI operation failed." }, status);
      }
    }
    if (path === TOOLS_ROUTE) {
      if (method === "GET") return reply(ToolsCatalog, await readToolsCatalog());
      return reply(ToolsError, { error: "method not allowed" }, 405);
    }
    const resourceRead = path.match(PI_RESOURCE_READ_ROUTE);
    if (resourceRead) {
      if (method !== "GET") return reply(PiError, { error: "method not allowed" }, 405);
      try {
        return reply(PiResourceDocument, await readPiResourceDocument(resourceRead[1] as "skill" | "plugin", resourceRead[2] ?? ""));
      } catch (error) {
        return reply(PiError, { error: error instanceof Error ? error.message : "Could not read the resource." },
          error instanceof PiResourceNotFoundError ? 404 : 500);
      }
    }
    if (path === PI_ROUTE) {
      if (method === "GET") return reply(PiSnapshot, await readPiConfig());
      return reply(PiError, { error: "method not allowed" }, 405);
    }
    return undefined;
  }

  return { handle };
}
