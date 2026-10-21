/**
 * Which workspace defaults a session group lends to New Session. A group's worktree mode and base ref apply
 * only when the chosen directory is the group's own and is a real Git checkout.
 */
import type { GitCheckoutInfo, SessionGroup } from "../api/sessions.ts";

/** Apply group defaults only to its original directory and an actual checkout. */
export function groupCheckoutDefaults(directory: string, checkout: GitCheckoutInfo,
  group?: Pick<SessionGroup, "cwd" | "workspaceMode" | "baseRef">) {
  if (!checkout.available) return { worktree: false, baseRef: "" };
  const matching = group?.cwd?.trim() === directory.trim();
  return {
    worktree: matching && group?.workspaceMode === "worktree",
    baseRef: (matching ? group?.baseRef : "") || checkout.defaultBranch || checkout.headBranch || "HEAD",
  };
}
