/** Browser lacks a press-and-hold action. This isolated CDP helper sends only
 * the native touch gesture; Browser owns navigation, coordinates and assertions.
 * Usage: node e2e/probes/touch-hold-probe.mjs <page-websocket-url> <x> <y>
 */
const [address, xValue, yValue] = process.argv.slice(2);
const url = new URL(address);
const x = Number(xValue), y = Number(yValue);
if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !Number.isFinite(x) || !Number.isFinite(y)) {
  throw new Error("Provide an isolated loopback page WebSocket and finite coordinates");
}
const socket = new WebSocket(url);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const pending = new Map();
let id = 0;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const callback = pending.get(message.id);
  if (callback) { pending.delete(message.id); message.error ? callback.reject(message.error) : callback.resolve(message.result); }
};
const send = (method, params) => new Promise((resolve, reject) => {
  const messageId = ++id;
  pending.set(messageId, { resolve, reject });
  socket.send(JSON.stringify({ id: messageId, method, params }));
});
try {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  const result = await send("Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `new Promise((resolve, reject) => {
      const open = () => !!document.querySelector('.chat-send-mode-menu:popover-open');
      if (open()) { resolve(true); return; }
      const observer = new MutationObserver(() => { if (open()) { observer.disconnect(); clearTimeout(timeout); resolve(true); } });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Hold did not open Enqueue')); }, 10000);
      observer.observe(document.body, {subtree:true, attributes:true, childList:true});
    })`,
  });
  if (result.exceptionDetails || result.result?.value !== true) throw new Error(JSON.stringify(result));
  process.stdout.write("Native touch hold opened Enqueue.\n");
} finally {
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  socket.close();
}
