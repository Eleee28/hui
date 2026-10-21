/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { SessionPullRequest } from "./github.ts";

export type MemorySource = { "workspace": string; "path": string; "relativePath": string; "kind": ("context") | ("memory"); "bytes": number; "modifiedAt": string; };

export type WorkspaceInspection = { "workspaces": Array<string>; "memory": Array<MemorySource>; "worktrees": Array<WorktreeView>; "diagnostics": Array<string>; };

export type WorktreeError = { "error": string; };

export type WorktreeInventory = { "worktrees": Array<WorktreeRow>; "diagnostics": Array<string>; "pending": boolean; };

export type WorktreeRemovalMode = ("single") | ("merged");

export type WorktreeRemovalRequest = { "paths": Array<string>; "mode": WorktreeRemovalMode; "acknowledged"?: Array<WorktreeRisk>; };

export type WorktreeRemovalResponse = { "results": Array<WorktreeRemovalResult>; "inventory": WorktreeInventory; };

export type WorktreeRemovalResult = { "path": string; "label": string; "removed": boolean; "branchDeleted": boolean; "error"?: string; };

export type WorktreeRisk = ("dirty") | ("unknown") | ("locked") | ("running") | ("missing") | ("external");

export type WorktreeRow = { "repository": string; "path": string; "displayPath": string; "branch": string; "head": string; "detached": boolean; "managed": boolean; "sessions": Array<WorktreeSessionRef>; "pullRequests"?: Array<SessionPullRequest>; "dirty"?: boolean; "bytes"?: number; "merged": boolean; "risks": Array<WorktreeRisk>; "unavailable"?: Array<("pullRequests") | ("dirty") | ("bytes")>; "removal"?: ("queued") | ("removing"); "remainingBytes"?: number; };

export type WorktreeSessionRef = { "id": string; "title": string; "archived": boolean; };

export type WorktreeView = { "repository": string; "path": string; "branch": string; "head": string; "bare": boolean; "detached": boolean; "sessionIds": Array<string>; };
