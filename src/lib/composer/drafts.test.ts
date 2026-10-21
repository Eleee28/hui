import assert from "node:assert/strict";
import { test } from "vitest";

import { mayUseComposerDraftKey, mergeComposerDraft, NEW_SESSION_DRAFT_KEY, sessionDraftKey, sessionIdFromDraftKey } from "./drafts.ts";

test("draft keys isolate New Session and each registered session", () => {
  assert.equal(NEW_SESSION_DRAFT_KEY, "new-session");
  assert.equal(sessionDraftKey("abc"), "session:abc");
  assert.notEqual(sessionDraftKey("abc"), sessionDraftKey("def"));
});

test("only the app that renders it may use the launch draft key", () => {
  // A pane connects to `session:<id>`; every draft it reads or writes belongs
  // to that session, so the launch slot stays the shell's text alone.
  assert.equal(mayUseComposerDraftKey(false, NEW_SESSION_DRAFT_KEY), true);
  assert.equal(mayUseComposerDraftKey(false, sessionDraftKey("abc")), true);
  assert.equal(mayUseComposerDraftKey(true, NEW_SESSION_DRAFT_KEY), false);
  assert.equal(mayUseComposerDraftKey(true, sessionDraftKey("abc")), true);
});

test("only session draft keys project back to sidebar session ids", () => {
  assert.equal(sessionIdFromDraftKey("session:abc-123"), "abc-123");
  assert.equal(sessionIdFromDraftKey("session:"), undefined);
  assert.equal(sessionIdFromDraftKey(NEW_SESSION_DRAFT_KEY), undefined);
});

test("a rejected payload is restored ahead of newer per-session work", () => {
  const sent = { kind: "image" as const, name: "sent.png", mimeType: "image/png", dataBase64: "YQ==" };
  const current = { kind: "file" as const, name: "next.txt", mimeType: "text/plain", dataBase64: "Yg==" };
  assert.deepEqual(
    mergeComposerDraft({ text: "new work", attachments: [current] }, { text: "failed send", attachments: [sent] }),
    { text: "failed send\n\nnew work", attachments: [sent, current] },
  );
});
