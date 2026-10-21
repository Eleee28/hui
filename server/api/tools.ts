/** Public shipped-tool catalogs and the live, cold or unsupported session tool inspection payloads. */
import { Type, type Static } from "typebox";

export const ToolCatalogEntry = Type.Object({
  name: Type.String(), description: Type.String(), source: Type.String(), defaultEnabled: Type.Boolean(),
}, { $id: "ToolCatalogEntry" });
export type ToolCatalogEntry = Static<typeof ToolCatalogEntry>;

export const RuntimeTool = Type.Object({
  name: Type.String(), description: Type.String(), source: Type.String(), active: Type.Boolean(), parameters: Type.Unknown(),
}, { $id: "RuntimeTool" });
export type RuntimeTool = Static<typeof RuntimeTool>;

export const RuntimeInspection = Type.Object({
  status: Type.Literal("live"), backend: Type.String(), version: Type.String(), revision: Type.String(), tools: Type.Array(RuntimeTool),
  prompt: Type.String(), promptPhase: Type.Union([Type.Literal("initialized"), Type.Literal("current-turn"), Type.Literal("last-turn")]),
  promptSource: Type.String(), diagnostics: Type.Array(Type.String()),
}, { $id: "RuntimeInspection" });
export type RuntimeInspection = Static<typeof RuntimeInspection>;

export const SessionTools = Type.Union([
  RuntimeInspection, Type.Object({ status: Type.Union([Type.Literal("cold"), Type.Literal("unsupported")]) }),
], { $id: "SessionTools" });
export type SessionTools = Static<typeof SessionTools>;

export const ToolsCatalog = Type.Object({
  backend: Type.Union([Type.Literal("sdk"), Type.Literal("cli")]), sdkVersion: Type.String(), tools: Type.Array(ToolCatalogEntry),
  sources: Type.Array(Type.String()), diagnostics: Type.Array(Type.String()), prompt: Type.Object({ revision: Type.String(), text: Type.String() }),
}, { $id: "ToolsCatalog" });
export type ToolsCatalog = Static<typeof ToolsCatalog>;

export const ToolsError = Type.Object({ error: Type.String() }, { $id: "ToolsError" });
export type ToolsError = Static<typeof ToolsError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/tools", response: ToolsCatalog },
  { method: "GET", path: "/__hui/sessions/:id/tools", response: SessionTools },
];
