/**
 * Bots' animated faces (HUI-18), the pure half: what a face shows for a bot's
 * roster entry, its open chat and its call, and the geometry and colors of
 * the face itself, ported from the prototype the owner approved on
 * 2026-10-06 (OpenAI Dots: a plush shape, two dot eyes, no mouth), and the
 * ears, antenna, sprout or horns that may sit on top, placed for each shape.
 * `<hui-bot-face>` (src/components/bot-face.ts) draws it.
 */
import type { BotFaceEars, BotFaceShape } from "../../api/schema/bots.ts";
import type { BotView } from "./bots.ts";
import { botActivity } from "./roster.ts";
import type { CallView } from "../voice/live-call.ts";
import type { SessionStatus, TranscriptItem } from "../../api/sessions.ts";

/* ── states ───────────────────────────────────────────────────────────── */

export const BOT_FACE_STATES = ["idle", "sleeping", "thinking", "working", "speaking", "listening", "waiting", "memory", "error", "done", "offline"] as const;
export type BotFaceState = (typeof BOT_FACE_STATES)[number];

/** What each state means, in the prototype's words. Faces are decorative: the
 * views keep their own status text, so these name the states in tests and docs. */
export const BOT_FACE_STATE_LABELS: Readonly<Record<BotFaceState, string>> = {
  idle: "Idle",
  sleeping: "Sleeping",
  thinking: "Thinking…",
  working: "Using tools…",
  speaking: "Speaking",
  listening: "Listening…",
  waiting: "Needs your answer",
  memory: "Summarizing memory…",
  error: "Something went wrong",
  done: "Done",
  offline: "Offline",
};

export function isBotFaceState(value: unknown): value is BotFaceState {
  return typeof value === "string" && (BOT_FACE_STATES as readonly string[]).includes(value);
}

/** Small for roster rows and the call bar, medium for the chat header, large
 * for the empty chat, extra large for the call. */
export const BOT_FACE_SIZES = ["sm", "md", "lg", "xl"] as const;
export type BotFaceSize = (typeof BOT_FACE_SIZES)[number];

/** Only the large faces follow the pointer, morph and take an audio level. */
export function isLiveFaceSize(size: BotFaceSize): boolean {
  return size === "lg" || size === "xl";
}

/** A roster entry knows only the bot's view: a running turn reads as thinking, and a bot with nothing to do or show
 * sleeps. */
export function rosterFaceState(bot: Pick<BotView, "status" | "memory" | "unread" | "archived">, open = false): BotFaceState {
  if (bot.archived) return "offline";
  switch (botActivity(bot, open)) {
    case "waiting": return "waiting";
    case "error": return "error";
    case "away": return "offline";
    case "summarizing": return "memory";
    case "running": return "thinking";
    case "idle":
    case "done": return "idle";
    case "sleeping": return "sleeping";
  }
}

export type ChatFaceInput = {
  status: SessionStatus;
  /** A turn is in flight. */
  streaming: boolean;
  /** A question waits for the operator. */
  question: boolean;
  /** The turn waits for OptChat to summarize the newest messages. */
  memoryWaiting: boolean;
  /** A tool call of the current turn is running. */
  toolRunning: boolean;
  /** The last turn ended on an error nobody dismissed. */
  failed: boolean;
};

/** A bot's open chat sees more than its roster entry: a running tool and a failed turn. */
export function chatFaceState(input: ChatFaceInput): BotFaceState {
  if (input.question || input.status === "waiting") return "waiting";
  if (input.status === "error") return "error";
  if (input.status === "reconnecting" || input.status === "disconnected") return "offline";
  if (input.memoryWaiting) return "memory";
  if (input.streaming || input.status === "running" || input.status === "starting") return input.toolRunning ? "working" : "thinking";
  if (input.failed) return "error";
  return "idle";
}

/** A tool call of the latest turn (after the last user message) that is still running. */
export function hasRunningTool(transcript: readonly TranscriptItem[]): boolean {
  for (let index = transcript.length - 1; index >= 0; index--) {
    const item = transcript[index]!;
    if (item.kind === "tool" && item.status === "running") return true;
    if (item.kind === "message" && item.role === "user") return false;
  }
  return false;
}

/** A call: the bot listens while the microphone is open and speaks while its voice plays. */
export function callFaceState(call: Pick<CallView, "phase" | "micMuted" | "tool">, summarizing = false): BotFaceState {
  switch (call.phase) {
    case "connecting": return "idle";
    case "listening": return call.micMuted ? "idle" : "listening";
    case "hearing": return "listening";
    case "thinking": return summarizing ? "memory" : call.tool ? "working" : "thinking";
    case "speaking": return "speaking";
    case "ended": return "offline";
    case "failed": return "error";
  }
}

