#!/usr/bin/env node
/**
 * Shared-terminal rendering benchmark. Drives a running, disposable HUI (a
 * visual-verification receipt) in headless Chromium over the DevTools protocol:
 * opens a terminal through the chat header's **Open terminal**, runs output-heavy
 * workloads in its PTY and measures, per run, the wall time until the final line
 * is in the painted screen, main-thread long tasks and slow frames while output
 * streams, idle main-thread cost, keystroke echo latency through the real keyboard path, slow frames
 * while wheel-scrolling the scrollback, the gateway process's
 * CPU time and the bytes/messages on the terminal socket. A reconnect run measures
 * replaying the full 256 KiB buffer. Development tooling only; never shipped.
 *
 *   node e2e/probes/terminal-benchmark.mjs --receipt <receipt.json> [--browser <chromium>] [--runs 3] [--label name] [--out result.json]
 *
 * The receipt may come from any checkout (for example a detached origin/main
 * worktree), so the same script measures a baseline and a branch. The screen is
 * read through Gespenst's public API (its worker answers once the pending frame
 * is painted); checkouts that still draw with ghostty-web are read from its grid,
 * so older baselines stay measurable.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const ESC = String.fromCharCode(27);
const NL = String.fromCharCode(10);
const { values: args } = parseArgs({ options: {
  receipt: { type: "string" },
  browser: { type: "string" },
  runs: { type: "string", default: "3" },
  label: { type: "string", default: "" },
  out: { type: "string" },
  scenarios: { type: "string", default: "idle,typing,seq,cat,redraw,replay" },
} });
if (!args.receipt) throw new Error("Usage: node e2e/probes/terminal-benchmark.mjs --receipt <receipt.json> [--browser <chromium>] [--runs 3] [--out result.json]");
const receipt = JSON.parse(await readFile(args.receipt, "utf8"));
if (receipt.state !== "ready" || !receipt.url || !receipt.workspace || !receipt.serverPid) throw new Error("The receipt does not describe a ready visual-verification instance.");
const runs = Math.max(1, Number(args.runs) || 1);
const scenarios = new Set(args.scenarios.split(","));
const browserPath = args.browser ?? ["/run/current-system/sw/bin/brave", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((path) => existsSync(path));
if (!browserPath) throw new Error("No Chromium-family browser found; pass --browser <path>.");

// Loopback only: the agent shell's egress proxy must not carry these requests.
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NODE_USE_ENV_PROXY"]) delete process.env[name];

const appUrl = receipt.browserUrl ?? receipt.url;
const api = async (path, body) => {
  const response = await fetch(receipt.url + path, { method: body === undefined ? "GET" : "POST", headers: { "x-hui": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(path + ": " + response.status + " " + await response.text());
  return response.json();
};

/** utime + stime of one process in milliseconds (Linux /proc, 100 Hz ticks). */
async function cpuMs(pid) {
  const stat = await readFile("/proc/" + pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return (Number(fields[11]) + Number(fields[12])) * 10;
}

// Workloads live in the fixture's disposable workspace.
const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];
const lines = [];
let size = 0;
for (let i = 0; size < 5 * 1024 * 1024; i++) {
  const line = ESC + "[" + colors[i % colors.length] + "m" + String(i).padStart(7, "0") + ESC + "[0m " + "lorem ipsum dolor sit amet ".repeat(3) + ESC + "[1m" + (i % 97) + ESC + "[0m" + NL;
  lines.push(line);
  size += Buffer.byteLength(line);
}
await writeFile(join(receipt.workspace, "bench-5mb.txt"), lines.join(""));
await writeFile(join(receipt.workspace, "bench-redraw.mjs"), [
  "const ESC = String.fromCharCode(27);",
  "const cols = process.stdout.columns || 100, rows = process.stdout.rows || 30;",
  "for (let frame = 0; frame < 400; frame++) {",
  "  let out = ESC + '[H';",
  "  for (let row = 0; row < rows - 1; row++) {",
  "    out += ESC + '[' + (31 + ((row + frame) % 7)) + 'm' + ('frame ' + frame + ' row ' + row + ' ').padEnd(cols, '#').slice(0, cols) + ESC + '[0m' + (row < rows - 2 ? String.fromCharCode(13, 10) : '');",
  "  }",
  "  process.stdout.write(out);",
  "}",
  "process.stdout.write(ESC + '[2J' + ESC + '[H');",
].join(NL) + NL);

