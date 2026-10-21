/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type WorkerActionResponse = { "ok": true; };

export type WorkerError = { "error": string; };

export type WorkerInput = { "name": string; "command": string; "extraPaths"?: Array<string>; };

export type WorkerPatch = { "name"?: string; "command"?: string; "extraPaths"?: Array<string>; };

export type WorkerResponse = { "worker": WorkerView; };

export type WorkerState = ("disconnected") | ("connecting") | ("connected") | ("error");

export type WorkerView = { "id": string; "name": string; "command": string; "extraPaths": Array<string>; "state": WorkerState; "phase"?: string; "error"?: string; "host"?: { "hostname": string; "platform": string; "arch": string; "node": string; "home": string; "release": string; }; "sync"?: { "at": string; "files": number; "uploaded": number; "deleted": number; "installed": Array<string>; "skipped": Array<string>; "errors": Array<string>; }; };

export type WorkersResponse = { "workers": Array<WorkerView>; };
