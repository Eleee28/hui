/**
 * Serves the built web app from the package's dist directory: app routes get an uncached index.html and every
 * other path the matching file. Only GET and HEAD are served, and dot segments, backslashes, control
 * characters or paths resolving outside the root are 404s. Text and WebAssembly are sent compressed (cached per file),
 * content-hashed assets are cached by the browser for good and other files revalidate by ETag.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { COMPRESSION_MIN_BYTES, compressBody, isCompressible, negotiateEncoding, type ContentEncoding } from "./compression.ts";

const DEEP_LINK_SECTIONS = ["sessions", "settings", "bots"] as const;

const PAGE = /^\/[a-z][a-z0-9-]*$/u;
const DEEP_LINK = new RegExp(`^/(?:${DEEP_LINK_SECTIONS.join("|")})/[^.]*$`, "u");

/** Whether a decoded pathname is an app route: Home, a top-level page (`/skills`,
 * `/kanban`) or a deep link. A deep link with a dot in it is a file request. */
export function isAppRoutePath(path: string): boolean {
  return path === "/" || PAGE.test(path) || DEEP_LINK.test(path);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  // The terminal's Ghostty VT; browsers compile WebAssembly while it streams only when served with this type.
  ".wasm": "application/wasm",
};

/** Vite names everything under `assets/` by content hash, so a URL there never
 * changes meaning: a browser may keep it for good and never ask again. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=3600";

/** Compressed copies of built files, keyed by path, size, mtime and encoding.
 * A release's `dist/` holds a few megabytes of text, so the bound only matters
 * for a checkout rebuilt many times under one gateway. */
const CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
const compressed = new Map<string, Promise<Buffer | undefined>>();
let cachedBytes = 0;

function cachedCompression(key: string, target: string, encoding: ContentEncoding): Promise<Buffer | undefined> {
  let entry = compressed.get(key);
  if (entry) {
    // Refresh its place: the oldest entry is evicted first.
    compressed.delete(key);
    compressed.set(key, entry);
    return entry;
  }
  entry = readFile(target).then((raw) => compressBody(raw, encoding, "max")).then((body) => {
    cachedBytes += body.length;
    for (const [oldest, value] of compressed) {
      if (cachedBytes <= CACHE_LIMIT_BYTES || oldest === key) break;
      compressed.delete(oldest);
      void value.then((evicted) => { cachedBytes -= evicted?.length ?? 0; });
    }
    return body;
  }, () => {
    // Serve the file uncompressed and try again on the next request.
    compressed.delete(key);
    return undefined;
  });
  compressed.set(key, entry);
  return entry;
}

function notModified(request: IncomingMessage, etag: string): boolean {
  const header = request.headers["if-none-match"];
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === etag.slice(2) || `W/${value}` === etag;
  });
}

export async function serveStatic(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
  let path: string;
  try { path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname); }
  catch { response.writeHead(400).end(); return; }
  if (path.includes("\\") || /[\p{Cc}]/u.test(path) || path.split("/").some((part) => part.startsWith("."))) {
    response.writeHead(404).end(); return;
  }
  const spa = isAppRoutePath(path);
  try {
    const target = await realpath(join(root, spa ? "index.html" : path));
    const delta = relative(await realpath(root), target);
    const file = await stat(target);
    if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta) || !file.isFile()) {
      response.writeHead(404).end(); return;
    }
    const type = MIME[extname(target)] ?? "application/octet-stream";
    response.setHeader("Content-Type", type);
    response.setHeader("X-Content-Type-Options", "nosniff");
    // The page itself is never cached, so a release's new asset names load at once.
    response.setHeader("Cache-Control", spa ? "no-store" : path.startsWith("/assets/") ? IMMUTABLE : REVALIDATE);
    const encoding = isCompressible(type) && file.size >= COMPRESSION_MIN_BYTES ? negotiateEncoding(request.headers["accept-encoding"]) : undefined;
    if (isCompressible(type)) response.setHeader("Vary", "Accept-Encoding");
    if (!spa) {
      const etag = `W/"${file.size.toString(36)}-${Math.trunc(file.mtimeMs).toString(36)}${encoding ? `-${encoding}` : ""}"`;
      response.setHeader("ETag", etag);
      if (notModified(request, etag)) { response.writeHead(304).end(); return; }
    }
    const body = encoding
      ? await cachedCompression(`${target}\0${file.size}\0${file.mtimeMs}\0${encoding}`, target, encoding)
      : undefined;
    if (body && encoding) response.setHeader("Content-Encoding", encoding);
    const sent = body ?? await readFile(target);
    response.setHeader("Content-Length", sent.length);
    response.end(request.method === "HEAD" ? undefined : sent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") response.writeHead(404).end();
    else throw error;
  }
}
