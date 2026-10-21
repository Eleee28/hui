/** The GitHub connection's status line in Settings. Its requests live in src/api/github.ts. */
import type { GitHubConnection } from "../api/schema/github.ts";

export const GITHUB_CLI_URL = "https://cli.github.com";

/** Status line shown under the GitHub heading. */
export function gitHubStatusLabel(connection: GitHubConnection | undefined): { kind: "ok" | "warn" | "danger" | "accent" | "muted"; label: string } {
  if (!connection) return { kind: "muted", label: "Checking…" };
  if (!connection.cli.installed) return { kind: "danger", label: "GitHub CLI required" };
  if (connection.login.phase === "starting") return { kind: "accent", label: "Requesting code…" };
  if (connection.login.phase === "pending") return { kind: "accent", label: "Waiting for approval…" };
  if (connection.status === "connected") return { kind: "ok", label: "Connected" };
  if (connection.status === "invalid") return { kind: "danger", label: "Sign-in required" };
  if (connection.status === "unknown") return { kind: "warn", label: "Could not verify" };
  return { kind: "muted", label: "Not connected" };
}
