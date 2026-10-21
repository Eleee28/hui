/** Public directory and path completions and the launcher's read-only Git checkout inspection. */
import { Type, type Static } from "typebox";

export const LocalPathSuggestion = Type.Object({
  path: Type.String(), kind: Type.Union([Type.Literal("directory"), Type.Literal("file")]),
}, { $id: "LocalPathSuggestion" });
export type LocalPathSuggestion = Static<typeof LocalPathSuggestion>;

export const GitCheckoutInfo = Type.Object({
  available: Type.Boolean(), headBranch: Type.String(), defaultBranch: Type.String(),
  branches: Type.Immutable(Type.Array(Type.String())), branchesUnavailable: Type.Optional(Type.Boolean()),
}, { $id: "GitCheckoutInfo" });
export type GitCheckoutInfo = Static<typeof GitCheckoutInfo>;

export const DirectoriesResponse = Type.Object({ directories: Type.Array(Type.String()) }, { $id: "DirectoriesResponse" });
export type DirectoriesResponse = Static<typeof DirectoriesResponse>;

export const LocalPathsResponse = Type.Object({ paths: Type.Array(LocalPathSuggestion) }, { $id: "LocalPathsResponse" });
export type LocalPathsResponse = Static<typeof LocalPathsResponse>;

export const GitCheckoutResponse = Type.Object({ checkout: GitCheckoutInfo }, { $id: "GitCheckoutResponse" });
export type GitCheckoutResponse = Static<typeof GitCheckoutResponse>;

export const LocalPathError = Type.Object({ error: Type.String() }, { $id: "LocalPathError" });
export type LocalPathError = Static<typeof LocalPathError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/directories", response: DirectoriesResponse },
  { method: "GET", path: "/__hui/local-paths", response: LocalPathsResponse },
  { method: "GET", path: "/__hui/git-checkout", response: GitCheckoutResponse },
];
