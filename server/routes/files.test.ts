import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createFileRoutes, REMOTE_FILES_REASON } from "./files.ts";
import type { RouteRequest } from "../http/route.ts";
import * as schemas from "../api/files.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { MAX_RESOLVE_PATHS } from "../files.ts";
import type { FileRead } from "../api/files.ts";

async function workspace() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "hui-file-routes-")));
  const cwd = join(dir, "work");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "one\n");
  await writeFile(join(dir, "secret.txt"), "outside");
  return { dir, cwd };
}

function request(method: string, path: string, options: { query?: Record<string, string>; ifMatch?: string; body?: unknown; bytes?: Buffer } = {}): RouteRequest {
  return {
    method,
    path,
    query: new URLSearchParams(options.query ?? {}),
    headers: options.ifMatch ? { "if-match": `"${options.ifMatch}"` } : {},
    json: async () => options.body,
    bytes: async () => options.bytes ?? Buffer.alloc(0),
    signal: new AbortController().signal,
  };
}

test("file routes scope every request to the conversation's directory and explain remote sessions", async (t) => {
  const { dir, cwd } = await workspace();
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const sessions: Record<string, { cwd: string; worker?: string }> = { local: { cwd }, remote: { cwd: "/srv/elsewhere", worker: "w1" }, gone: { cwd: join(dir, "missing") } };
  const routes = createFileRoutes({ session: async (id) => sessions[id] });
  const call = async (...args: Parameters<typeof request>) => {
    const result = await routes.handle(request(...args));
    assert(result && "body" in result, "expected a JSON result");
    const route = schemas.routeSchemas.find((route) => route.method === args[0] && route.path === args[1].replace(/\/sessions\/[^/]+/u, "/sessions/:id"));
    if (result.status >= 400) expectSchema(schemas.FileError, result.body);
    else {
      assert(route);
      expectSchema(route.response, result.body);
    }
    return result as { status: number; body: Record<string, unknown>; etag?: string };
  };

  assert.equal(await routes.handle(request("GET", "/__hui/sessions/local/other")), undefined);
  assert.equal((await call("GET", "/__hui/sessions/nobody/files")).status, 404);
  const info = await call("GET", "/__hui/sessions/local/files");
  assert.equal(info.status, 200);
  assert.equal(info.body["available"], true);
  assert.equal(info.body["name"], "work");
  assert.deepEqual((await call("GET", "/__hui/sessions/remote/files")).body, { available: false, reason: REMOTE_FILES_REASON });
  const remoteList = await call("GET", "/__hui/sessions/remote/files/list");
  assert.equal(remoteList.status, 409);
  assert.equal(remoteList.body["code"], "remote");
  const gone = await call("GET", "/__hui/sessions/gone/files");
  assert.equal(gone.body["available"], false);
  assert.match(String(gone.body["reason"]), /no longer exists/u);

  assert.equal((await call("GET", "/__hui/sessions/local/files/list", { query: { path: "../" } })).status, 403);
  assert.equal((await call("GET", "/__hui/sessions/local/files/file", { query: { path: "../secret.txt" } })).status, 403);
  const listing = await call("GET", "/__hui/sessions/local/files/list", { query: { path: "src" } });
  assert.deepEqual((listing.body["entries"] as { path: string }[]).map((entry) => entry.path), ["src/a.ts"]);

  const read = await call("GET", "/__hui/sessions/local/files/file", { query: { path: "src/a.ts" } });
  assert.equal(read.status, 200);
  assert.equal(read.etag, (read.body as unknown as FileRead).etag);
  assert.equal((await call("PUT", "/__hui/sessions/local/files/file", { query: { path: "src/a.ts" }, body: { content: "two\n" } })).status, 428);
  assert.equal((await call("PUT", "/__hui/sessions/local/files/file", { query: { path: "src/a.ts" }, ifMatch: read.etag!, body: { content: 2 } })).status, 400);
  assert.equal((await call("PUT", "/__hui/sessions/local/files/file", { query: { path: "src/a.ts" }, ifMatch: read.etag!, body: { content: "x", force: true } })).status, 400);
  const saved = await call("PUT", "/__hui/sessions/local/files/file", { query: { path: "src/a.ts" }, ifMatch: read.etag!, body: { content: "two\n" } });
  assert.equal(saved.status, 200);
  const stale = await call("PUT", "/__hui/sessions/local/files/file", { query: { path: "src/a.ts" }, ifMatch: read.etag!, body: { content: "three\n" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body["code"], "conflict");
  assert.equal((stale.body["current"] as FileRead).content, "two\n");
  assert.equal(await readFile(join(cwd, "src", "a.ts"), "utf8"), "two\n");

  assert.equal((await call("POST", "/__hui/sessions/local/files/entry", { body: { path: "src/b.ts", kind: "file" } })).status, 201);
  assert.equal((await call("POST", "/__hui/sessions/local/files/entry", { body: { path: "src/b.ts", kind: "file" } })).status, 409);
  assert.equal((await call("POST", "/__hui/sessions/local/files/entry", { body: { path: "src/c", kind: "socket" } })).status, 400);
  assert.equal((await call("POST", "/__hui/sessions/local/files/upload", { query: { dir: "src", name: "up.txt" }, bytes: Buffer.from("up") })).status, 201);
  assert.equal((await call("POST", "/__hui/sessions/local/files/upload", { query: { dir: "src", name: "up.txt" }, bytes: Buffer.from("again") })).status, 409);
  assert.equal((await call("POST", "/__hui/sessions/local/files/upload", { query: { dir: "src", name: "up.txt", overwrite: "1" }, bytes: Buffer.from("again") })).status, 201);
  assert.equal(await readFile(join(cwd, "src", "up.txt"), "utf8"), "again");
  assert.equal((await call("DELETE", "/__hui/sessions/local/files/entry", { query: { path: "src" } })).status, 409);
  assert.equal((await call("DELETE", "/__hui/sessions/local/files/entry", { query: { path: "" } })).status, 422);
  assert.equal((await call("DELETE", "/__hui/sessions/local/files/entry", { query: { path: "src", recursive: "1" } })).status, 200);
  assert.equal((await call("PATCH", "/__hui/sessions/local/files/file", { query: { path: "x" } })).status, 405);
});

test("resolve answers which chat paths exist inside the conversation's directory, and nothing outside it", async (t) => {
  const { dir, cwd } = await workspace();
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(cwd, "README.md"), "# readme\n");
  await symlink(join(dir, "secret.txt"), join(cwd, "escape.txt"));
  await symlink(join(cwd, "src"), join(cwd, "linked"));
  // The registry may record the directory through a link; absolute paths under either spelling resolve.
  await symlink(cwd, join(dir, "alias"));
  const sessions: Record<string, { cwd: string; worker?: string }> = {
    local: { cwd: join(dir, "alias") },
    remote: { cwd: "/srv/elsewhere", worker: "w1" },
    gone: { cwd: join(dir, "missing") },
  };
  const routes = createFileRoutes({ session: async (id) => sessions[id] });
  const resolve = async (id: string, body: unknown) => {
    const result = await routes.handle(request("POST", `/__hui/sessions/${id}/files/resolve`, { body }));
    assert(result && "body" in result, "expected a JSON result");
    return result as { status: number; body: Record<string, unknown> };
  };
  const asked = [
    "src/a.ts", "./src/a.ts", "src/", "src", "README.md", "src/../README.md", `${cwd}/src/a.ts`, `${join(dir, "alias")}/README.md`,
    "linked/a.ts", "missing.ts", "../secret.txt", "src/../../secret.txt", join(dir, "secret.txt"), "/etc/hosts", "escape.txt",
    "~/definitely-not-a-hui-test-file.ts", "", "\0",
  ];
  const answer = await resolve("local", { paths: asked });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body["entries"], [
    { path: "src/a.ts", kind: "file" },
    { path: "src/a.ts", kind: "file" },
    { path: "src", kind: "directory" },
    { path: "src", kind: "directory" },
    { path: "README.md", kind: "file" },
    { path: "README.md", kind: "file" },
    { path: "src/a.ts", kind: "file" },
    { path: "README.md", kind: "file" },
    { path: "linked/a.ts", kind: "file" },
    null, null, null, null, null, null, null, null, null,
  ]);

  assert.equal((await resolve("local", { paths: "src/a.ts" })).status, 400);
  assert.equal((await resolve("local", { paths: [1] })).status, 400);
  assert.equal((await resolve("local", { paths: ["x".repeat(2000)] })).status, 400);
  assert.equal((await resolve("local", { paths: Array.from({ length: MAX_RESOLVE_PATHS + 1 }, () => "src/a.ts") })).status, 400);
  assert.equal((await resolve("local", ["src/a.ts"])).status, 400);
  const remote = await resolve("remote", { paths: ["src/a.ts"] });
  assert.equal(remote.status, 409);
  assert.equal(remote.body["code"], "remote");
  assert.equal((await resolve("gone", { paths: ["src/a.ts"] })).status, 404);
  assert.equal((await routes.handle(request("GET", "/__hui/sessions/local/files/resolve")))?.status, 405);
});

