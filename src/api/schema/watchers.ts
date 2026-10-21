/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type Watcher = { "id": string; "purpose": string; "target": string; "outcome": string; "command": string; "logPath": string; "state": WatcherState; "pid": (number) | (null); "exitCode"?: number; "startedAt": string; "endedAt"?: string; "lastLine": string; "keepRunning"?: true; };

export type WatcherError = { "error": string; };

export type WatcherLog = { "id": string; "lines": Array<string>; "truncated": boolean; };

export type WatcherState = ("running") | ("done") | ("failed") | ("stopped") | ("dead");

export type WatchersResponse = { "watchers": Array<Watcher>; };
