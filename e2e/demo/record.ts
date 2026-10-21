#!/usr/bin/env node
/**
 * Records HUI demo videos: each scene launches a fresh isolated HUI with the
 * scripted demo model (`visual-verification.mjs launch --demo`), plays it in a
 * framed stage page in headless Chrome with a synthetic cursor, captions and
 * zoom, and encodes the screencast to MP4 with ffmpeg. See README.md here.
 *
 *   node e2e/demo/record.ts [scene ...] [--out <dir>] [--voice <model>/<voice>] [--music <file>] [--accept-vscode-license] [--keep]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import { CdpConnection, type CdpEvent } from "../../server/browser/cdp.ts";
import { resolveBrowserExecutable } from "../../server/browser/executable.ts";
import { parseKey } from "../../server/browser/keys.ts";
import { browserLaunchArguments } from "../../server/browser/manager.ts";
import { scenes, type Scene } from "./scenes.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
/** The stage is captured at 4K (its 1920×1080 layout drawn at 2×, for sharp text) and the clips keep that size. */
const STAGE = { width: 3840, height: 2160 };
const VOICE_SPEED = 1.25;
const PACE = 0.7;
/** Kokoro speaks near -19 LUFS: a little louder reads well; the bed sits about 15 LU under it. */
const VOICE_GAIN_DB = 3;
const MUSIC_GAIN_DB = -17;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Visible text, an aria-label, a placeholder or a CSS selector, searched through shadow roots and same-origin frames
 * (such as the VS Code view's). */
export type Target = string | { text?: string; contains?: string; label?: string; placeholder?: string; css?: string; nth?: number; last?: boolean };
type Box = { x: number; y: number; width: number; height: number };
type Line = { file: string; seconds: number };

// Runs on the stage, which shares HUI's origin: the innermost visible element in HUI's frame matching the target, with
// its box in HUI's frame coordinates.
const FIND = `(target) => {
  const norm = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
  const all = [], place = new Map();
  const walk = (root, frame, dx, dy) => {
    for (const element of root.querySelectorAll("*")) {
      all.push(element);
      place.set(element, { frame, dx, dy });
      if (element.shadowRoot) walk(element.shadowRoot, frame, dx, dy);
      let inner;
      try { inner = element.tagName === "IFRAME" && element.contentDocument; } catch { inner = undefined; }
      if (inner) { const box = element.getBoundingClientRect(); walk(inner, element.contentWindow, dx + box.x + element.clientLeft, dy + box.y + element.clientTop); }
    }
  };
  walk(document.getElementById("app").contentDocument, document.getElementById("app").contentWindow, 0, 0);
  const visible = (element) => {
    const { frame } = place.get(element), box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || box.bottom < 0 || box.right < 0 || box.top > frame.innerHeight || box.left > frame.innerWidth) return false;
    const style = frame.getComputedStyle(element);
    return style.visibility !== "hidden" && style.opacity !== "0";
  };
  const text = (element) => norm(element.innerText ?? element.textContent);
  let found = all.filter((element) =>
    (!target.css || element.matches(target.css)) &&
    (!target.label || norm(element.getAttribute("aria-label")) === target.label) &&
    (!target.placeholder || element.getAttribute("placeholder") === target.placeholder) &&
    (!target.text || text(element) === target.text) &&
    (!target.contains || text(element).includes(target.contains)) && visible(element));
  if (!target.css) found = found.filter((element) => !found.some((other) => other !== element && element.contains(other)));
  const element = target.last ? found.at(-1) : found[target.nth ?? 0];
  window.found = element;
  if (!element) return null;
  const box = element.getBoundingClientRect(), { dx, dy } = place.get(element);
  return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
}`;

export class Director {
  readonly #cdp: CdpConnection;
  readonly #session: string;
  constructor(cdp: CdpConnection, session: string) {
    this.#cdp = cdp;
    this.#session = session;
  }

  async send<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) {
    const started = Date.now();
    try {
      return await this.#cdp.send<T>(method, params, this.#session);
    } finally {
      if (process.env["HUI_DEMO_DEBUG"] && Date.now() - started > 1_500) process.stderr.write(`slow ${method} ${Date.now() - started} ms ${JSON.stringify(params).slice(0, 120)}\n`);
    }
  }

  /** Evaluates on the stage page. */
  async stage<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Stage: ${result.exceptionDetails.text} in ${expression}`);
    return result.result.value;
  }

  find(target: Target): Promise<Box | null> {
    return this.stage<Box | null>(`(${FIND})(${JSON.stringify(typeof target === "string" ? { text: target } : target)})`);
  }

  /** Waits until the target is visible; the scripted model makes every wait short. */
  async waitFor(target: Target, timeout = 20_000): Promise<Box> {
    if (process.env["HUI_DEMO_DEBUG"]) process.stderr.write(`${new Date().toISOString()} waitFor ${JSON.stringify(target)}\n`);
    const deadline = Date.now() + timeout;
    for (;;) {
      const box = await this.find(target);
      if (box) return box;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(target)}`);
      await sleep(100);
    }
  }

  async #point(target: Target | { x: number; y: number }) {
    if (typeof target === "object" && "x" in target && typeof target.x === "number") return target;
    const box = await this.waitFor(target as Target);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async #mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    const point = await this.stage<{ x: number; y: number }>(`stage.toStage(${x}, ${y})`);
    await this.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "none", ...extra });
  }

  /** On a phone, input is touch: taps and swipes, and no hover on the way. */
  touch = false;
  async #touch(type: string, points: { x: number; y: number }[]) {
    const touchPoints = await Promise.all(points.map((point) => this.stage<{ x: number; y: number }>(`stage.toStage(${point.x}, ${point.y})`)));
    await this.send("Input.dispatchTouchEvent", { type, touchPoints });
  }

  /** Glides the cursor to a target, sending real mouse moves on the way for hover states (a finger just lands). */
  async move(target: Target | { x: number; y: number }) {
    const to = await this.#point(target);
    const from = await this.stage<{ x: number; y: number }>("stage.cursor()");
    const ms = Math.round(Math.min(1_000, 380 + Math.hypot(to.x - from.x, to.y - from.y) * 0.45));
    await this.stage(`stage.cursorTo(${to.x}, ${to.y}, ${ms})`);
    if (this.touch) {
      await sleep(ms);
      return to;
    }
    const steps = 6;
    for (let step = 1; step <= steps; step++) {
      const eased = 1 - (1 - step / steps) ** 2;
      await this.#mouse("mouseMoved", from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
      await sleep(ms / steps);
    }
    return to;
  }

  async click(target: Target | { x: number; y: number }) {
    const { x, y } = await this.move(target);
    await sleep(120);
    await this.stage("stage.press(true)");
    if (this.touch) {
      await this.#touch("touchStart", [{ x, y }]);
      await sleep(70);
      await this.#touch("touchEnd", []);
    } else {
      await this.#mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
      await sleep(70);
      await this.#mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1 });
    }
    await this.stage("stage.press(false); stage.ripple()");
    await sleep(250);
  }

  /** Types like a person, one character at a time, into the field the cursor clicked. Focus is set too: after a click in
   * a widget's frame, Chrome keeps sending text there. A terminal clears its input as it goes, so it is not checked. */
  async type(text: string, options: { terminal?: boolean } = {}) {
    if (!options.terminal) await this.stage("window.found?.focus()");
    for (const character of text) {
      await this.send("Input.insertText", { text: character });
      await sleep(26 + (character === " " ? 24 : Math.random() * 20));
    }
    if (options.terminal) return;
    const typed = await this.stage<boolean>(`Boolean(document.getElementById("app").contentDocument.activeElement?.value?.endsWith(${JSON.stringify(text)}))`);
    if (!typed) throw new Error(`Typing "${text}" did not reach the field.`);
  }

  /** On a phone, scrolls the content under a target by (deltaX, deltaY): the finger drags the other way. */
  async swipe(target: Target, deltaX: number, deltaY = 0) {
    const { x, y } = await this.#point(target);
    await this.move({ x, y });
    await this.#touch("touchStart", [{ x, y }]);
    for (let step = 1; step <= 12; step++) {
      const [tx, ty] = [x - (deltaX * step) / 12, y - (deltaY * step) / 12];
      await this.#touch("touchMove", [{ x: tx, y: ty }]);
      await this.stage(`stage.cursorTo(${tx}, ${ty}, 40)`);
      await sleep(40);
    }
    await this.#touch("touchEnd", []);
    await sleep(700);
  }

  async press(name: string) {
    const stroke = parseKey(name);
    const base = { modifiers: stroke.modifiers, key: stroke.key, code: stroke.code, windowsVirtualKeyCode: stroke.keyCode, nativeVirtualKeyCode: stroke.keyCode };
    await this.send("Input.dispatchKeyEvent", { type: stroke.text ? "keyDown" : "rawKeyDown", ...base, ...(stroke.text ? { text: stroke.text, unmodifiedText: stroke.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(150);
  }

  /** HTML5 drag and drop through Chrome's drag interception, with a ghost of the dragged element. */
  async drag(from: Target, to: Target) {
    const source = await this.waitFor(from);
    const start = { x: source.x + Math.min(40, source.width / 2), y: source.y + Math.min(24, source.height / 2) };
    await this.move(start);
    const shot = await this.#shot(source);
    const end = await this.#point(to);
    await this.send("Input.setInterceptDrags", { enabled: true });
    const intercepted = new Promise<Record<string, unknown>>((done, fail) => {
      const timer = setTimeout(() => { off(); fail(new Error(`No drag started from ${JSON.stringify(from)}`)); }, 5_000);
      const off = this.#cdp.on((event: CdpEvent) => {
        if (event.method === "Input.dragIntercepted" && event.sessionId === this.#session) { off(); clearTimeout(timer); done(event.params["data"] as Record<string, unknown>); }
      });
    });
    await this.stage("stage.press(true)");
    await this.#mouse("mousePressed", start.x, start.y, { button: "left", buttons: 1, clickCount: 1 });
    await this.#mouse("mouseMoved", start.x + 12, start.y + 6, { button: "left", buttons: 1 });
    const data = await intercepted;
    await this.stage(`stage.ghost(${JSON.stringify(shot)}, ${source.width}, ${source.height}, ${start.x - source.x}, ${start.y - source.y})`);
    const drag = async (type: string, x: number, y: number) => {
      const point = await this.stage<{ x: number; y: number }>(`stage.toStage(${x}, ${y})`);
      await this.send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data, modifiers: 0 });
    };
    await drag("dragEnter", start.x, start.y);
    const ms = Math.round(Math.min(1_400, 600 + Math.hypot(end.x - start.x, end.y - start.y) * 0.5));
    await this.stage(`stage.cursorTo(${end.x}, ${end.y}, ${ms}); stage.moveGhost(${end.x}, ${end.y}, ${ms})`);
    const steps = 12;
    for (let step = 1; step <= steps; step++) {
      const eased = 0.5 - Math.cos((Math.PI * step) / steps) / 2;
      await drag("dragOver", start.x + (end.x - start.x) * eased, start.y + (end.y - start.y) * eased);
      await sleep(ms / steps);
    }
    await sleep(250);
    await drag("drop", end.x, end.y);
    await this.stage("stage.ghost(null); stage.press(false)");
    await this.#mouse("mouseReleased", end.x, end.y, { button: "left", buttons: 0, clickCount: 1 });
    await this.send("Input.setInterceptDrags", { enabled: false });
    await sleep(300);
  }

  async #shot(box: Box): Promise<string> {
    const topLeft = await this.stage<{ x: number; y: number }>(`stage.toStage(${box.x}, ${box.y})`);
    const bottomRight = await this.stage<{ x: number; y: number }>(`stage.toStage(${box.x + box.width}, ${box.y + box.height})`);
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png", clip: { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y, scale: 1 },
    });
    return `data:image/png;base64,${data}`;
  }

  /** Zooms the camera onto a target (factor > 1) or back out (no target). */
  async zoom(target?: Target | { x: number; y: number }, factor = 1.5) {
    if (!target) await this.stage("stage.zoom(0, 0, 1)");
    else {
      const { x, y } = await this.#point(target);
      await this.stage(`stage.zoom(${x}, ${y}, ${factor})`);
    }
    await sleep(750);
  }

  async caption(text = "") {
    await this.stage(`stage.caption(${JSON.stringify(text)})`);
  }

  /** Lets the viewer read; the only fixed waits in a scene are pacing, never synchronization. */
  pause(ms: number) {
    return sleep(ms * PACE);
  }

  /** The scene's narration, synthesized before recording; absent without --voice. */
  voice: Map<string, Line> | undefined;
  /** Where each spoken line starts, in recording time. */
  readonly spoken: { file: string; at: number }[] = [];
  #speakingUntil = 0;

  /** Starts a line of the scene's narration once the previous one has ended, and returns while it plays. */
  async say(key: string) {
    if (!this.voice) return;
    const line = this.voice.get(key);
    if (!line) throw new Error(`The scene has no narration line "${key}".`);
    await this.quiet();
    this.spoken.push({ file: line.file, at: this.clock() });
    this.#speakingUntil = this.clock() + line.seconds + 0.3;
  }

  /** Waits until the narrator has finished speaking, in recording time: a cut does not shorten a line. */
  async quiet() {
    while (this.clock() < this.#speakingUntil) await sleep(50);
  }

  /** Recording time in seconds, which stands still during a cut. */
  clock = () => (Date.now() - this.#cutMs) / 1000;
  cutting = false;
  #cutMs = 0;

  /** Waits without recording: the clip jumps from before to after, like an edit. */
  async cut(work: () => Promise<unknown>) {
    const started = Date.now();
    this.cutting = true;
    try {
      await work();
    } finally {
      this.cutting = false;
      this.#cutMs += Date.now() - started;
    }
  }
}

/** A fresh isolated HUI with the scripted demo model, from the launcher; `stop` also removes its temporary folders. */
async function launchHui() {
  const branch = execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim() || "HEAD";
  // HUI_DEMO_CACHE keeps VS Code's server download (about 220 MB) between clips and runs.
  const child = spawn(process.execPath, [join(repo, "e2e/visual-verification.mjs"), "launch", "--branch", branch, "--demo"],
    { cwd: repo, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, HUI_DEMO_CACHE: join(out, ".cache") } });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  };
  let output = "";
  const receipt = await new Promise<Record<string, string>>((done, fail) => {
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((value) => value.startsWith("{"));
      if (line) done(JSON.parse(line));
    });
    child.once("exit", (code) => fail(new Error(`HUI launch exited (${code}).`)));
  }).catch(async (error) => { await stop(); throw error; });
  return {
    url: receipt["url"]!,
    providerUrl: receipt["providerUrl"]!,
    stop: async () => {
      await stop();
      if (keep) return;
      for (const path of [dirname(receipt["receipt"]!), receipt["workspace"]!]) await rm(path, { recursive: true, force: true });
    },
  };
}

