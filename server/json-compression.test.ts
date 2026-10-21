import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

/** A raw request, so the test sees the bytes on the wire rather than a decoded body. */
function get(url: string, headers: Record<string, string>): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
}

test("large JSON answers are compressed for clients that accept it and identical once decoded", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-json-compression-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  const workspace = join(dir, "workspace");
  await mkdir(join(dir, "hui"), { recursive: true });
  await mkdir(workspace);
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    id: `compression-${index}`, title: `Session number ${index} with a descriptive title`, group: "Compression", cwd: workspace,
    tool: "durable", piSessionFile: `durable:compression-${index}`, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T11:00:00.000Z", source: "hui",
  }));
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 2, groups: [], sessions }));
  const { middleware } = await import("./hui.ts");
  const { stopBackend } = await import("./backend.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/__hui/sessions`;
  t.onTestFinished(async () => {
    await stopBackend();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const plain = await get(url, { "x-hui": "1" });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["content-encoding"], undefined);
  const list = JSON.parse(plain.body.toString("utf8")) as { groups: { sessions: unknown[] }[] };
  assert.equal(list.groups.flatMap((group) => group.sessions).length, 40);
  assert(plain.body.length > 4096, "the list is large enough to compress");

  const br = await get(url, { "x-hui": "1", "accept-encoding": "gzip, deflate, br" });
  assert.equal(br.headers["content-encoding"], "br");
  assert.match(String(br.headers["vary"]), /accept-encoding/iu);
  assert.equal(Number(br.headers["content-length"]), br.body.length);
  assert(br.body.length < plain.body.length / 3);
  assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString("utf8")), list);

  const gzip = await get(url, { "x-hui": "1", "accept-encoding": "gzip" });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(gzip.body).toString("utf8")), list);

  // Small answers and refusals go as they are.
  const refused = await get(url, { "accept-encoding": "br" });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers["content-encoding"], undefined);
});
