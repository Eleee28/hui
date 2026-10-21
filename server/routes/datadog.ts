/**
 * `/__hui/datadog…`: the `pup` connection, its orgs and sign-in (`datadog.ts`) and dashboard and share previews
 * (`datadog-previews.ts`). `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { DatadogError, type DatadogOrgs } from "../integrations/datadog.ts";
import type { DatadogPreviews } from "../integrations/datadog-previews.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import { DatadogConnection, DatadogError as DatadogErrorResponse, DatadogPreviewsResponse, routeSchemas as datadogRouteSchemas } from "../api/datadog.ts";
import { MAX_DATADOG_EMBEDS, parseDatadogUrl } from "../integrations/datadog-links.ts";

export const routeSchemas: RouteSchema[] = datadogRouteSchemas;

const DATADOG_ROUTE = "/__hui/datadog";
const DATADOG_ORGS_ROUTE = `${DATADOG_ROUTE}/orgs`;
const DATADOG_LOGIN_ROUTE = `${DATADOG_ROUTE}/login`;
const DATADOG_PREVIEWS_ROUTE = `${DATADOG_ROUTE}/previews`;

/** A Datadog route failure: the operator's input (400/404/409) or HUI's own (500), never pup's output. */
function datadogError(error: unknown): JsonResult {
  if (error instanceof DatadogError) return reply(DatadogErrorResponse, { error: error.message }, error.status);
  if (error instanceof SyntaxError) return reply(DatadogErrorResponse, { error: "Send a JSON body." }, 400);
  return reply(DatadogErrorResponse, { error: error instanceof Error ? error.message : "Datadog request failed." }, 500);
}

export function createDatadogRoutes(deps: { datadogOrgs: DatadogOrgs; datadogPreviews: DatadogPreviews }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    const { datadogOrgs, datadogPreviews } = deps;

    if (path === DATADOG_ROUTE) {
      if (method !== "GET") return reply(DatadogErrorResponse, { error: "method not allowed" }, 405);
      try {
        return reply(DatadogConnection, await datadogOrgs.connection());
      } catch (error) {
        return datadogError(error);
      }
    }

    if (path === DATADOG_ORGS_ROUTE) {
      if (method !== "POST" && method !== "DELETE") return reply(DatadogErrorResponse, { error: "method not allowed" }, 405);
      try {
        const params = request.query;
        return reply(DatadogConnection, method === "POST"
          ? await datadogOrgs.add(await request.json())
          : await datadogOrgs.remove({ name: params.get("name") ?? "", site: params.get("site") ?? "" }));
      } catch (error) {
        return datadogError(error);
      }
    }

    if (path === DATADOG_LOGIN_ROUTE) {
      if (method !== "POST" && method !== "DELETE") return reply(DatadogErrorResponse, { error: "method not allowed" }, 405);
      try {
        return reply(DatadogConnection, method === "POST" ? await datadogOrgs.startLogin(await request.json()) : await datadogOrgs.cancelLogin());
      } catch (error) {
        return datadogError(error);
      }
    }

    if (path === DATADOG_PREVIEWS_ROUTE) {
      if (method !== "GET") return reply(DatadogErrorResponse, { error: "method not allowed" }, 405);
      const urls = request.query.getAll("url");
      if (urls.length === 0 || urls.length > MAX_DATADOG_EMBEDS || urls.some((url) => url.length > 4_000 || !parseDatadogUrl(url))) {
        return reply(DatadogErrorResponse, { error: `Pass 1-${MAX_DATADOG_EMBEDS} Datadog share or dashboard URLs.` }, 400);
      }
      return reply(DatadogPreviewsResponse, { previews: await Promise.all(urls.map((url) => datadogPreviews.lookup(url))) });
    }

    return undefined;
  }

  return { handle };
}
