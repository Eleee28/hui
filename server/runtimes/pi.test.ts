import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, test } from "vitest";

import type { RuntimeEvent } from "./types.ts";

// HUI's provider selections resolve at import time and are read with each model list: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-pi-home-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
afterAll(() => rm(root, { recursive: true, force: true }));
const { branchHistory, imageFromMessages, PiSession, runtimeCommands, runtimeUsage, toRuntimeEvent, transcriptFrom } = await import("./pi.ts");
type PiSession = import("./pi.ts").PiSession;

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

function childWith(handle: (command: Record<string, unknown>, child: FakeChild) => void): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at === -1) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line) {
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command["type"] === "get_session_stats") {
          respond(child, command, { contextUsage: { tokens: null, contextWindow: 200_000, percent: null } });
        } else {
          handle(command, child);
        }
      }
    }
  });
  return child;
}

/** A `get_entries` reply holding one linear branch of `messages`, ids e0, e1, … */
function branch(messages: readonly unknown[]): { entries: unknown[]; leafId: string | null } {
  return {
    entries: messages.map((message, index) => ({ type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : null, message })),
    leafId: messages.length ? `e${messages.length - 1}` : null,
  };
}

function respond(child: FakeChild, command: Record<string, unknown>, data?: unknown): void {
  child.stdout.write(`${JSON.stringify({
    type: "response",
    id: command["id"],
    success: true,
    ...(data === undefined ? {} : { data }),
  })}\n`);
}

function nextEvent(session: PiSession, type: RuntimeEvent["type"]): Promise<RuntimeEvent> {
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === type) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

test("the shown history is the whole active branch with compactions in place and retried attempts hidden", () => {
  const message = (id: string, parentId: string | null, role: string, text: string) =>
    ({ type: "message", id, parentId, message: { role, content: [{ type: "text", text }] } });
  const history = branchHistory({
    leafId: "a3",
    entries: [
      message("u1", "missing-parent", "user", "first"),
      message("a1", "u1", "assistant", "summarized answer"),
      message("abandoned", "a1", "user", "abandoned branch"),
      message("u2", "a1", "user", "kept"),
      message("retried", "u2", "assistant", "failed attempt"),
      { type: "context_edit", id: "hide", parentId: "retried", targetId: "retried", replacement: null },
      { type: "compaction", id: "c", parentId: "hide", summary: "## Goal", tokensBefore: 120_000, firstKeptEntryId: "u2" },
      message("a2", "c", "assistant", "edited later"),
      { type: "context_edit", id: "hide-a2", parentId: "a2", targetId: "a2", replacement: null },
      { type: "context_edit", id: "restore-a2", parentId: "hide-a2", targetId: "a2", replacement: { content: "restored" } },
      message("a3", "restore-a2", "assistant", "after compaction"),
    ],
  });
  assert.deepEqual(transcriptFrom(history).map((entry) => entry.kind === "message" ? `${entry.entryId}:${entry.text}` : entry.kind), [
    "u1:first", "a1:summarized answer", "u2:kept", "compaction", "a2:edited later", "a3:after compaction",
  ]);
});

test("PI catalogs apply models.json to RPC results and preserve namespaced switch IDs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-pi-catalog-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {
    gateway: { models: [{ id: "anthropic/opus" }] },
  } }));
  const commands: Record<string, unknown>[] = [];
  const child = childWith((command, active) => {
    commands.push(command);
    respond(active, command, command["type"] === "get_available_models" ? { models: [
      { provider: "gateway", id: "anthropic/opus", name: "Opus", apiKey: "private-fixture" },
      { provider: "gateway", id: "other", name: "Hidden" },
      { provider: "unconfigured", id: "anthropic/opus", name: "Hidden provider" },
    ] } : undefined);
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams, dir);
  t.onTestFinished(() => session.dispose());
  assert.deepEqual(await session.listModels(), [{ provider: "gateway", id: "anthropic/opus", name: "Opus" }]);
  await session.setModel("gateway", "anthropic/opus");
  assert.equal(commands.at(-1)?.["modelId"], "anthropic/opus");
  assert.equal(session.currentModel()?.id, "anthropic/opus");
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {} }));
  assert.deepEqual(await session.listModels(), []);
  assert.equal(session.currentModel()?.id, "anthropic/opus", "listing must not switch an existing session");
});

