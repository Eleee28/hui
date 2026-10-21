import assert from "node:assert/strict";
import { test } from "vitest";
import { PassThrough } from "node:stream";
import { CdpConnection, CdpError, type CdpEvent } from "./cdp.ts";
import { waitFor } from "../test-support/wait-for.ts";

/** A fake browser end of the pipe: reads commands and writes raw frames. */
function fixture() {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const connection = new CdpConnection(toBrowser, fromBrowser);
  const commands: Array<{ id: number; method: string; params: unknown; sessionId?: string }> = [];
  let buffered = "";
  toBrowser.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let end = buffered.indexOf("\0");
    while (end !== -1) {
      commands.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\0");
    }
  });
  const next = async (): Promise<(typeof commands)[number]> => {
    await waitFor("the next command to the browser", () => commands.length > 0, { state: () => ({ buffered }) });
    return commands.shift()!;
  };
  return { connection, fromBrowser, next, frame: (value: unknown) => `${JSON.stringify(value)}\0` };
}

test("commands correlate responses, errors and session-scoped events", async () => {
  const f = fixture();
  const events: CdpEvent[] = [];
  f.connection.on((event) => events.push(event));
  const version = f.connection.send("Browser.getVersion");
  const command = await f.next();
  assert.deepEqual(command, { id: 1, method: "Browser.getVersion", params: {} });
  const scoped = f.connection.send("Runtime.evaluate", { expression: "1" }, "session-a");
  const second = await f.next();
  assert.equal(second.sessionId, "session-a");
  // One chunk carrying an event, an error and a result, out of order.
  f.fromBrowser.write(f.frame({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "session-a" })
    + f.frame({ id: 2, error: { code: -32000, message: "Cannot find context" } })
    + f.frame({ id: 1, result: { product: "Chrome/1" } }));
  assert.deepEqual(await version, { product: "Chrome/1" });
  await assert.rejects(scoped, (error: unknown) => error instanceof CdpError && error.code === -32000 && /Cannot find context/u.test(error.message));
  assert.deepEqual(events, [{ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "session-a" }]);
  f.connection.close();
});

test("frames split across chunks and multibyte text reassemble exactly", async () => {
  const f = fixture();
  const pending = f.connection.send("Runtime.evaluate");
  await f.next();
  const bytes = Buffer.from(f.frame({ id: 1, result: { value: "héllo 😀" } }));
  for (let index = 0; index < bytes.length; index += 3) f.fromBrowser.write(bytes.subarray(index, index + 3));
  assert.deepEqual(await pending, { value: "héllo 😀" });
  f.connection.close();
});

test("malformed data, closing and timeouts reject every pending command", async () => {
  const f = fixture();
  const first = f.connection.send("A");
  const second = f.connection.send("B");
  let closedWith = "";
  f.connection.onClose((reason) => { closedWith = reason.message; });
  f.fromBrowser.write("{not json\0");
  await assert.rejects(first, /malformed/u);
  await assert.rejects(second, /malformed/u);
  assert.equal(f.connection.closed, true);
  assert.match(closedWith, /malformed/u);
  await assert.rejects(f.connection.send("C"), /malformed/u);
  let late = "";
  f.connection.onClose((reason) => { late = reason.message; });
  assert.match(late, /malformed/u, "a late observer learns the close reason immediately");

  const g = fixture();
  await assert.rejects(g.connection.send("Slow.method", {}, undefined, 20), /did not answer Slow\.method/u);
  const pending = g.connection.send("Never");
  g.fromBrowser.end();
  await assert.rejects(pending, /closed/u);
});
