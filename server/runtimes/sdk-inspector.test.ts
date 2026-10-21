import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { SdkInspector } from "./sdk-inspector.ts";

function fixture(reply?: Record<string, unknown>) {
  const child = new EventEmitter() as EventEmitter & { connected: boolean; send: Function };
  child.connected = true;
  child.send = (request: { id: string }) => {
    if (reply) queueMicrotask(() => child.emit("message", { version: 1, id: request.id, ...reply }));
  };
  const fatal: string[] = [];
  const inspector = new SdkInspector(child as unknown as ChildProcess, (message) => { fatal.push(message); inspector.close(message); });
  return { child, inspector, fatal };
}

test("inspection rejects malformed payloads and unsupported versions", async () => {
  const first = fixture({ type: "inspection", data: { status: "live" } });
  await assert.rejects(first.inspector.inspect(), /Malformed/u);
  const second = fixture({ version: 99, type: "inspection" });
  await assert.rejects(second.inspector.inspect(), /Unsupported/u);
  assert.equal(second.fatal.length, 1);
});

test("inspection deadlines and disposal release outstanding requests", async () => {
  const { inspector } = fixture();
  await assert.rejects(inspector.inspect(1), /timed out/u);
  const pending = inspector.inspect();
  inspector.close("Worker exited");
  await assert.rejects(pending, /Worker exited/u);
  await assert.rejects(inspector.inspect(), /unavailable/u);
});

test("abort, rewind and prompt-free continuation use acknowledged SDK worker requests", async () => {
  const { child, inspector } = fixture();
  const requests: Record<string, unknown>[] = [];
  child.send = (request: Record<string, unknown>) => {
    requests.push(request);
    queueMicrotask(() => child.emit("message", { version: 1, id: request["id"], type: "ok" }));
  };

  await inspector.abort();
  await inspector.rewind("entry-1", true);
  await inspector.continueRun();
  await inspector.reload();

  assert.deepEqual(requests.map(({ type, entryId, excludeUserMessage }) => ({ type, entryId, excludeUserMessage })), [
    { type: "abort", entryId: undefined, excludeUserMessage: undefined },
    { type: "rewind", entryId: "entry-1", excludeUserMessage: true },
    { type: "continue", entryId: undefined, excludeUserMessage: undefined },
    { type: "reload", entryId: undefined, excludeUserMessage: undefined },
  ]);
});
