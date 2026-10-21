/** Browser client for the GitHub integration: connection status and the `gh auth login --web` flow. `gh` on the
 * gateway owns the credential; these requests only move credential-free status and login state. */
import type { GitHubConnection } from "./schema/github.ts";
import { fetchJson } from "./request.ts";

const GITHUB_URL = "/__hui/github";

export function loadGitHubConnection(): Promise<GitHubConnection> {
  return fetchJson<GitHubConnection>(GITHUB_URL, { signal: AbortSignal.timeout(25_000) });
}

/** Starts `gh auth login --web` and resolves with the one-time code once gh prints it. */
export function startGitHubLogin(): Promise<GitHubConnection> {
  return fetchJson<GitHubConnection>(`${GITHUB_URL}/login`, { method: "POST", signal: AbortSignal.timeout(45_000) });
}

export function cancelGitHubLogin(): Promise<GitHubConnection> {
  return fetchJson<GitHubConnection>(`${GITHUB_URL}/login`, { method: "DELETE", signal: AbortSignal.timeout(25_000) });
}