// Headless Chromium with a private profile and an OS-assigned DevTools port.
const profile = await mkdtemp(join(tmpdir(), "hui-terminal-bench-"));
const browser = spawn(browserPath, [
  "--headless=new", "--remote-debugging-port=0", "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "--window-size=1440,900", "about:blank",
], { stdio: "ignore", detached: true, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" } });
// The executable may be a wrapper script: stop the whole process group, then wait for the DevTools port to close.
async function cleanup() {
  try { process.kill(-browser.pid, "SIGTERM"); } catch { /* Already gone. */ }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch("http://127.0.0.1:" + devtools + "/json/version"); } catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await rm(profile, { recursive: true, force: true });
}
// An interrupted or timed-out run must not leave its browser behind.
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
let devtools;
for (let attempt = 0; attempt < 100 && !devtools; attempt++) {
  try { devtools = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(NL)[0]); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
}
if (!devtools) { await cleanup(); throw new Error("Browser did not report a DevTools port."); }
let socket, cdp;
try {

const target = await (await fetch("http://127.0.0.1:" + devtools + "/json/new?about:blank", { method: "PUT" })).json();
socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 1;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
};
cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(fn, ...params) {
  const result = await cdp("Runtime.evaluate", { expression: "(" + fn + ")(..." + JSON.stringify(params) + ")", awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

// Instrumentation installed before the app loads: long tasks and terminal sockets.
const instrument = () => {
  const bench = window.__terminalBench = { longTasks: [], sockets: [] };
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) bench.longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: true });
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...params) {
      super(...params);
      if (!String(params[0]).includes("terminal-stream")) return;
      const record = { opened: performance.now(), first: undefined, messages: 0, bytes: 0, binary: 0 };
      bench.sockets.push(record);
      this.addEventListener("message", (event) => {
        record.first ??= performance.now();
        record.messages++;
        if (typeof event.data === "string") record.bytes += event.data.length;
        else { record.binary++; record.bytes += event.data.byteLength ?? event.data.size ?? 0; }
      });
    }
  };
};
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Performance.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp("Page.addScriptToEvaluateOnNewDocument", { source: "(" + instrument + ")()" });

const { session } = await api("/__hui/sessions", { cwd: receipt.workspace, title: "Terminal benchmark" });

