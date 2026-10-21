/** Browser client for themes: the list the gateway merges from built-ins and `~/.config/hui/themes/`, one theme's
 * file, and a tweakcn import. Applying a theme is lib/theme/theme-store.ts's job. */
import type { ThemeFile, ThemeImportResponse, ThemeRef, ThemesResponse } from "./schema/themes.ts";
import { fetchJson } from "./request.ts";

const THEMES_URL = "/__hui/themes";
const IMPORT_URL = "/__hui/themes/import";

export type { ThemeRef } from "./schema/themes.ts";

export function fetchThemeList(): Promise<ThemesResponse> {
  return fetchJson<ThemesResponse>(THEMES_URL);
}

export function fetchThemeFile(theme: ThemeRef): Promise<ThemeFile> {
  return fetchJson<ThemeFile>(theme.url);
}

export function postThemeImport(url: string): Promise<ThemeImportResponse> {
  return fetchJson<ThemeImportResponse>(IMPORT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}
