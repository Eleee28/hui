/** Status line shown while the gateway creates a session's Git worktree. */
import type { WorktreeProgress } from "../api/sessions.ts";

/** The status line shown while the gateway creates a session's worktree. */
export function worktreeProgressLabel(progress: WorktreeProgress | undefined): string {
  switch (progress?.phase) {
    case "naming": return "Naming worktree";
    case "checkout": return "Checking out files";
    case "filtering": return "Running checkout filters";
    case "finalizing": return "Finalizing Git worktree";
    default: return "Preparing Git worktree";
  }
}
