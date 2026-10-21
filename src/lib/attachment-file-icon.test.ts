import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vitest";
import { resolveAttachmentFileIcon } from "./attachment-file-icon.ts";

test("file icons retain upstream type, accent and fallback resolution", () => {
  assert.deepEqual(resolveAttachmentFileIcon("notes.txt"), { family: "text", accent: "#5B7FD6", extension: "txt", extensionLabel: "TXT", compact: "txt" });
  assert.equal(resolveAttachmentFileIcon("script.ts").family, "code");
  assert.equal(resolveAttachmentFileIcon("styles.css").accent, "#8B7CF6");
  assert.equal(resolveAttachmentFileIcon("data", "application/json; charset=utf-8").family, "json");
  assert.equal(resolveAttachmentFileIcon("unknown").extensionLabel, "FILE");
  for (const filename of ["notes.txt", "readme.md", "data.json", "script.py", "photo.png", "file.zip", "paper.pdf"]) {
    const icon = resolveAttachmentFileIcon(filename);
    for (const mode of ["light", "dark"]) assert.ok(existsSync(new URL(`../../public/file-icons/compact/${mode}/${icon.compact}.svg`, import.meta.url)), filename);
    assert.ok(existsSync(new URL(`../../public/file-icons/overlays/${icon.family}.svg`, import.meta.url)), filename);
  }
});
