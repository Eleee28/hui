/**
 * Files an agent shows in the chat through present_media. Each one is copied out of the session workspace into
 * HUI's presented-media store under a random id, so the chat keeps it after the original changes, and is
 * served back as an immutable, range-capable response. The id in the URL is the capability; nothing outside
 * that store is ever served.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import { PRESENTED_MEDIA_DIR } from "../paths.ts";
import { readSessionRegistry } from "../sessions/sessions.ts";

const MAX_MEDIA_COUNT = 8;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_MEDIA_TOTAL_BYTES = 200 * 1024 * 1024;
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const MEDIA_TYPES = new Map<string, { kind: PresentedMediaKind; mimeType: string }>([
  [".png", { kind: "image", mimeType: "image/png" }],
  [".jpg", { kind: "image", mimeType: "image/jpeg" }],
  [".jpeg", { kind: "image", mimeType: "image/jpeg" }],
  [".gif", { kind: "image", mimeType: "image/gif" }],
  [".webp", { kind: "image", mimeType: "image/webp" }],
  [".avif", { kind: "image", mimeType: "image/avif" }],
  [".mp4", { kind: "video", mimeType: "video/mp4" }],
  [".webm", { kind: "video", mimeType: "video/webm" }],
  [".ogv", { kind: "video", mimeType: "video/ogg" }],
  [".mov", { kind: "video", mimeType: "video/quicktime" }],
  [".mp3", { kind: "audio", mimeType: "audio/mpeg" }],
  [".wav", { kind: "audio", mimeType: "audio/wav" }],
  [".ogg", { kind: "audio", mimeType: "audio/ogg" }],
  [".oga", { kind: "audio", mimeType: "audio/ogg" }],
  [".m4a", { kind: "audio", mimeType: "audio/mp4" }],
  [".aac", { kind: "audio", mimeType: "audio/aac" }],
  [".flac", { kind: "audio", mimeType: "audio/flac" }],
]);

export type PresentedMediaKind = "image" | "video" | "audio" | "file";

export type PresentedMedia = {
  id: string;
  name: string;
  kind: PresentedMediaKind;
  mimeType: string;
  size: number;
  url: string;
};

type StoredMedia = Omit<PresentedMedia, "url">;

export class PresentedMediaInputError extends Error {}

function mediaDescription(name: string): { kind: PresentedMediaKind; mimeType: string } {
  return MEDIA_TYPES.get(extname(name).toLowerCase()) ?? { kind: "file", mimeType: "application/octet-stream" };
}

function displayName(path: string): string {
  const name = basename(path).trim();
  if (!name || name === "." || name === ".." || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new PresentedMediaInputError("Media paths must end in a safe filename.");
  }
  return Array.from(name).slice(0, 240).join("");
}

function publicMedia(stored: StoredMedia): PresentedMedia {
  return {
    ...stored,
    url: `/__hui/media/${stored.id}/${encodeURIComponent(stored.name)}`,
  };
}

export async function stagePresentedMedia(
  cwd: string,
  paths: readonly string[],
  root = PRESENTED_MEDIA_DIR,
  uuid: () => string = randomUUID,
): Promise<PresentedMedia[]> {
  if (!paths.length || paths.length > MAX_MEDIA_COUNT) {
    throw new PresentedMediaInputError(`present_media accepts between 1 and ${MAX_MEDIA_COUNT} paths.`);
  }
  const sources: Array<{ path: string; name: string; size: number; kind: PresentedMediaKind; mimeType: string }> = [];
  let total = 0;
  for (const raw of paths) {
    if (typeof raw !== "string" || !raw.trim()) throw new PresentedMediaInputError("Every media path must be a non-empty string.");
    const candidate = isAbsolute(raw) ? raw : resolve(cwd, raw);
    let source: string;
    try { source = await realpath(candidate); }
    catch { throw new PresentedMediaInputError(`Media file does not exist: ${raw}`); }
    const info = await stat(source);
    if (!info.isFile()) throw new PresentedMediaInputError(`Media path is not a regular file: ${raw}`);
    if (info.size > MAX_MEDIA_BYTES) throw new PresentedMediaInputError(`Media files may not exceed 100 MB: ${raw}`);
    total += info.size;
    if (total > MAX_MEDIA_TOTAL_BYTES) throw new PresentedMediaInputError("Presented media may not exceed 200 MB in one call.");
    const name = displayName(source);
    sources.push({ path: source, name, size: info.size, ...mediaDescription(name) });
  }

  const result: PresentedMedia[] = [];
  await mkdir(root, { recursive: true });
  for (const source of sources) {
    const id = uuid();
    if (!MEDIA_ID.test(id)) throw new Error("Media id generator returned an invalid id.");
    const directory = join(root, id);
    await mkdir(directory);
    await copyFile(source.path, join(directory, "content"));
    const stored: StoredMedia = { id, name: source.name, kind: source.kind, mimeType: source.mimeType, size: source.size };
    await writeFile(join(directory, "metadata.json"), `${JSON.stringify(stored)}\n`, { encoding: "utf8", flag: "wx" });
    result.push(publicMedia(stored));
  }
  return result;
}

export async function presentMediaForSession(
  callerSessionId: string,
  params: Record<string, unknown>,
): Promise<{ media: PresentedMedia[] }> {
  const paths = params["paths"];
  if (!Array.isArray(paths) || !paths.every((item): item is string => typeof item === "string")) {
    throw new PresentedMediaInputError("present_media requires a paths array.");
  }
  const record = (await readSessionRegistry()).sessions.find((item) => item.id === callerSessionId);
  if (!record) throw new PresentedMediaInputError(`Unknown caller session: ${callerSessionId}`);
  return { media: await stagePresentedMedia(record.cwd, paths) };
}

async function storedMedia(id: string, encodedName: string, root = PRESENTED_MEDIA_DIR): Promise<StoredMedia | undefined> {
  if (!MEDIA_ID.test(id)) return undefined;
  let requestedName: string;
  try { requestedName = decodeURIComponent(encodedName); } catch { return undefined; }
  try {
    const raw = JSON.parse(await readFile(join(root, id, "metadata.json"), "utf8")) as StoredMedia;
    if (raw.id !== id || raw.name !== requestedName || typeof raw.size !== "number" || raw.size < 0) return undefined;
    if (!(["image", "video", "audio", "file"] as const).includes(raw.kind)) return undefined;
    if (typeof raw.mimeType !== "string") return undefined;
    const expected = mediaDescription(raw.name);
    if (raw.kind !== expected.kind || raw.mimeType !== expected.mimeType) return undefined;
    const content = await stat(join(root, id, "content"));
    if (!content.isFile() || content.size !== raw.size) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function requestedRange(value: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return "invalid";
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function contentDisposition(media: StoredMedia): string {
  const disposition = media.kind === "file" ? "attachment" : "inline";
  const fallback = media.name.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 120) || "media";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(media.name)}`;
}

/** Serves one immutable media capability. Returns false when the token/name is
 * unknown so the caller can produce the ordinary JSON 404. */
export async function servePresentedMedia(
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
  encodedName: string,
  root = PRESENTED_MEDIA_DIR,
): Promise<boolean> {
  const media = await storedMedia(id, encodedName, root);
  if (!media) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.setHeader("allow", "GET, HEAD");
    response.end();
    return true;
  }
  const range = requestedRange(request.headers.range, media.size);
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  response.setHeader("content-type", media.mimeType);
  response.setHeader("content-disposition", contentDisposition(media));
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("x-content-type-options", "nosniff");
  if (range === "invalid") {
    response.statusCode = 416;
    response.setHeader("content-range", `bytes */${media.size}`);
    response.end();
    return true;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, media.size - 1);
  const length = media.size === 0 ? 0 : end - start + 1;
  response.statusCode = range ? 206 : 200;
  response.setHeader("content-length", String(length));
  if (range) response.setHeader("content-range", `bytes ${start}-${end}/${media.size}`);
  if (request.method === "HEAD" || media.size === 0) {
    response.end();
    return true;
  }
  createReadStream(join(root, id, "content"), { start, end })
    .on("error", () => response.destroy())
    .pipe(response);
  return true;
}
