import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";
import type { TranscriptEntry } from "../runtimes/types.ts";
import { interruptedRunOriginal, interruptedRunPrompt, INTERRUPTED_RUN_PROMPT } from "./interrupted-run.ts";
import { operatorText, sessionDigest } from "./digest.ts";
import { CONTINUE_PROMPT, SUBAGENT_COMPLETION_MARKER } from "../agent-tools/subagent-completion.ts";
import { CONTINUE_AFTER_ERROR_PROMPT } from "./digest.ts";

const user = (text: string): TranscriptEntry => ({ kind: "message", role: "user", text });
const assistant = (text: string): TranscriptEntry => ({ kind: "message", role: "assistant", text });

test("interrupted-run prompts round-trip to the operator's request", () => {
  assert.equal(interruptedRunOriginal(interruptedRunPrompt("Add retries")), "Add retries");
  assert.equal(interruptedRunPrompt(""), INTERRUPTED_RUN_PROMPT);
  assert.equal(interruptedRunOriginal(INTERRUPTED_RUN_PROMPT), "");
  assert.equal(interruptedRunOriginal("Add retries"), undefined);
});

test("HUI control prompts are not operator intent", () => {
  assert.equal(operatorText(CONTINUE_PROMPT), undefined);
  assert.equal(operatorText(CONTINUE_AFTER_ERROR_PROMPT), undefined);
  assert.equal(operatorText(SUBAGENT_COMPLETION_MARKER + "\nchild finished"), undefined);
  assert.equal(operatorText(interruptedRunPrompt(CONTINUE_PROMPT)), undefined);
  assert.equal(operatorText(interruptedRunPrompt("Add retries")), "Add retries");
  assert.equal(operatorText("  Add retries  "), "Add retries");
});

test("the digest keeps the goal of a long session that a tail slice would drop", () => {
  const goal = "Add exponential backoff retries to webhook delivery with a dead-letter table.";
  const entries: TranscriptEntry[] = [user(goal)];
  for (let index = 0; index < 60; index += 1) entries.push(assistant("Lint fix " + index + ": " + "x".repeat(400)));
  entries.push(user("thanks, lint is green now"));
  const digest = sessionDigest(entries);
  assert.equal(digest.goal, goal);
  assert.ok(digest.text.startsWith("## Session goal"));
  assert.ok(digest.text.includes(goal));
  assert.ok(digest.text.includes("thanks, lint is green now"), "recent conversation stays");
  assert.ok(digest.text.length < 14_000, "the digest is bounded");
});

test("the digest lists follow-ups, changed files and recent turns without control prompts", () => {
  const goal = "Export invoices as CSV and JSON.";
  const digest = sessionDigest([
    user(goal),
    { kind: "tool", id: "1", name: "write", args: { path: "server/export.ts" }, output: "ok" },
    { kind: "tool", id: "2", name: "edit", args: { path: "failed.ts" }, output: "no", failed: true },
    { kind: "tool", id: "3", name: "read", args: { path: "read-only.ts" }, output: "…" },
    assistant("Both formats work."),
    { kind: "error", message: "Connection lost." },
    user(interruptedRunPrompt(goal)),
    user(CONTINUE_PROMPT),
    user("Drop JSON, only CSV, and it must stream."),
    { kind: "tool", id: "4", name: "edit", args: { path: "server/export.ts" }, output: "ok" },
    assistant("Streaming CSV only now."),
  ]);
  assert.equal(digest.goal, goal);
  assert.match(digest.text, /## Later user messages[^]*- Drop JSON, only CSV, and it must stream\./u);
  assert.match(digest.text, /## Files the agent changed\n\nserver\/export\.ts\n\n## Most recent/u);
  assert.doesNotMatch(digest.text, /failed\.ts|read-only\.ts/u);
  assert.doesNotMatch(digest.text, /Continue from where|previous run was interrupted/u);
  assert.equal(digest.text.split(goal).length - 1, 1, "a resumed run's repeated goal appears once");
  assert.match(digest.text, /## Most recent conversation[^]*error: Connection lost\.[^]*assistant: Streaming CSV only now\.$/u);
});

test("an empty session has no goal", () => {
  const digest = sessionDigest([]);
  assert.equal(digest.goal, "");
  assert.match(digest.text, /No request yet/u);
});

test("continuing after an error preserves the control prompt", () => {
  const fixture: { continuePrompt: string } = JSON.parse(readFileSync(new URL("./digest.fixture.json", import.meta.url), "utf8"));
  assert.equal(CONTINUE_AFTER_ERROR_PROMPT, fixture.continuePrompt);
});
