import assert from "node:assert/strict";
import { test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("attachment image route is guarded, typed and never resolves unknown sessions or indexes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-attachment-route-"));
  process.env["XDG_CONFIG_HOME"] = dir;
  await mkdir(join(dir, "hui"));
  const now = new Date().toISOString();
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 1, sessions: [
    { id: "alpha", title: "Alpha", tool: "pi", cwd: dir, createdAt: now, updatedAt: now },
  ], groups: [] }));
  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => { await stopBackend(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const get = (path: string, guard = true, method = "GET") => fetch(origin + path, { method, headers: guard ? { "x-hui": "1" } : {} });

  assert.equal((await get("/__hui/sessions/alpha/attachments/0/0", false)).status, 403);
  assert.equal((await fetch(origin + "/__hui/sessions/alpha/attachments/0/0", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(origin + "/__hui/sessions/missing/attachments/0/0", { headers: { "sec-fetch-site": "same-origin" } })).status, 404);
  assert.equal((await get("/__hui/sessions/missing/attachments/0/0")).status, 404);
  const outOfRange = await get("/__hui/sessions/alpha/attachments/99/7");
  assert.equal(outOfRange.status, 404);
  assert.doesNotMatch(await outOfRange.text(), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await get("/__hui/sessions/alpha/attachments/0/0", true, "DELETE")).status, 405);
  assert.equal((await get("/__hui/sessions/alpha/attachments/0/files/0", false)).status, 403);
  assert.equal((await get("/__hui/sessions/alpha/attachments/0/files/0")).status, 404);
});

test("stored attachment files are only read from inside the attachment store", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-attachment-store-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const store = join(dir, "store");
  const { readStoredAttachment, storeAttachmentFile } = await import("../sessions/attachments.ts");
  const stored = await storeAttachmentFile("alpha", "notes.md", Buffer.from("notes").toString("base64"), store);
  assert.equal((await readStoredAttachment(stored.path, store))?.toString(), "notes");

  const outside = join(dir, "secret.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(store, "alpha", "link.txt"));
  assert.equal(await readStoredAttachment(outside, store), undefined);
  assert.equal(await readStoredAttachment(join(store, "alpha", "..", "..", "secret.txt"), store), undefined);
  assert.equal(await readStoredAttachment(join(store, "alpha", "link.txt"), store), undefined);
  assert.equal(await readStoredAttachment(join(store, "alpha"), store), undefined);
  assert.equal(await readStoredAttachment(join(store, "alpha", "missing"), store), undefined);
});

test("public transcript replaces runtime attachment locations with opaque URLs", async () => {
  const { publicTranscript } = await import("../sessions/live-sessions.ts");
  assert.deepEqual(publicTranscript("a b", [{ kind: "message", role: "user", text: "", attachments: [
    { name: "s.png", kind: "image", mimeType: "image/png", source: { message: 3, image: 1 } },
    { name: "n.txt", kind: "file", source: { message: 3, file: 0 } },
    { name: "legacy.txt", kind: "file" },
  ] }]), [{ kind: "message", role: "user", text: "", attachments: [
    { name: "s.png", kind: "image", mimeType: "image/png", url: "/__hui/sessions/a%20b/attachments/3/1" },
    { name: "n.txt", kind: "file", url: "/__hui/sessions/a%20b/attachments/3/files/0" },
    { name: "legacy.txt", kind: "file" },
  ] }]);
});
