/** Attachment and message action contracts owned by the home view. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("transcript attachments use the original sized file-icon component", () => {
  const source = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  assert.match(source, /renderAttachmentFileIcon\(\{ filename: attachmentName\(attachment\), mode: "large-placeholder" \}\)/);
  assert.doesNotMatch(source, /chat-assistant-attachment-card__identity">\$\{icons\.fileText\}/);
});

test("settled messages keep the context menu and a footer copy button", () => {
  const view = readFileSync(new URL("./home.ts", import.meta.url), "utf8");
  assert.match(view, /row\.role === "assistant" \? "Copy response" : "Copy prompt"/);
  assert.match(view, /@contextmenu=\$\{\(event: MouseEvent\) => openMessageContextMenu/);
  assert.match(view, /@keydown=\$\{\(event: KeyboardEvent\) => openMessageContextMenu/);
  assert.match(view, /chat-group-footer--persistent-identity/);
});
