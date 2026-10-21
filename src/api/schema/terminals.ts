/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type TerminalConnectResponse = { "url": string; };

export type TerminalControlFrame = (TerminalSnapshotFrame) | ({ "type": "state"; "terminal": TerminalView; }) | ({ "type": "error"; "error": string; });

export type TerminalCreateRequest = { "cols"?: number; "rows"?: number; "title"?: string; };

export type TerminalError = { "error": string; };

export type TerminalInput = ({ "action": "input"; "data": string; }) | ({ "action": "resize"; "cols": number; "rows": number; });

export type TerminalOperationRequest = (TerminalInput) | ({ "action": ("list") | ("read") | ("close"); });

export type TerminalOperationResponse = (TerminalsResponse) | ({ "terminal": TerminalView; "data": string; "sequence": number; "truncated": boolean; "format": string; }) | ({ "accepted": true; "terminal": TerminalView; }) | (TerminalResponse) | ({ "closed": true; });

export type TerminalResponse = { "terminal": TerminalView; };

export type TerminalSnapshot = { "terminal": TerminalView; "data": string; "sequence": number; "truncated": boolean; };

export type TerminalSnapshotFrame = { "type": "snapshot"; "terminal": TerminalView; "sequence": number; "truncated": boolean; "replayBytes": number; };

export type TerminalView = { "id": string; "ownerSessionId": string; "title": string; "cwd": string; "cols": number; "rows": number; "status": ("running") | ("exited"); "exitCode"?: number; "createdAt": string; };

export type TerminalsResponse = { "terminals": Array<TerminalView>; };
