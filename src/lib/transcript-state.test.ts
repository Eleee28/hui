import assert from "node:assert/strict";
import { test } from "vitest";
import { appendPendingUser, keepSentPreviews, normalizeTranscript, reduceTranscript, settlePendingUser } from "./transcript-state.ts";

test("a snapshot of the prompt this screen just sent keeps its image previews until PI's history has them", () => {
  const sent = appendPendingUser([], "local", "look", [{ name: "a.png", kind: "image", url: "blob:a" }]);
  const gateway = normalizeTranscript([{ kind: "message", role: "user", text: "look", attachments: [{ name: "a.png", kind: "image" }] }]);
  const kept = keepSentPreviews(gateway, sent)[0];
  assert.deepEqual(kept?.kind === "message" && kept.attachments, [{ name: "a.png", kind: "image", url: "blob:a" }]);
  const history = normalizeTranscript([{ kind: "message", role: "user", text: "look", attachments: [{ name: "a.png", kind: "image", url: "/__hui/a" }] }]);
  assert.equal(keepSentPreviews(history, sent), history, "history's own preview wins");
  const other = normalizeTranscript([{ kind: "message", role: "user", text: "other", attachments: [{ name: "a.png", kind: "image" }] }]);
  assert.equal(keepSentPreviews(other, sent), other, "another prompt keeps its own attachments");
});

test("tool calls correlate by id even when names match and output is empty", () => {
  let items = reduceTranscript([], { type: "tool_start", id: "a", name: "bash", args: { command: "a" } });
  items = reduceTranscript(items, { type: "tool_start", id: "b", name: "bash", args: { command: "b" } });
  items = reduceTranscript(items, { type: "tool_end", id: "a", name: "bash", output: "" });
  assert.equal(items[0]?.kind === "tool" && items[0].status, "succeeded");
  assert.equal(items[1]?.kind === "tool" && items[1].status, "running");
});

test("tool progress replaces accumulated output and a failure keeps its args", () => {
  let items = reduceTranscript([], { type: "tool_start", id: "x", name: "read", args: { path: "a" } });
  items = reduceTranscript(items, { type: "tool_update", id: "x", output: "partial" });
  items = reduceTranscript(items, { type: "tool_end", id: "x", name: "read", output: "denied", failed: true });
  assert.deepEqual(items[0], {
    kind: "tool", id: "x", name: "read", args: { path: "a" }, output: "denied", failed: true, status: "failed",
  });
});

test("tool result details survive live reduction and durable normalization", () => {
  const details = { media: [{ name: "demo.mp4" }] };
  let items = reduceTranscript([], { type: "tool_start", id: "media", name: "present_media", args: { paths: ["demo.mp4"] } });
  items = reduceTranscript(items, { type: "tool_end", id: "media", name: "present_media", output: "Presented", details });
  assert.equal(items[0]?.kind === "tool" && items[0].details, details);
  const normalized = normalizeTranscript(items);
  assert.equal(normalized[0]?.kind === "tool" && normalized[0].details, details);
});

test("streamed text and thinking remain separate ordered blocks", () => {
  let items = reduceTranscript([], { type: "thinking", id: "t", delta: "plan" });
  items = reduceTranscript(items, { type: "text", id: "m", delta: "answer" });
  items = reduceTranscript(items, { type: "thinking", id: "t", delta: " more" });
  assert.deepEqual(items.map((item) => item.kind), ["thinking", "message"]);
  assert.equal(items[0]?.kind === "thinking" && items[0].text, "plan more");
});

test("id-less deltas continue the latest projected blocks after reconnect", () => {
  let items = normalizeTranscript([
    { kind: "message", role: "user", text: "question" },
    { kind: "thinking", text: "plan" },
    { kind: "message", role: "assistant", text: "prefix" },
  ], { streaming: true });

  const projectedIds = items.map((item) => item.id);
  assert.deepEqual(projectedIds, ["history-0", "streaming-thinking", "streaming-assistant"]);
  items = reduceTranscript(items, { type: "thinking", delta: " more" });
  items = reduceTranscript(items, { type: "text", delta: " suffix" });

  assert.deepEqual(items.map((item) => item.id), projectedIds);
  assert.equal(items[1]?.kind === "thinking" && items[1].text, "plan more");
  assert.equal(
    items[2]?.kind === "message" && items[2].role === "assistant" && items[2].text,
    "prefix suffix",
  );
});

test("a settled projection does not absorb the next turn's id-less delta", () => {
  const settled = normalizeTranscript([
    { kind: "message", role: "user", text: "first question" },
    { kind: "message", role: "assistant", text: "first answer" },
  ]);

  const next = reduceTranscript(settled, { type: "text", delta: "second answer" });

  assert.deepEqual(
    next.flatMap((item) =>
      item.kind === "message" && item.role === "assistant" ? [item.text] : [],
    ),
    ["first answer", "second answer"],
  );
});

test("reused tool call ids preserve history and update the latest call", () => {
  let items = normalizeTranscript([
    { kind: "tool", id: "call-1", name: "read", output: "old output" },
  ]);

  items = reduceTranscript(items, {
    type: "tool_start",
    id: "call-1",
    name: "read",
    args: { path: "new.txt" },
  });
  items = reduceTranscript(items, {
    type: "tool_update",
    id: "call-1",
    output: "partial",
  });
  items = reduceTranscript(items, {
    type: "tool_end",
    id: "call-1",
    name: "read",
    output: "new output",
  });

  assert.deepEqual(items, [
    {
      kind: "tool",
      id: "call-1",
      name: "read",
      output: "old output",
      failed: false,
      status: "succeeded",
    },
    {
      kind: "tool",
      id: "call-1",
      name: "read",
      args: { path: "new.txt" },
      output: "new output",
      failed: false,
      status: "succeeded",
    },
  ]);
});

test("pending user messages become accepted or retryable failures", () => {
  const pending = appendPendingUser([], "local", "hello", ["shot.png"]);
  assert.equal(pending[0]?.kind === "message" && pending[0].pending, true);
  const failed = settlePendingUser(pending, "local", false);
  assert.equal(failed[0]?.kind === "message" && failed[0].failed, true);
});

test("normalizer accepts legacy and discriminated durable transcripts", () => {
  const items = normalizeTranscript([
    { role: "assistant", text: "old", error: "bad" },
    { kind: "tool", id: "tool", name: "bash", output: "ok" },
  ]);
  assert.deepEqual(items.map((item) => item.kind), ["message", "error", "tool"]);
});

test("a call's record survives normalization as one call item; a malformed one is dropped", () => {
  const record = { call: "c1", bot: "Juno", startedAt: 1, endedAt: 61_000, summary: "**Discussed**: teal.", lines: [{ role: "user", text: "Hi", at: 2 }] };
  const items = normalizeTranscript([{ kind: "message", role: "user", text: "typed" }, { kind: "call", ...record }, { kind: "call", call: "broken" }] as never);
  assert.deepEqual(items.map((item) => item.kind), ["message", "call"]);
  const call = items[1] as { kind: "call"; summary?: string; lines: unknown[] };
  assert.equal(call.summary, "**Discussed**: teal.");
  assert.deepEqual(call.lines, record.lines);
});
