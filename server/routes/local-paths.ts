/**
 * Local path lookups for the launcher and the composer: `GET /__hui/directories` (working directory suggestions,
 * from a worker when one is named), `GET /__hui/local-paths` (path completion under a working directory) and
 * `GET /__hui/git-checkout` (what Git checkout a folder is). `hui.ts` applies the `x-hui` guard before dispatching
 * here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { DirectoriesResponse, GitCheckoutResponse, LocalPathError, LocalPathsResponse } from "../api/local-paths.ts";
export { routeSchemas } from "../api/local-paths.ts";
import { completeLocalPaths, completeWorkingDirectories, resolveWorkingDirectory } from "../git/working-directories.ts";
import type { WorkerService } from "../workers.ts";
import { inspectGitCheckout } from "../git/worktrees.ts";

const DIRECTORIES_ROUTE = "/__hui/directories";
const LOCAL_PATHS_ROUTE = "/__hui/local-paths";
const GIT_CHECKOUT_ROUTE = "/__hui/git-checkout";

export function createLocalPathRoutes(deps: { workers: WorkerService }) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    if (path === DIRECTORIES_ROUTE) {
      if (method === "GET") {
        const query = request.query.get("q") ?? "~/";
        const worker = request.query.get("worker");
        // An unreachable worker just offers no suggestions; launching reports why.
        const directories = worker ? await deps.workers.directories(worker, query).catch(() => []) : await completeWorkingDirectories(query);
        return reply(DirectoriesResponse, { directories });
      }
      return reply(LocalPathError, { error: "method not allowed" }, 405);
    }
    if (path === LOCAL_PATHS_ROUTE) {
      if (method === "GET") {
        const input = request.query.get("q") ?? "";
        const cwd = request.query.get("cwd") ?? "~/";
        if (input.length > 4_096 || cwd.length > 4_096) return reply(LocalPathError, { error: "path query is too long" }, 400);
        return reply(LocalPathsResponse, { paths: await completeLocalPaths(input, resolveWorkingDirectory(cwd)) });
      }
      return reply(LocalPathError, { error: "method not allowed" }, 405);
    }
    if (path === GIT_CHECKOUT_ROUTE) {
      if (method === "GET") {
        const query = request.query.get("cwd") ?? "~/";
        return reply(GitCheckoutResponse, { checkout: await inspectGitCheckout(resolveWorkingDirectory(query)) });
      }
      return reply(LocalPathError, { error: "method not allowed" }, 405);
    }
    return undefined;
  }

  return { handle };
}