/** Which audio moves the face during a call: the microphone while it listens, the bot's voice while it speaks. */
export function callLevelSource(state: BotFaceState): "microphone" | "voice" | undefined {
  return state === "listening" ? "microphone" : state === "speaking" ? "voice" : undefined;
}

/** A turn that ends plays the one-shot "done" hop before the face rests again. */
export function settlesWithDone(previous: BotFaceState, next: BotFaceState): boolean {
  return (next === "idle" || next === "sleeping") && (previous === "thinking" || previous === "working" || previous === "memory");
}

/* ── expression ───────────────────────────────────────────────────────── */

export type FaceEyes = "open" | "squint" | "wide" | "sad" | "closed" | "happy" | "sleepy";

export const FACE_EYES: Readonly<Record<BotFaceState, FaceEyes>> = {
  idle: "open", sleeping: "closed", thinking: "squint", working: "squint", speaking: "open", listening: "wide",
  waiting: "open", memory: "sleepy", error: "sad", done: "happy", offline: "closed",
};

/** Eyes drawn as dots blink; lines and arcs do not. */
export function eyesBlink(eyes: FaceEyes): boolean {
  return eyes === "open" || eyes === "squint" || eyes === "wide" || eyes === "sad";
}

/** A sprout's leaves: green whatever the body's color. */
export const FACE_LEAF_COLOR = "#3fae5a";

/** Where the eyes sit on each shape, in the 120×120 view box. */
export const FACE_EYE_POSITION: Readonly<Record<BotFaceShape, readonly [number, number]>> = {
  blob: [60, 63], round: [60, 62], triangle: [60, 77], heart: [60, 56], cookie: [60, 63],
  star: [60, 68], flower: [60, 67], cloud: [60, 72], drop: [60, 74], ghost: [60, 60], pill: [60, 68], block: [60, 63], hexagon: [60, 64],
};

/** Where each state rests its gaze (view-box units). */
export const FACE_GAZE: Readonly<Record<BotFaceState, readonly [number, number]>> = {
  idle: [0, 0], sleeping: [0, 1], thinking: [5, -4.2], working: [1.5, 2.6], speaking: [0, 0], listening: [0, -0.6],
  waiting: [3, -3.4], memory: [0, 1], error: [0, 1.6], done: [0, -1], offline: [0, 1],
};

/** States whose eyes follow the pointer; the others keep their own gaze. */
export const FACE_FOLLOWS_POINTER: ReadonlySet<BotFaceState> = new Set(["idle", "listening", "waiting", "speaking", "done"]);

/** The gaze and lean toward a pointer dx, dy pixels from the face's center, for a face width pixels wide. */
export function pointerGaze(dx: number, dy: number, width: number): { x: number; y: number; lean: number } {
  const length = Math.hypot(dx, dy) || 1;
  const reach = Math.min(1, length / (Math.max(1, width) * 0.9));
  return { x: round2((dx / length) * 6.5 * reach), y: round2((dy / length) * 4 * reach), lean: round2((dx / length) * reach * 3) };
}

/** The body's squash for an audio level (0–1): speaking stretches up, listening puffs out. */
export function levelSquash(state: BotFaceState, level: number): string {
  const amp = Math.max(0, Math.min(1, level));
  return state === "speaking"
    ? `scale(${round2(1 - amp * 0.05)},${round2(1 + amp * 0.09)})`
    : `scale(${round2(1.035 + amp * 0.02)},${round2(1.035 + amp * 0.035)})`;
}

/* ── geometry ─────────────────────────────────────────────────────────── */

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A closed Catmull-Rom spline through the points, as cubic Béziers. */
function smoothPath(points: readonly (readonly [number, number])[]): string {
  const count = points.length;
  let d = `M${round2(points[0]![0])},${round2(points[0]![1])}`;
  for (let index = 0; index < count; index++) {
    const p0 = points[(index - 1 + count) % count]!;
    const p1 = points[index]!;
    const p2 = points[(index + 1) % count]!;
    const p3 = points[(index + 2) % count]!;
    d += `C${round2(p1[0] + (p2[0] - p0[0]) / 6)},${round2(p1[1] + (p2[1] - p0[1]) / 6)} ${round2(p2[0] - (p3[0] - p1[0]) / 6)},${round2(p2[1] - (p3[1] - p1[1]) / 6)} ${round2(p2[0])},${round2(p2[1])}`;
  }
  return `${d}Z`;
}

