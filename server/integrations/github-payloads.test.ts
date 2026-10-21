import { expectTypeOf, test } from "vitest";
import type * as Api from "../api/github.ts";

type LegacyPullRequestState = "open" | "draft" | "merged" | "closed";
type LegacyGitHubAccount = {
  host: string;
  login: string;
  scopes: string[];
  tokenSource?: string;
};
type LegacyGitHubLoginState =
  | { phase: "idle" }
  | { phase: "starting" }
  | {
    phase: "pending";
    userCode: string;
    verificationUri: string;
    expiresAt: number;
  }
  | { phase: "failed"; message: string };
type LegacyGitHubConnection = {
  cli: { installed: false } | { installed: true; version: string };
  status: "connected" | "disconnected" | "invalid" | "unknown";
  account?: LegacyGitHubAccount;
  message?: string;
  login: LegacyGitHubLoginState;
};
type LegacyGitHubContributionAccount = {
  login: string;
  createdAt?: string;
  commits: string[];
  pullRequests: string[];
  error?: string;
};
type LegacyGitHubContributions = { accounts: LegacyGitHubContributionAccount[] };
type LegacyGitHubPreview =
  | {
    kind: "repo";
    url: string;
    fullName: string;
    description?: string;
    stars: number;
    forks: number;
    language?: string;
    private: boolean;
    archived: boolean;
  }
  | {
    kind: "pull";
    url: string;
    repository: string;
    number: number;
    title: string;
    state: LegacyPullRequestState;
    author?: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    comments: number;
    body?: string;
  }
  | {
    kind: "issue";
    url: string;
    repository: string;
    number: number;
    title: string;
    state: "open" | "closed";
    stateReason?: string;
    author?: string;
    comments: number;
    labels: string[];
    body?: string;
  };
type LegacyGitHubPreviewError = "not_found" | "signed_out" | "cli_missing" | "unavailable";
type LegacyGitHubPreviewResult = { url: string; preview?: LegacyGitHubPreview; error?: LegacyGitHubPreviewError };


type LegacySessionPullRequest = {
  repository: string;
  number: number;
  url: string;
  state?: LegacyPullRequestState;
  title?: string;
  body?: string;
};

test("the schemas preserve the existing github payload types", () => {
  expectTypeOf<LegacySessionPullRequest>().toMatchTypeOf<Api.SessionPullRequest>();
  expectTypeOf<Api.SessionPullRequest>().toMatchTypeOf<LegacySessionPullRequest>();
  expectTypeOf<LegacyPullRequestState>().toMatchTypeOf<Api.PullRequestState>();
  expectTypeOf<Api.PullRequestState>().toMatchTypeOf<LegacyPullRequestState>();
  expectTypeOf<LegacyGitHubAccount>().toMatchTypeOf<Api.GitHubAccount>();
  expectTypeOf<Api.GitHubAccount>().toMatchTypeOf<LegacyGitHubAccount>();
  expectTypeOf<LegacyGitHubLoginState>().toMatchTypeOf<Api.GitHubLoginState>();
  expectTypeOf<Api.GitHubLoginState>().toMatchTypeOf<LegacyGitHubLoginState>();
  expectTypeOf<LegacyGitHubConnection>().toMatchTypeOf<Api.GitHubConnection>();
  expectTypeOf<Api.GitHubConnection>().toMatchTypeOf<LegacyGitHubConnection>();
  expectTypeOf<LegacyGitHubContributionAccount>().toMatchTypeOf<Api.GitHubContributionAccount>();
  expectTypeOf<Api.GitHubContributionAccount>().toMatchTypeOf<LegacyGitHubContributionAccount>();
  expectTypeOf<LegacyGitHubContributions>().toMatchTypeOf<Api.GitHubContributions>();
  expectTypeOf<Api.GitHubContributions>().toMatchTypeOf<LegacyGitHubContributions>();
  expectTypeOf<LegacyGitHubPreview>().toMatchTypeOf<Api.GitHubPreview>();
  expectTypeOf<Api.GitHubPreview>().toMatchTypeOf<LegacyGitHubPreview>();
  expectTypeOf<LegacyGitHubPreviewError>().toMatchTypeOf<Api.GitHubPreviewError>();
  expectTypeOf<Api.GitHubPreviewError>().toMatchTypeOf<LegacyGitHubPreviewError>();
  expectTypeOf<LegacyGitHubPreviewResult>().toMatchTypeOf<Api.GitHubPreviewResult>();
  expectTypeOf<Api.GitHubPreviewResult>().toMatchTypeOf<LegacyGitHubPreviewResult>();
});
