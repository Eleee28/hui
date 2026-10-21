#!/usr/bin/env node
/** Screenshot an already-observed test page when the Browser screenshot wrapper
 * is unavailable. No navigation, DOM mutation, or synthetic image rendering. */
import { writeFile } from "node:fs/promises";

const [urlPrefix, output] = process.argv.slice(2);
if (!urlPrefix || !output) throw new Error("Usage: node e2e/probes/capture-rendered.mjs <page-url-prefix> <output.png>");
const tabs = await (await fetch("http://127.0.0.1:18800/json/list")).json();
const tab = tabs.find((item) => item.type === "page" && item.url.startsWith(urlPrefix));
if (!tab) throw new Error("No matching open browser page.");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
const timeout = setTimeout(() => { socket.close(); console.error("Screenshot timed out."); process.exitCode = 1; }, 10_000);
socket.onopen = () => socket.send(JSON.stringify({ id: 0, method: "Page.bringToFront" }));
socket.onmessage = async (event) => {
  const message = JSON.parse(event.data);
  if (message.id === 0) {
    socket.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png", captureBeyondViewport: false } }));
    return;
  }
  if (message.id !== 1) return;
  clearTimeout(timeout);
  try {
    if (message.error) throw new Error(message.error.message);
    await writeFile(output, Buffer.from(message.result.data, "base64"));
    console.log(output);
  } finally { socket.close(); }
};
