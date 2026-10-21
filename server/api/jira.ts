/** Public Jira connection, project search, work-item and draft payloads, separate from stored credentials. */
import { Type, type Static } from "typebox";
import { JiraStatusCategory, SessionView } from "./sessions.ts";

export const JiraConnection = Type.Object({
  configured: Type.Boolean(), site: Type.String(), email: Type.String(), tokenSet: Type.Boolean(),
  defaultProject: Type.String(), accountName: Type.Optional(Type.String()),
}, { $id: "JiraConnection" });
export type JiraConnection = Static<typeof JiraConnection>;

export const JiraProject = Type.Object({ key: Type.String(), name: Type.String() }, { $id: "JiraProject" });
export type JiraProject = Static<typeof JiraProject>;

export const JiraParentCandidate = Type.Object({
  key: Type.String(), summary: Type.String(), issueType: Type.String(), hierarchyLevel: Type.Number(), status: Type.Optional(Type.String()),
}, { $id: "JiraParentCandidate" });
export type JiraParentCandidate = Static<typeof JiraParentCandidate>;

export const JiraDraft = Type.Object({
  project: Type.String(), parents: Type.Array(JiraParentCandidate), parent: Type.String(), summary: Type.String(), description: Type.String(),
  model: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
  parentChoice: Type.Optional(Type.Union([
    Type.Literal("suggested"), Type.Literal("unmatched"), Type.Literal("none-available"), Type.Literal("not-drafted"), Type.Literal("omitted"),
  ])),
  rejectedParent: Type.Optional(Type.String()),
}, { $id: "JiraDraft" });
export type JiraDraft = Static<typeof JiraDraft>;

export const JiraIssueMatch = Type.Object({
  key: Type.String(), url: Type.String(), summary: Type.String(), status: Type.Optional(Type.String()),
  statusCategory: Type.Optional(JiraStatusCategory), issueType: Type.Optional(Type.String()),
}, { $id: "JiraIssueMatch" });
export type JiraIssueMatch = Static<typeof JiraIssueMatch>;

export const JiraConnectRequest = Type.Object({
  site: Type.String(), email: Type.String(), token: Type.String(), defaultProject: Type.String(),
}, { $id: "JiraConnectRequest" });
export type JiraConnectRequest = Static<typeof JiraConnectRequest>;

export const JiraDefaultProjectRequest = Type.Object({ defaultProject: Type.String() }, { $id: "JiraDefaultProjectRequest" });
export type JiraDefaultProjectRequest = Static<typeof JiraDefaultProjectRequest>;

export const JiraProjectsResponse = Type.Object({ projects: Type.Array(JiraProject), total: Type.Number() }, { $id: "JiraProjectsResponse" });
export type JiraProjectsResponse = Static<typeof JiraProjectsResponse>;

export const JiraIssuesResponse = Type.Object({ issues: Type.Array(JiraIssueMatch) }, { $id: "JiraIssuesResponse" });
export type JiraIssuesResponse = Static<typeof JiraIssuesResponse>;

export const JiraDraftRequest = Type.Object({
  project: Type.Optional(Type.String()), suggestionId: Type.Optional(Type.String()),
}, { $id: "JiraDraftRequest" });
export type JiraDraftRequest = Static<typeof JiraDraftRequest>;

export const JiraDraftResponse = Type.Object({ draft: JiraDraft }, { $id: "JiraDraftResponse" });
export type JiraDraftResponse = Static<typeof JiraDraftResponse>;

export const JiraCreateRequest = Type.Object({
  project: Type.String(), parent: Type.String(), summary: Type.String(), description: Type.String(),
  assignToMe: Type.Optional(Type.Boolean()), suggestionId: Type.Optional(Type.String()),
}, { $id: "JiraCreateRequest" });
export type JiraCreateRequest = Static<typeof JiraCreateRequest>;

export const JiraLinkRequest = Type.Object({ key: Type.String() }, { $id: "JiraLinkRequest" });
export type JiraLinkRequest = Static<typeof JiraLinkRequest>;

export const JiraIssueRef = Type.Object({ key: Type.String(), url: Type.String() }, { $id: "JiraIssueRef" });
export type JiraIssueRef = Static<typeof JiraIssueRef>;

export const JiraError = Type.Object({ error: Type.String() }, { $id: "JiraError" });
export type JiraError = Static<typeof JiraError>;

export const JiraLinkResponse = Type.Object({
  issue: JiraIssueRef, session: Type.Optional(SessionView),
}, { $id: "JiraLinkResponse" });
export type JiraLinkResponse = Static<typeof JiraLinkResponse>;

export const JiraCreateResponse = Type.Object({
  issue: JiraIssueRef, session: Type.Optional(SessionView), warning: Type.Optional(Type.String()),
}, { $id: "JiraCreateResponse" });
export type JiraCreateResponse = Static<typeof JiraCreateResponse>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/jira", response: JiraConnection },
  { method: "PUT", path: "/__hui/jira", request: JiraConnectRequest, response: JiraConnection },
  { method: "PATCH", path: "/__hui/jira", request: JiraDefaultProjectRequest, response: JiraConnection },
  { method: "DELETE", path: "/__hui/jira", response: JiraConnection },
  { method: "GET", path: "/__hui/jira/projects", response: JiraProjectsResponse },
  { method: "GET", path: "/__hui/jira/issues", response: JiraIssuesResponse },
  { method: "POST", path: "/__hui/sessions/:id/jira/draft", request: JiraDraftRequest, response: JiraDraftResponse },
  { method: "POST", path: "/__hui/sessions/:id/jira", request: JiraCreateRequest, response: JiraCreateResponse },
  { method: "POST", path: "/__hui/sessions/:id/jira/link", request: JiraLinkRequest, response: JiraLinkResponse },
];
