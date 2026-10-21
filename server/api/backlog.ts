/** Public Kanban backlog items, start requests, branch names and local-task Jira responses. */
import { Type, type Static } from "typebox";
import { SessionJiraIssue, SessionStage, SessionView } from "./sessions.ts";
import { JiraCreateRequest, JiraDraftRequest, JiraDraftResponse, JiraIssueRef, JiraLinkRequest } from "./jira.ts";

export const BacklogItemKind = Type.Union([Type.Literal("jira"), Type.Literal("local")], { $id: "BacklogItemKind" });
export type BacklogItemKind = Static<typeof BacklogItemKind>;

export const BacklogItem = Type.Object({
  id: Type.String(), kind: BacklogItemKind, title: Type.String(), group: Type.String(),
  cwd: Type.Optional(Type.String()), problem: Type.Optional(Type.String()), fix: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()), jira: Type.Optional(SessionJiraIssue),
}, { $id: "BacklogItem" });
export type BacklogItem = Static<typeof BacklogItem>;

export const BacklogJiraState = Type.Union([
  Type.Object({ status: Type.Literal("ok") }),
  Type.Object({ status: Type.Literal("unconfigured") }),
  Type.Object({ status: Type.Literal("unavailable"), message: Type.String() }),
], { $id: "BacklogJiraState" });
export type BacklogJiraState = Static<typeof BacklogJiraState>;

export const BacklogView = Type.Object({ items: Type.Array(BacklogItem), jira: BacklogJiraState }, { $id: "BacklogView" });
export type BacklogView = Static<typeof BacklogView>;

export const BacklogStartInput = Type.Object({
  cwd: Type.String(), worktree: Type.Boolean(), branchName: Type.Optional(Type.String()), baseRef: Type.Optional(Type.String()),
  stage: SessionStage, group: Type.String(),
}, { $id: "BacklogStartInput" });
export type BacklogStartInput = Static<typeof BacklogStartInput>;

export const BacklogGroupRequest = Type.Object({ group: Type.String() }, { $id: "BacklogGroupRequest" });
export type BacklogGroupRequest = Static<typeof BacklogGroupRequest>;

export const BacklogStartResponse = Type.Object({ session: SessionView, backlog: BacklogView }, { $id: "BacklogStartResponse" });
export type BacklogStartResponse = Static<typeof BacklogStartResponse>;

export const BacklogBranchNameRequest = Type.Object({ cwd: Type.String() }, { $id: "BacklogBranchNameRequest" });
export type BacklogBranchNameRequest = Static<typeof BacklogBranchNameRequest>;

export const SuggestedBranchName = Type.Object({
  name: Type.String(), source: Type.Union([Type.Literal("model"), Type.Literal("fallback")]),
}, { $id: "SuggestedBranchName" });
export type SuggestedBranchName = Static<typeof SuggestedBranchName>;

export const BacklogJiraDraftRequest = Type.Omit(JiraDraftRequest, ["suggestionId"], { $id: "BacklogJiraDraftRequest" });
export type BacklogJiraDraftRequest = Static<typeof BacklogJiraDraftRequest>;

export const BacklogJiraCreateRequest = Type.Omit(JiraCreateRequest, ["suggestionId"], { $id: "BacklogJiraCreateRequest" });
export type BacklogJiraCreateRequest = Static<typeof BacklogJiraCreateRequest>;

export const BacklogJiraResponse = Type.Object({
  issue: JiraIssueRef, backlog: BacklogView, warning: Type.Optional(Type.String()),
}, { $id: "BacklogJiraResponse" });
export type BacklogJiraResponse = Static<typeof BacklogJiraResponse>;

export const BacklogError = Type.Object({ error: Type.String() }, { $id: "BacklogError" });
export type BacklogError = Static<typeof BacklogError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/backlog", response: BacklogView },
  { method: "PATCH", path: "/__hui/backlog/items/:id", request: BacklogGroupRequest, response: BacklogView },
  { method: "DELETE", path: "/__hui/backlog/items/:id", response: BacklogView },
  { method: "POST", path: "/__hui/backlog/items/:id/start", request: BacklogStartInput, response: BacklogStartResponse },
  { method: "POST", path: "/__hui/backlog/items/:id/branch-name", request: BacklogBranchNameRequest, response: SuggestedBranchName },
  { method: "POST", path: "/__hui/backlog/items/:id/jira/draft", request: BacklogJiraDraftRequest, response: JiraDraftResponse },
  { method: "POST", path: "/__hui/backlog/items/:id/jira/link", request: JiraLinkRequest, response: BacklogJiraResponse },
  { method: "POST", path: "/__hui/backlog/items/:id/jira", request: BacklogJiraCreateRequest, response: BacklogJiraResponse },
];
