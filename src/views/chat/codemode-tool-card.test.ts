import assert from "node:assert/strict";
import { test } from "vitest";
import { codemodeSummary, codemodeToolPresentation, formatCallDuration } from "./codemode-tool-card.ts";

const code = 'await tools.read({ path: "a.ts" });';
const read = (status: string, extra: Record<string, unknown> = {}) => ({ name: "read", args: '{"path":"a.ts"}', status, ...extra });
const tool = (overrides: Record<string, unknown>) =>
  ({ kind: "tool" as const, id: "call-1", name: "codemode", args: { code }, ...overrides });

test("a codemode row names the tools its script called and says how it ended", () => {
  const cases = [
    {
      name: "running, from the gateway's live calls",
      item: tool({ status: "running", details: { calls: [read("ok"), read("running"), { name: "bash", args: "{}", status: "running" }] } }),
      view: { state: "running", tools: "read ×2, bash", failedCalls: 0, output: "", summary: "read ×2, bash…" },
    },
    {
      name: "completed with one failed call",
      item: tool({
        status: "succeeded",
        output: "Script completed\nWall time 6.2 seconds\nOutput:\nread 1 file\n",
        details: { calls: [read("ok", { durationMs: 12 }), read("error", { error: "ENOENT" })] },
      }),
      view: { state: "completed", tools: "read ×2", failedCalls: 1, output: "read 1 file", wallSeconds: "6.2", summary: "read ×2" },
    },
    {
      name: "a failed script, even when the tool row was not marked failed",
      item: tool({ status: "succeeded", output: "Script failed\nWall time 0.4 seconds\nOutput:\nScript error:\nTypeError: x", details: { calls: [] } }),
      view: { state: "failed", tools: "", failedCalls: 0, output: "Script error:\nTypeError: x", wallSeconds: "0.4", summary: "no tool calls" },
    },
  ];
  for (const { name, item, view } of cases) {
    const presented = codemodeToolPresentation(item);
    assert(presented, name);
    const { summary, ...expected } = view;
    assert.deepEqual({ state: presented.state, tools: presented.tools, failedCalls: presented.failedCalls, output: presented.output,
      ...(presented.wallSeconds ? { wallSeconds: presented.wallSeconds } : {}) }, expected, name);
    assert.equal(codemodeSummary(presented), summary, name);
  }
});

test("only a codemode call with a script gets the card; unreadable calls are left out", () => {
  assert.equal(codemodeToolPresentation(tool({ name: "bash", args: { command: "ls" } })), null);
  assert.equal(codemodeToolPresentation(tool({ args: {} })), null);
  const many = ["read", "grep", "find", "ls", "bash", "edit"].map((name) => ({ name, args: "{}", status: "ok" }));
  const view = codemodeToolPresentation(tool({ status: "succeeded", details: { calls: [...many, { status: "ok" }, "junk"], fullOutputPath: "/tmp/out.txt" } }));
  assert.equal(view?.calls.length, 6, "rows without a name or status are dropped");
  assert.equal(view?.tools, "read, grep, find, ls +2 more");
  assert.equal(view?.fullOutputPath, "/tmp/out.txt");
});

test("a call's duration stays short: milliseconds, then seconds with one decimal, then minutes", () => {
  assert.deepEqual([12, 999, 4_100, 65_000].map(formatCallDuration), ["12ms", "999ms", "4.1s", "1m 5s"]);
});
