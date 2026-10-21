/**
 * The Worktrees page: `GET /__hui/worktrees` (the inventory), `POST /__hui/worktrees/remove` (one worktree or the
 * merged cleanup, over `worktree-inventory.ts`) and `GET /__hui/workspaces` (the workspace inspection).
 * `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { readWorkspaceInspection } from "../control-surfaces.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { WorkspaceInspection, WorktreeError, WorktreeInventory, WorktreeRemovalResponse } from "../api/worktrees.ts";
export { routeSchemas } from "../api/worktrees.ts";
import type { SessionRecord } from "../sessions/sessions.ts";
import type { WorktreeService } from "../git/worktree-inventory.ts";
import type { WorktreeRisk } from "../api/worktrees.ts";

const WORKTREES_ROUTE = "/__hui/worktrees";
const WORKTREES_REMOVE_ROUTE = "/__hui/worktrees/remove";
const WORKSPACES_ROUTE = "/__hui/workspaces";

const WORKTREE_RISKS = new Set(["dirty", "unknown", "locked", "running", "missing", "external"]);

/** Validates `{ paths, mode, acknowledged? }` for worktree removal. */
export function parseWorktreeRemoval(body: unknown): { paths: string[]; mode: "single" | "merged"; acknowledged: WorktreeRisk[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Removal request must be an object.");
  const record = body as Record<string, unknown>;
  const mode = record["mode"];
  if (mode !== "single" && mode !== "merged") throw new Error("mode must be single or merged.");
  const paths = record["paths"];
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200
    || paths.some((path) => typeof path !== "string" || !path.startsWith("/") || path.length > 4096 || path.includes("\0"))) {
    throw new Error("paths must be 1-200 absolute paths.");
  }
  if (mode === "single" && paths.length !== 1) throw new Error("single removal takes exactly one path.");
  const acknowledged = record["acknowledged"] ?? [];
  if (!Array.isArray(acknowledged) || acknowledged.some((risk) => typeof risk !== "string" || !WORKTREE_RISKS.has(risk))) {
    throw new Error("acknowledged must list known worktree risks.");
  }
  if (mode === "merged" && acknowledged.length) throw new Error("merged cleanup never overrides risks.");
  return { paths: [...new Set(paths as string[])], mode, acknowledged: acknowledged as WorktreeRisk[] };
}

export function createWorktreeRoutes(deps: { worktreeService: WorktreeService; readRegistry(): Promise<SessionRecord[]> }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    const { worktreeService, readRegistry } = deps;
    if (path === WORKTREES_ROUTE) {
      if (method === "GET") return reply(WorktreeInventory, await worktreeService.inventory(await readRegistry()));
      return reply(WorktreeError, { error: "method not allowed" }, 405);
    }
    if (path === WORKTREES_REMOVE_ROUTE) {
      if (method !== "POST") return reply(WorktreeError, { error: "method not allowed" }, 405);
      let removal: ReturnType<typeof parseWorktreeRemoval>;
      try {
        removal = parseWorktreeRemoval(await request.json());
      } catch (error) {
        return reply(WorktreeError, { error: error instanceof Error ? error.message : "Invalid removal request." }, 400);
      }
      const results = await worktreeService.remove(await readRegistry(), removal.paths, removal.mode, removal.acknowledged);
      return reply(WorktreeRemovalResponse, { results, inventory: await worktreeService.inventory(await readRegistry()) });
    }
    if (path === WORKSPACES_ROUTE) {
      if (method === "GET") return reply(WorkspaceInspection, await readWorkspaceInspection());
      return reply(WorktreeError, { error: "method not allowed" }, 405);
    }
    return undefined;
  }

  return { handle };
}