const waitFor = (fn, timeoutMs = 30_000) => evaluate(async (source, timeout) => {
  const check = (0, eval)(source);
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error("Timed out waiting for " + source);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, String(fn), timeoutMs);

// A session created a moment ago can still be unknown to a fresh page, which then falls back to Home.
for (let attempt = 1; ; attempt++) {
  await cdp("Page.navigate", { url: appUrl + "/sessions/" + encodeURIComponent(session.id) });
  try { await waitFor(() => document.querySelector('button[aria-label="Open terminal"]:not([disabled])'), 10_000); break; }
  catch (error) { if (attempt === 3) throw error; }
}
await evaluate(() => document.querySelector('button[aria-label="Open terminal"]').click());
await waitFor(() => { const pane = document.querySelector("hui-terminal-pane"); return pane?.ready && pane.status === "Connected"; });
// Let the shell print its first prompt before measuring.
await new Promise((resolve) => setTimeout(resolve, 1500));
const environment = await evaluate(() => {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  const pane = document.querySelector("hui-terminal-pane");
  return { gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown", userAgent: navigator.userAgent, cols: pane.terminalView?.cols, rows: pane.terminalView?.rows };
});

/** Page-side: the painted screen's rows as text (Gespenst), or the rows around the cursor (ghostty-web baselines). */
const screenRows = String(async () => {
  const term = document.querySelector("hui-terminal-pane")?.terminal;
  if (!term) return [];
  if (term.readViewport) return (await term.readViewport()).viewportRows.map((row) => row.text);
  const grid = term.wasmTerm;
  if (!grid) return [];
  const cursor = grid.getCursor().y;
  const rows = [];
  for (let y = Math.max(0, cursor - 6); y <= cursor; y++) {
    const cells = grid.getLine(y);
    rows.push(cells ? String.fromCodePoint(...cells.map((cell) => cell.codepoint || 32)) : "");
  }
  return rows;
});
/** Page-side: whether the marker is on the painted screen. */
const markerProbe = "async (marker) => (await (" + screenRows + ")()).some((row) => row.includes(marker))";

/** Renderer main-thread busy time (all tasks) and script time, in ms, from the DevTools Performance domain. */
async function mainThread() {
  const { metrics } = await cdp("Performance.getMetrics");
  const value = (name) => (metrics.find((metric) => metric.name === name)?.value ?? 0) * 1000;
  return { task: value("TaskDuration"), script: value("ScriptDuration") };
}
const mainThreadSince = async (start) => { const end = await mainThread(); return { mainThreadMs: Math.round(end.task - start.task), scriptMs: Math.round(end.script - start.script) }; };

/** Sends a command through the terminal API and waits, frame by frame, for its marker. */
async function measureOutput(command, marker) {
  const before = await cpuMs(receipt.serverPid);
  const busy = await mainThread();
  const result = await evaluate(async (probeSource, input, mark) => {
    const probe = (0, eval)(probeSource);
    const bench = window.__terminalBench;
    const pane = document.querySelector("hui-terminal-pane");
    const socket = bench.sockets.at(-1);
    const startMessages = socket.messages, startBytes = socket.bytes;
    // Gespenst keeps a scrolled-back viewport in place while output arrives; start each run at the bottom.
    pane.terminal.scrollToBottom?.();
    const gaps = [];
    const start = performance.now();
    let last = start;
    await fetch("/__hui/sessions/" + encodeURIComponent(pane.ownerSessionId) + "/terminals/" + encodeURIComponent(pane.terminalId), { method: "POST", headers: { "x-hui": "1", "content-type": "application/json" }, body: JSON.stringify({ action: "input", data: input + String.fromCharCode(13) }) });
    const deadline = start + 180_000;
    let end;
    for (;;) {
      const now = await new Promise((done) => requestAnimationFrame(done));
      gaps.push(now - last); last = now;
      if (await probe(mark)) { end = performance.now(); break; }
      if (now > deadline) throw new Error("Marker " + mark + " never painted");
    }
    const tasks = bench.longTasks.filter((task) => task.start >= start && task.start <= end);
    return {
      wallMs: Math.round(end - start),
      longTasks: tasks.length,
      longTaskMs: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)),
      maxLongTaskMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))),
      frames: gaps.length,
      slowFrames: gaps.filter((gap) => gap > 50).length,
      maxFrameGapMs: Math.round(Math.max(...gaps)),
      socketMessages: socket.messages - startMessages,
      socketBytes: socket.bytes - startBytes,
    };
  }, markerProbe, command, marker);
  Object.assign(result, await mainThreadSince(busy));
  result.gatewayCpuMs = (await cpuMs(receipt.serverPid)) - before;
  return result;
}

/** Types characters through the real keyboard path, one at a time; each waits for its echo to be painted. */
async function measureTyping(count = 20) {
  const box = await evaluate(() => { const rect = document.querySelector("hui-terminal-pane .hui-terminal-surface").getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  const latencies = [];
  for (let n = 1; n <= count; n++) {
    const painted = evaluate(async (rowsSource, expected) => {
      const rows = (0, eval)(rowsSource);
      const start = performance.now();
      for (;;) {
        // The echo may wrap: join the rows.
        const text = (await rows()).join("");
        const now = performance.now();
        if (text.includes("q".repeat(expected))) return now - start;
        if (now - start > 5000) throw new Error("Echo " + expected + " never painted");
        await new Promise((done) => requestAnimationFrame(done));
      }
    }, screenRows, n);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "q", code: "KeyQ", text: "q", unmodifiedText: "q", windowsVirtualKeyCode: 81 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81 });
    latencies.push(await painted);
  }
  await evaluate(async () => {
    const pane = document.querySelector("hui-terminal-pane");
    await fetch("/__hui/sessions/" + encodeURIComponent(pane.ownerSessionId) + "/terminals/" + encodeURIComponent(pane.terminalId), { method: "POST", headers: { "x-hui": "1", "content-type": "application/json" }, body: JSON.stringify({ action: "input", data: String.fromCharCode(21) }) });
  });
  const sorted = latencies.sort((a, b) => a - b);
  return { echoMedianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), echoP90Ms: Math.round(sorted[Math.floor(sorted.length * 0.9)]), echoMaxMs: Math.round(sorted.at(-1)) };
}

/** Renderer main-thread time over 3 s with nothing written: the cost of an idle, visible terminal. */
async function measureIdle() {
  const busy = await mainThread();
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return mainThreadSince(busy);
}

