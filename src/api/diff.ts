/**
 * Browser client for the Diff view's routes (`/__hui/sessions/:id/diff…`, see docs/api.md). The gateway runs Git and
 * owns every rule about refs and paths; this only builds the query, sends the local-client header and turns refusals
 * into errors the view shows.
 */
import type { DiffChanges, DiffComparison, DiffFile, DiffFileChanges, DiffInfo } from "./schema/diff.ts";
import { CLIENT_HEADERS, trackedFetch } from "./request.ts";

const base = (sessionId: string, action = "") => `/__hui/sessions/${encodeURIComponent(sessionId)}/diff${action ? `/${action}` : ""}`;

/** A refusal; `status` 409 with `code: "remote"` is a conversation on a remote worker. */
export class DiffRequestError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type DiffQuery = { comparison: DiffComparison; parent?: string | undefined; uncommitted: boolean };

/** The query string for a comparison; the picked branch is sent only where it applies. */
export function diffQuery(query: DiffQuery, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ compare: query.comparison });
  if (query.comparison === "parent" && query.parent) params.set("parent", query.parent);
  if ((query.comparison === "parent" || query.comparison === "default") && !query.uncommitted) params.set("uncommitted", "0");
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await trackedFetch(url, { cache: "no-store", headers: { ...CLIENT_HEADERS }, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string; code?: string } | undefined;
    throw new DiffRequestError(body?.error ?? `The gateway answered HTTP ${response.status}.`, response.status, body?.code);
  }
  return await response.json() as T;
}

export function loadDiffInfo(sessionId: string, signal?: AbortSignal): Promise<DiffInfo> {
  return get<DiffInfo>(base(sessionId), signal);
}

export function loadDiffChanges(sessionId: string, query: DiffQuery, signal?: AbortSignal): Promise<DiffChanges> {
  return get<DiffChanges>(`${base(sessionId, "changes")}?${diffQuery(query)}`, signal);
}

/** One file the full answer left out (`truncated: "total"`). */
export async function loadDiffFile(sessionId: string, query: DiffQuery, file: Pick<DiffFile, "path" | "oldPath">, signal?: AbortSignal): Promise<DiffFile | null> {
  const extra: Record<string, string> = { path: file.path };
  if (file.oldPath) extra["from"] = file.oldPath;
  return (await get<DiffFileChanges>(`${base(sessionId, "file")}?${diffQuery(query, extra)}`, signal)).file;
}
