import assert from "node:assert/strict";
import { test } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { CONTEXT_EDIT_KIND, planPiImport, type PiImportDraft } from "./pi-import.ts";
import { SUMMARY_PREFIX, SUMMARY_SUFFIX } from "./durable.ts";

const TIME = "2026-10-01T10:00:00.000Z";
type Raw = Record<string, unknown> & { type: string; id?: string; parentId?: string | null };

/** A PI session file: each entry's parent is the one before it unless it names its own. */
function session(entries: Raw[], header: Record<string, unknown> = { version: 3 }): string {
  let previous: string | null = null;
  const lines = [{ type: "session", id: "session-1", timestamp: TIME, cwd: "/work", ...header }];
  for (const [index, entry] of entries.entries()) {
    const id = entry.id ?? `e${index + 1}`;
    lines.push({ timestamp: TIME, ...entry, id, parentId: entry.parentId === undefined ? previous : entry.parentId } as never);
    previous = id;
  }
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

const usage = (input: number, total = 0.5) => ({
  input, output: 2, cacheRead: 1, cacheWrite: 3, totalTokens: input + 6,
  cost: { input: total / 2, output: total / 4, cacheRead: total / 8, cacheWrite: total / 8, total },
});
const user = (text: string, extra: Partial<Raw> = {}): Raw => ({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 }, ...extra });
const assistant = (text: string, model = "m1", extra: Partial<Raw> = {}): Raw => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "p", model, usage: usage(10), stopReason: "stop", timestamp: 2 },
  ...extra,
});
const texts = (draft: PiImportDraft) => (draft.model ?? []).map((message) => JSON.stringify(message.content));
const outline = (drafts: PiImportDraft[]) => drafts.map((draft) => `${draft.kind}:${texts(draft).join("|").slice(0, 40)}`);

test("the active branch becomes Durable entries in order; abandoned branches and PI-only entries stay behind", () => {
  const plan = planPiImport(session([
    user("ONE"),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }], api: "anthropic-messages", provider: "p", model: "m1", usage: usage(5), stopReason: "toolUse", timestamp: 2 } },
    { type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 3 } },
    { type: "message", message: { role: "system", content: "prompt", timestamp: 3 } },
    { type: "model_change", provider: "p", modelId: "m2" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    assistant("answer one", "m2", { id: "e7" }),
    user("ABANDONED", { id: "x1", parentId: "e7" }),
    assistant("abandoned answer", "m2", { id: "x2" }),
    { type: "session_info", name: "Renamed", id: "e10", parentId: "e7" },
    { type: "custom", customType: "state", data: { a: 1 } },
    { type: "label", targetId: "e7", label: "mark" },
    user("TWO"),
    assistant("answer two", "m2"),
  ]));
  assert.deepEqual(plan.drafts.map((draft) => draft.kind), ["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant", "pi.user", "pi.assistant"]);
  assert.match(texts(plan.drafts[0]!)[0]!, /ONE/u);
  assert.deepEqual(plan.drafts[2]!.data, { diagnostics: [] });
  assert.match(texts(plan.drafts[4]!)[0]!, /TWO/u, "the session continues after the rewind point, not on the abandoned branch");
  assert.equal(outline(plan.drafts).some((line) => line.includes("ABANDONED")), false);
  assert.deepEqual({ messages: plan.messages, summaries: plan.summaries, abandoned: plan.abandoned }, { messages: 6, summaries: 0, abandoned: 2 });
  assert.deepEqual(plan.model, { provider: "p", modelId: "m2" });
  assert.equal(plan.thinkingLevel, "high");
  // Spend counts every record, the abandoned answer included, by the model that produced it.
  assert.deepEqual(Object.keys(plan.usage).toSorted(), ["p/m1", "p/m2"]);
  assert.equal(plan.usage["p/m1"]!.input, 5);
  assert.equal(plan.usage["p/m2"]!.input, 30);
  assert.equal(plan.usage["p/m2"]!.totalTokens, 48);
  assert.equal(plan.usage["p/m2"]!.cost.total, 1.5);
  assert.equal(plan.usage["p/m2"]!.cost.input, 0.75);
});