type Point = readonly [number, number];

function polarPoints(radius: (angle: number) => number, cy: number, squeeze = 1, count = 72): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2;
    const r = radius(angle);
    points.push([60 + Math.cos(angle) * r, cy + Math.sin(angle) * r * squeeze]);
  }
  return points;
}

/** A regular polygon's polar radius blended with a circle's (a superellipse-style cap), so the corners stay soft. */
function softPolygon(sides: number, inradius: number, cap: number, start: number, power: number): (angle: number) => number {
  const sector = (Math.PI * 2) / sides;
  return (a) => {
    const offset = (((a - start) % sector) + sector) % sector - sector / 2;
    const r = inradius / Math.cos(offset);
    return (r ** -power + cap ** -power) ** (-1 / power);
  };
}

/** Points along a closed run of segments, each a function of t in [0, 1), count of them in all. */
function piecewise(count: number, pieces: readonly [share: number, at: (t: number) => Point][]): Point[] {
  const points: Point[] = [];
  for (const [share, at] of pieces) {
    const steps = Math.round(count * share);
    for (let index = 0; index < steps; index++) points.push(at(index / steps));
  }
  return points;
}

/** The body's outline as points a spline runs through, in the 120×120 view box. */
function outline(shape: BotFaceShape, phase: number): Point[] {
  switch (shape) {
    case "blob":
      return polarPoints((a) => 37.5 * (1 + 0.038 * Math.sin(7 * a + phase) + 0.03 * Math.sin(3 * a - phase * 0.7) + 0.012 * Math.sin(11 * a + phase * 1.3)), 67);
    case "round": return polarPoints(() => 38.5, 66, 0.93);
    case "cookie": return polarPoints((a) => 37 * (1 + 0.045 * Math.cos(10 * a)), 67);
    case "triangle": return polarPoints(softPolygon(3, 27.5, 46.5, -Math.PI / 2, 6), 75);
    case "heart": {
      const points: Point[] = [];
      for (let index = 0; index < 72; index++) {
        const t = (index / 72) * Math.PI * 2;
        const x = 16 * Math.sin(t) ** 3;
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        // Pulled toward a circle, so the heart reads as plush rather than sharp.
        const r = Math.hypot(x, y) * 0.78 + 13.5 * 0.22;
        const angle = Math.atan2(y, x);
        points.push([60 + Math.cos(angle) * r * 2.55, 61 + Math.sin(angle) * r * 2.45]);
      }
      return points;
    }
    // Five arms, one up; rounded tips and valleys.
    case "star": return polarPoints((a) => 30 + 14 * ((Math.cos(5 * (a + Math.PI / 2)) + 1) / 2) ** 1.6, 67, 1, 90);
    // Five round petals, one up.
    case "flower": return polarPoints((a) => 29 + 10 * Math.abs(Math.cos(2.5 * (a + Math.PI / 2))) ** 0.5, 68, 1, 90);
    // Puffs along the top, a flatter bottom.
    case "cloud": return polarPoints((a) => Math.sin(a) > 0 ? 36 : 36 + 5 * Math.abs(Math.sin(4 * a)) ** 0.6, 76, 1, 120)
      .map(([x, y]) => [60 + (x - 60) * 1.08, 76 + (y - 76) * (y > 76 ? 0.62 : 0.86)]);
    // A circle whose top is drawn up into a soft point.
    case "drop": return polarPoints(() => 1, 70, 1, 96).map(([x, y]) => {
      const up = Math.max(0, 70 - y);
      const r = 32 * (1 + 0.5 * up ** 6);
      return [60 + (x - 60) * r * (1 - 0.45 * up ** 2), 70 + (y - 70) * r];
    });
    // A dome over straight sides and a skirt of four points.
    case "ghost": return piecewise(96, [
      [0.5, (t) => [60 - Math.cos(t * Math.PI) * 34, 58 - Math.sin(t * Math.PI) * 34]],
      [0.1, (t) => [94, 58 + t * 44]],
      [0.3, (t) => [94 - t * 68, 98 + 4 * Math.cos(t * Math.PI * 6)]],
      [0.1, (t) => [26, 102 - t * 44]],
    ]);
    // A wide capsule: a superellipse.
    case "pill": return polarPoints((a) => (Math.abs(Math.cos(a) / 42) ** 2.6 + Math.abs(Math.sin(a) / 30) ** 2.6) ** (-1 / 2.6), 70);
    // A squircle.
    case "block": return polarPoints((a) => 36 / (Math.abs(Math.cos(a)) ** 4 + Math.abs(Math.sin(a)) ** 4) ** 0.25, 67, 0.94);
    case "hexagon": return polarPoints(softPolygon(6, 33, 40, 0, 7), 66);
  }
}

