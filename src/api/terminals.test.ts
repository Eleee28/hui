import assert from "node:assert/strict";
import { test } from "vitest";
import { createTerminalStreamReader } from "./terminals.ts";
import type { TerminalView } from "./schema/terminals.ts";

const terminal: TerminalView = { id: "t1", ownerSessionId: "s1", title: "Terminal 1", cwd: "/tmp", cols: 80, rows: 24, status: "running", createdAt: "2026-10-09T00:00:00.000Z" };
const encode = (text: string) => new TextEncoder().encode(text).buffer;

function recorder() {
  const calls: unknown[][] = [];
  const read = createTerminalStreamReader({
    snapshot: (frame, replay) => calls.push(["snapshot", frame.sequence, new TextDecoder().decode(replay)]),
    output: (bytes) => calls.push(["output", new TextDecoder().decode(bytes)]),
    state: (view) => calls.push(["state", view.cols]),
    error: (message) => calls.push(["error", message]),
  });
  return { calls, read };
}

test("a snapshot is paired with the binary replay that follows it, then output streams as bytes", () => {
  const { calls, read } = recorder();
  read(JSON.stringify({ type: "snapshot", terminal, sequence: 7, truncated: false, replayBytes: 5 }));
  assert.deepEqual(calls, [], "the snapshot waits for its replay");
  read(encode("$ ls\u001b[0m"));
  read(encode("\u001b[31mred"));
  read(JSON.stringify({ type: "state", terminal: { ...terminal, cols: 120 } }));
  read(JSON.stringify({ type: "error", error: "Terminal has exited." }));
  assert.deepEqual(calls, [["snapshot", 7, "$ ls\u001b[0m"], ["output", "\u001b[31mred"], ["state", 120], ["error", "Terminal has exited."]]);
});

test("an empty replay completes the snapshot at once and typed-array views are accepted", () => {
  const { calls, read } = recorder();
  read(JSON.stringify({ type: "snapshot", terminal, sequence: 0, truncated: false, replayBytes: 0 }));
  const bytes = new TextEncoder().encode("xxprompt$ ");
  read(bytes.subarray(2));
  read(new ArrayBuffer(0));
  assert.deepEqual(calls, [["snapshot", 0, ""], ["output", "prompt$ "]]);
});

test("malformed, unknown and out-of-order messages surface as errors without writing output", () => {
  const { calls, read } = recorder();
  read("not json");
  read(JSON.stringify({ type: "data", data: "legacy JSON output", sequence: 1 }));
  read(JSON.stringify({ type: "snapshot", terminal: { id: "t1" }, sequence: 1, truncated: false, replayBytes: 0 }));
  read({ some: "object" });
  read(JSON.stringify({ type: "snapshot", terminal, sequence: 2, truncated: true, replayBytes: 3 }));
  read(JSON.stringify({ type: "state", terminal }));
  assert.deepEqual(calls, [
    ["error", "Malformed terminal message."],
    ["error", "Malformed terminal message."],
    ["error", "Malformed terminal message."],
    ["error", "Unsupported terminal message."],
    ["error", "Terminal replay was interrupted."],
    ["state", 80],
  ]);
});
