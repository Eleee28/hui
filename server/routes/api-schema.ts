/** Serves the running gateway's public schema from its in-memory payload descriptions, behind the x-hui gate. */
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { ApiSchemaDocument, ApiSchemaError, routeSchemas as apiRouteSchemas } from "../api/api-schema.ts";
import { buildApiSchema, type RouteSchema } from "../api/index.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";

export const routeSchemas: RouteSchema[] = apiRouteSchemas;

export async function handleApiSchemaRoute(request: RouteRequest): Promise<JsonResult | undefined> {
  if (request.path !== "/__hui/api-schema") return undefined;
  if (request.method !== "GET") return reply(ApiSchemaError, { error: "method not allowed" }, 405);
  const manifest = findPackageJSON(import.meta.url);
  if (!manifest) throw new Error("HUI package.json not found");
  const { version } = JSON.parse(await readFile(manifest, "utf8")) as { version: string };
  return reply(ApiSchemaDocument, buildApiSchema(version));
}
