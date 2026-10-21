import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { readTranscriptAttachments } from "./attachments.ts";

test("reads a sent message's attachments back into the composer, skipping unreadable ones", async () => {
  const served = new Map([
    ["/image", () => new Response(new Blob(["png"], { type: "image/png" }))],
    ["/file", () => new Response(new Blob(["notes"], { type: "application/octet-stream" }))],
  ]);
  vi.stubGlobal("fetch", async (url: string) => served.get(url)?.() ?? new Response("", { status: 404 }));
  const restored = await readTranscriptAttachments([
    "legacy.txt",
    { name: "unsent.md", kind: "file" },
    { name: "shot.png", kind: "image", mimeType: "image/png", url: "/image" },
    { name: "notes.md", kind: "file", url: "/file" },
    { name: "gone.png", kind: "image", mimeType: "image/png", url: "/gone" },
  ]);
  assert.deepEqual(restored, [
    { kind: "image", name: "shot.png", mimeType: "image/png", dataBase64: "cG5n" },
    { kind: "file", name: "notes.md", mimeType: "application/octet-stream", dataBase64: "bm90ZXM=" },
  ]);
});
