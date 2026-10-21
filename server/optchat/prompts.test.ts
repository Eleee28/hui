import assert from "node:assert/strict";
import { test } from "vitest";
import { compactPrompt, compressStep, masterPrompt, mergeStep, ruler, sizeFeedback, viewDoc } from "./prompts.ts";

test("the size reference is a ruler of dashes as many bytes long as the limit, with nothing in it to copy", () => {
  assert.equal(Buffer.byteLength(ruler(512), "utf8"), 512);
  assert.match(ruler(512), /^-+$/u);
  const step = compressStep(512, "user", "hello");
  assert.equal(step.split("\n")[1], ruler(512), "on a line of its own, under the sentence that gives its size");
  assert(step.startsWith("For scale, the line of dashes below is exactly 512 bytes:\n"));
});

test("the prompts are the spec's, for the agent's name, and name no user", () => {
  const compact = compactPrompt("Grok");
  assert(compact.startsWith("You write the memory of Grok, an AI agent that works for one user in one\nendless chat"));
  assert(compact.endsWith("Output only the line; non-ASCII characters cost 2-4 bytes."));
  assert(!compact.includes("OptChat"));
  assert.equal(compact.split("Grok").length - 1, 11, "every mention renamed");
  assert(masterPrompt("Grok").startsWith("You are Grok, an AI agent that works for one user in a single chat that\nnever ends."));
  const doc = viewDoc("Grok");
  assert(doc.includes("before\nyou act, guess or ask. date(id) gives the date and time of message id."), "zoom before you act, guess or ask");
  assert(doc.includes("A message not summarized yet shows as \"(not summarized yet: zoom it)\"."));
  assert(!masterPrompt("Grok").includes("OptChat") && !doc.includes("OptChat"));
  assert.equal(compactPrompt("A$&B").split("A$&B").length - 1, 11, "a name is literal text, never a replacement pattern");
});

test("compactor steps say what to do with the message or the two lines, under the ruler", () => {
  assert.equal(compressStep(4, "user", "line one\nline two"),
    "For scale, the line of dashes below is exactly 4 bytes:\n----\n\nCompress this message into one line, in at most 4 bytes:\nuser: line one\nline two");
  assert.equal(mergeStep(8, "user: a\nb", "talk: c"),
    "For scale, the line of dashes below is exactly 8 bytes:\n--------\n\nMerge these two lines into one, in at most 8 bytes:\nuser: a b\ntalk: c");
  assert.equal(sizeFeedback(600, 512, "cut"), "That line is 600 bytes; the limit is 512. It must end where it is cut here:\ncut| ← LIMIT");
});
