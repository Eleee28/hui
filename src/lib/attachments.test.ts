import assert from "node:assert/strict";
import { test } from "vitest";
import { File } from "node:buffer";
import { attachmentBytes, readAttachment, validateAttachmentTotal } from "./attachments.ts";
import type { Attachment } from "../api/sessions.ts";

const attachment = (dataBase64: string): Attachment => ({ kind: "file", name: "a", mimeType: "text/plain", dataBase64 });

test("computes decoded attachment bytes including padding", () => {
  assert.equal(attachmentBytes(attachment("YQ==")), 1);
  assert.equal(attachmentBytes(attachment("YWI=")), 2);
});

test("rejects an aggregate larger than the safe request budget", () => {
  const eightMegabytes = attachment("A".repeat(Math.ceil((8 * 1024 * 1024 * 4) / 3 / 4) * 4));
  assert.throws(() => validateAttachmentTotal([eightMegabytes, eightMegabytes, attachment("YQ==")]), /16 MB/);
});

test("matches the gateway count and per-item limits", () => {
  const tiny = attachment("YQ==");
  assert.doesNotThrow(() => validateAttachmentTotal(Array(8).fill(tiny)));
  assert.throws(() => validateAttachmentTotal(Array(9).fill(tiny)), /At most 8/);

  const overTwelveMegabytes = attachment("A".repeat(Math.ceil(((12 * 1024 * 1024 + 1) * 4) / 3 / 4) * 4));
  assert.throws(() => validateAttachmentTotal([overTwelveMegabytes]), /larger than 12 MB/);
});

test("rejects names the gateway cannot safely store", async () => {
  const common = new File(["hi"], "captura final 🏂.png", { type: "image/png" });
  assert.equal((await readAttachment(common as unknown as globalThis.File)).name, "captura final 🏂.png");
  assert.throws(
    () => validateAttachmentTotal([{ ...attachment("YQ=="), name: "../note.txt" }]),
    /path separators or controls/,
  );
  assert.throws(
    () => validateAttachmentTotal([{ ...attachment("YQ=="), name: "bad\u0000name.txt" }]),
    /path separators or controls/,
  );
  assert.throws(
    () => validateAttachmentTotal([{ ...attachment("YQ=="), name: ".." }]),
    /path separators or controls/,
  );
});
