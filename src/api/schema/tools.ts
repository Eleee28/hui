/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type RuntimeInspection = { "status": "live"; "backend": string; "version": string; "revision": string; "tools": Array<RuntimeTool>; "prompt": string; "promptPhase": ("initialized") | ("current-turn") | ("last-turn"); "promptSource": string; "diagnostics": Array<string>; };

export type RuntimeTool = { "name": string; "description": string; "source": string; "active": boolean; "parameters": unknown; };

export type SessionTools = (RuntimeInspection) | ({ "status": ("cold") | ("unsupported"); });

export type ToolCatalogEntry = { "name": string; "description": string; "source": string; "defaultEnabled": boolean; };

export type ToolsCatalog = { "backend": ("sdk") | ("cli"); "sdkVersion": string; "tools": Array<ToolCatalogEntry>; "sources": Array<string>; "diagnostics": Array<string>; "prompt": { "revision": string; "text": string; }; };

export type ToolsError = { "error": string; };
