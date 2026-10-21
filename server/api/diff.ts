/** Public read-only Git comparison payloads for the Diff view. */
import { Type, type Static } from "typebox";

export const DiffComparison = Type.Union([
  Type.Literal("uncommitted"), Type.Literal("last-commit"), Type.Literal("parent"), Type.Literal("default"),
], { $id: "DiffComparison" });
export type DiffComparison = Static<typeof DiffComparison>;

export const DiffBranch = Type.Object({
  ref: Type.String(), name: Type.String(), remote: Type.Boolean(), distance: Type.Optional(Type.Number()),
}, { $id: "DiffBranch" });
export type DiffBranch = Static<typeof DiffBranch>;

export const DiffParentSource = Type.Union([
  Type.Literal("gh-merge-base"), Type.Literal("git-town"), Type.Literal("upstream"), Type.Literal("nearest"),
], { $id: "DiffParentSource" });
export type DiffParentSource = Static<typeof DiffParentSource>;

export const DiffInfo = Type.Union([
  Type.Object({ available: Type.Literal(false), reason: Type.String(), code: Type.Union([Type.Literal("remote"), Type.Literal("not-repo"), Type.Literal("missing"), Type.Literal("git")]) }),
  Type.Object({
    available: Type.Literal(true), root: Type.String(), subdirectory: Type.String(), branch: Type.Optional(Type.String()),
    detached: Type.Boolean(), unborn: Type.Boolean(), head: Type.Optional(Type.String()), uncommitted: Type.Number(),
    lastCommit: Type.Optional(Type.Object({ sha: Type.String(), subject: Type.String() })),
    parent: Type.Optional(Type.Object({ ...DiffBranch.properties, source: DiffParentSource })),
    branches: Type.Array(DiffBranch), defaultBranch: Type.Optional(Type.Object({ ref: Type.String(), name: Type.String() })),
    comparisons: Type.Array(DiffComparison),
  }),
], { $id: "DiffInfo" });
export type DiffInfo = Static<typeof DiffInfo>;

export const DiffFileStatus = Type.Union([
  Type.Literal("A"), Type.Literal("M"), Type.Literal("D"), Type.Literal("R"), Type.Literal("C"), Type.Literal("T"), Type.Literal("U"),
], { $id: "DiffFileStatus" });
export type DiffFileStatus = Static<typeof DiffFileStatus>;

export const DiffFile = Type.Object({
  path: Type.String(), oldPath: Type.Optional(Type.String()), status: DiffFileStatus, similarity: Type.Optional(Type.Number()),
  additions: Type.Number(), deletions: Type.Number(), binary: Type.Boolean(), oldMode: Type.Optional(Type.String()),
  newMode: Type.Optional(Type.String()), patch: Type.Optional(Type.String()), truncated: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("total")])),
}, { $id: "DiffFile" });
export type DiffFile = Static<typeof DiffFile>;

export const DiffEndpoint = Type.Object({ label: Type.String(), sha: Type.Optional(Type.String()) }, { $id: "DiffEndpoint" });
export type DiffEndpoint = Static<typeof DiffEndpoint>;

export const DiffChanges = Type.Object({
  comparison: DiffComparison, base: DiffEndpoint, head: DiffEndpoint, includesUncommitted: Type.Boolean(), files: Type.Array(DiffFile),
  additions: Type.Number(), deletions: Type.Number(), truncated: Type.Boolean(), filesOmitted: Type.Number(), untrackedOmitted: Type.Number(),
}, { $id: "DiffChanges" });
export type DiffChanges = Static<typeof DiffChanges>;

export const DiffFileChanges = Type.Object({ file: Type.Union([DiffFile, Type.Null()]) }, { $id: "DiffFileChanges" });
export type DiffFileChanges = Static<typeof DiffFileChanges>;

export const DiffErrorResponse = Type.Object({ error: Type.String(), code: Type.Optional(Type.String()) }, { $id: "DiffErrorResponse" });
export type DiffErrorResponse = Static<typeof DiffErrorResponse>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/sessions/:id/diff", response: DiffInfo },
  { method: "GET", path: "/__hui/sessions/:id/diff/changes", response: DiffChanges },
  { method: "GET", path: "/__hui/sessions/:id/diff/file", response: DiffFileChanges },
];
