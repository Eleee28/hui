/**
 * `/__hui/sessions/:id/diff…`: the Diff view's routes. Like the Files routes (`routes/files.ts`) it finds the
 * conversation's working directory in the registry, opens it through `FilesRoot` (realpath, must be a folder) and
 * refuses conversations on a remote worker; `git-diff.ts` runs Git there. Query values are validated here: the
 * comparison against its fixed list, paths with the Files path rules, and a picked branch against the branches the
 * gateway itself offers. `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { displayPath } from "../git/working-directories.ts";
import { FilesError, FilesRoot } from "../files.ts";
import { diffChanges, diffFile, diffInfo, DiffError, runGit, isDiffComparison, type DiffRequest, type GitRunner } from "../git/diff.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { DiffChanges, DiffErrorResponse, DiffFileChanges, DiffInfo } from "../api/diff.ts";
export { routeSchemas } from "../api/diff.ts";

export const DIFF_ROUTE = /^\/__hui\/sessions\/([^/]+)\/diff(?:\/(changes|file))?$/u;

export const REMOTE_DIFF_REASON = "Diffs are not available for conversations on a remote worker yet: their files live on that machine.";

const MAX_QUERY_VALUE = 1024;

type SessionLocation = { cwd: string; worker?: string | undefined };

function queryValue(query: URLSearchParams, key: string): string | undefined {
  const value = query.get(key);
  if (value === null || value === "") return undefined;
  if (value.length > MAX_QUERY_VALUE || value.includes("\0")) throw new DiffError(`The ${key} parameter is too long.`, 400);
  return value;
}

/** The comparison a request names: `compare` from the fixed list, `parent` a full ref (checked against the offered
 * branches later), `uncommitted` on unless `0`. */
export function parseDiffRequest(query: URLSearchParams): DiffRequest {
  const comparison = query.get("compare") ?? "";
  if (!isDiffComparison(comparison)) throw new DiffError("Choose a comparison: uncommitted, last-commit, parent or default.", 400);
  const parent = queryValue(query, "parent");
  if (parent !== undefined && !/^refs\/(heads|remotes)\/\S+$/u.test(parent)) throw new DiffError("Choose the previous branch from the list.", 400, "unknown-ref");
  return { comparison, parent, uncommitted: query.get("uncommitted") !== "0" };
}

export function createDiffRoutes(deps: { session(id: string): Promise<SessionLocation | undefined>; git?: GitRunner }) {
  const git = deps.git ?? runGit;

  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const match = DIFF_ROUTE.exec(request.path);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    try {
      if (request.method !== "GET") return reply(DiffErrorResponse, { error: "method not allowed" }, 405);
      const location = await deps.session(id);
      if (!location) return reply(DiffErrorResponse, { error: `unknown session: ${id}` }, 404);
      if (!action) {
        if (location.worker) return reply(DiffInfo, { available: false, reason: REMOTE_DIFF_REASON, code: "remote" });
        let root: FilesRoot;
        try {
          root = await FilesRoot.open(location.cwd);
        } catch (error) {
          if (error instanceof FilesError) return reply(DiffInfo, { available: false, reason: error.message, code: "missing" });
          throw error;
        }
        return reply(DiffInfo, await diffInfo(root.root, displayPath(root.root), git));
      }
      if (location.worker) return reply(DiffErrorResponse, { error: REMOTE_DIFF_REASON, code: "remote" }, 409);
      const root = await FilesRoot.open(location.cwd);
      const diff = parseDiffRequest(request.query);
      if (action === "changes") return reply(DiffChanges, await diffChanges(root.root, diff, git));
      const path = queryValue(request.query, "path") ?? "";
      const from = queryValue(request.query, "from");
      return reply(DiffFileChanges, { file: await diffFile(root.root, diff, path, from, git) });
    } catch (error) {
      if (error instanceof DiffError || error instanceof FilesError) {
        return reply(DiffErrorResponse, { error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      }
      return reply(DiffErrorResponse, { error: error instanceof Error ? error.message : "Diff request failed." }, 500);
    }
  }

  return { handle };
}
