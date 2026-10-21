/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type DiffBranch = { "ref": string; "name": string; "remote": boolean; "distance"?: number; };

export type DiffChanges = { "comparison": DiffComparison; "base": DiffEndpoint; "head": DiffEndpoint; "includesUncommitted": boolean; "files": Array<DiffFile>; "additions": number; "deletions": number; "truncated": boolean; "filesOmitted": number; "untrackedOmitted": number; };

export type DiffComparison = ("uncommitted") | ("last-commit") | ("parent") | ("default");

export type DiffEndpoint = { "label": string; "sha"?: string; };

export type DiffErrorResponse = { "error": string; "code"?: string; };

export type DiffFile = { "path": string; "oldPath"?: string; "status": DiffFileStatus; "similarity"?: number; "additions": number; "deletions": number; "binary": boolean; "oldMode"?: string; "newMode"?: string; "patch"?: string; "truncated"?: ("file") | ("total"); };

export type DiffFileChanges = { "file": (DiffFile) | (null); };

export type DiffFileStatus = ("A") | ("M") | ("D") | ("R") | ("C") | ("T") | ("U");

export type DiffInfo = ({ "available": false; "reason": string; "code": ("remote") | ("not-repo") | ("missing") | ("git"); }) | ({ "available": true; "root": string; "subdirectory": string; "branch"?: string; "detached": boolean; "unborn": boolean; "head"?: string; "uncommitted": number; "lastCommit"?: { "sha": string; "subject": string; }; "parent"?: { "ref": string; "name": string; "remote": boolean; "distance"?: number; "source": DiffParentSource; }; "branches": Array<DiffBranch>; "defaultBranch"?: { "ref": string; "name": string; }; "comparisons": Array<DiffComparison>; });

export type DiffParentSource = ("gh-merge-base") | ("git-town") | ("upstream") | ("nearest");
