import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { servePresentedMedia, stagePresentedMedia } from "./presented-media.ts";

const FIXTURE_ID = "12345678-1234-4123-8123-123456789abc";

test("stages typed media behind an opaque URL without exposing its local path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-presented-media-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "clip.mp4"), Buffer.from("video-bytes"));
  const [media] = await stagePresentedMedia(dir, ["clip.mp4"], join(dir, "store"), () => FIXTURE_ID);
  assert.deepEqual(media, {
    id: FIXTURE_ID,
    name: "clip.mp4",
    kind: "video",
    mimeType: "video/mp4",
    size: 11,
    url: `/__hui/media/${FIXTURE_ID}/clip.mp4`,
  });
  assert.equal(await readFile(join(dir, "store", FIXTURE_ID, "content"), "utf8"), "video-bytes");
  assert.doesNotMatch(JSON.stringify(media), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("serves byte ranges for native media playback and rejects a wrong display name", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-presented-media-route-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "sound.mp3"), Buffer.from("0123456789"));
  await stagePresentedMedia(dir, ["sound.mp3"], join(dir, "store"), () => FIXTURE_ID);
  const server = createServer(async (request, response) => {
    const match = request.url?.match(/^\/media\/([^/]+)\/([^/]+)$/u);
    if (!match || !await servePresentedMedia(request, response, match[1]!, match[2]!, join(dir, "store"))) {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => { server.close(); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/media/${FIXTURE_ID}`;
  const response = await fetch(`${base}/sound.mp3`, { headers: { range: "bytes=2-5" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(await response.text(), "2345");
  assert.equal((await fetch(`${base}/other.mp3`)).status, 404);
  await writeFile(join(dir, "store", FIXTURE_ID, "metadata.json"), JSON.stringify({
    id: FIXTURE_ID, name: "sound.mp3", kind: "audio", mimeType: "text/html", size: 10,
  }));
  assert.equal((await fetch(`${base}/sound.mp3`)).status, 404, "tampered MIME metadata must not become same-origin HTML");
});

test("rejects missing files and more than eight media paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-presented-media-invalid-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(stagePresentedMedia(dir, ["missing.png"], join(dir, "store")), /does not exist/u);
  await assert.rejects(stagePresentedMedia(dir, Array(9).fill("x"), join(dir, "store")), /between 1 and 8/u);
});
