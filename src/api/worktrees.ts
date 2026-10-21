/** Browser client for the worktree inventory in Settings: loading it and removing worktrees with acknowledged
 * risks. Git work happens in the gateway. */
import type { WorktreeInventory, WorktreeRemovalMode, WorktreeRemovalResponse, WorktreeRisk } from "./schema/worktrees.ts";
import { fetchJson } from "./request.ts";

export function loadWorktrees(): Promise<WorktreeInventory> {
  return fetchJson<WorktreeInventory>("/__hui/worktrees", { signal: AbortSignal.timeout(30_000) });
}

export function removeWorktrees(
  paths: readonly string[],
  mode: WorktreeRemovalMode,
  acknowledged: readonly WorktreeRisk[] = [],
): Promise<WorktreeRemovalResponse> {
  return fetchJson("/__hui/worktrees/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths, mode, acknowledged }),
    // Removing large checkouts can take a while; the server serializes removals.
    signal: AbortSignal.timeout(15 * 60_000),
  });
}
