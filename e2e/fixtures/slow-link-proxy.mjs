#!/usr/bin/env node
/**
 * A TCP proxy that behaves like a slow remote link (a phone on mobile data
 * through a Tailscale relay): every chunk is delayed by half the round trip in
 * each direction, and everything the gateway sends shares one downstream
 * bandwidth budget across all connections.
 *
 *   node e2e/fixtures/slow-link-proxy.mjs --target 127.0.0.1:4173 [--port 0]
 *     [--rtt-ms 300] [--down-kbps 1600] [--up-kbps 800]
 *
 * Prints {"url": "http://127.0.0.1:<port>/", ...} once listening. HTTP and
 * WebSocket upgrades pass through unchanged, so the gateway must allow the
 * Host (loopback is). Ctrl+C stops it.
 */
import { createConnection, createServer } from "node:net";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const [targetHost, targetPort] = String(option("target", "")).split(":");
if (!targetHost || !Number(targetPort)) {
  console.error("Usage: slow-link-proxy.mjs --target host:port [--port 0] [--rtt-ms 300] [--down-kbps 1600] [--up-kbps 800]");
  process.exit(2);
}
const oneWayMs = Number(option("rtt-ms", "300")) / 2;
const down = (Number(option("down-kbps", "1600")) * 1000) / 8; // bytes per second
const up = (Number(option("up-kbps", "800")) * 1000) / 8;

/** One shared pipe per direction: a chunk leaves once the link has carried
 * everything queued before it, and arrives half a round trip later. */
function link(bytesPerSecond) {
  let freeAt = 0;
  return (size) => {
    const start = Math.max(Date.now(), freeAt);
    freeAt = start + (size / bytesPerSecond) * 1000;
    return freeAt + oneWayMs;
  };
}
const downstream = link(down);
const upstream = link(up);

/**
 * One browser connection. The gateway writes a response at loopback speed and
 * starts its keep-alive idle timer long before the slow link has delivered it,
 * so it may close a connection the browser is about to reuse: a real front
 * proxy (tailscale serve) keeps its own backend connections and never shows
 * the browser that close. Likewise here, the gateway's close only ends that
 * backend connection, and the browser's next request opens a new one.
 */
function relay(client) {
  // Order is preserved per direction: a chunk never overtakes the one before.
  let lastUp = 0;
  let lastDown = 0;
  let target;
  const toClient = (chunk) => {
    lastDown = Math.max(downstream(chunk.length), lastDown);
    setTimeout(() => { if (!client.destroyed) client.write(chunk); }, lastDown - Date.now());
  };
  const connect = () => {
    const socket = createConnection({ host: targetHost, port: Number(targetPort) });
    socket.on("data", toClient);
    const forget = () => { if (target === socket) target = undefined; };
    socket.on("end", forget);
    socket.on("close", forget);
    socket.on("error", forget);
    return socket;
  };
  client.on("data", (chunk) => {
    lastUp = Math.max(upstream(chunk.length), lastUp);
    setTimeout(() => {
      target ??= connect();
      target.write(chunk);
    }, lastUp - Date.now());
  });
  client.on("end", () => setTimeout(() => target?.end(), Math.max(0, lastUp - Date.now())));
  client.on("close", () => target?.destroy());
  client.on("error", () => target?.destroy());
}

const server = createServer(relay);

server.listen(Number(option("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, rttMs: oneWayMs * 2, downKbps: (down * 8) / 1000, upKbps: (up * 8) / 1000 }));
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(0));
