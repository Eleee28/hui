import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { BOT_FACE_COLORS, BOT_FACE_EARS, BOT_FACE_SHAPES, botLook, botSeed, defaultBotLook } from "./bots.ts";
import {
  BOT_FACE_STATES,
  FACE_EYES,
  FACE_GAZE,
  SyllableLevel,
  callFaceState,
  callLevelSource,
  chatFaceState,
  eyesBlink,
  faceBodyColor,
  faceEars,
  faceInk,
  facePath,
  faceViewBox,
  faceTone,
  hasRunningTool,
  levelSquash,
  pointerGaze,
  rosterFaceState,
  settlesWithDone,
  type ChatFaceInput,
} from "./face.ts";
import { initialLiveCallState } from "../voice/live-call.ts";
import type { TranscriptItem } from "../../api/sessions.ts";

const PALETTE: ReadonlySet<string> = new Set(BOT_FACE_COLORS.map((color) => color.hex));
const SHAPES: ReadonlySet<string> = new Set(BOT_FACE_SHAPES);

test("a bot without a stored look gets a face its id picks: the same on every call, rename and machine", () => {
  const id = "0b6c8a52-4f1e-4d0e-9a51-3f1f2f6a7c11";
  const first = botLook({ id });
  assert.deepEqual(botLook({ id }), first);
  assert.deepEqual(botLook({ id, avatar: {} }), first, "an empty avatar changes nothing");
  assert.equal(first.kind, "face");
  assert.deepEqual(first.derived, { shape: true, color: true });
  assert.deepEqual({ shape: first.shape, color: first.color }, defaultBotLook(id));
  // Pinned: changing the hash would silently give every existing bot another face.
  assert.equal(botSeed(id), 269040390);
  assert.deepEqual(defaultBotLook(id), { shape: "blob", color: "#3a7bfa" });
  assert.equal(botSeed("scout"), 1487071437);
  assert.deepEqual(defaultBotLook("scout"), { shape: "triangle", color: "#9b7cf6" });
});

test("the default look is always one of the first five shapes and a palette color, spread across bots", () => {
  const shapes = new Set<string>();
  const colors = new Set<string>();
  for (let index = 0; index < 600; index++) {
    const look = botLook({ id: randomUUID() });
    assert.ok(SHAPES.has(look.shape), look.shape);
    assert.ok(PALETTE.has(look.color), look.color);
    assert.ok(Number.isInteger(look.seed) && look.seed >= 0 && look.seed < 2 ** 32);
    shapes.add(look.shape);
    colors.add(look.color);
  }
  assert.deepEqual([...shapes].sort(), ["blob", "cookie", "heart", "round", "triangle"], "the shapes bots had before the others came, so their faces stay");
  assert.equal(colors.size, BOT_FACE_COLORS.length, "every color is picked");
  const pairs = new Set(Array.from({ length: 400 }, (_, index) => { const look = defaultBotLook(`bot-${index}`); return `${look.shape}${look.color}`; }));
  assert.ok(pairs.size >= 25, `shape and color vary independently (${pairs.size} of 30 pairs)`);
});

test("a stored shape and color win over the id's, and an emoji wins over the face until it is cleared", () => {
  const id = "ledger";
  const stored = botLook({ id, avatar: { shape: "heart", color: "#2FC49A" } });
  assert.equal(stored.kind, "face");
  assert.equal(stored.shape, "heart");
  assert.equal(stored.color, "#2fc49a", "a color reads lowercase");
  assert.deepEqual(stored.derived, { shape: false, color: false });
  const emoji = botLook({ id, avatar: { emoji: "🦊", shape: "heart" } });
  assert.equal(emoji.kind, "emoji");
  assert.equal(emoji.emoji, "🦊");
  assert.equal(emoji.shape, "heart", "the face waits behind the emoji");
  assert.equal(emoji.color, defaultBotLook(id).color, "its tile takes the id's color");
  assert.equal(stored.ears, undefined, "no ears unless chosen; the id never picks any");
  assert.equal(botLook({ id, avatar: { ears: "bunny" } }).ears, "bunny");
  // A record edited by hand: an unknown shape, ears or a bad color falls back to the id's face.
  const odd = botLook({ id, avatar: { shape: "dragon" as never, ears: "wings" as never, color: "teal" } });
  assert.deepEqual({ shape: odd.shape, ears: odd.ears, color: odd.color }, { ...defaultBotLook(id), ears: undefined });
});

const IDLE_CHAT: ChatFaceInput = { status: "idle", streaming: false, question: false, memoryWaiting: false, toolRunning: false, failed: false };

