import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canSubmitComposer,
  composerEnterMode,
  composerPlaceholder,
  questionAnswer,
  restoreRejectedSubmission,
  streamingAfterSubmission,
} from "./state.ts";

test("Enter steers, modifier Enter queues and Shift Enter keeps a newline", () => {
  assert.equal(composerEnterMode({ streaming: true, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false }), "steer");
  assert.equal(composerEnterMode({ streaming: true, shiftKey: false, ctrlKey: true, metaKey: false, isComposing: false }), "followUp");
  assert.equal(composerEnterMode({ streaming: true, shiftKey: false, ctrlKey: false, metaKey: true, isComposing: false }), "followUp");
  assert.equal(composerEnterMode({ streaming: true, shiftKey: true, ctrlKey: false, metaKey: false, isComposing: false }), "newline");
  assert.equal(composerEnterMode({ streaming: false, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false }), "prompt");
  assert.equal(composerEnterMode({ streaming: true, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: true }), undefined);
});

test("plain Enter inserts a newline on touch devices while hardware modifiers still work", () => {
  assert.equal(composerEnterMode({ streaming: false, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, coarsePointer: true }), "newline");
  assert.equal(composerEnterMode({ streaming: true, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, coarsePointer: true }), "newline");
  assert.equal(composerEnterMode({ streaming: true, shiftKey: false, ctrlKey: true, metaKey: false, isComposing: false, coarsePointer: true }), "followUp");
});

test("modifier Enter preference keeps plain Enter as a newline", () => {
  assert.equal(composerEnterMode({ streaming: false, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, sendShortcut: "modifierEnter" }), "newline");
  assert.equal(composerEnterMode({ streaming: false, shiftKey: false, ctrlKey: true, metaKey: false, isComposing: false, sendShortcut: "modifierEnter" }), "prompt");
});

test("a busy composer names the steer and queue shortcuts for its platform", () => {
  const busy = { reconnecting: false, streaming: true, coarsePointer: false, applePlatform: true } as const;
  assert.equal(composerPlaceholder(busy), "↵ adds to this run · ⌘↵ queues for later");
  assert.equal(composerPlaceholder({ ...busy, applePlatform: false }), "↵ adds to this run · Ctrl+↵ queues for later");
  assert.equal(composerPlaceholder({ ...busy, applePlatform: false, sendShortcut: "modifierEnter" }), "Send adds to this run · Ctrl+↵ queues for later");
  assert.equal(composerPlaceholder({ ...busy, coarsePointer: true }), "Add to this run…");
  assert.equal(composerPlaceholder({ ...busy, streaming: false }), "Send a message…");
  assert.equal(composerPlaceholder({ ...busy, reconnecting: true }), "Draft while HUI reconnects…");
  assert.equal(composerPlaceholder({ ...busy, status: "disconnected", reconnecting: true }), "Draft while disconnected…");
});

test("composer preserves work while disconnected or sending", () => {
  assert.equal(canSubmitComposer({ draft: "hello", hasImage: false, opening: false, sending: false, connection: "live" }), true);
  assert.equal(canSubmitComposer({ draft: "hello", hasImage: false, opening: false, sending: false, connection: "reconnecting" }), false);
  assert.equal(canSubmitComposer({ draft: "hello", hasImage: false, opening: false, sending: true, connection: "live" }), false);
});

test("a late prompt acknowledgement cannot re-lock an already settled turn", () => {
  assert.equal(streamingAfterSubmission(false, "prompt", "started", "idle"), true);
  assert.equal(streamingAfterSubmission(false, "prompt", "accepted", "idle"), false);
  assert.equal(streamingAfterSubmission(true, "prompt", "accepted", "running"), true);
  assert.equal(streamingAfterSubmission(true, "prompt", "rejected", "idle"), false);
  // A resend the gateway recognised started nothing: the session's own status decides, as for a rejection.
  assert.equal(streamingAfterSubmission(true, "prompt", "duplicate", "idle"), false);
  assert.equal(streamingAfterSubmission(true, "prompt", "duplicate", "running"), true);
  assert.equal(streamingAfterSubmission(true, "prompt", "rejected", "waiting"), true);
  assert.equal(streamingAfterSubmission(true, "followUp", "accepted", "running"), true);
});

test("question answers preserve confirm semantics", () => {
  assert.deepEqual(questionAnswer({ id: "q", method: "confirm" }, "true"), { confirmed: true });
  assert.deepEqual(questionAnswer({ id: "q", method: "input" }, "value"), { value: "value" });
});

test("a rejected deferred send recovers its payload without overwriting newer work", () => {
  const sent = [{ kind: "file" as const, name: "sent.txt", mimeType: "text/plain", dataBase64: "YQ==" }];
  const next = [{ kind: "image" as const, name: "next.png", mimeType: "image/png", dataBase64: "Yg==" }];

  assert.deepEqual(restoreRejectedSubmission("next draft", next, "sent draft", sent), {
    draft: "sent draft\n\nnext draft",
    attachments: [...sent, ...next],
  });
  assert.deepEqual(restoreRejectedSubmission("", [], "sent draft", sent), {
    draft: "sent draft",
    attachments: sent,
  });
});
