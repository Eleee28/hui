/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { JiraStatusCategory, SessionView } from "./sessions.ts";

export type JiraConnectRequest = { "site": string; "email": string; "token": string; "defaultProject": string; };

export type JiraConnection = { "configured": boolean; "site": string; "email": string; "tokenSet": boolean; "defaultProject": string; "accountName"?: string; };

export type JiraCreateRequest = { "project": string; "parent": string; "summary": string; "description": string; "assignToMe"?: boolean; "suggestionId"?: string; };

export type JiraCreateResponse = { "issue": JiraIssueRef; "session"?: SessionView; "warning"?: string; };

export type JiraDefaultProjectRequest = { "defaultProject": string; };

export type JiraDraft = { "project": string; "parents": Array<JiraParentCandidate>; "parent": string; "summary": string; "description": string; "model"?: string; "note"?: string; "parentChoice"?: ("suggested") | ("unmatched") | ("none-available") | ("not-drafted") | ("omitted"); "rejectedParent"?: string; };

export type JiraDraftRequest = { "project"?: string; "suggestionId"?: string; };

export type JiraDraftResponse = { "draft": JiraDraft; };

export type JiraError = { "error": string; };

export type JiraIssueMatch = { "key": string; "url": string; "summary": string; "status"?: string; "statusCategory"?: JiraStatusCategory; "issueType"?: string; };

export type JiraIssueRef = { "key": string; "url": string; };

export type JiraIssuesResponse = { "issues": Array<JiraIssueMatch>; };

export type JiraLinkRequest = { "key": string; };

export type JiraLinkResponse = { "issue": JiraIssueRef; "session"?: SessionView; };

export type JiraParentCandidate = { "key": string; "summary": string; "issueType": string; "hierarchyLevel": number; "status"?: string; };

export type JiraProject = { "key": string; "name": string; };

export type JiraProjectsResponse = { "projects": Array<JiraProject>; "total": number; };