test("an open chat's face: thinking, working on a tool, waiting, summarizing, failed, unreachable", () => {
  assert.equal(chatFaceState(IDLE_CHAT), "idle");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "running", streaming: true }), "thinking");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "starting" }), "thinking");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "running", streaming: true, toolRunning: true }), "working");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "waiting", streaming: true }), "waiting");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "running", streaming: true, question: true, toolRunning: true }), "waiting", "a question outranks the tool that asked it");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "running", streaming: true, memoryWaiting: true }), "memory");
  assert.equal(chatFaceState({ ...IDLE_CHAT, failed: true }), "error", "a failed turn shows until dismissed");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "running", streaming: true, failed: true }), "thinking", "a new turn moves on from it");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "error" }), "error");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "reconnecting" }), "offline");
  assert.equal(chatFaceState({ ...IDLE_CHAT, status: "disconnected" }), "offline");
});

test("only a running tool of the latest turn counts as working", () => {
  const user = (id: string): TranscriptItem => ({ kind: "message", id, role: "user", text: "hi" });
  const tool = (id: string, status: "running" | "succeeded"): TranscriptItem => ({ kind: "tool", id, name: "read", status });
  assert.equal(hasRunningTool([]), false);
  assert.equal(hasRunningTool([user("1"), tool("t1", "running")]), true);
  assert.equal(hasRunningTool([user("1"), tool("t1", "succeeded"), { kind: "message", id: "2", role: "assistant", text: "done" }]), false);
  assert.equal(hasRunningTool([tool("old", "running"), user("1")]), false, "a stale tool before the latest prompt is not this turn's");
});

test("a roster entry maps the bot's activity: resting bots sleep unless open or done, archived bots go offline", () => {
  const usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const memory = { messages: 1, built: 0, pending: 0, viewBytes: 0, viewLines: 0, usage };
  assert.equal(rosterFaceState({ status: "idle", unread: false }), "sleeping");
  assert.equal(rosterFaceState({ status: "idle", unread: true }), "idle", "done, awake until read");
  assert.equal(rosterFaceState({ status: "idle", unread: false }, true), "idle", "the open bot is awake");
  assert.equal(rosterFaceState({ status: "running", unread: false }), "thinking");
  assert.equal(rosterFaceState({ status: "starting", unread: false }), "thinking");
  assert.equal(rosterFaceState({ status: "waiting", unread: false }), "waiting");
  assert.equal(rosterFaceState({ status: "running", unread: false, memory: { ...memory, waiting: true } }), "memory");
  assert.equal(rosterFaceState({ status: "error", unread: false }), "error");
  assert.equal(rosterFaceState({ status: "disconnected", unread: false }), "offline");
  assert.equal(rosterFaceState({ status: "running", unread: false, archived: true }), "offline");
});

test("a call's face listens while the microphone is open and speaks while the bot's voice plays", () => {
  const call = initialLiveCallState(0);
  assert.equal(callFaceState(call), "idle", "connecting");
  assert.equal(callFaceState({ ...call, phase: "listening" }), "listening");
  assert.equal(callFaceState({ ...call, phase: "listening", micMuted: true }), "idle", "a muted microphone hears nothing");
  assert.equal(callFaceState({ ...call, phase: "hearing" }), "listening");
  assert.equal(callFaceState({ ...call, phase: "thinking" }), "thinking");
  assert.equal(callFaceState({ ...call, phase: "thinking", tool: "read" }), "working");
  assert.equal(callFaceState({ ...call, phase: "thinking" }, true), "memory");
  assert.equal(callFaceState({ ...call, phase: "speaking" }), "speaking");
  assert.equal(callFaceState({ ...call, phase: "failed" }), "error");
  assert.equal(callFaceState({ ...call, phase: "ended" }), "offline");
  assert.equal(callLevelSource("listening"), "microphone");
  assert.equal(callLevelSource("speaking"), "voice");
  assert.equal(callLevelSource("thinking"), undefined);
});

test("a turn that ends hops once; other changes do not", () => {
  assert.equal(settlesWithDone("thinking", "idle"), true);
  assert.equal(settlesWithDone("working", "idle"), true);
  assert.equal(settlesWithDone("memory", "idle"), true);
  assert.equal(settlesWithDone("thinking", "sleeping"), true, "a turn someone else read ends asleep");
  assert.equal(settlesWithDone("sleeping", "idle"), false, "waking up is not a finished turn");
  assert.equal(settlesWithDone("waiting", "idle"), false, "an answered question is not a finished turn");
  assert.equal(settlesWithDone("idle", "idle"), false);
  assert.equal(settlesWithDone("thinking", "error"), false);
});

test("every state has the prototype's expression: eyes, resting gaze, blinking only with dot eyes", () => {
  for (const state of BOT_FACE_STATES) {
    assert.ok(FACE_EYES[state], state);
    assert.equal(FACE_GAZE[state].length, 2, state);
  }
  assert.equal(FACE_EYES.thinking, "squint");
  assert.equal(FACE_EYES.listening, "wide");
  assert.equal(FACE_EYES.memory, "sleepy");
  assert.equal(FACE_EYES.error, "sad");
  assert.equal(FACE_EYES.done, "happy");
  assert.equal(FACE_EYES.offline, "closed");
  assert.equal(FACE_EYES.sleeping, "closed");
  assert.equal(eyesBlink("open"), true);
  assert.equal(eyesBlink("closed"), false);
  assert.equal(eyesBlink("happy"), false);
});