async function startChrome(profile: string) {
  const resolved = await resolveBrowserExecutable("");
  if (!resolved.executable) throw new Error(resolved.error);
  const args = browserLaunchArguments({ profileDir: profile, headless: true, width: STAGE.width, height: STAGE.height }).filter((arg) => arg !== "about:blank");
  const child = spawn(resolved.executable.path, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdp = new CdpConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
  return { child, cdp };
}

/** Encodes screencast frames (shown until the next one arrives) to 30 fps H.264, with the narration and music when
 * there are any. The voice alone also goes to `.voice/<clip>.wav` for the overview. */
async function encode(frames: { file: string; t: number }[], end: number, list: string, output: string, spoken: { file: string; at: number }[]) {
  const lines = ["ffconcat version 1.0"];
  frames.forEach((frame, index) => {
    lines.push(`file '${frame.file}'`, `duration ${Math.max(0.001, (frames[index + 1]?.t ?? end) - frame.t).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1)!.file}'`);
  await writeFile(list, `${lines.join("\n")}\n`);
  // Clock times are absolute; the clip starts at its first frame. Every output is cut to the same length with -t, which
  // the overview's crossfades rely on.
  const start = frames[0]!.t, length = ["-t", (end - start).toFixed(3)];
  const video = ["-f", "concat", "-safe", "0", "-i", list];
  const encodeVideo = ["-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart"];
  if (!voiceModel && !music) return void execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...video, ...encodeVideo, "-an", ...length, output]);
  // The audio is mixed on its own first: in one graph with the frame list, ffmpeg's audio timestamps go backwards.
  const stem = join(dirname(output), ".voice", `${basename(output, ".mp4")}.wav`);
  const mix = join(dirname(list), "mix.wav");
  await mkdir(dirname(stem), { recursive: true });
  const placed = spoken.map((line, index) => `[${index}:a]adelay=${Math.round((line.at - start) * 1_000)}:all=1[line${index}]`);
  const voiceTrack = spoken.length
    ? `${placed.join(";")};${spoken.map((_, index) => `[line${index}]`).join("")}amix=inputs=${spoken.length}:normalize=0,volume=${VOICE_GAIN_DB}dB,aresample=48000,aformat=channel_layouts=stereo,apad`
    : "anullsrc=r=48000:cl=stereo";
  const filter = `${voiceTrack},asplit=2[voice][stem];${mixWithMusic("[voice]", music ? `[${spoken.length}:a]` : "", end - start)}[audio]`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...spoken.flatMap((line) => ["-i", line.file]), ...(music ? ["-stream_loop", "-1", "-i", music] : []),
    "-filter_complex", filter, "-map", "[audio]", ...length, mix, "-map", "[stem]", ...length, stem]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...video, "-i", mix, "-map", "0:v", "-map", "1:a", ...encodeVideo, "-c:a", "aac", "-b:a", "160k", ...length, output]);
}

