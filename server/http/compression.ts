/**
 * Response compression for the gateway. A phone on mobile data reaches HUI
 * through Tailscale at a fraction of the LAN's bandwidth, and the app's
 * scripts, styles and transcripts are text that shrinks four to twenty times,
 * and the terminal's WebAssembly about three times.
 *
 * Brotli is preferred, gzip is the fallback, and a client that offers neither
 * (or refuses both with q=0) gets the identity body. Small bodies are sent as
 * they are: the framing would cost more than it saves.
 */
import type { IncomingHttpHeaders } from "node:http";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export type ContentEncoding = "br" | "gzip";

/** Below this, compression saves less than a packet. */
export const COMPRESSION_MIN_BYTES = 1024;

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Picks the encoding to answer with from an `Accept-Encoding` header. */
export function negotiateEncoding(header: IncomingHttpHeaders["accept-encoding"]): ContentEncoding | undefined {
  const value = header ?? "";
  const weights = new Map<string, number>();
  for (const part of value.split(",")) {
    const [name = "", ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    const weight = q === undefined ? 1 : Number(q.slice(2));
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const weight = (name: ContentEncoding) => weights.get(name) ?? weights.get("*") ?? 0;
  if (weight("br") > 0 && weight("br") >= weight("gzip")) return "br";
  if (weight("gzip") > 0) return "gzip";
  return undefined;
}

/** Whether a `Content-Type` is worth compressing: text and WebAssembly (images and fonts already are compressed). */
export function isCompressible(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type === "application/javascript"
    || type === "image/svg+xml" || type.endsWith("+json") || type === "application/wasm";
}

/**
 * `effort` trades CPU for size: `fast` suits a body built per request (a
 * transcript), `max` a file compressed once and cached (a script bundle).
 */
export async function compressBody(body: Buffer, encoding: ContentEncoding, effort: "fast" | "max"): Promise<Buffer> {
  if (encoding === "gzip") return gzipAsync(body, { level: effort === "max" ? 9 : 6 });
  // Quality 9 is within a few percent of 11 at a twentieth of its CPU time, so
  // the first visitor after a restart does not wait seconds for the bundle.
  return brotli(body, { params: {
    [constants.BROTLI_PARAM_QUALITY]: effort === "max" ? 9 : 5,
    [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
    [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
  } });
}
