/** Labels for GitHub chat embeds: compact counts and why a preview is missing. */
import type { GitHubPreviewResult } from "../api/schema/github.ts";

export function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}

export function previewErrorLabel(error: GitHubPreviewResult["error"]): string {
  switch (error) {
    case "not_found": return "Not found, or your GitHub account cannot see it.";
    case "signed_out": return "Connect GitHub in Settings → Integrations to preview it.";
    case "cli_missing": return "GitHub CLI (gh) is required for previews.";
    default: return "GitHub preview unavailable.";
  }
}
