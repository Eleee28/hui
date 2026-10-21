/** Public GitHub connection, contribution and preview payloads, without credentials. */
import { Type, type Static } from "typebox";

export const PullRequestState = Type.Union([
  Type.Literal("open"), Type.Literal("draft"), Type.Literal("merged"), Type.Literal("closed"),
], { $id: "PullRequestState" });
export type PullRequestState = Static<typeof PullRequestState>;

export const GitHubAccount = Type.Object({
  host: Type.String(), login: Type.String(), scopes: Type.Array(Type.String()), tokenSource: Type.Optional(Type.String()),
}, { $id: "GitHubAccount" });
export type GitHubAccount = Static<typeof GitHubAccount>;

export const GitHubLoginState = Type.Union([
  Type.Object({ phase: Type.Literal("idle") }),
  Type.Object({ phase: Type.Literal("starting") }),
  Type.Object({ phase: Type.Literal("pending"), userCode: Type.String(), verificationUri: Type.String(), expiresAt: Type.Number() }),
  Type.Object({ phase: Type.Literal("failed"), message: Type.String() }),
], { $id: "GitHubLoginState" });
export type GitHubLoginState = Static<typeof GitHubLoginState>;

export const GitHubConnection = Type.Object({
  cli: Type.Union([Type.Object({ installed: Type.Literal(false) }), Type.Object({ installed: Type.Literal(true), version: Type.String() })]),
  status: Type.Union([Type.Literal("connected"), Type.Literal("disconnected"), Type.Literal("invalid"), Type.Literal("unknown")]),
  account: Type.Optional(GitHubAccount), message: Type.Optional(Type.String()), login: GitHubLoginState,
}, { $id: "GitHubConnection" });
export type GitHubConnection = Static<typeof GitHubConnection>;

export const GitHubContributionAccount = Type.Object({
  login: Type.String(), createdAt: Type.Optional(Type.String()), commits: Type.Array(Type.String()),
  pullRequests: Type.Array(Type.String()), error: Type.Optional(Type.String()),
}, { $id: "GitHubContributionAccount" });
export type GitHubContributionAccount = Static<typeof GitHubContributionAccount>;

export const GitHubContributions = Type.Object({ accounts: Type.Array(GitHubContributionAccount) }, { $id: "GitHubContributions" });
export type GitHubContributions = Static<typeof GitHubContributions>;

export const GitHubPreview = Type.Union([
  Type.Object({
    kind: Type.Literal("repo"), url: Type.String(), fullName: Type.String(), description: Type.Optional(Type.String()),
    stars: Type.Number(), forks: Type.Number(), language: Type.Optional(Type.String()), private: Type.Boolean(), archived: Type.Boolean(),
  }),
  Type.Object({
    kind: Type.Literal("pull"), url: Type.String(), repository: Type.String(), number: Type.Number(), title: Type.String(),
    state: PullRequestState, author: Type.Optional(Type.String()), additions: Type.Number(), deletions: Type.Number(),
    changedFiles: Type.Number(), comments: Type.Number(), body: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("issue"), url: Type.String(), repository: Type.String(), number: Type.Number(), title: Type.String(),
    state: Type.Union([Type.Literal("open"), Type.Literal("closed")]), stateReason: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()), comments: Type.Number(), labels: Type.Array(Type.String()), body: Type.Optional(Type.String()),
  }),
], { $id: "GitHubPreview" });
export type GitHubPreview = Static<typeof GitHubPreview>;

export const GitHubPreviewError = Type.Union([
  Type.Literal("not_found"), Type.Literal("signed_out"), Type.Literal("cli_missing"), Type.Literal("unavailable"),
], { $id: "GitHubPreviewError" });
export type GitHubPreviewError = Static<typeof GitHubPreviewError>;

export const GitHubPreviewResult = Type.Object({
  url: Type.String(), preview: Type.Optional(GitHubPreview), error: Type.Optional(GitHubPreviewError),
}, { $id: "GitHubPreviewResult" });
export type GitHubPreviewResult = Static<typeof GitHubPreviewResult>;

export const SessionPullRequest = Type.Object({
  repository: Type.String(), number: Type.Number(), url: Type.String(), state: Type.Optional(PullRequestState),
  title: Type.Optional(Type.String()), body: Type.Optional(Type.String()),
}, { $id: "SessionPullRequest" });
export type SessionPullRequest = Static<typeof SessionPullRequest>;

export const ActivityBlock = Type.Object({
  start: Type.Number(), end: Type.Number(), model: Type.Optional(Type.String()), firstMessage: Type.Optional(Type.String()),
}, { $id: "ActivityBlock" });
export type ActivityBlock = Static<typeof ActivityBlock>;

export const ActivitySession = Type.Object({
  id: Type.String(), title: Type.String(), group: Type.String(), project: Type.String(),
  archived: Type.Optional(Type.Boolean()), blocks: Type.Array(ActivityBlock),
}, { $id: "ActivitySession" });
export type ActivitySession = Static<typeof ActivitySession>;

export const SessionActivity = Type.Object({ sessions: Type.Array(ActivitySession) }, { $id: "SessionActivity" });
export type SessionActivity = Static<typeof SessionActivity>;

export const GitHubPreviewsResponse = Type.Object({ previews: Type.Array(GitHubPreviewResult) }, { $id: "GitHubPreviewsResponse" });
export type GitHubPreviewsResponse = Static<typeof GitHubPreviewsResponse>;

export const GitHubError = Type.Object({ error: Type.String() }, { $id: "GitHubError" });
export type GitHubError = Static<typeof GitHubError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/github", response: GitHubConnection },
  { method: "POST", path: "/__hui/github/login", response: GitHubConnection },
  { method: "DELETE", path: "/__hui/github/login", response: GitHubConnection },
  { method: "GET", path: "/__hui/github/previews", response: GitHubPreviewsResponse },
  { method: "GET", path: "/__hui/github/contributions", response: GitHubContributions },
  { method: "GET", path: "/__hui/session-activity", response: SessionActivity },
];
