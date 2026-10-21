import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { BrowserViewController, forgetRecentBrowserFrames } from "./browser-view-controller.ts";

class FakeSocket {
  readyState = 1;
  binaryType = "blob";
  closed = false;
  readonly sent: string[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  text(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  frame(tabId: string, bytes = [0xff, 0xd8, 0xff, 0xd9]) {
    assert.equal(tabId, "t1");
    const header = Buffer.from('000000307b227461624964223a227431222c227769647468223a313238302c22686569676874223a3830302c22736571223a317d', "hex");
    const frame = new Uint8Array([...header, ...bytes]);
    this.onmessage?.({ data: frame.buffer });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const opened: string[] = [];
  const host = { addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) };
  const controller = new BrowserViewController(host, async (sessionId) => {
    opened.push(sessionId);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { controller, sockets, opened };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const state = (overrides: Record<string, unknown> = {}) => ({
  type: "state", running: true, mode: "headless", tabs: [{ id: "t1", title: "Fixture", url: "http://127.0.0.1/" }],
  current: "t1", watching: "t1", following: true, ...overrides,
});

test("a snapshot keeps one frame, disconnects and seeds later views of the conversation", async (t) => {
  t.onTestFinished(forgetRecentBrowserFrames);
  const { controller, sockets, opened } = harness();
  controller.connect("alpha", "snapshot");
  assert.equal(controller.connection, "connecting");
  await settle();
  assert.deepEqual(opened, ["alpha"]);
  const socket = sockets[0]!;
  assert.equal(socket.binaryType, "arraybuffer");
  socket.text(state());
  assert.equal(controller.connection, "live");
  assert.equal(socket.closed, false, "a snapshot waits for its frame");
  socket.frame("t1");
  assert.equal(socket.closed, true);
  assert.equal(controller.connection, "idle");
  assert.equal(controller.mode, undefined);
  assert.match(controller.frame!.src, /^blob:/u);
  assert.deepEqual({ ...controller.frame, src: "" }, { src: "", tabId: "t1", title: "Fixture", pageUrl: "http://127.0.0.1/", width: 1280, height: 800 });

  const other = harness();
  other.controller.connect("alpha", "stream");
  assert.equal(other.controller.frame?.tabId, "t1", "a new view shows the conversation's last frame at once");
  assert.notEqual(other.controller.frame?.src, controller.frame?.src, "each view owns its object URL");
  other.controller.disconnect();
  await settle();
  assert.equal(other.sockets[0]?.closed, true, "a socket that opens after disconnecting is closed");
});

test("a snapshot of a conversation without a tab stops at once", async () => {
  const { controller, sockets } = harness();
  controller.connect("beta", "snapshot");
  await settle();
  sockets[0]!.text(state({ running: false, tabs: [], current: null, watching: null }));
  assert.equal(sockets[0]!.closed, true);
  assert.equal(controller.connection, "idle");
  assert.equal(controller.frame, undefined);
});

test("a stream follows state, actions and frames, marks clicks and releases replaced frames", async () => {
  const revoked = vi.spyOn(URL, "revokeObjectURL");
  const { controller, sockets } = harness();
  controller.connect("gamma", "stream");
  await settle();
  const socket = sockets[0]!;
  socket.text(state());
  socket.frame("t1");
  const first = controller.frame!.src;
  socket.text({ type: "action", tabId: "t1", text: "Clicked e2 (button \"Greet\")", point: { x: 640, y: 200 }, at: "2026-09-28T08:00:00.000Z" });
  assert.equal(controller.action?.text, "Clicked e2 (button \"Greet\")");
  assert.deepEqual([controller.pointer?.left, controller.pointer?.top], [50, 25]);
  const key = controller.pointer?.key;
  socket.text({ type: "action", tabId: "t7", text: "Opened a blank tab", point: { x: 1, y: 1 }, at: "2026-09-28T08:00:01.000Z" });
  assert.equal(controller.pointer?.key, key, "a click in another tab does not move the marker");
  socket.frame("t1", [0xff, 0xd8, 1, 0xff, 0xd9]);
  assert.notEqual(controller.frame!.src, first);
  assert.ok(revoked.mock.calls.some((call) => call[0] === first), "the replaced frame's URL is revoked");
  controller.select("t2");
  controller.select(null);
  assert.deepEqual(socket.sent.map((message) => JSON.parse(message) as unknown), [{ action: "select", tabId: "t2" }, { action: "select", tabId: null }]);
  assert.equal(socket.closed, false, "a stream stays open");
  controller.disconnect();
  assert.equal(socket.closed, true);
  assert.equal(controller.pointer, undefined);
  assert.ok(controller.frame, "disconnecting keeps the last frame");
  controller.hostDisconnected();
  assert.equal(controller.frame, undefined);
});

test("a stream reconnects with backoff, gives up after repeated failures and restarts on connect", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => { vi.useRealTimers(); });
  const { controller, sockets, opened } = harness();
  controller.connect("delta", "stream");
  await settle();
  sockets[0]!.onclose?.();
  assert.equal(controller.connection, "reconnecting");
  vi.advanceTimersByTime(1_000);
  await settle();
  assert.equal(opened.length, 2);
  sockets[1]!.text(state());
  assert.equal(controller.connection, "live", "a state resets the retry budget");
  for (let attempt = 0; attempt < 6; attempt += 1) {
    sockets.at(-1)!.onclose?.();
    vi.advanceTimersByTime(10_000);
    await settle();
  }
  assert.equal(controller.connection, "disconnected");
  assert.equal(controller.mode, undefined);
  const count = opened.length;
  controller.connect("delta", "stream");
  await settle();
  assert.equal(opened.length, count + 1);
  controller.disconnect();
});