/** Wheel-scrolls up through scrollback for ~2 s while recording frame gaps. */
async function measureScroll() {
  const busy = await mainThread();
  const box = await evaluate(() => { const rect = document.querySelector("hui-terminal-pane .hui-terminal-surface").getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; });
  await evaluate(() => {
    const bench = window.__terminalBench;
    bench.scroll = { gaps: [], last: performance.now(), running: true, start: performance.now() };
    const frame = (now) => { const s = bench.scroll; if (!s.running) return; s.gaps.push(now - s.last); s.last = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  for (let i = 0; i < 120; i++) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return evaluate(() => {
    const bench = window.__terminalBench;
    const s = bench.scroll; s.running = false;
    const tasks = bench.longTasks.filter((task) => task.start >= s.start);
    const gaps = s.gaps.slice(1);
    return { frames: gaps.length, droppedFrames: gaps.filter((gap) => gap > 25).length, maxFrameGapMs: Math.round(Math.max(...gaps)), longTasks: tasks.length, longTaskMs: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)) };
  }).then(async (result) => Object.assign(result, await mainThreadSince(busy)));
}

/** Drops the socket; measures from the replay's first message to the replayed marker being painted. */
async function measureReplay(marker) {
  const before = await cpuMs(receipt.serverPid);
  const busy = await mainThread();
  const result = await evaluate(async (probeSource, mark) => {
    const probe = (0, eval)(probeSource);
    const bench = window.__terminalBench;
    const pane = document.querySelector("hui-terminal-pane");
    const count = bench.sockets.length;
    pane.socket.close();
    while (bench.sockets[count]?.first === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
    const record = bench.sockets[count];
    let end;
    for (;;) {
      await new Promise((done) => requestAnimationFrame(done));
      if (pane.ready && await probe(mark)) { end = performance.now(); break; }
    }
    const tasks = bench.longTasks.filter((task) => task.start >= record.first);
    return { replayMs: Math.round(end - record.first), longTaskMs: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)), maxLongTaskMs: Math.round(Math.max(0, ...tasks.map((task) => task.duration))), socketBytes: record.bytes, socketMessages: record.messages };
  }, markerProbe, marker);
  Object.assign(result, await mainThreadSince(busy));
  result.gatewayCpuMs = (await cpuMs(receipt.serverPid)) - before;
  return result;
}

const results = { label: args.label, url: receipt.url, checkout: receipt.checkout?.head, branch: receipt.checkout?.branch, browser: browserPath, environment, startedAt: new Date().toISOString(), runs: {} };
const record = (name, value) => { (results.runs[name] ??= []).push(value); console.error(name + ": " + JSON.stringify(value)); };
const workload = {
  seq: (id) => "seq 1 300000; printf 'BENCH_%s\\n' " + id,
  cat: (id) => "cat bench-5mb.txt; printf 'BENCH_%s\\n' " + id,
  redraw: (id) => "node bench-redraw.mjs; printf 'BENCH_%s\\n' " + id,
};
{
  let lastMarker;
  for (let run = 1; run <= runs; run++) {
    if (scenarios.has("idle")) record("idle", await measureIdle());
    if (scenarios.has("typing")) record("typing", await measureTyping());
    for (const name of ["seq", "cat", "redraw"]) {
      if (!scenarios.has(name)) continue;
      const marker = name.toUpperCase() + run + "DONE";
      record(name, await measureOutput(workload[name](marker), "BENCH_" + marker));
      lastMarker = "BENCH_" + marker;
      if (name !== "redraw") record(name + "-scroll", await measureScroll());
    }
    if (scenarios.has("replay") && lastMarker) record("replay", await measureReplay(lastMarker));
  }
}
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
results.median = Object.fromEntries(Object.entries(results.runs).map(([name, list]) => [name, Object.fromEntries(Object.keys(list[0]).map((key) => [key, median(list.map((item) => item[key]))]))]));
const output = JSON.stringify(results, null, 2);
if (args.out) await writeFile(args.out, output + NL);
console.log(output);
} catch (error) {
  // Keep what the page showed when the run failed, next to the requested output.
  if (socket?.readyState === WebSocket.OPEN && args.out) {
    const shot = await cdp("Page.captureScreenshot", { format: "png" }).catch(() => undefined);
    if (shot) await writeFile(args.out.replace(/[.]json$/u, "") + "-failure.png", Buffer.from(shot.data, "base64"));
    const text = await cdp("Runtime.evaluate", { expression: "location.href + '\\n' + document.body.innerText", returnByValue: true }).catch(() => undefined);
    if (text) await writeFile(args.out.replace(/[.]json$/u, "") + "-failure.txt", String(text.result?.value));
  }
  throw error;
} finally {
  socket?.close();
  await cleanup();
}