/** The body outline in the 120×120 view box. phase turns the blob's wobble (it morphs slowly on large faces). */
export function facePath(shape: BotFaceShape, phase = 0): string {
  return smoothPath(outline(shape, phase));
}

/** One filled part of what sits on top, drawn behind the body; `leaf` parts are a sprout's green, the rest the body's color. */
export type FaceEarPart = { d: string; transform: string; leaf?: boolean };

/**
 * Each kind drawn upright with its base at 0,0, sunk into the body, inside `box` ([left, top, right]). A pair
 * sits on the `shoulders`, `spread` degrees either side of straight up from the body's middle, leaning out with the
 * outline by `lean` of its slope; a single one stands on the top.
 */
const EARS: Readonly<Record<BotFaceEars, { parts: readonly { d: string; leaf?: boolean }[]; box: readonly [number, number, number]; shoulders?: { spread: number; lean: number } }>> = {
  cat: { parts: [{ d: "M-12 4C-10 -8 -6 -20 -2.2 -26.5Q0 -29 2.2 -26.5C6 -20 10 -8 12 4Z" }], box: [-12, -28, 12], shoulders: { spread: 40, lean: 0.75 } },
  bear: { parts: [{ d: "M0 -18A11 11 0 1 1 0 4A11 11 0 1 1 0 -18Z" }], box: [-11, -18, 11], shoulders: { spread: 46, lean: 1 } },
  bunny: { parts: [{ d: "M0 -40C5 -40 8 -30 8 -18C8 -6 5 4 0 4C-5 4 -8 -6 -8 -18C-8 -30 -5 -40 0 -40Z" }], box: [-8, -40, 8], shoulders: { spread: 20, lean: 0.35 } },
  horns: { parts: [{ d: "M-7 4C-8 -6 -7 -15 -3 -22Q-1.5 -24 -0.6 -22C1 -14 4 -6 7 4Z" }], box: [-8, -23.5, 7], shoulders: { spread: 32, lean: 0.7 } },
  antenna: { parts: [{ d: "M-1.6 6L-1.6 -14Q0 -15.6 1.6 -14L1.6 6Z" }, { d: "M0 -25A5.2 5.2 0 1 1 0 -14.6A5.2 5.2 0 1 1 0 -25Z" }], box: [-5.2, -25, 5.2] },
  sprout: { parts: [
    { d: "M-1.4 6C-2 -1 -1.6 -8 -0.2 -13L1.6 -12.6C0.6 -7.6 0.4 -1 1.4 6Z", leaf: true },
    { d: "M0 -12C-4 -21 -12 -23 -18 -18C-12 -12 -5 -11 0 -12Z", leaf: true },
    { d: "M0 -12C3 -23 12 -26 19 -21C14 -13 6 -11 0 -12Z", leaf: true },
  ], box: [-18, -25, 19] },
};

/** How far a base sinks into the body, so a part never floats off a wobbling outline. */
const EAR_SINK = 5;

/** The parts that sit on a shape's top, placed for its outline, the highest y they reach (view-box units), and
 * whether they come as a pair on the shoulders, where the memory state's thought dots would land. */