test("a compaction becomes Durable's summary entry headed at PI's first kept entry", () => {
  const plan = planPiImport(session([
    user("A"), assistant("a"),
    { type: "model_change", provider: "p", modelId: "m1", id: "switch" },
    user("B", { id: "b" }), assistant("b"),
    { type: "compaction", summary: "SUM", firstKeptEntryId: "switch", tokensBefore: 900, usage: usage(7) },
    user("C"), assistant("c"),
  ]));
  assert.deepEqual(plan.drafts.map((draft) => draft.kind), ["pi.user", "pi.assistant", "pi.user", "pi.assistant", "pi.compaction", "pi.user", "pi.assistant"]);
  const summary = plan.drafts[4]!;
  assert.equal(summary.head, 2, "a first kept entry with no model messages starts at the next one");
  assert.deepEqual(summary.model, [{ role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}SUM${SUMMARY_SUFFIX}` }], timestamp: Date.parse(TIME) }]);
  assert.deepEqual(summary.data, { reason: "threshold" });
  assert.equal(plan.summaries, 1);
  // The summary's own spend records no model; it counts toward the one in use: three answers and the summary.
  assert.equal(plan.usage["p/m1"]!.input, 3 * 10 + 7);

  const alone = planPiImport(session([user("A"), assistant("a"), { type: "compaction", summary: "ALL", firstKeptEntryId: "gone", tokensBefore: 1 }, user("C")]));
  assert.equal(alone.drafts[2]!.head, "self", "without a kept entry the summary starts the context alone");
});

test("PI's own message kinds reach the model as user messages, and context edits become Durable edits", () => {
  const bash = { role: "bashExecution", command: "ls", output: "listing", exitCode: 0, cancelled: false, truncated: false, timestamp: 4 };
  const plan = planPiImport(session([
    user("A"), assistant("original", "m1", { id: "target" }),
    { type: "custom_message", customType: "note", content: "NOTE text", display: false },
    { type: "branch_summary", fromId: "target", summary: "BRANCH work" },
    { type: "message", message: bash },
    { type: "context_edit", targetId: "target", replacement: { content: "EDITED" } },
    { type: "context_edit", targetId: "e1", replacement: null },
  ]));
  assert.deepEqual(plan.drafts.map((draft) => draft.kind), ["pi.user", "pi.assistant", "pi.user", "pi.user", "pi.user", CONTEXT_EDIT_KIND, CONTEXT_EDIT_KIND]);
  for (const [index, source] of [[2, { role: "custom", customType: "note", content: "NOTE text", display: false, timestamp: Date.parse(TIME) }], [4, bash]] as const) {
    assert.deepEqual(plan.drafts[index]!.model, convertToLlm([source as never]), "converted as PI sends it");
  }
  assert.match(texts(plan.drafts[3]!)[0]!, /BRANCH work/u);
  assert.equal(plan.messages, 5);
  assert.deepEqual(plan.drafts[5]!.edits, [{ target: 1, action: "replace", messages: [{ ...plan.drafts[1]!.model![0]!, content: [{ type: "text", text: "EDITED" }] }] }]);
  assert.deepEqual(plan.drafts[6]!.edits, [{ target: 0, action: "omit" }]);
  assert.equal(plan.drafts[5]!.model, undefined, "an edit contributes no messages of its own");
});

test("an older PI file is upgraded in memory, and a file that is not a PI session is refused", () => {
  const legacy = [
    { type: "session", id: "old", timestamp: TIME, cwd: "/work" },
    { type: "message", timestamp: TIME, message: { role: "user", content: [{ type: "text", text: "LEGACY" }], timestamp: 1 } },
    { type: "message", timestamp: TIME, message: { role: "assistant", content: [{ type: "text", text: "reply" }], api: "anthropic-messages", provider: "p", model: "m1", usage: usage(1), stopReason: "stop", timestamp: 2 } },
  ].map((line) => JSON.stringify(line)).join("\n");
  const plan = planPiImport(legacy);
  assert.deepEqual(plan.drafts.map((draft) => draft.kind), ["pi.user", "pi.assistant"]);
  assert.match(texts(plan.drafts[0]!)[0]!, /LEGACY/u);
  assert.throws(() => planPiImport('{"type":"message"}\n'), /not a PI session file/u);
  assert.throws(() => planPiImport(""), /not a PI session file/u);
});
