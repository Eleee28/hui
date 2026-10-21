/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type DirectoriesResponse = { "directories": Array<string>; };

export type GitCheckoutInfo = { "available": boolean; "headBranch": string; "defaultBranch": string; "branches": Array<string>; "branchesUnavailable"?: boolean; };

export type GitCheckoutResponse = { "checkout": GitCheckoutInfo; };

export type LocalPathError = { "error": string; };

export type LocalPathSuggestion = { "path": string; "kind": ("directory") | ("file"); };

export type LocalPathsResponse = { "paths": Array<LocalPathSuggestion>; };
