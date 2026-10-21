import assert from "node:assert/strict";
import { test } from "vitest";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressBody, isCompressible, negotiateEncoding } from "./compression.ts";

test("encoding negotiation prefers brotli, honours q-values and falls back to identity", () => {
  assert.equal(negotiateEncoding("gzip, deflate, br, zstd"), "br");
  assert.equal(negotiateEncoding("gzip, deflate"), "gzip");
  assert.equal(negotiateEncoding("br;q=0, gzip"), "gzip");
  assert.equal(negotiateEncoding("br;q=0.4, gzip;q=0.8"), "gzip");
  assert.equal(negotiateEncoding("*"), "br");
  assert.equal(negotiateEncoding("*;q=0"), undefined);
  assert.equal(negotiateEncoding("identity"), undefined);
  assert.equal(negotiateEncoding("gzip;q=0, br;q=0"), undefined);
  assert.equal(negotiateEncoding(undefined), undefined);
  assert.equal(negotiateEncoding("deflate, GZIP"), "gzip");
});

test("only text and WebAssembly are worth compressing", () => {
  for (const type of ["text/javascript; charset=utf-8", "text/css; charset=utf-8", "text/html; charset=utf-8", "application/json", "application/json; charset=utf-8", "image/svg+xml", "application/manifest+json", "application/wasm"]) {
    assert.equal(isCompressible(type), true, type);
  }
  for (const type of ["image/png", "font/woff2", "application/octet-stream"]) assert.equal(isCompressible(type), false, type);
});

test("compressed bodies decode to the original bytes", async () => {
  const body = Buffer.from(JSON.stringify({ transcript: Array.from({ length: 400 }, (_, index) => ({ kind: "message", text: `line ${index}` })) }));
  for (const effort of ["fast", "max"] as const) {
    const br = await compressBody(body, "br", effort);
    const gzip = await compressBody(body, "gzip", effort);
    assert.deepEqual(brotliDecompressSync(br), body);
    assert.deepEqual(gunzipSync(gzip), body);
    assert(br.length < body.length / 4 && gzip.length < body.length / 4, effort);
  }
});
