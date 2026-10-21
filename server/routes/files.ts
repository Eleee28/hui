/**
 * `/__hui/sessions/:id/files…`: the Files view's routes. It finds the conversation's working directory in the
 * registry, refuses conversations on a remote worker (their files are on that machine, not the gateway's disk), and
 * maps requests onto `FilesRoot` (`../files.ts`). `hui.ts` applies the `x-hui` guard before dispatching here.
 */
import { displayPath } from "../git/working-directories.ts";
import { FilesError, FilesRoot, parseIfMatch, MAX_EDITABLE_FILE_BYTES, MAX_RAW_FILE_BYTES, MAX_RESOLVE_PATH_LENGTH, MAX_RESOLVE_PATHS } from "../files.ts";
import { reply, type RouteRequest, type RouteResult } from "../http/route.ts";
import { FileDeleted, FileEntryResponse, FileError, FileRead, FileSaved, FilesInfo, FilesListing, FilesResolve, FilesSearch } from "../api/files.ts";
export { routeSchemas } from "../api/files.ts";
import { basename } from "node:path";

export const FILES_ROUTE = /^\/__hui\/sessions\/([^/]+)\/files(?:\/(list|search|file|raw|entry|upload|resolve))?$/u;

export const REMOTE_FILES_REASON = "Files are not available for conversations on a remote worker yet: their files live on that machine.";

type SessionLocation = { cwd: string; worker?: string | undefined };

/** JSON text escapes and quotes: a 2 MB file can take a few times that on the wire. */
const SAVE_BODY_BYTES = MAX_EDITABLE_FILE_BYTES * 6 + 1024;

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new FilesError("Send a JSON object.", 400);
  return body as Record<string, unknown>;
}

export function createFileRoutes(deps: { session(id: string): Promise<SessionLocation | undefined> }) {
  async function info(location: SessionLocation): Promise<FilesInfo> {
    if (location.worker) return { available: false, reason: REMOTE_FILES_REASON };
    try {
      const root = await FilesRoot.open(location.cwd);
      return { available: true, root: displayPath(root.root), name: basename(root.root) || root.root };
    } catch (error) {
      if (error instanceof FilesError) return { available: false, reason: error.message };
      throw error;
    }
  }

  async function handle(request: RouteRequest): Promise<RouteResult | undefined> {
    const match = FILES_ROUTE.exec(request.path);
    if (!match) return undefined;
    const id = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    try {
      const location = await deps.session(id);
      if (!location) return reply(FileError, { error: `unknown session: ${id}` }, 404);
      if (!action) {
        if (request.method !== "GET") return reply(FileError, { error: "method not allowed" }, 405);
        return reply(FilesInfo, await info(location));
      }
      if (location.worker) return reply(FileError, { error: REMOTE_FILES_REASON, code: "remote" }, 409);
      const root = await FilesRoot.open(location.cwd);
      const path = request.query.get("path") ?? "";
      const method = request.method;
      if (action === "list" && method === "GET") return reply(FilesListing, await root.list(path));
      if (action === "search" && method === "GET") return reply(FilesSearch, await root.search(request.query.get("q") ?? ""));
      if (action === "file" && method === "GET") {
        const file = await root.read(path);
        return { ...reply(FileRead, file), etag: file.etag };
      }
      if (action === "file" && method === "PUT") {
        let body: unknown;
        try { body = await request.json(SAVE_BODY_BYTES); } catch { throw new FilesError("Send the file as JSON: { \"content\": \"…\" }.", 400); }
        const fields = object(body);
        if (typeof fields["content"] !== "string" || Object.keys(fields).some((key) => key !== "content")) {
          throw new FilesError("Send only the file's text: { \"content\": \"…\" }.", 400);
        }
        const saved = await root.write(path, fields["content"], parseIfMatch(request.headers["if-match"]));
        return { ...reply(FileSaved, saved), etag: saved.etag };
      }
      if (action === "raw" && method === "GET") {
        const raw = await root.raw(path);
        const preview = raw.mimeType.startsWith("image/") || raw.mimeType === "application/pdf";
        const headers: Record<string, string> = { "cross-origin-resource-policy": "same-origin", "content-security-policy": "default-src 'none'; sandbox" };
        if (!preview) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(raw.name)}`;
        return { status: 200, file: { mimeType: raw.mimeType, data: raw.data, headers } };
      }
      if (action === "entry" && method === "POST") {
        let body: unknown;
        try { body = await request.json(64 * 1024); } catch { throw new FilesError("Send { \"path\": \"…\", \"kind\": \"file\" | \"directory\" }.", 400); }
        const fields = object(body);
        const kind = fields["kind"];
        if (typeof fields["path"] !== "string" || (kind !== "file" && kind !== "directory")) {
          throw new FilesError("Send { \"path\": \"…\", \"kind\": \"file\" | \"directory\" }.", 400);
        }
        return reply(FileEntryResponse, { entry: await root.create(fields["path"], kind) }, 201);
      }
      if (action === "entry" && method === "DELETE") {
        const recursive = request.query.get("recursive") === "1";
        return reply(FileDeleted, { deleted: await root.remove(path, recursive) });
      }
      if (action === "resolve" && method === "POST") {
        const usage = `Send { "paths": ["…"] }: at most ${MAX_RESOLVE_PATHS} paths of at most ${MAX_RESOLVE_PATH_LENGTH} characters.`;
        let body: unknown;
        try { body = await request.json(MAX_RESOLVE_PATHS * (MAX_RESOLVE_PATH_LENGTH * 6 + 8) + 1024); } catch { throw new FilesError(usage, 400); }
        const paths = object(body)["paths"];
        if (!Array.isArray(paths) || paths.length > MAX_RESOLVE_PATHS || paths.some((path) => typeof path !== "string" || path.length > MAX_RESOLVE_PATH_LENGTH)) {
          throw new FilesError(usage, 400);
        }
        const entries = await Promise.all((paths as string[]).map(async (path) => (await root.locate(path)) ?? null));
        return reply(FilesResolve, { entries });
      }
      if (action === "upload" && method === "POST") {
        const name = request.query.get("name") ?? "";
        const overwrite = request.query.get("overwrite") === "1";
        let data: Buffer;
        try { data = await request.bytes(MAX_RAW_FILE_BYTES); } catch { throw new FilesError("Uploads are limited to 64 MB.", 413); }
        return reply(FileEntryResponse, { entry: await root.upload(request.query.get("dir") ?? "", name, data, overwrite) }, 201);
      }
      return reply(FileError, { error: "method not allowed" }, 405);
    } catch (error) {
      if (error instanceof FilesError) {
        return reply(FileError, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.current ? { current: error.current } : {}) }, error.status);
      }
      return reply(FileError, { error: error instanceof Error ? error.message : "Files request failed." }, 500);
    }
  }

  return { handle };
}

