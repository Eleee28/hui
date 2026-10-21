/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { JiraIssueRef } from "./jira.ts";
import type { SessionJiraIssue, SessionStage, SessionView } from "./sessions.ts";

export type BacklogBranchNameRequest = { "cwd": string; };

export type BacklogError = { "error": string; };

export type BacklogGroupRequest = { "group": string; };

export type BacklogItem = { "id": string; "kind": BacklogItemKind; "title": string; "group": string; "cwd"?: string; "problem"?: string; "fix"?: string; "createdAt"?: string; "jira"?: SessionJiraIssue; };

export type BacklogItemKind = ("jira") | ("local");

export type BacklogJiraCreateRequest = { "project": string; "parent": string; "summary": string; "description": string; "assignToMe"?: boolean; };

export type BacklogJiraDraftRequest = { "project"?: string; };

export type BacklogJiraResponse = { "issue": JiraIssueRef; "backlog": BacklogView; "warning"?: string; };

export type BacklogJiraState = ({ "status": "ok"; }) | ({ "status": "unconfigured"; }) | ({ "status": "unavailable"; "message": string; });

export type BacklogStartInput = { "cwd": string; "worktree": boolean; "branchName"?: string; "baseRef"?: string; "stage": SessionStage; "group": string; };

export type BacklogStartResponse = { "session": SessionView; "backlog": BacklogView; };

export type BacklogView = { "items": Array<BacklogItem>; "jira": BacklogJiraState; };

export type SuggestedBranchName = { "name": string; "source": ("model") | ("fallback"); };