export function faceEars(shape: BotFaceShape, ears: BotFaceEars): { parts: FaceEarPart[]; top: number; pair: boolean } {
  const points = outline(shape, 0);
  const ys = points.map(([, y]) => y);
  const middle = (Math.min(...ys) + Math.max(...ys)) / 2;
  const kind = EARS[ears];
  const place = (x: number, y: number, tilt: number, mirror = false) =>
    `translate(${round2(x)},${round2(y)}) rotate(${round2(tilt)})${mirror ? " scale(-1,1)" : ""}`;
  if (!kind.shoulders) {
    // The top of the outline at the middle, a heart's dip included.
    const [, top] = points.filter(([, y]) => y < middle).reduce((best, point) => Math.abs(point[0] - 60) < Math.abs(best[0] - 60) ? point : best);
    const y = top + EAR_SINK;
    return { parts: kind.parts.map((part) => ({ ...part, transform: place(60, y, 0) })), top: y + kind.box[1], pair: false };
  }
  // The outline point on the left shoulder, and the outward lean of the outline there.
  const target = -Math.PI / 2 - (kind.shoulders.spread * Math.PI) / 180;
  const gap = (index: number) => {
    const [x, y] = points[index]!;
    const delta = Math.atan2(y - middle, x - 60) - target;
    return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
  };
  let best = 0;
  for (let index = 1; index < points.length; index++) if (gap(index) < gap(best)) best = index;
  const [x, y] = points[best]!;
  const before = points[(best - 1 + points.length) % points.length]!;
  const after = points[(best + 1) % points.length]!;
  // The outward normal, from the tangent; its angle from straight up is the slope the ear leans with.
  let nx = after[1] - before[1];
  let ny = before[0] - after[0];
  if (nx * (x - 60) + ny * (y - middle) < 0) { nx = -nx; ny = -ny; }
  const length = Math.hypot(nx, ny) || 1;
  const tilt = (Math.atan2(nx, -ny) * 180) / Math.PI * kind.shoulders.lean;
  const baseX = x - (nx / length) * EAR_SINK;
  const baseY = y - (ny / length) * EAR_SINK;
  const parts = kind.parts.flatMap((part) => [
    { ...part, transform: place(baseX, baseY, tilt) },
    { ...part, transform: place(120 - baseX, baseY, -tilt, true) },
  ]);
  // The box's top corners, turned with the ear, bound how high it reaches.
  const [left, boxTop, right] = kind.box;
  const [sin, cos] = [Math.sin((tilt * Math.PI) / 180), Math.cos((tilt * Math.PI) / 180)];
  return { parts, top: baseY + boxTop * cos + Math.min(left * sin, right * sin), pair: true };
}

/** A view box `[x, y, size]` grown upward (keeping its bottom and center) so parts reaching to `top` fit. */
export function faceViewBox(box: readonly [number, number, number], top: number | undefined): string {
  const [x, y, size] = box;
  if (top === undefined || top - 2 >= y) return `${x} ${y} ${size} ${size}`;
  const grown = round2(y + size - (top - 2));
  return `${round2(x + size / 2 - grown / 2)} ${round2(top - 2)} ${grown} ${grown}`;
}

const HEX = /^#[0-9a-f]{6}$/iu;
const FALLBACK_COLOR = "#3a7bfa";

function channels(hex: string): [number, number, number] {
  const value = HEX.test(hex) ? hex : FALLBACK_COLOR;
  return [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255];
}

/** hex with its saturation and lightness scaled (HSL), as #rrggbb. */
export function faceTone(hex: string, saturation: number, lightness: number): string {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  let s = 0;
  let h = 0;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  s *= saturation;
  l = Math.min(0.9, l * lightness);
  const hue = (p: number, q: number, t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return "#" + [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
}

/** The body's color in a state: muted after an error, almost grey offline. */
export function faceBodyColor(color: string, state: BotFaceState): string {
  if (state === "error") return faceTone(color, 0.55, 0.96);
  if (state === "offline") return faceTone(color, 0.12, 1.08);
  return HEX.test(color) ? color.toLowerCase() : FALLBACK_COLOR;
}

/** Relative luminance (WCAG) of #rrggbb. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Eye color: the prototype's near-black, or near-white on a body too dark for it (a custom color from the API). */
export function faceInk(color: string): string {
  return luminance(color) < 0.08 ? "#f4f4f4" : "#141414";
}

/* ── a stand-in voice ─────────────────────────────────────────────────── */

/**
 * The prototype's syllable rhythm: an audio-like level for a face that speaks
 * or listens without a measured one.
 * Quiet mode is softer and pauses more, like a room being listened to.
 */
export class SyllableLevel {
  readonly #random: () => number;
  #next = 0;
  #start = -1;
  #peak = 0;
  #length = 1;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  at(now: number, quiet = false): number {
    if (now >= this.#next) {
      const random = this.#random;
      this.#start = now;
      this.#peak = quiet ? 0.18 + random() * 0.35 : 0.45 + random() * 0.55;
      this.#length = quiet ? 90 + random() * 110 : 120 + random() * 150;
      this.#next = now + this.#length + (random() < (quiet ? 0.35 : 0.18) ? 380 + random() * 600 : 25 + random() * 70);
    }
    const t = now - this.#start;
    return t < 0 || t > this.#length ? 0 : this.#peak * Math.sin((Math.PI * t) / this.#length) ** 0.8;
  }
}
