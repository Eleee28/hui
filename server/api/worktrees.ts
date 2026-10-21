/** Public Git worktree inventory, guarded removals and read-only workspace inspection payloads. */
import { Type, type Static } from "typebox";
import { SessionPullRequest } from "./github.ts";

export const WorktreeSessionRef = Type.Object({
  id: Type.String(), title: Type.String(), archived: Type.Boolean(),
}, { $id: "WorktreeSessionRef" });
export type WorktreeSessionRef = Static<typeof WorktreeSessionRef>;

export const WorktreeRisk = Type.Union([
  Type.Literal("dirty"), Type.Literal("unknown"), Type.Literal("locked"), Type.Literal("running"), Type.Literal("missing"), Type.Literal("external"),
], { $id: "WorktreeRisk" });
export type WorktreeRisk = Static<typeof WorktreeRisk>;

export const WorktreeRow = Type.Object({
  repository: Type.String(), path: Type.String(), displayPath: Type.String(), branch: Type.String(), head: Type.String(),
  detached: Type.Boolean(), managed: Type.Boolean(), sessions: Type.ReadonlyObject(Type.Array(WorktreeSessionRef)),
  pullRequests: Type.Optional(Type.ReadonlyObject(Type.Array(SessionPullRequest))), dirty: Type.Optional(Type.Boolean()),
  bytes: Type.Optional(Type.Number()), merged: Type.Boolean(), risks: Type.ReadonlyObject(Type.Array(WorktreeRisk)),
  unavailable: Type.Optional(Type.ReadonlyObject(Type.Array(Type.Union([
    Type.Literal("pullRequests"), Type.Literal("dirty"), Type.Literal("bytes"),
  ])))),
  removal: Type.Optional(Type.Union([Type.Literal("queued"), Type.Literal("removing")])), remainingBytes: Type.Optional(Type.Number()),
}, { $id: "WorktreeRow" });
export type WorktreeRow = Static<typeof WorktreeRow>;

export const WorktreeInventory = Type.Object({
  worktrees: Type.ReadonlyObject(Type.Array(WorktreeRow)), diagnostics: Type.ReadonlyObject(Type.Array(Type.String())), pending: Type.Boolean(),
}, { $id: "WorktreeInventory" });
export type WorktreeInventory = Static<typeof WorktreeInventory>;

export const WorktreeRemovalMode = Type.Union([Type.Literal("single"), Type.Literal("merged")], { $id: "WorktreeRemovalMode" });
export type WorktreeRemovalMode = Static<typeof WorktreeRemovalMode>;

export const WorktreeRemovalResult = Type.Object({
  path: Type.String(), label: Type.String(), removed: Type.Boolean(), branchDeleted: Type.Boolean(), error: Type.Optional(Type.String()),
}, { $id: "WorktreeRemovalResult" });
export type WorktreeRemovalResult = Static<typeof WorktreeRemovalResult>;

export const WorktreeRemovalRequest = Type.Object({
  paths: Type.Array(Type.String()), mode: WorktreeRemovalMode, acknowledged: Type.Optional(Type.Array(WorktreeRisk)),
}, { $id: "WorktreeRemovalRequest" });
export type WorktreeRemovalRequest = Static<typeof WorktreeRemovalRequest>;

export const WorktreeRemovalResponse = Type.Object({
  results: Type.Array(WorktreeRemovalResult), inventory: WorktreeInventory,
}, { $id: "WorktreeRemovalResponse" });
export type WorktreeRemovalResponse = Static<typeof WorktreeRemovalResponse>;

export const MemorySource = Type.Object({
  workspace: Type.String(), path: Type.String(), relativePath: Type.String(), kind: Type.Union([Type.Literal("context"), Type.Literal("memory")]),
  bytes: Type.Number(), modifiedAt: Type.String(),
}, { $id: "MemorySource" });
export type MemorySource = Static<typeof MemorySource>;

export const WorktreeView = Type.Object({
  repository: Type.String(), path: Type.String(), branch: Type.String(), head: Type.String(), bare: Type.Boolean(), detached: Type.Boolean(),
  sessionIds: Type.ReadonlyObject(Type.Array(Type.String())),
}, { $id: "WorktreeView" });
export type WorktreeView = Static<typeof WorktreeView>;

export const WorkspaceInspection = Type.Object({
  workspaces: Type.ReadonlyObject(Type.Array(Type.String())), memory: Type.ReadonlyObject(Type.Array(MemorySource)),
  worktrees: Type.ReadonlyObject(Type.Array(WorktreeView)), diagnostics: Type.ReadonlyObject(Type.Array(Type.String())),
}, { $id: "WorkspaceInspection" });
export type WorkspaceInspection = Static<typeof WorkspaceInspection>;

export const WorktreeError = Type.Object({ error: Type.String() }, { $id: "WorktreeError" });
export type WorktreeError = Static<typeof WorktreeError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/worktrees", response: WorktreeInventory },
  { method: "POST", path: "/__hui/worktrees/remove", request: WorktreeRemovalRequest, response: WorktreeRemovalResponse },
  { method: "GET", path: "/__hui/workspaces", response: WorkspaceInspection },
];
