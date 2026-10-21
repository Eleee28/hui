/**
 * `GET /__hui/themes` (the merged theme list) and `POST /__hui/themes/import` (a tweakcn theme into the user's
 * themes), over `themes.ts`. `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { ThemeError, ThemeImportResponse, ThemesResponse } from "../api/themes.ts";
export { routeSchemas } from "../api/themes.ts";
import { importTweakcnTheme, listThemes } from "../themes.ts";

export const THEMES_ROUTE = "/__hui/themes";
const THEME_IMPORT_ROUTE = "/__hui/themes/import";

export function createThemeRoutes() {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    if (request.path === THEMES_ROUTE && request.method === "GET") {
      return reply(ThemesResponse, { themes: (await listThemes()).themes });
    }
    if (request.path === THEME_IMPORT_ROUTE && request.method === "POST") {
      const body = (await request.json()) as { url?: unknown };
      if (typeof body.url !== "string") return reply(ThemeError, { error: "Expected a url." }, 400);
      try {
        const id = await importTweakcnTheme(body.url);
        return reply(ThemeImportResponse, { id, themes: (await listThemes()).themes });
      } catch (error) {
        return reply(ThemeError, { error: error instanceof Error ? error.message : "Import failed." }, 400);
      }
    }
    return undefined;
  }

  return { handle };
}
