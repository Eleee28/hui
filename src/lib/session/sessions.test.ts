import assert from "node:assert/strict";
import { test } from "vitest";
import { transcriptAsMarkdown, unreachableHost } from "./sessions.ts";

test("conversation Markdown preserves visible message, thinking, tool and error rows", () => {
  assert.equal(transcriptAsMarkdown([
    { kind: "message", id: "u", role: "user", text: "Hello" },
    { kind: "thinking", id: "t", text: "Consider it" },
    { kind: "tool", id: "tool", name: "read", output: "done" },
    { kind: "error", id: "e", text: "Nope" },
  ]), "## User\n\nHello\n\n### Thinking\n\nConsider it\n\n### Tool: read\n\n```\ndone\n```\n\n### Error\n\nNope");
});

test("a session on a machine HUI cannot reach reads as reconnecting or disconnected, by that machine's name", () => {
  const worker = { id: "w", name: "devbox" };
  assert.deepEqual(unreachableHost({ status: "reconnecting", worker }), {
    status: "Reconnecting to devbox…",
    notice: "Connection to devbox lost — the session keeps running there. HUI reconnects automatically.",
  });
  assert.deepEqual(unreachableHost({ status: "disconnected", worker }), {
    status: "Disconnected from devbox",
    notice: "Disconnected from devbox. The session may still be running there.",
  });
  for (const status of ["idle", "running", "waiting", "starting", "error"] as const) {
    assert.equal(unreachableHost({ status, worker }), undefined, status);
  }
});
