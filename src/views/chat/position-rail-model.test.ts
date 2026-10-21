import assert from "node:assert/strict";
import { test } from "vitest";
import { conversationFocusIndex, conversationMarkers, conversationPosition } from "./position-rail-model.ts";
import { projectChatTranscript } from "./projection.ts";
import type { TranscriptItem } from "../../api/sessions.ts";

test("indexes every prompt and assistant message but not the folded activity between them", () => {
  const transcript: TranscriptItem[] = [
    { kind: "message", id: "u1", role: "user", text: "First prompt" },
    { kind: "message", id: "u2", role: "user", text: "Second prompt" },
    { kind: "message", id: "intermediate", role: "assistant", text: "Checking" },
    { kind: "thinking", id: "thought", text: "Private reasoning" },
    { kind: "tool", id: "tool", name: "read", status: "succeeded" },
    { kind: "message", id: "final", role: "assistant", text: "Final answer" },
  ];
  const markers = conversationMarkers(projectChatTranscript(transcript));
  assert.deepEqual(markers.map((m) => m.id), ["u1", "u2", "intermediate", "final"]);
  assert.deepEqual(markers.map((m) => m.label), ["User message", "User message", "Assistant message", "Assistant message"]);
});

test("a message HUI delivered from someone else is labeled by its sender and previewed without its header", () => {
  const markers = conversationMarkers(projectChatTranscript([
    { kind: "message", id: "g", role: "user", text: "[from @grace · hop 2] Keep the retry limit?" },
    { kind: "message", id: "s", role: "user", text: "[Inter-session message from Build (s-1)]\nDone." },
    { kind: "message", id: "r", role: "user", text: "[routine: Digest] Summarize." },
  ]));
  assert.deepEqual(markers.map((m) => [m.label, m.preview]), [["From @grace", "Keep the retry limit?"], ["From Build", "Done."], ["From Digest", "Summarize."]]);
});

test("previews preserve attachment-only prompts, whitespace and Unicode without splitting code points", () => {
  const markers = conversationMarkers(projectChatTranscript([
    { kind: "message", id: "file", role: "user", text: "", attachments: ["Screenshot.png"] },
    { kind: "message", id: "empty", role: "user", text: "" },
    { kind: "message", id: "words", role: "user", text: "  one\n\n two\tthree  " },
    { kind: "message", id: "emoji", role: "user", text: "a".repeat(139) + "🌴last" },
  ]));
  assert.deepEqual(markers.map((m) => m.preview), ["Screenshot.png", "Empty message", "one two three", "a".repeat(139) + "🌴…"]);
});

test("long conversations retain every marker in order rather than sampling prompts", () => {
  const messages: TranscriptItem[] = Array.from({ length: 1200 }, (_, i) => ({ kind: "message", id: String(i), role: i % 2 ? "assistant" : "user", text: `Message ${i}` }));
  assert.deepEqual(conversationMarkers(projectChatTranscript(messages)).map((m) => m.id), messages.map((m) => m.id));
  assert.deepEqual(conversationMarkers([]), []);
});

test("position follows visible geometry, handles activity gaps and selects the final message at the bottom", () => {
  const positions = [{ id: "u", top: 20, bottom: 60 }, { id: "a", top: 100, bottom: 800 }, { id: "u2", top: 1500, bottom: 1540 }];
  assert.deepEqual(conversationPosition(positions, 0, 200, 1600), { activeId: "a", visibleIds: new Set(["u", "a"]) });
  assert.deepEqual(conversationPosition(positions, 800, 200, 1600), { activeId: "a", visibleIds: new Set() });
  assert.deepEqual(conversationPosition(positions, 1399, 200, 1600), { activeId: "u2", visibleIds: new Set(["u2"]) });
  assert.deepEqual(conversationPosition([], 0, 200, 200), { activeId: undefined, visibleIds: new Set() });
});

test("keyboard navigation clamps to the rail and leaves unrelated keys to native buttons", () => {
  assert.equal(conversationFocusIndex("Home", 10, 100), 0);
  assert.equal(conversationFocusIndex("End", 10, 100), 99);
  assert.equal(conversationFocusIndex("ArrowUp", 0, 100), 0);
  assert.equal(conversationFocusIndex("ArrowLeft", 10, 100), 9);
  assert.equal(conversationFocusIndex("ArrowDown", 99, 100), 99);
  assert.equal(conversationFocusIndex("ArrowRight", 10, 100), 11);
  for (const key of ["Tab", "Escape", "Enter", " ", "x"]) assert.equal(conversationFocusIndex(key, 0, 100), undefined);
  assert.equal(conversationFocusIndex("End", 0, 0), undefined);
});
