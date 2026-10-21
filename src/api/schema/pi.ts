/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type PiConfiguredResource = { "id": string; "label": string; "kind": ("package") | ("extension"); };

export type PiError = { "error": string; };

export type PiInstallRequest = { "url": string; };

export type PiModel = { "defaultProvider": string; "defaultModel": string; "thinking": (string) | (null); "enabled": Array<string>; "authenticated": Array<string>; "catalog": Array<PiModelCatalogEntry>; };

export type PiModelCatalogEntry = { "provider": string; "id": string; "name": string; "contextWindow"?: number; "maxTokens"?: number; "thinkingLevels"?: Array<string>; "fast"?: true; };

export type PiMutationKind = ("package-install") | ("package-remove") | ("skill-install");

export type PiMutationResult = { "kind": PiMutationKind; "target": string; "message": string; "snapshot": PiSnapshot; };

export type PiRemoveRequest = { "source": string; };

export type PiResourceDocument = { "id": string; "kind": ("skill") | ("package") | ("extension"); "title": string; "fileName": string; "format": ("markdown") | ("code") | ("json"); "content": string; "truncated": boolean; };

export type PiSettingsSummary = { "path": string; "exists": boolean; "packages": Array<string>; "extensions": Array<string>; "resources": Array<PiConfiguredResource>; "skillRoots": Array<string>; };

export type PiSkill = { "id": string; "name": string; "description": string; "path": string; "root": string; "origin"?: "hui"; "tags"?: Array<string>; "preferencePath"?: string; };

export type PiSnapshot = { "agentDir": string; "settings": PiSettingsSummary; "skills": Array<PiSkill>; "tools": Array<PiTool>; "model": PiModel; "diagnostics": Array<string>; };

export type PiTool = { "name": string; "kind": ("builtin") | ("hui"); "source"?: string; };
