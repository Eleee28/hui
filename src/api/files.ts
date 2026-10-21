/**
 * Browser client for the Files view's routes (`/__hui/sessions/:id/files…`, see docs/api.md). The gateway owns the
 * disk and resolves every path inside the conversation's working directory; this only sends requests with the
 * local-client header and turns refusals into errors, except a save conflict, which is an answer. It also downloads
 * the blobs behind media and file previews.
 */
import type { FileEntry, FileRead, FileSaved, FilesInfo, FilesListing, FilesResolve, FilesSearch } from "./schema/files.ts";
import { CLIENT_HEADERS, fetchJson, trackedFetch } from "./request.ts";

export const MAX_RESOLVE_PATHS = 100;

export function fileExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function isMarkdownPath(path: string): boolean {
  return ["md", "markdown", "mdx"].includes(fileExtension(path));
}

const base = (sessionId: string, action = "") => `/__hui/sessions/${encodeURIComponent(sessionId)}/files${action ? `/${action}` : ""}`;
const withQuery = (url: string, query: Record<string, string>) => `${url}?${new URLSearchParams(query)}`;

/** A refusal the view shows as it is; `status` lets callers tell "already exists" (409) from the rest. */
export class FilesRequestError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  return trackedFetch(url, { ...init, cache: "no-store", headers: { ...CLIENT_HEADERS, ...init.headers } });
}

async function failure(response: Response): Promise<FilesRequestError> {
  const body = await response.json().catch(() => undefined) as { error?: string; code?: string } | undefined;
  return new FilesRequestError(body?.error ?? `The gateway answered HTTP ${response.status}.`, response.status, body?.code);
}

export function loadFilesInfo(sessionId: string): Promise<FilesInfo> {
  return fetchJson<FilesInfo>(base(sessionId));
}

export async function listDirectory(sessionId: string, path: string): Promise<FilesListing> {
  const response = await request(withQuery(base(sessionId, "list"), { path }));
  if (!response.ok) throw await failure(response);
  return await response.json() as FilesListing;
}

export async function searchFiles(sessionId: string, query: string, signal?: AbortSignal): Promise<FilesSearch> {
  const response = await request(withQuery(base(sessionId, "search"), { q: query }), signal ? { signal } : {});
  if (!response.ok) throw await failure(response);
  return await response.json() as FilesSearch;
}

/** Which of `paths` (as the agent wrote them in the chat) exist inside the working directory. */
export async function resolveFilePaths(sessionId: string, paths: string[]): Promise<FilesResolve> {
  const response = await request(base(sessionId, "resolve"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!response.ok) throw await failure(response);
  return await response.json() as FilesResolve;
}

export async function readFile(sessionId: string, path: string): Promise<FileRead> {
  const response = await request(withQuery(base(sessionId, "file"), { path }));
  if (!response.ok) throw await failure(response);
  return await response.json() as FileRead;
}

/** Saves text over the version `etag` names. A changed file answers with its current content instead. */
export async function saveFile(sessionId: string, path: string, content: string, etag: string): Promise<{ saved: FileSaved } | { conflict: FileRead }> {
  const response = await request(withQuery(base(sessionId, "file"), { path }), {
    method: "PUT",
    headers: { "content-type": "application/json", "if-match": `"${etag}"` },
    body: JSON.stringify({ content }),
  });
  if (response.status === 409) {
    const body = await response.json().catch(() => undefined) as { current?: FileRead; error?: string } | undefined;
    if (body?.current) return { conflict: body.current };
    throw new FilesRequestError(body?.error ?? "The file changed on disk.", 409);
  }
  if (!response.ok) throw await failure(response);
  return { saved: await response.json() as FileSaved };
}

/** A file's bytes as a blob (image and PDF previews, downloads). The route needs the client header, so an element
 * cannot point at it directly. */
export async function fetchRawFile(sessionId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await request(withQuery(base(sessionId, "raw"), { path }), signal ? { signal } : {});
  if (!response.ok) throw await failure(response);
  return await response.blob();
}

export async function fetchBlob(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`The image could not be downloaded (HTTP ${response.status}).`);
  return response.blob();
}

export async function fetchPreviewBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

export async function createEntry(sessionId: string, path: string, kind: "file" | "directory"): Promise<FileEntry> {
  const response = await request(base(sessionId, "entry"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, kind }),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json() as { entry: FileEntry }).entry;
}

export async function deleteEntry(sessionId: string, path: string, recursive: boolean): Promise<void> {
  const response = await request(withQuery(base(sessionId, "entry"), { path, ...(recursive ? { recursive: "1" } : {}) }), { method: "DELETE" });
  if (!response.ok) throw await failure(response);
}

/** Uploads one file into a folder; an existing file answers 409 unless `overwrite`. */
export async function uploadFile(sessionId: string, directory: string, file: File, overwrite: boolean): Promise<FileEntry> {
  const response = await request(withQuery(base(sessionId, "upload"), { dir: directory, name: file.name, ...(overwrite ? { overwrite: "1" } : {}) }), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw await failure(response);
  return (await response.json() as { entry: FileEntry }).entry;
}
