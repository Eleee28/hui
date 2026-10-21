import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { attachSessionTransport, SESSION_STREAM_GONE, sessionStreamTicket } from "./transport.ts";

test("session views stream over one-use, same-origin WebSocket tickets", { timeout: 10_000 }, async (t) => {
  let emit: (event: string, data: unknown) => void = () => {};
  let unsubscribed = 0;
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  const attach = () => attachSessionTransport(server, async (id, send) => {
    if (id === "gone") return undefined;
    emit = send;
    send("snapshot", { transcript: [], status: "idle" });
    return () => { unsubscribed += 1; };
  }, new Set(["127.0.0.1"]));
  let detach = attach();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const socketUrl = (path: string) => origin.replace("http:", "ws:") + path;
  t.onTestFinished(async () => {
    detach();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const refused = async (path: string, pageOrigin = origin) => {
    const [error] = await once(new NodeWebSocket(socketUrl(path), { origin: pageOrigin }), "error");
    assert.match((error as Error).message, /403/u);
  };
  await refused(sessionStreamTicket("alpha")!, "https://outside.example");
  await refused("/__hui/session-stream?ticket=invented");
  const ticket = sessionStreamTicket("alpha")!;
  const first = new NodeWebSocket(socketUrl(ticket), { origin });
  await once(first, "message");
  first.close();
  await refused(ticket);

  const connect = (id: string) => {
    const socket = new NodeWebSocket(socketUrl(sessionStreamTicket(id)!), { origin });
    const frames: unknown[] = [];
    socket.on("message", (message: Buffer) => frames.push(JSON.parse(message.toString("utf8"))));
    const closed = once(socket, "close") as Promise<[number, Buffer]>;
    return { socket, frames, closed };
  };
  const until = async (check: () => boolean) => {
    for (const deadline = Date.now() + 3_000; !check(); await new Promise((resolve) => setTimeout(resolve, 10))) {
      assert.ok(Date.now() < deadline, "the expected stream state never arrived");
    }
  };

  const alpha = connect("alpha");
  await until(() => alpha.frames.length === 1);
  emit("status", { status: "running" });
  await until(() => alpha.frames.length === 2);
  assert.deepEqual(alpha.frames, [{ event: "snapshot", data: { transcript: [], status: "idle" } }, { event: "status", data: { status: "running" } }]);
  // A gateway restart drops the socket; a fresh ticket gets a fresh snapshot.
  const subscribed = unsubscribed;
  detach();
  assert.equal((await alpha.closed)[0], 1006);
  await until(() => unsubscribed === subscribed + 1);
  detach = attach();
  const again = connect("alpha");
  await until(() => again.frames.length === 1);
  emit("closed", {});
  const [code] = await again.closed;
  assert.equal(code, 1000);
  assert.deepEqual(again.frames, [{ event: "snapshot", data: { transcript: [], status: "idle" } }, { event: "closed", data: {} }]);
  await until(() => unsubscribed === subscribed + 2);

  const [goneCode, reason] = await connect("gone").closed;
  assert.deepEqual([goneCode, reason.toString("utf8")], [SESSION_STREAM_GONE, "unknown session"]);
});

test("a large session frame is deflated on the wire and arrives intact", { timeout: 10_000 }, async (t) => {
  const transcript = Array.from({ length: 2_000 }, (_, index) => ({ kind: "message", role: "assistant", text: `Line ${index} of a long session` }));
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  const detach = attachSessionTransport(server, async (_id, send) => {
    send("snapshot", { transcript, status: "idle" });
    return () => {};
  }, new Set(["127.0.0.1"]));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.onTestFinished(async () => {
    detach();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  let wireBytes = 0;
  server.on("upgrade", (_request, socket) => {
    const write = socket.write.bind(socket) as (chunk: Buffer | string, ...rest: unknown[]) => boolean;
    socket.write = ((chunk: Buffer | string, ...rest: unknown[]) => { wireBytes += Buffer.byteLength(chunk); return write(chunk, ...rest); }) as typeof socket.write;
  });
  const socket = new NodeWebSocket(origin.replace("http:", "ws:") + sessionStreamTicket("long")!, { origin });
  const [message] = await once(socket, "message") as [Buffer];
  assert.match(socket.extensions, /permessage-deflate/u);
  const frame = JSON.parse(message.toString("utf8")) as { event: string; data: { transcript: unknown[] } };
  assert.equal(frame.event, "snapshot");
  assert.deepEqual(frame.data.transcript, transcript);
  assert(wireBytes > 0 && wireBytes < message.length / 4, `${wireBytes} bytes on the wire for ${message.length}`);
  socket.close();
});
