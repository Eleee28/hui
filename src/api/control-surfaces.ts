/**
 * Browser client for the gateway's read-mostly control surfaces: health, macOS power and the workspace
 * inspection of context files, memory and worktrees. The gateway gathers all of it; this module only fetches
 * and types the results.
 */
import type { PowerResponse, PowerStatus } from "./schema/power.ts";
import type { WorkspaceInspection } from "./schema/worktrees.ts";
import { fetchJson } from "./request.ts";

import type { GatewayHealth } from "./schema/diagnostics.ts";
export type { GatewayHealth } from "./schema/diagnostics.ts";

export type { MemorySource, WorktreeView, WorkspaceInspection } from "./schema/worktrees.ts";

export function loadGatewayHealth(): Promise<GatewayHealth> {
  return fetchJson<GatewayHealth>("/__hui/health");
}

/** `null` when the gateway does not run on macOS. */
export async function loadPower(): Promise<PowerStatus | null> {
  return (await fetchJson<PowerResponse>("/__hui/power")).power;
}

export async function setLidAwake(lidAwake: boolean): Promise<PowerStatus | null> {
  return (await fetchJson<PowerResponse>("/__hui/power", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lidAwake }),
  })).power;
}

export function loadWorkspaceInspection(): Promise<WorkspaceInspection> {
  return fetchJson<WorkspaceInspection>("/__hui/workspaces");
}
