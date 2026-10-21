/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type ThemeError = { "error": string; };

export type ThemeFile = Record<string, unknown>;

export type ThemeImportRequest = { "url": string; };

export type ThemeImportResponse = { "id": string; "themes": Array<ThemeRef>; };

export type ThemeRef = { "id": string; "name": string; "url": string; };

export type ThemesResponse = { "themes": Array<ThemeRef>; };
