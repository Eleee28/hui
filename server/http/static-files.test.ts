import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { serveStatic } from "./static-files.ts";
import routes from "./static-files.fixture.json";

test("static production server serves deep links/assets but not private files, symlinks or missing assets", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "hui-static-"));
  const root = join(temporary, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<hui-app></hui-app>");
  await writeFile(join(root, "assets", "app.js"), "export const app = true;");
  await writeFile(join(temporary, "secret.txt"), "not public");
  await symlink(join(temporary, "secret.txt"), join(root, "escape.txt"));
  const server = createServer((request, response) => { void serveStatic(root, request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await rm(temporary, { recursive: true, force: true }); });
  for (const path of routes.app) {
    const response = await fetch(base + path); assert.equal(response.status, 200, path); assert.match(await response.text(), /hui-app/u);
  }
  const script = await fetch(base + "/assets/app.js"); assert.match(script.headers.get("content-type")!, /javascript/u);
  assert.equal((await fetch(base + "/", { method: "HEAD" })).headers.get("x-content-type-options"), "nosniff");
  for (const path of [...routes.files, "/.env", "/escape.txt", "/bots/missing.js", "/%2e%2e/secret.txt", "/build/cli/main.js", "/%5csecret.txt"]) assert.equal((await fetch(base + path)).status, 404, path);
  assert.equal((await fetch(base + "/%zz")).status, 400);
  assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
});

test("built files are compressed, hashed assets cached for good and the rest revalidated", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "hui-static-compression-"));
  const root = join(temporary, "dist");
  await mkdir(join(root, "assets"), { recursive: true });
  const script = `export const rows = [${Array.from({ length: 500 }, (_, index) => `"row ${index}"`).join(",")}];\n`;
  await writeFile(join(root, "index.html"), `<!doctype html><hui-app></hui-app>${" ".repeat(2048)}`);
  await writeFile(join(root, "assets", "app-abc123.js"), script);
  await writeFile(join(root, "assets", "tiny-abc123.js"), "export {};");
  await writeFile(join(root, "logo.png"), Buffer.alloc(4096, 7));
  // A stand-in module: the magic number and version, then repetitive bytes like real code sections.
  const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(8192, 0x41)]);
  await writeFile(join(root, "assets", "ghostty-vt-abc123.wasm"), wasm);
  const server = createServer((request, response) => { void serveStatic(root, request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await rm(temporary, { recursive: true, force: true }); });
  const raw = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    httpRequest(base + path, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });

  const br = await raw("/assets/app-abc123.js", { "accept-encoding": "gzip, br" });
  assert.equal(br.status, 200);
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(br.headers["vary"], "Accept-Encoding");
  assert.equal(br.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(brotliDecompressSync(br.body).toString("utf8"), script);
  assert(br.body.length < script.length / 3);
  const again = await raw("/assets/app-abc123.js", { "accept-encoding": "br" });
  assert.deepEqual(again.body, br.body, "the cached copy is served");
  const gzip = await raw("/assets/app-abc123.js", { "accept-encoding": "gzip" });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gzip.body).toString("utf8"), script);
  const identity = await raw("/assets/app-abc123.js");
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.body.toString("utf8"), script);
  assert.notEqual(identity.headers["etag"], br.headers["etag"], "each encoding is its own representation");

  // A revalidation of an unchanged file costs no body.
  const revalidated = await raw("/assets/app-abc123.js", { "accept-encoding": "br", "if-none-match": String(br.headers["etag"]) });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0);

  // The terminal's WebAssembly is served as such (streaming compilation requires the type) and compressed.
  const module = await raw("/assets/ghostty-vt-abc123.wasm", { "accept-encoding": "br" });
  assert.equal(module.status, 200);
  assert.equal(module.headers["content-type"], "application/wasm");
  assert.equal(module.headers["content-encoding"], "br");
  assert.equal(module.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.deepEqual(brotliDecompressSync(module.body), wasm);

  const tiny = await raw("/assets/tiny-abc123.js", { "accept-encoding": "br" });
  assert.equal(tiny.headers["content-encoding"], undefined, "too small to be worth it");
  const image = await raw("/logo.png", { "accept-encoding": "br" });
  assert.equal(image.headers["content-encoding"], undefined, "already compressed");
  assert.equal(image.headers["cache-control"], "public, max-age=3600");
  assert.ok(image.headers["etag"]);

  // The page is compressed too, but never cached or revalidated: a release's
  // new asset names must load at once.
  const page = await raw("/sessions/fixture", { "accept-encoding": "br" });
  assert.equal(page.headers["content-encoding"], "br");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["etag"], undefined);
  assert.match(brotliDecompressSync(page.body).toString("utf8"), /hui-app/u);
  const head = await raw("/assets/app-abc123.js", { "accept-encoding": "br" }).then(() => new Promise<IncomingHttpHeaders>((resolve, reject) => {
    httpRequest(base + "/assets/app-abc123.js", { method: "HEAD", headers: { "accept-encoding": "br" } }, (response) => { response.resume(); resolve(response.headers); }).on("error", reject).end();
  }));
  assert.equal(head["content-length"], String(br.body.length));
});
