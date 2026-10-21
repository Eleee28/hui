import assert from "node:assert/strict";
import { test } from "vitest";
import { forkPoint } from "./fork-point.ts";

const prompt = { kind: "message", role: "user", text: "Plan it", entryId: "e1" };
const asks = { kind: "message", role: "assistant", text: "Reading the code first.", entryId: "e2" };
const call = { kind: "tool", id: "t1", name: "read" };
const thinking = { kind: "thinking", text: "…" };
const answer = { kind: "message", role: "assistant", text: "Here is the plan.", entryId: "e4" };

test("a finished reply is a fork point; one followed by its tool calls is not", () => {
  const transcript = [prompt, asks, call, thinking, answer];
  assert.equal(forkPoint(transcript, answer), "e4");
  assert.equal(forkPoint(transcript, asks), undefined);
});

test("a reply followed by the next prompt is a fork point, and thinking in between does not matter", () => {
  const next = { kind: "message", role: "user", text: "Go on", entryId: "e5" };
  assert.equal(forkPoint([prompt, answer, thinking, next], answer), "e4");
});

test("prompts, replies without an entry yet and items outside the transcript are never fork points", () => {
  const streaming = { kind: "message", role: "assistant", text: "Here is" };
  assert.equal(forkPoint([prompt, answer], prompt), undefined);
  assert.equal(forkPoint([prompt, streaming], streaming), undefined);
  assert.equal(forkPoint([prompt], answer), undefined);
  assert.equal(forkPoint([prompt], undefined), undefined);
});