/** Lays the music bed (looped when short) under a voice track: quiet, faded in and out, and ducked further while the voice speaks. */
function mixWithMusic(voice: string, bed: string, seconds: number): string {
  if (!bed) return `${voice}alimiter=limit=0.95`;
  return `${voice}asplit=2[speech][key];${bed}aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${seconds},volume=${MUSIC_GAIN_DB}dB,`
    + `afade=t=in:d=2,afade=t=out:st=${Math.max(0, seconds - 3)}:d=3[bed];[bed][key]sidechaincompress=threshold=0.02:ratio=4:attack=20:release=500[ducked];`
    + `[ducked][speech]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95`;
}

async function record(scene: Scene, chapter: number, out: string, voice?: Map<string, Line>) {
  const work = await mkdtemp(join(tmpdir(), `hui-demo-${scene.name}-`));
  const frames: { file: string; t: number }[] = [];
  const writes: Promise<void>[] = [];
  let spoken: { file: string; at: number }[] = [];
  let recording = true;
  let failure: unknown;
  let end = 0;
  let hui: Awaited<ReturnType<typeof launchHui>> | undefined;
  let chrome: Awaited<ReturnType<typeof startChrome>> | undefined;
  try {
    hui = await launchHui();
    chrome = await startChrome(join(work, "profile"));
    const { cdp } = chrome;
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const director = new Director(cdp, sessionId);
    await director.send("Page.enable");
    // A background tab paints no frames, and input to it waits for one.
    await director.send("Page.bringToFront");
    await director.send("Emulation.setDeviceMetricsOverride", { ...STAGE, deviceScaleFactor: 1, mobile: false });
    const phone = scene.device === "phone";
    if (phone) await director.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    director.touch = phone;
    await director.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "no-preference" },
      // A phone has a finger, not a mouse: HUI's touch layout keys on these.
      ...(phone ? [{ name: "pointer", value: "coarse" }, { name: "any-pointer", value: "coarse" }, { name: "hover", value: "none" }, { name: "any-hover", value: "none" }] : [])] });
    await director.send("Page.navigate", { url: new URL("/__demo/stage", hui.url).href });
    await director.stage(`new Promise((done) => document.readyState === "complete" ? done() : addEventListener("load", done))`);
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(new URL(path, hui!.url), { method, headers: { "x-hui": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
      return response.json() as Promise<Record<string, any>>;
    };
    const context = { director, api, providerUrl: hui.providerUrl };
    const [width, height] = phone ? [390, 844] : scene.viewport ?? [1440, 810];
    // View preferences, such as the board's grouping, go into the localStorage HUI reads when it loads: the stage shares its origin.
    await director.stage(`Object.entries(${JSON.stringify(scene.storage ?? {})}).forEach(([key, value]) => localStorage.setItem(key, value))`);
    await director.stage(`stage.load(${JSON.stringify(new URL(scene.path ?? "/", hui.url).href)}, ${width}, ${height}, ${JSON.stringify(scene.device ?? "desktop")})`);
    await director.waitFor(scene.ready ?? "Settings", 60_000);
    // Only on the operator's explicit --accept-vscode-license: HUI runs code serve-web only after that acceptance.
    if (scene.vscode) await api("POST", "/__hui/vscode-server", { action: "accept-license" });
    // Before recording starts: the clip opens on the loaded app.
    await scene.setup?.(context);
    director.voice = voice;
    spoken = director.spoken;

    const framesDir = join(work, "frames");
    await mkdir(framesDir, { recursive: true });
    cdp.on((event) => {
      if (event.method !== "Page.screencastFrame" || event.sessionId !== sessionId) return;
      void cdp.send("Page.screencastFrameAck", { sessionId: event.params["sessionId"] }, sessionId).catch(() => undefined);
      if (director.cutting || !recording) return;
      const file = join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
      frames.push({ file, t: director.clock() });
      writes.push(writeFile(file, Buffer.from(String(event.params["data"]), "base64")));
    });
    await director.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: STAGE.width, maxHeight: STAGE.height, everyNthFrame: 1 });
    await director.pause(300);
    await director.stage(`stage.chip(${chapter}, ${JSON.stringify(scene.chapter)})`);
    await director.pause(700);
    await scene.run(context).catch(async (error) => {
      const { data } = await director.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      await writeFile(join(out, `${scene.name}-failed.png`), Buffer.from(data, "base64"));
      throw new Error(`${scene.name} failed; its screen is in ${join(out, `${scene.name}-failed.png`)}`, { cause: error });
    });
    await director.quiet();
    await director.pause(1_200);
    end = director.clock();
    await director.send("Page.stopScreencast");
    await Promise.all(writes);
  } catch (error) {
    recording = false;
    failure = error;
  } finally {
    chrome?.cdp.close();
    if (chrome && chrome.child.exitCode === null && chrome.child.signalCode === null) { chrome.child.kill(); await once(chrome.child, "exit"); }
    await hui?.stop();
  }
  // Only now that Chrome is gone can its profile go.
  if (failure) {
    await Promise.allSettled(writes);
    if (!keep) await rm(work, { recursive: true, force: true });
    throw failure;
  }
  // Encoded once HUI and Chrome are gone.
  const output = join(out, `${scene.name}.mp4`);
  await encode(frames, end, join(work, "frames.txt"), output, spoken);
  if (!keep) await rm(work, { recursive: true, force: true });
  process.stdout.write(`${output} (${frames.length} frames, ${(end - frames[0]!.t).toFixed(1)} s)\n`);
}