test("the gateway guards file routes with x-hui and serves previews as inert bytes", async (t) => {
  const { dir, cwd } = await workspace();
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
  await mkdir(join(dir, "config", "hui"), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(dir, "config", "hui", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "alpha", title: "Alpha", tool: "pi", cwd, createdAt: now, updatedAt: now },
  ], groups: [] }));
  await writeFile(join(cwd, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(cwd, "blob.bin"), Buffer.from([1, 0, 2]));
  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}/__hui/sessions/alpha/files`;
  t.onTestFinished(async () => { await stopBackend(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const guarded = { "x-hui": "1" };

  assert.equal((await fetch(`${origin}/list`)).status, 403);
  assert.equal((await fetch(`${origin}/raw?path=logo.png`)).status, 403);
  const resolveBody = { method: "POST", body: JSON.stringify({ paths: ["src/a.ts", "../secret.txt"] }) };
  assert.equal((await fetch(`${origin}/resolve`, { ...resolveBody, headers: { "content-type": "application/json" } })).status, 403);
  const resolved = await fetch(`${origin}/resolve`, { ...resolveBody, headers: { ...guarded, "content-type": "application/json" } });
  assert.equal(resolved.status, 200);
  assert.deepEqual(await resolved.json(), { entries: [{ path: "src/a.ts", kind: "file" }, null] });
  assert.equal((await fetch(`${origin}/file?path=..%2Fsecret.txt`, { headers: guarded })).status, 403);
  const read = await fetch(`${origin}/file?path=src%2Fa.ts`, { headers: guarded });
  assert.equal(read.status, 200);
  const file = await read.json() as FileRead;
  assert.equal(read.headers.get("etag"), `"${file.etag}"`);
  const saved = await fetch(`${origin}/file?path=src%2Fa.ts`, {
    method: "PUT",
    headers: { ...guarded, "content-type": "application/json", "if-match": `"${file.etag}"` },
    body: JSON.stringify({ content: "saved\n" }),
  });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(join(cwd, "src", "a.ts"), "utf8"), "saved\n");
  const image = await fetch(`${origin}/raw?path=logo.png`, { headers: guarded });
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.match(image.headers.get("content-security-policy") ?? "", /sandbox/u);
  assert.equal(image.headers.get("content-disposition"), null);
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
  const binary = await fetch(`${origin}/raw?path=blob.bin`, { headers: guarded });
  assert.equal(binary.headers.get("content-type"), "application/octet-stream");
  assert.match(binary.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''blob\.bin$/u);
  await binary.arrayBuffer();
  const upload = await fetch(`${origin}/upload?dir=src&name=photo.png`, { method: "POST", headers: guarded, body: new Uint8Array([7, 8, 9]) });
  assert.equal(upload.status, 201);
  assert.deepEqual([...await readFile(join(cwd, "src", "photo.png"))], [7, 8, 9]);
});