test("shapes are closed outlines inside the view box", () => {
  for (const shape of BOT_FACE_SHAPES) {
    const path = facePath(shape);
    assert.match(path, /^M[\d.]+,[\d.]+(C[\d.,\s-]+)+Z$/u, shape);
    const numbers = path.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    assert.ok(numbers.every((value) => value > 10 && value < 112), `${shape} stays inside 120×120`);
  }
  assert.notEqual(facePath("blob", 0), facePath("blob", 1), "the blob morphs with its phase");
  assert.equal(facePath("round", 0), facePath("round", 1), "other shapes hold still");
});

/** Whether x,y is inside the closed outline through the path's segment ends (even-odd ray cast). */
function insideOutline(path: string, x: number, y: number): boolean {
  const ends = [...path.matchAll(/(?:M|\s)(-?[\d.]+),(-?[\d.]+)(?=C|Z)/gu)].map((match) => [Number(match[1]), Number(match[2])] as const);
  let inside = false;
  for (let index = 0, previous = ends.length - 1; index < ends.length; previous = index++) {
    const [x1, y1] = ends[index]!;
    const [x2, y2] = ends[previous]!;
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

test("ears sit on every shape: each part's base inside the body, pairs mirrored, the view box grown to show them", () => {
  for (const shape of BOT_FACE_SHAPES) {
    const body = facePath(shape);
    for (const ears of BOT_FACE_EARS) {
      const placed = faceEars(shape, ears);
      const bases = placed.parts.map((part) => part.transform.match(/^translate\((-?[\d.]+),(-?[\d.]+)\)/u)!.slice(1).map(Number) as [number, number]);
      for (const [x, y] of bases) assert.ok(insideOutline(body, x, y), `${ears} on ${shape}: base ${x},${y} sunk into the body`);
      for (const [x, y] of bases) assert.ok(bases.some(([mx, my]) => Math.abs(mx - (120 - x)) < 0.02 && my === y), `${ears} on ${shape} is symmetric`);
      const [, boxTop] = faceViewBox([12, 18, 96], placed.top).split(" ").map(Number);
      assert.ok(boxTop! <= placed.top, `${ears} on ${shape} fit a small face's view box`);
    }
  }
  assert.equal(faceViewBox([12, 18, 96], undefined), "12 18 96 96", "no ears: the view box as it was");
  assert.equal(faceViewBox([0, 0, 120], 30), "0 0 120 120", "ears that already fit change nothing");
  assert.equal(faceViewBox([12, 18, 96], 8), "6 6 108 108", "taller ears grow it upward, keeping its bottom and middle");
});

test("colors: a muted body after an error, almost grey offline, and eyes that stay visible", () => {
  assert.equal(faceBodyColor("#3A7BFA", "idle"), "#3a7bfa");
  assert.notEqual(faceBodyColor("#3a7bfa", "error"), "#3a7bfa");
  const offline = faceBodyColor("#3a7bfa", "offline");
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(offline.slice(at, at + 2), 16));
  assert.ok(Math.max(r!, g!, b!) - Math.min(r!, g!, b!) < 40, `offline is nearly grey: ${offline}`);
  assert.equal(faceTone("#808080", 1, 1), "#808080", "a tone without change is the color itself");
  for (const color of BOT_FACE_COLORS) assert.equal(faceInk(color.hex), "#141414", `${color.label} keeps the prototype's dark eyes`);
  assert.equal(faceInk("#101820"), "#f4f4f4", "a custom dark body gets light eyes");
});

test("pointer gaze is capped and leans toward the pointer; an audio level squashes the body", () => {
  assert.deepEqual(pointerGaze(1000, 0, 100), { x: 6.5, y: 0, lean: 3 });
  const near = pointerGaze(9, 0, 100);
  assert.ok(near.x > 0 && near.x < 1, "close to the face the eyes move a little");
  assert.deepEqual(pointerGaze(0, 0, 100), { x: 0, y: 0, lean: 0 });
  assert.equal(levelSquash("speaking", 0), "scale(1,1)");
  assert.equal(levelSquash("speaking", 1), "scale(0.95,1.09)");
  assert.equal(levelSquash("listening", 0), "scale(1.03,1.03)", "listening puffs the body out a little");
  assert.equal(levelSquash("listening", 2), levelSquash("listening", 1), "levels clamp to 0–1");
});

test("the stand-in voice makes syllables: bounded, with gaps, softer when listening", () => {
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const voice = new SyllableLevel(random);
  const loud = Array.from({ length: 400 }, (_, index) => voice.at(index * 16));
  assert.ok(loud.every((value) => value >= 0 && value <= 1));
  assert.ok(loud.some((value) => value > 0.4), "it speaks up");
  assert.ok(loud.some((value) => value === 0), "and pauses");
  const quiet = new SyllableLevel(random);
  assert.ok(Math.max(...Array.from({ length: 400 }, (_, index) => quiet.at(index * 16, true))) <= 0.53);
});