test("pi's agent_end is the normalized settle signal", () => {
  assert.deepEqual(toRuntimeEvent({ type: "agent_end" }), { type: "settled" });
  assert.equal(toRuntimeEvent({ type: "agent_settled" }), undefined);
});

test("PI commands preserve invocation names and precedence, exposing only presentation fields", async (t) => {
  const raw = [
    { name: "review", source: "extension", path: "/private/source.ts", sourceInfo: { secret: "hidden" } },
    { name: "review", source: "prompt", description: "Shadowed" },
    { name: "skill:testing", source: "skill", description: "Test changes" },
    { name: "ext:tools:inspect", source: "extension", description: "Inspect" },
    { name: "outline", source: "prompt", description: 42 },
    { name: "/invalid", source: "extension" }, { name: "bad\nname", source: "skill" },
    { name: "", source: "skill" }, { name: "no-source" }, null,
  ];
  const commands = [
    { name: "review", description: "", source: "extension" },
    { name: "skill:testing", description: "Test changes", source: "skill" },
    { name: "ext:tools:inspect", description: "Inspect", source: "extension" },
    { name: "outline", description: "", source: "prompt" },
  ];
  assert.deepEqual(runtimeCommands(raw), commands);
  const child = childWith((command, active) => {
    assert.equal(command["type"], "get_commands");
    respond(active, command, { commands: raw });
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  assert.deepEqual(await session.listCommands(), commands);
});

test("PI clear opens a fresh native session and refreshes its identity and transcript", async (t) => {
  const commands: string[] = [];
  const child = childWith((command, active) => {
    commands.push(String(command["type"]));
    if (command["type"] === "new_session") {
      respond(active, command, { cancelled: false });
    } else if (command["type"] === "get_state") {
      respond(active, command, {
        sessionId: "pi-fresh",
        sessionFile: "/tmp/pi-fresh.jsonl",
        isStreaming: false,
        thinkingLevel: "high",
        model: { provider: "openai", id: "gpt", name: "GPT" },
      });
    } else if (command["type"] === "get_entries") {
      respond(active, command, branch([]));
    }
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());

  await session.clear();

  assert.deepEqual(commands, ["new_session", "get_state", "get_entries"]);
  assert.equal(session.sessionId, "pi-fresh");
  assert.equal(session.sessionFile, "/tmp/pi-fresh.jsonl");
  assert.deepEqual(session.transcript(), []);
  assert.equal(session.currentModel()?.id, "gpt");
  assert.equal(session.currentThinking(), "high");
});

test("disabled HUI skills are omitted from PI's live command catalog", async (t) => {
  const child = childWith((command, active) => respond(active, command, { commands: [
    { name: "skill:review", source: "skill", description: "Review" },
    { name: "skill:testing", source: "skill", description: "Test" },
    { name: "review", source: "extension", description: "Extension command" },
  ] }));
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams, undefined, ["review"]);
  t.onTestFinished(() => session.dispose());
  assert.deepEqual(await session.listCommands(), [
    { name: "skill:testing", source: "skill", description: "Test" },
    { name: "review", source: "extension", description: "Extension command" },
  ]);
});

test("command discovery reports malformed and failed RPC replies instead of an empty success", async (t) => {
  const child = childWith((command, active) => respond(active, command, {}));
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  await assert.rejects(() => session.listCommands(), /invalid command catalog/);
  const failed = childWith((command, active) => active.stdout.write(`${JSON.stringify({ type: "response", id: command["id"], success: false, error: "catalog failed" })}\n`));
  const failedSession = new PiSession(failed as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => failedSession.dispose());
  await assert.rejects(() => failedSession.listCommands(), /catalog failed/);
});

test("an unexpected exit reports its exit code or signal", async (t) => {
  for (const [code, signal, message] of [
    [1, null, "pi exited with code 1"],
    [null, "SIGKILL", "pi exited after SIGKILL"],
  ] as const) {
    const child = childWith(() => {});
    const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
    t.onTestFinished(() => session.dispose());
    const error = nextEvent(session, "error");
    child.stderr.end();
    child.emit("exit", code, signal);
    assert.deepEqual(await error, { type: "error", message });
  }
});

test("a crash keeps the informative end of stderr, even when it arrives after the exit", async (t) => {
  const child = childWith(() => {});
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  const error = nextEvent(session, "error");
  // Node may report the exit before the last stderr chunk has been read.
  child.emit("exit", 1, null);
  child.stderr.write("Loading extension probe\n/tmp/worker.js:10\n    throw new Error(\"boom\");\n    ^\n\n");
  child.stderr.end("Error: boom\n    at Object.<anonymous> (/tmp/worker.js:10:11)\n    at Module._compile (node:internal/modules/cjs/loader:1554:14)\n\nNode.js v24.20.0\n");
  assert.deepEqual(await error, {
    type: "error",
    message: "pi exited with code 1",
    output: 'Loading extension probe | /tmp/worker.js:10 | throw new Error("boom"); | Error: boom | at Object.<anonymous> (/tmp/worker.js:10:11)',
  });
});

test("an exit does not wait on a stderr pipe that a grandchild keeps open", async (t) => {
  const child = childWith(() => {});
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  const error = nextEvent(session, "error");
  child.stderr.write("worker still logging\n");
  child.emit("exit", null, "SIGKILL");
  assert.deepEqual(await error, { type: "error", message: "pi exited after SIGKILL", output: "worker still logging" });
});

test("the stderr tail is bounded and skips a line repeating the reported message", async (t) => {
  const child = childWith(() => {});
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  child.stderr.write(`first line\n${"x".repeat(9_000)}\n`);
  child.stderr.write("No API key found for hui-e2e\n");
  await new Promise((resolve) => setImmediate(resolve));
  const output = session.recentOutput("No API key found for hui-e2e");
  assert.match(output, /^x+$/u, "only the newest 8 KiB are kept");
  assert.ok(output.length < 8 * 1024);
  assert.match(session.recentOutput(), /\| No API key found for hui-e2e$/u);
});

test("a command with no agent turn settles and unlocks the next prompt", async (t) => {
  const child = childWith((command, active) => {
    respond(active, command, command["type"] === "get_state"
      ? { isStreaming: false }
      : command["type"] === "get_entries" ? branch([]) : undefined);
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.prompt("/review");
  assert.equal(session.isStreaming, false);
  assert.equal(events.filter((event) => event.type === "settled").length, 1);
  await session.prompt("/review again");
  assert.equal(session.isStreaming, false);
});

test("a skill or extension that starts an agent turn is not settled by its prompt acknowledgement", async (t) => {
  const child = childWith((command, active) => respond(active, command,
    command["type"] === "get_state" ? { isStreaming: true } : undefined));
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.prompt("/skill:testing");
  assert.equal(session.isStreaming, true);
  assert.equal(events.some((event) => event.type === "settled"), false);
});

test("session usage combines PI context stats with the latest run only", () => {
  assert.deepEqual(runtimeUsage(
    { contextUsage: { tokens: 166_300, contextWindow: 258_400, percent: 64.36 } },
    [
      { role: "user", content: "old" },
      { role: "assistant", usage: { input: 99, output: 9, cost: { total: 1 } } },
      { role: "user", content: "latest" },
      { role: "assistant", usage: { input: 10_000, output: 2_000, cost: { total: 0.03 } } },
      { role: "toolResult", content: [] },
      { role: "toolResult", content: [], usage: { input: 600, output: 100, cost: { total: 0.01 } } },
      { role: "system", content: "", sections: { tools: "changed" } },
      { role: "assistant", usage: { input: 3_400, output: 1_200, cost: { total: 0.02 } } },
    ],
  ), {
    contextTokens: 166_300,
    contextWindow: 258_400,
    percent: 64.36,
    inputTokens: 14_000,
    outputTokens: 3_300,
    costUsd: 0.06,
  });
});

test("tool events retain ids, arguments, updates, output and failures", () => {
  assert.deepEqual(
    toRuntimeEvent({
      type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" },
    }),
    { type: "tool_start", id: "call-1", name: "bash", args: { command: "ls" } },
  );
  assert.deepEqual(
    toRuntimeEvent({
      type: "tool_execution_update", toolCallId: "call-1", toolName: "bash",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    }),
    { type: "tool_update", id: "call-1", name: "bash", output: "partial" },
  );
  assert.deepEqual(
    toRuntimeEvent({
      type: "tool_execution_end", toolCallId: "call-1", toolName: "bash",
      result: { content: [{ type: "text", text: "done" }] }, isError: true,
    }),
    { type: "tool_end", id: "call-1", name: "bash", output: "done", failed: true },
  );
  assert.deepEqual(
    toRuntimeEvent({
      type: "tool_execution_end", toolCallId: "media", toolName: "present_media",
      result: { content: [{ type: "text", text: "Presented" }], details: { media: [{ id: "one" }] } },
    }),
    { type: "tool_end", id: "media", name: "present_media", output: "Presented", details: { media: [{ id: "one" }] }, failed: false },
  );
});

test("empty PI tool content stays empty instead of leaking a protocol envelope", () => {
  assert.deepEqual(toRuntimeEvent({
    type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { content: [] },
  }), { type: "tool_update", id: "call-1", name: "bash", output: "" });
  assert.deepEqual(toRuntimeEvent({
    type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: [],
  }), { type: "tool_end", id: "call-1", name: "bash", output: "", failed: false });
  assert.deepEqual(toRuntimeEvent({
    type: "tool_execution_end", toolCallId: "call-1", toolName: "custom", result: { answer: 42 },
  }), { type: "tool_end", id: "call-1", name: "custom", output: '{\n  "answer": 42\n}', failed: false });
});

test("text, thinking, queues, questions and notices normalize", () => {
  assert.deepEqual(toRuntimeEvent({
    type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" },
  }), { type: "text", delta: "hi" });
  assert.deepEqual(toRuntimeEvent({
    type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
  }), { type: "thinking", delta: "hmm" });
  assert.deepEqual(
    toRuntimeEvent({ type: "queue_update", steering: ["one", 2], followUp: ["later"] }),
    { type: "queue_update", queue: { steering: ["one"], followUp: ["later"] } },
  );
  assert.deepEqual(toRuntimeEvent({
    type: "extension_ui_request", id: "q-1", method: "select", title: "Choose",
    options: ["A", "B"], timeout: 5000,
  }), { type: "question", question: {
    id: "q-1", method: "select", title: "Choose", options: ["A", "B"], timeout: 5000,
  } });
  assert.deepEqual(toRuntimeEvent({
    type: "extension_ui_request", id: "n-1", method: "notify", message: "Heads up",
    notifyType: "warning",
  }), { type: "notice", message: "Heads up", level: "warning" });
});

test("history preserves ordered message, thinking, tool and error entries", () => {
  assert.deepEqual(transcriptFrom([
    { role: "user", content: "hello" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "consider" },
      { type: "text", text: "running" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
    ] },
    { role: "toolResult", toolCallId: "call-1", toolName: "bash",
      content: [{ type: "text", text: "file.ts" }], isError: false },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "model unavailable" },
  ]), [
    { kind: "message", role: "user", text: "hello" },
    { kind: "thinking", text: "consider" },
    { kind: "message", role: "assistant", text: "running" },
    { kind: "tool", id: "call-1", name: "bash", args: { command: "ls" }, output: "file.ts", failed: false },
    { kind: "error", message: "model unavailable" },
  ]);
});

test("history preserves structured HUI tool presentation details", () => {
  assert.deepEqual(transcriptFrom([
    { role: "assistant", content: [{ type: "toolCall", id: "media", name: "present_media", arguments: { paths: ["demo.mp4"] } }] },
    { role: "toolResult", toolCallId: "media", toolName: "present_media", content: [{ type: "text", text: "Presented" }], details: { media: [{ id: "one" }] }, isError: false },
  ]), [{
    kind: "tool", id: "media", name: "present_media", args: { paths: ["demo.mp4"] }, output: "Presented",
    details: { media: [{ id: "one" }] }, failed: false,
  }]);
});

test("image-only history retains attachment markers", () => {
  assert.deepEqual(transcriptFrom([{ role: "user", content: [
    { type: "image", data: "…", mimeType: "image/png" },
    { type: "image", data: "…", mimeType: "image/png" },
  ] }]), [
    { kind: "message", role: "user", text: "", attachments: [{ name: "image 1", kind: "image", mimeType: "image/png", source: { message: 0, image: 0 } }, { name: "image 2", kind: "image", mimeType: "image/png", source: { message: 0, image: 1 } }] },
  ]);
});

test("PI compaction events map to a start and one outcome, keeping PI's reason and message", () => {
  assert.deepEqual(toRuntimeEvent({ type: "compaction_start", reason: "threshold" }), { type: "compaction_start", reason: "threshold" });
  assert.deepEqual(toRuntimeEvent({ type: "compaction_end", reason: "overflow", result: { summary: "## Goal" }, aborted: false, willRetry: true }),
    { type: "compaction_end", reason: "overflow", outcome: "done", willRetry: true });
  assert.deepEqual(toRuntimeEvent({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: "Compaction failed: Nothing to compact (session too small)" }),
    { type: "compaction_end", reason: "manual", outcome: "failed", willRetry: false, message: "Nothing to compact (session too small)" });
  assert.deepEqual(toRuntimeEvent({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false }),
    { type: "compaction_end", reason: "threshold", outcome: "cancelled", willRetry: false });
  assert.equal(toRuntimeEvent({ type: "compaction_start", reason: "unknown" }), undefined);
});

test("a compaction that ends with no run active refreshes history and settles; one inside a run does not", async () => {
  const commands: string[] = [];
  const child = childWith((command, active) => {
    commands.push(String(command["type"]));
    respond(active, command, command["type"] === "get_entries" ? branch([{ role: "user", content: "hello" }]) : undefined);
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  const seen: RuntimeEvent["type"][] = [];
  session.subscribe((event) => seen.push(event.type));

  child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "compaction_start", reason: "threshold" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false })}\n`);
  let settled = nextEvent(session, "settled");
  child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await settled;
  assert.deepEqual(seen, ["compaction_start", "compaction_end", "settled"]);

  settled = nextEvent(session, "settled");
  child.stdout.write(`${JSON.stringify({ type: "compaction_start", reason: "manual" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "compaction_end", reason: "manual", result: {}, aborted: false, willRetry: false })}\n`);
  await settled;
  assert.deepEqual(seen.slice(3), ["compaction_start", "compaction_end", "settled"]);
  assert.equal(commands.filter((type) => type === "get_entries").length, 2);
  assert.equal(session.isStreaming, false);
  session.dispose();
});

test("a compaction PI runs before a pending prompt accepts the prompt and settles only after its run", async () => {
  let promptCommand: Record<string, unknown> | undefined;
  const child = childWith((command, active) => {
    if (command["type"] === "prompt") promptCommand = command;
    else respond(active, command, command["type"] === "get_entries" ? branch([]) : command["type"] === "get_state" ? { isStreaming: true } : undefined);
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  const seen: RuntimeEvent["type"][] = [];
  session.subscribe((event) => seen.push(event.type));

  const prompt = session.prompt("hello");
  await Promise.resolve();
  child.stdout.write(`${JSON.stringify({ type: "compaction_start", reason: "threshold" })}\n`);
  await prompt; // released at once instead of waiting out the summary
  child.stdout.write(`${JSON.stringify({ type: "compaction_end", reason: "threshold", result: {}, aborted: false, willRetry: false })}\n`);
  respond(child, promptCommand!);
  child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  const settled = nextEvent(session, "settled");
  child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await settled;
  assert.deepEqual(seen, ["compaction_start", "compaction_end", "settled"]);
  session.dispose();
});

test("a settle requested while one is refreshing refreshes again and still reports once", async () => {
  let refreshes = 0;
  let answerFirst!: () => void;
  let firstRefreshSent!: () => void;
  const firstRefresh = new Promise<void>((resolve) => (firstRefreshSent = resolve));
  const child = childWith((command, active) => {
    if (command["type"] !== "get_entries") return respond(active, command);
    refreshes += 1;
    const answer = () => respond(active, command, branch([{ role: "user", content: `refresh ${refreshes}` }]));
    if (refreshes > 1) return answer();
    answerFirst = answer;
    firstRefreshSent();
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await firstRefresh;
  // PI's failed overflow recovery ends a compaction it never started, right after agent_end.
  // Written before the refresh answer below, so PI's stream order delivers it first.
  child.stdout.write(`${JSON.stringify({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "Context overflow recovery failed after one compact-and-retry attempt." })}\n`);
  const settled = nextEvent(session, "settled");
  answerFirst();
  await settled;
  assert.equal(refreshes, 2);
  assert.deepEqual(session.transcript(), [{ kind: "message", role: "user", text: "refresh 2", entryId: "e0" }]);
  session.dispose();
});

test("settled is emitted only after refreshed history is installed", async () => {
  let releaseHistory!: () => void;
  const historyMayReturn = new Promise<void>((resolve) => (releaseHistory = resolve));
  const child = childWith((command, active) => {
    if (command["type"] === "get_entries") {
      void historyMayReturn.then(() => respond(active, command, branch([{ role: "assistant", content: [{ type: "text", text: "finished" }] }])));
    }
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  const settled = nextEvent(session, "settled");
  child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await Promise.resolve();
  assert.equal(session.isStreaming, true);
  releaseHistory();
  await settled;
  assert.equal(session.isStreaming, false);
  assert.deepEqual(session.transcript(), [
    { kind: "message", role: "assistant", text: "finished", entryId: "e0" },
  ]);
  session.dispose();
});

test("a failed history refresh emits an error and settles without claiming fresh history", async () => {
  const child = childWith((command, active) => {
    if (command["type"] !== "get_entries") return;
    active.stdout.write(`${JSON.stringify({
      type: "response",
      id: command["id"],
      success: false,
      error: "history unavailable",
    })}\n`);
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  const seen: RuntimeEvent[] = [];
  session.subscribe((event) => seen.push(event));
  const settled = nextEvent(session, "settled");

  child.stdout.write(`${JSON.stringify({ type: "agent_start" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  const settledEvent = await settled;

  assert.equal(session.isStreaming, false);
  assert.deepEqual(seen.filter((event) => event.type === "error" || event.type === "settled"), [
    { type: "error", message: "history unavailable" },
    { type: "settled", historyRefreshed: false },
  ]);
  assert.deepEqual(settledEvent, { type: "settled", historyRefreshed: false });
  session.dispose();
});

test("bootstrap retains model, thinking and durable history", async () => {
  const child = childWith((command, active) => {
    if (command["type"] === "get_state") respond(active, command, {
      sessionId: "pi-1", sessionFile: "/tmp/session.jsonl", isStreaming: false,
      thinkingLevel: "high", model: { provider: "openai", id: "gpt", name: "GPT" },
    });
    else if (command["type"] === "get_entries") respond(active, command, branch([{ role: "user", content: "hello" }]));
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  await session.bootstrap();
  assert.equal(session.sessionId, "pi-1");
  assert.equal(session.currentThinking(), "high");
  assert.equal(session.currentModel()?.id, "gpt");
  assert.deepEqual(session.transcript(), [{ kind: "message", role: "user", text: "hello", entryId: "e0" }]);
  session.dispose();
});

test("steer and follow-up preserve images, file references and durable display names", async () => {
  const commands: Record<string, unknown>[] = [];
  const child = childWith((command, active) => { commands.push(command); respond(active, command); });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  const attachments = [
    { kind: "image" as const, name: "captura final 🏂.png", mimeType: "image/png", dataBase64: "AAAA" },
    { kind: "file" as const, name: "notas finales.txt", path: "/tmp/notes.txt" },
  ];
  await session.steer("look", attachments);
  await session.followUp("later", attachments);
  const [steer, followUp] = commands.map(({ id: _id, ...command }) => command);
  assert.equal(steer?.["type"], "steer");
  assert.equal(followUp?.["type"], "follow_up");
  assert.deepEqual(steer?.["images"], [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  assert.deepEqual(followUp?.["images"], [{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  assert.match(String(steer?.["message"]), /^look\n\n@\/tmp\/notes\.txt\n\n<!-- hui-attachments:v1:[A-Za-z0-9_-]+ -->$/);
  assert.match(String(followUp?.["message"]), /^later\n\n@\/tmp\/notes\.txt\n\n<!-- hui-attachments:v1:[A-Za-z0-9_-]+ -->$/);
  assert.deepEqual(toRuntimeEvent({
    type: "queue_update",
    steering: [steer?.["message"]],
    followUp: [followUp?.["message"]],
  }), {
    type: "queue_update",
    queue: { steering: ["look"], followUp: ["later"] },
  });

  assert.deepEqual(transcriptFrom([{ role: "user", content: [
    { type: "text", text: steer?.["message"] },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ] }]), [
    { kind: "message", role: "user", text: "look", attachments: [{ name: "captura final 🏂.png", kind: "image", mimeType: "image/png", source: { message: 0, image: 0 } }, { name: "notas finales.txt", kind: "file", source: { message: 0, file: 0 } }] },
  ]);
  session.dispose();
});

test("settled transcript restores image and file names without exposing transport metadata", async () => {
  let persistedUserMessage = "";
  const child = childWith((command, active) => {
    if (command["type"] === "prompt") {
      persistedUserMessage = String(command["message"]);
      respond(active, command);
    } else if (command["type"] === "get_entries") {
      respond(active, command, branch([{ role: "user", content: [
        { type: "text", text: persistedUserMessage },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ] }]));
    }
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  await session.prompt("inspect these", [
    { kind: "image", name: "screen.png", mimeType: "image/png", dataBase64: "AAAA" },
    { kind: "file", name: "report.txt", path: "/tmp/uuid-report.txt" },
  ]);
  const settled = nextEvent(session, "settled");
  child.stdout.write(`${JSON.stringify({ type: "agent_end" })}\n`);
  await settled;

  const transcript = session.transcript();
  assert.deepEqual(transcript, [{
    kind: "message",
    role: "user",
    text: "inspect these",
    entryId: "e0",
    attachments: [{ name: "screen.png", kind: "image", mimeType: "image/png", source: { message: 0, image: 0 } }, { name: "report.txt", kind: "file", source: { message: 0, file: 0 } }],
  }]);
  assert.deepEqual(await session.attachmentImage(0, 0), { mimeType: "image/png", data: Buffer.from("AAAA", "base64") });
  assert.equal(await session.attachmentImage(0, 1), undefined);
  assert.equal(await session.attachmentImage(5, 0), undefined);
  assert.equal(session.attachmentFile(0, 0), "/tmp/uuid-report.txt");
  assert.equal(session.attachmentFile(0, 1), undefined);
  assert.equal(session.attachmentFile(5, 0), undefined);
  const restored = transcript[0];
  assert.doesNotMatch(restored?.kind === "message" ? restored.text : "", /hui-attachments|uuid-report/);
  session.dispose();
});

test("queue and question state follows events and responses use the UI sub-protocol", async () => {
  const commands: Record<string, unknown>[] = [];
  const child = childWith((command) => commands.push(command));
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  child.stdout.write(`${JSON.stringify({ type: "queue_update", steering: ["now"], followUp: ["later"] })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: "extension_ui_request", id: "confirm-1", method: "confirm",
    title: "Continue?", message: "Proceed",
  })}\n`);
  await Promise.resolve();
  assert.deepEqual(session.pendingQueue(), { steering: ["now"], followUp: ["later"] });
  assert.equal(session.pendingQuestions().length, 1);
  await assert.rejects(() => session.respondQuestion("confirm-1", { value: "yes" }), /confirmation/);
  await session.respondQuestion("confirm-1", { confirmed: true });
  assert.equal(session.pendingQuestions().length, 0);
  assert.deepEqual(commands.at(-1), {
    type: "extension_ui_response", id: "confirm-1", confirmed: true,
  });
  await assert.rejects(() => session.cancelQuestion("missing"), /Unknown PI question/);
  session.dispose();
});

test("an extension question acknowledges its prompt before the human answers", async () => {
  const commands: Record<string, unknown>[] = [];
  let promptCommand: Record<string, unknown> | undefined;
  const child = childWith((command, active) => {
    commands.push(command);
    if (command["type"] === "prompt") {
      promptCommand = command;
      active.stdout.write(`${JSON.stringify({
        type: "extension_ui_request",
        id: "input-1",
        method: "input",
        title: "Name",
      })}\n`);
    } else if (command["type"] === "extension_ui_response" && promptCommand) {
      respond(active, promptCommand);
    } else if (command["type"] === "get_entries") {
      respond(active, command, branch([]));
    } else if (command["type"] === "get_state") {
      respond(active, command, { isStreaming: false });
    }
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);

  await session.prompt("/ask");
  assert.equal(session.pendingQuestions()[0]?.id, "input-1");
  assert.equal(session.isStreaming, true, "early acknowledgement must not settle before the answer");
  const settled = nextEvent(session, "settled");
  await session.respondQuestion("input-1", { value: "Ada" });
  await settled;
  assert.ok(commands.some((command) =>
    command["type"] === "extension_ui_response" &&
    command["id"] === "input-1" &&
    command["value"] === "Ada"
  ));
  assert.equal(session.isStreaming, false);
  session.dispose();
});

test("model and thinking acknowledgements update local state", async () => {
  const child = childWith((command, active) => respond(active, command));
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  await session.setModel("openai", "gpt-5.6");
  await session.setThinking("high");
  assert.deepEqual(session.currentModel(), { provider: "openai", id: "gpt-5.6", name: "gpt-5.6" });
  assert.equal(session.currentThinking(), "high");
  session.dispose();
});

test("malformed JSON becomes an explicit runtime error", async () => {
  const child = childWith(() => {});
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  const error = nextEvent(session, "error");
  child.stdout.write("not-json\n");
  assert.deepEqual(await error, { type: "error", message: "PI emitted malformed JSONL." });
  for (const line of ["null", "[]", "42"]) {
    const malformed = nextEvent(session, "error");
    child.stdout.write(`${line}\n`);
    assert.equal((await malformed).type, "error");
  }
  session.dispose();
});

test("child error rejects pending RPC and exit notification is idempotent", async () => {
  const child = childWith(() => {});
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  let exits = 0;
  session.onExit(() => (exits += 1));
  const pending = session.setThinking("high");
  child.emit("error", new Error("ENOENT"));
  child.emit("exit", 1);
  await assert.rejects(() => pending, /ENOENT/);
  assert.equal(exits, 1);
  let late = 0;
  session.onExit(() => (late += 1));
  assert.equal(late, 1);
});

test("JSONL framing preserves unicode separators inside strings", async () => {
  const child = childWith(() => {});
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  const text = nextEvent(session, "text");
  child.stdout.write(`${JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "a\u2028b\u2029c" },
  })}\n`);
  assert.deepEqual(await text, { type: "text", delta: "a\u2028b\u2029c" });
  session.dispose();
});

test("history images decode only raster image MIME types from user messages", () => {
  const messages = [
    { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/svg+xml" }, { type: "image", data: "AAAA", mimeType: "text/html" }] },
    { role: "assistant", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
  ];
  assert.equal(imageFromMessages(messages, 0, 0), undefined);
  assert.equal(imageFromMessages(messages, 0, 1), undefined);
  assert.equal(imageFromMessages(messages, 1, 0), undefined);
});

test("dollar references reach PI's exact invocation and extension actions settle", async (t) => {
  const sent: Record<string, unknown>[] = [];
  const child = childWith((command, active) => {
    sent.push(command);
    respond(active, command, command["type"] === "get_commands"
      ? { commands: [{ name: "check-status", source: "extension" }, { name: "skill:review", source: "skill" }] }
      : command["type"] === "get_state" ? { isStreaming: false }
      : command["type"] === "get_entries" ? branch([]) : undefined);
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams);
  t.onTestFinished(() => session.dispose());
  await session.prompt("$check-status argument");
  assert.equal(sent.find((command) => command["type"] === "prompt")?.["message"], "/check-status argument");
  assert.equal(session.isStreaming, false);
  await session.steer("$review inspect code");
  assert.equal(sent.find((command) => command["type"] === "steer")?.["message"], "/skill:review inspect code");
  await assert.rejects(() => session.steer("$check-status"), /idle/);
  await session.followUp("$review later");
  assert.equal(sent.find((command) => command["type"] === "follow_up")?.["message"], "/skill:review later");
});

test("a disabled skill's dollar reference reaches PI as its /skill command, which the skill policy refuses", async (t) => {
  let message: unknown;
  const child = childWith((command, active) => {
    if (command["type"] === "prompt") message = command["message"];
    respond(active, command, command["type"] === "get_commands"
      ? { commands: [{ name: "skill:review", source: "skill" }] } : undefined);
  });
  const session = new PiSession(child as unknown as ChildProcessWithoutNullStreams, undefined, ["review"]);
  t.onTestFinished(() => session.dispose());
  await session.prompt("$review args");
  assert.equal(message, "/skill:review args");
  await session.prompt("$skill:review args");
  assert.equal(message, "/skill:review args", "the qualified $skill:name form too");
});


test("a call's record shows as one card with its summary and transcript, without an entry id to rewind to", () => {
  const record = {
    call: "c1", bot: "Juno", startedAt: 1_791_295_200_000, endedAt: 1_791_295_320_000, summary: "**To remember**: teal.",
    lines: [{ role: "user", text: "Remember teal.", at: 1_791_295_200_000 }, { role: "assistant", text: "Teal it is.", at: 1_791_295_203_000 }],
  };
  assert.deepEqual(transcriptFrom([
    { role: "user", content: "typed", entryId: "4", timestamp: 1 },
    { role: "call", record },
    { role: "call", record: { call: "broken" } },
  ]), [
    { kind: "message", role: "user", text: "typed", entryId: "4", metrics: { timestamp: 1 } },
    { kind: "call", ...record },
  ]);
});
