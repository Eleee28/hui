/** Public theme list and import payloads and the open-ended JSON documents supplied by theme authors. */
import { Type, type Static } from "typebox";

export const ThemeRef = Type.Object({ id: Type.String(), name: Type.String(), url: Type.String() }, { $id: "ThemeRef" });
export type ThemeRef = Static<typeof ThemeRef>;

export const ThemeFile = Type.Record(Type.String(), Type.Unknown(), { $id: "ThemeFile" });
export type ThemeFile = Static<typeof ThemeFile>;

export const ThemesResponse = Type.Object({ themes: Type.Array(ThemeRef) }, { $id: "ThemesResponse" });
export type ThemesResponse = Static<typeof ThemesResponse>;

export const ThemeImportRequest = Type.Object({ url: Type.String() }, { $id: "ThemeImportRequest" });
export type ThemeImportRequest = Static<typeof ThemeImportRequest>;

export const ThemeImportResponse = Type.Object({ id: Type.String(), themes: Type.Array(ThemeRef) }, { $id: "ThemeImportResponse" });
export type ThemeImportResponse = Static<typeof ThemeImportResponse>;

export const ThemeError = Type.Object({ error: Type.String() }, { $id: "ThemeError" });
export type ThemeError = Static<typeof ThemeError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/themes", response: ThemesResponse },
  { method: "POST", path: "/__hui/themes/import", request: ThemeImportRequest, response: ThemeImportResponse },
  { method: "GET", path: "/__hui/themes/file/:key", response: ThemeFile },
];
