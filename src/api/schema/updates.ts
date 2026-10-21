/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type ReleaseInfo = { "version": string; "tag": string; "url": string; };

export type UpdateCheck = { "currentVersion": (string) | (null); "latest": (ReleaseInfo) | (null); "status": ("available") | ("current") | ("unpublished") | ("unavailable"); "canInstall": boolean; "message": string; };

export type UpdateError = { "error": string; };

export type UpdateJob = { "id": string; "pid": number; "status": ("running") | ("succeeded") | ("failed"); "version": string; "message": string; };

export type UpdateRequest = { "version": string; };

export type UpdateSnapshot = { "currentVersion": (string) | (null); "check": (UpdateCheck) | (null); "job": (UpdateJob) | (null); };