/** The overview: every clip in order, crossfaded, with their voices and one continuous music bed. */
function overview(out: string, names: string[]) {
  const FADE = 0.5;
  const files = names.map((name) => join(out, `${name}.mp4`));
  const seconds = files.map((file) => Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=duration", "-of", "csv=p=0", file], { encoding: "utf8" })));
  const total = seconds.reduce((sum, value) => sum + value, 0) - FADE * (files.length - 1);
  const audio = Boolean(voiceModel || music);
  // Each voice is cut to its clip's video, so the crossfades line up.
  let filter = audio ? seconds.map((value, index) => `[${files.length + index}:a]apad=whole_dur=${value},atrim=duration=${value}[stem${index}];`).join("") : "";
  let video = "[0:v]", voice = "[stem0]", offset = 0;
  for (let index = 1; index < files.length; index++) {
    // Each fade starts FADE seconds before the end of everything joined so far.
    offset += seconds[index - 1]! - FADE;
    filter += `${video}[${index}:v]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[video${index}];`;
    video = `[video${index}]`;
    if (audio) {
      filter += `${voice}[stem${index}]acrossfade=d=${FADE}[voice${index}];`;
      voice = `[voice${index}]`;
    }
  }
  const stems = audio ? names.flatMap((name) => ["-i", join(out, ".voice", `${name}.wav`)]) : [];
  if (audio) filter += `${mixWithMusic(voice, music ? `[${files.length * 2}:a]` : "", total)}[audio];`;
  const output = join(out, "overview.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...files.flatMap((file) => ["-i", file]), ...stems, ...(audio && music ? ["-stream_loop", "-1", "-i", music] : []),
    "-filter_complex", `${filter}${video}fps=30[video]`, "-map", "[video]", ...(audio ? ["-map", "[audio]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-t", total.toFixed(3), "-movflags", "+faststart", output]);
  // GitHub takes videos up to 100 MB on a paid plan and 10 MB on a free one.
  const megabytes = statSync(output).size / 1e6;
  if (megabytes > 100) process.stderr.write(`overview.mp4 is ${megabytes.toFixed(0)} MB: too big for a GitHub attachment; record fewer clips.\n`);
}

/** The scene's narration lines as audio files, synthesized once per text and voice by VoiceStudio's OpenAI-style speech API. */
async function narrate(scene: Scene): Promise<Map<string, Line> | undefined> {
  if (!voiceModel) return undefined;
  const [model, voiceName] = voiceModel.split("/");
  const lines = new Map<string, Line>();
  await mkdir(join(out, ".voice"), { recursive: true });
  for (const [key, text] of Object.entries(scene.narration ?? {})) {
    const file = join(out, ".voice", `${createHash("sha256").update(`${voiceModel}\n${VOICE_SPEED}\n${text}`).digest("hex").slice(0, 16)}.wav`);
    if (!existsSync(file)) {
      const response = await fetch(new URL("/v1/audio/speech", voiceUrl), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, voice: voiceName, input: text, response_format: "wav", language: "en", speed: VOICE_SPEED }),
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/")) throw new Error(`VoiceStudio could not say "${text}": ${response.status} ${await response.text()}`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
    }
    lines.set(key, { file, seconds: Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" })) });
  }
  return lines;
}

const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); return index === -1 ? undefined : args.splice(index, 2)[1]; };
const out = resolve(option("--out") ?? join(tmpdir(), "hui-demo-videos"));
const keep = args.includes("--keep");
const acceptVscodeLicense = args.includes("--accept-vscode-license");
// --voice <model>/<voice> narrates through VoiceStudio (VOICESTUDIO_URL, default its local port), e.g. mlx-audio/af_heart.
const voiceModel = option("--voice");
if (voiceModel && !/^[^/]+\/[^/]+$/u.test(voiceModel)) throw new Error("--voice takes <model>/<voice>, for example mlx-audio/af_heart.");
const voiceUrl = process.env["VOICESTUDIO_URL"] ?? "http://127.0.0.1:3900";
// --music <file> lays a quiet bed under each clip and the overview.
const musicFile = option("--music");
const music = musicFile && resolve(musicFile);
const wanted = args.filter((arg) => !arg.startsWith("--"));
const selected = wanted.length ? scenes.filter((scene) => wanted.includes(scene.name)) : scenes;
if (selected.length !== (wanted.length || scenes.length)) throw new Error(`Unknown scene. Scenes: ${scenes.map((scene) => scene.name).join(", ")}`);
const needsLicense = selected.filter((scene) => scene.vscode).map((scene) => scene.name);
if (needsLicense.length && !acceptVscodeLicense) {
  throw new Error(`${needsLicense.join(", ")} opens VS Code through Microsoft's code serve-web. Pass --accept-vscode-license to accept the VS Code Server license (https://aka.ms/vscode-server-license) for the demo HUI, or leave the clip out.`);
}
await mkdir(out, { recursive: true });
for (const [index, scene] of selected.entries()) await record(scene, index + 1, out, await narrate(scene));
// Several clips also make an overview: every clip for the README, a release's new ones for its notes.
if (selected.length > 1) {
  overview(out, selected.map((scene) => scene.name));
  process.stdout.write(`${join(out, "overview.mp4")}\n`);
}
