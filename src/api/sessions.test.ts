import assert from "node:assert/strict";
import { test, vi } from "vitest";

import {
  reconnectDelay,
  STATUS_STREAM_STALL_MS,
  subscribeSessionStatuses,
  type RuntimeEvent,
  type SessionStatusUpdate,
} from "./sessions.ts";

test("the browser runtime contract includes settled", () => {
  const event: RuntimeEvent = { type: "settled" };
  assert.deepEqual(event, { type: "settled" });
});

// `random() = 0` is the low edge of the equal-jitter band, so these read as the
// un-jittered curve.
test("reconnect backoff doubles, then holds at the cap", () => {
  assert.equal(reconnectDelay(1, () => 0), 250);
  assert.equal(reconnectDelay(2, () => 0), 500);
  assert.equal(reconnectDelay(3, () => 0), 1000);
  assert.equal(reconnectDelay(4, () => 0), 2000);
  assert.equal(reconnectDelay(5, () => 0), 2000);
  assert.equal(reconnectDelay(50, () => 0), 2000);
});

test("jitter stays inside the band and under the cap", () => {
  assert.equal(reconnectDelay(1, () => 1), 500);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const delay = reconnectDelay(attempt, () => 0.5);
    assert.ok(delay > 0 && delay <= 4000, `attempt ${attempt} produced ${delay}`);
  }
});

test("the browser demultiplexes lifecycle snapshot and status frames", async () => {
  const body = [
    "event: snapshot",
    'data: {"statuses":[{"id":"a","status":"running"}]}',
    "",
    "event: status",
    'data: {"id":"a","status":"idle"}',
    "",
    "event: sessions",
    'data: {"revision":2,"upserts":[]}',
    "",
    "",
  ].join("\n");
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "/__hui/sessions/events");
    assert.deepEqual(init?.headers, { "x-hui": "1", accept: "text/event-stream" });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  const snapshots: Array<readonly SessionStatusUpdate[]> = [];
  const updates: SessionStatusUpdate[] = [];
  const lists: unknown[] = [];
  let finish!: () => void;
  const received = new Promise<void>((resolve) => { finish = resolve; });

  const stop = subscribeSessionStatuses({
    onSnapshot: (statuses) => snapshots.push(statuses),
    onStatus: (update) => updates.push(update),
    onSessions: (list) => {
      lists.push(list);
      finish();
    },
  }, fetcher);
  await received;
  stop();

  assert.deepEqual(snapshots, [[{ id: "a", status: "running" }]]);
  assert.deepEqual(updates, [{ id: "a", status: "idle" }]);
  assert.deepEqual(lists, [{ revision: 2, upserts: [] }]);
});

test("a status stream that goes silent reconnects to resync", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => { vi.useRealTimers(); });
  let connections = 0;
  const fetcher = (async () => {
    connections += 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"statuses":[]}\n\n'));
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const stop = subscribeSessionStatuses({ onSnapshot: () => {}, onStatus: () => {} }, fetcher);
  t.onTestFinished(stop);
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(setImmediate); };

  await settle();
  vi.advanceTimersByTime(STATUS_STREAM_STALL_MS - 1);
  await settle();
  assert.equal(connections, 1);
  vi.advanceTimersByTime(1);
  await settle();
  vi.advanceTimersByTime(reconnectDelay(1, () => 1));
  await settle();
  assert.equal(connections, 2);
});
