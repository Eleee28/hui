import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "vitest";
import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";
import { BrowserViewMessage } from "../api/browser.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import type { BrowserViewListener } from "./manager.ts";
import { attachBrowserTransport, browserViewTicket, type BrowserViewSource } from "./transport.ts";

test("one-use, same-origin tickets bind a view-only stream to one conversation", { timeout: 20_000 }, async (t) => {
  const watched: string[] = [];
  const selected: Array<string | null> = [];
  let closed = 0;
  let listener: BrowserViewListener | undefined;
  const source: BrowserViewSource = {
    watch(owner, next) {
      watched.push(owner);
      listener = next;
      next.state({ running: true, mode: "headless", tabs: [{ id: "t1", title: "Fixture", url: "http://127.0.0.1/" }], current: "t1", watching: "t1", following: true });
      next.frame({ tabId: "t1", width: 1280, height: 800, seq: 7, image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
      return { select: (tabId) => selected.push(tabId), close: () => { closed += 1; } };
    },
  };
  const server = createServer((_request, response) => response.writeHead(404).end());
  const detach = attachBrowserTransport(server, source, new Set(["127.0.0.1"]));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => { detach(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const connect = (url: string, pageOrigin = origin) => new WebSocket(origin.replace("http:", "ws:") + url, { origin: pageOrigin });
  const rejected = async (url: string, pageOrigin = origin) => {
    const [error] = await once(connect(url, pageOrigin), "error");
    assert.match((error as Error).message, /403/u);
  };

  await rejected(browserViewTicket("alpha"), "https://outside.example");
  await rejected("/__hui/browser-stream?ticket=invalid");
  const ticket = browserViewTicket("alpha");
  assert.match(ticket, /^\/__hui\/browser-stream\?ticket=[\w-]{43}$/u);
  const ws = connect(ticket);
  const messages: Array<{ text?: unknown; binary?: Buffer }> = [];
  ws.on("message", (data, binary) => messages.push(binary ? { binary: data as Buffer } : { text: JSON.parse(data.toString()) }));
  await once(ws, "open");
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail("Expected browser view message did not arrive.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await until(() => messages.length >= 2);
  assert.deepEqual(watched, ["alpha"]);
  assert.deepEqual(messages[0]!.text, {
    type: "state", running: true, mode: "headless", tabs: [{ id: "t1", title: "Fixture", url: "http://127.0.0.1/" }],
    current: "t1", watching: "t1", following: true,
  });
  const fixture = JSON.parse(await readFile(new URL("./transport.fixture.json", import.meta.url), "utf8"));
  assert.equal(messages[1]!.binary!.toString("hex"), fixture.frame);
  expectSchema(BrowserViewMessage, messages[0]!.text);
  listener!.action({ tabId: "t1", text: "Clicked e2 (button \"Greet\")", point: { x: 10, y: 20 }, at: "2026-09-28T07:00:00.000Z" });
  await until(() => messages.length >= 3);
  expectSchema(BrowserViewMessage, messages[2]!.text);
  assert.deepEqual(messages[2]!.text, { type: "action", tabId: "t1", text: "Clicked e2 (button \"Greet\")", point: { x: 10, y: 20 }, at: "2026-09-28T07:00:00.000Z" });

  // The only control message picks a tab; anything else is ignored.
  ws.send(JSON.stringify({ action: "select", tabId: "t3" }));
  ws.send(JSON.stringify({ action: "select", tabId: 42 }));
  ws.send("not json");
  ws.send(JSON.stringify({ action: "click", x: 1, y: 2 }));
  await until(() => selected.length >= 2);
  assert.deepEqual(selected, ["t3", null]);
  await rejected(ticket, origin);

  ws.close();
  await until(() => closed === 1);
});
