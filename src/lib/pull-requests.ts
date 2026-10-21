/** Formats pull-request references, states and accessible labels in the browser. */
import type { PullRequestState, SessionPullRequest } from "../api/schema/github.ts";

export function pullRequestReference(pullRequest: Pick<SessionPullRequest, "repository" | "number">): string {
  return `${pullRequest.repository}#${pullRequest.number}`;
}

export function pullRequestStateLabel(state: PullRequestState | undefined): string {
  switch (state) {
    case "open": return "Open";
    case "draft": return "Draft";
    case "merged": return "Merged";
    case "closed": return "Closed";
    default: return "Status unavailable";
  }
}

export function pullRequestAccessibleLabel(pullRequest: SessionPullRequest): string {
  const title = pullRequest.title ? `: ${pullRequest.title}` : "";
  return `Pull request ${pullRequestReference(pullRequest)}, ${pullRequestStateLabel(pullRequest.state).toLocaleLowerCase()}${title}`;
}
