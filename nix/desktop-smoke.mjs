import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const [output, electronDirectory] = process.argv.slice(2);
const root = join(output, "lib/node_modules/hui");
const temporary = await mkdtemp(join(tmpdir(), "hui-electron-proof-"));
const env = { ...process.env, HOME: temporary, XDG_CONFIG_HOME: join(temporary, "config"),
  XDG_DATA_HOME: join(temporary, "data"), PI_CODING_AGENT_DIR: join(temporary, "pi"),
  HUI_GATEWAY_HOST: "127.0.0.1", HUI_GATEWAY_PORT: "0", ELECTRON_OVERRIDE_DIST_PATH: electronDirectory };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NODE_USE_ENV_PROXY", "ELECTRON_RUN_AS_NODE"]) {
  delete env[key]; delete process.env[key];
}
Object.assign(process.env, env);
let child;
let socket;
const exec = promisify(execFile);
try {
  assert.match(await readFile(join(output, "share/applications/hui.desktop"), "utf8"), /Exec=hui desktop/);
  assert.ok((await readFile(join(output, "share/icons/hicolor/512x512/apps/hui.png"))).length > 100);
  const { launchDesktop } = await import(pathToFileURL(join(root, "desktop/launch.mjs")).href);
  let stderr = "";
  const debuggerUrl = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Electron debugger timed out: ${stderr}`)), 30_000);
    void launchDesktop(root, { spawnImpl(command, args, options) {
      // Only the test disables the sandbox, because it runs inside Nix's build sandbox.
      child = spawn(command, [...args, "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0"],
        { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        const url = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1];
        if (url) { clearTimeout(timeout); resolve(url); }
      });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Electron exited (${code}): ${stderr}`)); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      return child;
    } }).catch((error) => { clearTimeout(timeout); reject(error); });
  });
  const debug = new URL(await debuggerUrl);
  console.log("Electron debugger ready");
  let page;
  const deadline = Date.now() + 30_000;
  // Wait for Electron's real page target to navigate to the authenticated gateway.
  while (!page) {
    const targets = await (await fetch(`http://${debug.host}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
    page = targets.find((target) => target.type === "page" && target.url.startsWith("http://127.0.0.1:"));
    if (!page && Date.now() >= deadline) throw new Error(`HUI did not load: ${stderr}`);
    if (!page) await delay(50);
  }
  console.log("Electron gateway target ready", page.url);
  console.log("Gateway HTTP", (await fetch(page.url, { signal: AbortSignal.timeout(5000) })).status);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, "open", { signal: AbortSignal.timeout(5000) });
  console.log("Electron CDP connected");
  let id = 0;
  const pending = new Map();
  let onContext;
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method === "Runtime.executionContextCreated") {
      const context = reply.params.context;
      if (context.auxData?.isDefault && context.origin === new URL(page.url).origin) onContext?.(context.id);
    }
    if (!reply.id) return;
    const callbacks = pending.get(reply.id);
    if (!callbacks) return;
    pending.delete(reply.id);
    if (reply.error) callbacks.reject(new Error(JSON.stringify(reply.error)));
    else callbacks.resolve(reply.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { pending.delete(current); reject(new Error(`${method} timed out`)); }, 15_000);
    pending.set(current, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  let contextTimer;
  const contextReady = new Promise((resolve, reject) => {
    contextTimer = setTimeout(() => reject(new Error("Electron document context timed out")), 15000);
    onContext = resolve;
  });
  let contextId;
  try {
    await call("Runtime.enable");
    contextId = await contextReady;
  } finally { clearTimeout(contextTimer); onContext = undefined; }
  const rendered = await call("Runtime.evaluate", { contextId, awaitPromise: true, returnByValue: true, expression: `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const text = root => root.textContent + [...root.querySelectorAll('*')].map(el => el.shadowRoot ? text(el.shadowRoot) : '').join('');
      const check = () => {
        const app = document.querySelector('hui-app');
        const content = app ? text(app.shadowRoot ?? app) : '';
        if (content.includes('Contributions') && content.includes('Settings')) resolve({ title: document.title, url: location.href });
        else if (Date.now() > deadline) reject(new Error('HUI shell did not render'));
        else requestAnimationFrame(check);
      };
      check();
    })` });
  assert.equal(rendered.exceptionDetails, undefined, JSON.stringify(rendered.exceptionDetails));
  assert.match(rendered.result.value.url, /^http:\/\/127\.0\.0\.1:/u);
  const capture = await call("Page.captureScreenshot", { format: "png" });
  const png = Buffer.from(capture.data, "base64");
  assert.ok(png.length > 5000, "Electron produced a rendered screenshot");
  if (process.env.HUI_DESKTOP_SCREENSHOT) await writeFile(process.env.HUI_DESKTOP_SCREENSHOT, png);
  console.log("Electron: installed launcher, configured gateway and rendered HUI shell passed.");
} finally {
  socket?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.ref();
    const exited = once(child, "exit"); process.kill(-child.pid, "SIGKILL"); await exited;
  }
  await exec(join(output, "bin/hui"), ["gateway", "stop", "--force"], { env, timeout: 30_000 }).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
