/**
 * The request and result shape every route module (`server/routes/`) speaks. `hui.ts` turns an incoming message
 * into a `RouteRequest` (`routeRequest`) and writes the module's `RouteResult` back, so a module reads its body and
 * headers and answers JSON, HTML or a file without touching Node's HTTP objects. Also owns reading request bodies,
 * writing JSON answers (compressed when large, with the error text a failed answer's diagnostic records) and the
 * `x-hui` header name every guard checks.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Static, TSchema } from "typebox";
import { COMPRESSION_MIN_BYTES, compressBody, negotiateEncoding } from "./compression.ts";

const MAX_BODY_BYTES = 64 * 1024;

/** Refuse cross-origin callers. A page on any site can reach localhost, but it
 * cannot set a custom header without a preflight, and we answer none. */
export const CLIENT_HEADER = "x-hui";

export type RouteRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** The parsed JSON body, at most `maxBytes` (64 KiB by default). */
  json(maxBytes?: number): Promise<unknown>;
  /** The raw body, at most `maxBytes`. */
  bytes(maxBytes: number): Promise<Buffer>;
  /** Aborts when the client goes away. */
  signal: AbortSignal;
};

type RouteFile = { mimeType: string; data: Buffer; headers: Record<string, string> };

export type JsonResult = { status: number; body: unknown; etag?: string };

export type RouteResult =
  | JsonResult
  | { status: number; html: string }
  | { status: number; file: RouteFile };

export function reply<S extends TSchema>(_schema: S, body: Static<S>, status = 200): JsonResult {
  return { status, body };
}

/** A request body as bytes, refusing anything past `maxBytes`. */
export async function readBytes(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return JSON.parse((await readBytes(request, maxBytes)).toString("utf8"));
}

export function routeRequest(request: IncomingMessage, response: ServerResponse, path: string): RouteRequest {
  const gone = new AbortController();
  response.once("close", () => gone.abort());
  return {
    method: request.method ?? "GET",
    path,
    query: new URL(request.url ?? "/", "http://localhost").searchParams,
    headers: request.headers,
    json: (maxBytes) => readBody(request, maxBytes),
    bytes: (maxBytes) => readBytes(request, maxBytes),
    signal: gone.signal,
  };
}

/** A file as itself: never sniffed or cached. */
export function sendFile(response: ServerResponse, status: number, file: RouteFile): void {
  response.statusCode = status;
  response.setHeader("content-type", file.mimeType);
  response.setHeader("content-length", String(file.data.length));
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  for (const [name, value] of Object.entries(file.headers)) response.setHeader(name, value);
  response.end(file.data);
}

/** Error text of failed `/__hui/` responses, kept for their request diagnostic. */
export const responseFailures = new WeakMap<ServerResponse, string>();

/** Responses whose body is being compressed: they are answered, just not ended yet. */
const compressing = new WeakSet<ServerResponse>();

/**
 * A large body (a session's transcript) is compressed when the client accepts
 * it, off the event loop. The first answer wins, as when the body is sent at once.
 */
export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || compressing.has(response)) {
    return;
  }
  if (status >= 400 && !responseFailures.has(response)) {
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === "string") responseFailures.set(response, error);
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  const text = JSON.stringify(body);
  const encoding = text.length >= COMPRESSION_MIN_BYTES ? negotiateEncoding(response.req?.headers["accept-encoding"]) : undefined;
  if (!encoding) {
    response.end(text);
    return;
  }
  response.setHeader("vary", "accept-encoding");
  compressing.add(response);
  const raw = Buffer.from(text);
  void compressBody(raw, encoding, "fast").then((compressed) => {
    response.setHeader("content-encoding", encoding);
    return compressed;
  }, () => raw).then((sent) => {
    compressing.delete(response);
    if (response.writableEnded || response.destroyed) return;
    response.setHeader("content-length", sent.length);
    response.end(sent);
  });
}
