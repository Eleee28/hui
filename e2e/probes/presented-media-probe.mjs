#!/usr/bin/env node
/** Drive the real HUI DOM through a Chromium DevTools endpoint when the managed
 * Browser wrapper is unavailable. This never injects transcript/app state. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [portArg = "18801", outputArg = "e2e/evidence"] = process.argv.slice(2);
const port = Number(portArg);
const output = resolve(outputArg);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Provide a valid Chromium debugging port.");
await mkdir(output, { recursive: true });

const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find((item) => item.type === "page" && item.url.startsWith("http://localhost:"));
if (!tab?.webSocketDebuggerUrl) throw new Error("No HUI Chromium page is available.");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
const networkFailures = [];
let nextId = 1;

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    consoleErrors.push(message.params.args.map((item) => item.value ?? item.description).join(" "));
  }
  if (message.method === "Network.loadingFailed" && !message.params.canceled) {
    networkFailures.push(`${message.params.type}: ${message.params.errorText}`);
  }
};
await new Promise((resolveOpen, reject) => {
  socket.onopen = resolveOpen;
  socket.onerror = () => reject(new Error("Could not connect to Chromium."));
});

function call(method, params = {}) {
  const id = nextId++;
  return new Promise((resolveCall, reject) => {
    pending.set(id, { resolve: resolveCall, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(expression, label, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function screenshot(name) {
  const result = await call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(resolve(output, name), Buffer.from(result.data, "base64"));
}

try {
  await Promise.all([call("Page.enable"), call("Runtime.enable"), call("Network.enable")]);
  await waitFor("document.querySelector('hui-app') && [...document.querySelectorAll('a')].some((node) => node.textContent.includes('Media capabilities'))", "session navigation");
  await evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((node) => node.textContent.includes('Media capabilities'));
    if (!link) throw new Error('Session link is missing');
    link.click();
    return true;
  })()`);
  await waitFor("document.querySelector('.chat textarea') && document.body.textContent.includes('Idle')", "idle session");
  const alreadyPresented = await evaluate("document.querySelectorAll('.hui-presented-media').length === 4 && document.body.textContent.includes('attached above using HUI')");
  if (!alreadyPresented) {
    await evaluate(`(() => {
      const input = document.querySelector('.chat textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'E2E_PRESENT_MEDIA');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'E2E_PRESENT_MEDIA' }));
      return true;
    })()`);
    await waitFor("document.querySelector('button[aria-label=\"Send message\"]') && !document.querySelector('button[aria-label=\"Send message\"]').disabled", "enabled Send button");
    await evaluate("document.querySelector('button[aria-label=\"Send message\"]').click(); true");
  }
  await waitFor("document.querySelectorAll('.hui-presented-media').length === 4 && document.body.textContent.includes('attached above using HUI')", "presented media", 30_000);
  const first = await evaluate(`(async () => {
    const media = [...document.querySelectorAll('.hui-presented-media')];
    const image = document.querySelector('.hui-presented-media img');
    const video = document.querySelector('.hui-presented-media video');
    const audio = document.querySelector('.hui-presented-media audio');
    const file = [...document.querySelectorAll('.hui-presented-media a[download]')].find((node) => node.download.endsWith('.pdf'));
    const range = await fetch(video.src, { headers: { Range: 'bytes=0-31' } });
    document.querySelector('.chat-thread').scrollTop = document.querySelector('.chat-thread').scrollHeight;
    return {
      kinds: media.map((node) => node.className), imageComplete: image.complete && image.naturalWidth > 0,
      videoReady: video.readyState, audioReady: audio.readyState, file: file?.download,
      range: [range.status, range.headers.get('content-range')],
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('.hui-presented-media').scrollIntoView({ block: 'start', behavior: 'instant' }); true");
  await screenshot("presented-media-desktop.png");
  await evaluate("document.querySelectorAll('.hui-presented-media').item(3).scrollIntoView({ block: 'end', behavior: 'instant' }); true");
  await screenshot("presented-media-desktop-playback.png");

  await call("Page.reload", { ignoreCache: true });
  await waitFor("document.querySelectorAll('.hui-presented-media').length === 4", "persisted media after reload", 30_000);
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor("document.querySelectorAll('.hui-presented-media').length === 4", "media after responsive layout");
  await evaluate("document.querySelector('.hui-presented-media').scrollIntoView({ block: 'start', behavior: 'instant' }); true");
  const mobile = await evaluate(`({
    count: document.querySelectorAll('.hui-presented-media').length,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    videoWidth: document.querySelector('.hui-presented-media video').getBoundingClientRect().width,
    viewport: [innerWidth, innerHeight],
  })`);
  await screenshot("presented-media-mobile.png");
  await evaluate("document.querySelector('.chat-thread').scrollTop = document.querySelector('.chat-thread').scrollHeight; true");
  await screenshot("presented-media-mobile-playback.png");
  console.log(JSON.stringify({ first, mobile, exceptions, consoleErrors, networkFailures }, null, 2));
  if (!first.imageComplete || first.file !== "media-notes.pdf" || first.range[0] !== 206 || first.overflow !== 0) process.exitCode = 1;
  if (mobile.count !== 4 || mobile.overflow !== 0 || exceptions.length || consoleErrors.length || networkFailures.length) process.exitCode = 1;
} finally {
  socket.close();
}
