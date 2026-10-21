import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "vitest";
import { attachPeer, LineSplitter } from "./protocol.ts";

function pair() {
  const ab = new PassThrough();
  const ba = new PassThrough();
  return { a: attachPeer(ba, ab), b: attachPeer(ab, ba), ab, ba };
}

const aborted = (signal: AbortSignal) => signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));

test("frames split on newlines only, across chunk boundaries", () => {
  const splitter = new LineSplitter();
  const value = JSON.stringify({ t: "out", d: "line\u2028separator\u2029paragraph" });
  assert.deepEqual(splitter.push(value.slice(0, 7)), []);
  assert.deepEqual(splitter.push(`${value.slice(7)}\r\n\n${value}\n`), [value, value]);
});

test("requests carry parameters named like protocol fields", async () => {
  const { a, b } = pair();
  b.handle("credential", (params) => params);
  // `op`, `id` and `t` are ordinary parameter names to the caller.
  assert.deepEqual(await a.request("credential", { op: "read", id: "x", t: "y" }), { op: "read", id: "x", t: "y" });
});

test("handler failures reject the caller and unknown requests are refused", async () => {
  const { a, b } = pair();
  b.handle("boom", () => { throw new Error("remote failure"); });
  await assert.rejects(a.request("boom"), /remote failure/u);
  await assert.rejects(a.request("missing"), /Unsupported remote worker request: missing/u);
});

test("losing the stream rejects pending and later requests", async () => {
  const { a, b, ba } = pair();
  b.handle("slow", () => new Promise(() => undefined));
  const pending = a.request("slow");
  ba.destroy();
  await assert.rejects(pending, /connection closed/u);
  await assert.rejects(a.request("slow"), /connection closed/u);
});

test("malformed input closes the peer instead of throwing", async () => {
  const input = new PassThrough();
  const peer = attachPeer(input, new PassThrough());
  const closed = new Promise<string>((resolve) => peer.onClose(resolve));
  input.write("not json\n");
  assert.match(await closed, /malformed/u);
});

test("a peer that goes silent is closed, one that pings is kept", async () => {
  const { a, b } = pair();
  // Generous misses: a loaded test run can stall timers, never for half a second.
  b.keepAlive(10, 50);
  a.keepAlive(10, 50);
  // Both ping: neither closes while the other is alive.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(a.closed || b.closed, false);
  const silent = pair();
  silent.a.keepAlive(10, 3);
  // `b` never pings, like a laptop that went to sleep. The heartbeat timer is
  // unref'd, so hold the event loop open while waiting for it.
  const hold = setTimeout(() => undefined, 5_000);
  assert.match(await new Promise<string>((resolve) => silent.a.onClose(resolve)), /stopped answering/u);
  clearTimeout(hold);
});

test("a long frame still arriving keeps the peer alive", async () => {
  const input = new PassThrough();
  const peer = attachPeer(input, new PassThrough());
  peer.keepAlive(50, 3);
  const received = new Promise<Record<string, unknown>>((resolve) => peer.onFrame(resolve));
  const frame = JSON.stringify({ t: "out", d: "x".repeat(4000) });
  // Bytes trickle in for well over three silent intervals before the newline.
  for (let offset = 0; offset < frame.length; offset += 100) {
    input.write(frame.slice(offset, offset + 100));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  input.write("\n");
  assert.equal((await received)["t"], "out");
  assert.equal(peer.closed, false);
});

test("a requester that gives up aborts the handler's signal, and so does a closed peer", async () => {
  const { a, b, ab } = pair();
  const signals: AbortSignal[] = [];
  let entered!: () => void;
  const next = () => new Promise<void>((resolve) => { entered = resolve; });
  b.handle("wait", (_params, signal) => { signals.push(signal); entered(); return new Promise(() => undefined); });

  let started = next();
  const call = new AbortController();
  const cancelled = a.request("wait", {}, 30_000, call.signal);
  await started;
  call.abort();
  await assert.rejects(cancelled, /wait request was cancelled/u);
  await aborted(signals[0]!);

  started = next();
  const timedOut = a.request("wait", {}, 50);
  // The request timer is unref'd; hold the event loop open until it fires.
  const hold = setTimeout(() => undefined, 5_000);
  await started;
  await assert.rejects(timedOut, /did not answer wait in time/u);
  clearTimeout(hold);
  await aborted(signals[1]!);

  await assert.rejects(a.request("wait", {}, 30_000, AbortSignal.abort()), /cancelled/u);

  started = next();
  void a.request("wait").catch(() => undefined);
  await started;
  ab.destroy();
  await aborted(signals[2]!);
});
