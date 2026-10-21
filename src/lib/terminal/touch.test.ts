import assert from "node:assert/strict";
import { test } from "vitest";
import { TerminalTouchGesture, type TouchLikeEvent, type TouchPoint } from "./touch.ts";

const point = (x: number, y: number, identifier = 1): TouchPoint => ({ identifier, screenX: x, screenY: y, clientX: x, clientY: y });
function event(touches: TouchPoint[], timeStamp: number, changed: TouchPoint[] = touches) {
  const value = { touches, changedTouches: changed, timeStamp, prevented: false, preventDefault() { value.prevented = true; } };
  return value satisfies TouchLikeEvent;
}

function gesture() {
  const scrolls: number[] = [];
  const taps: [number, number][] = [];
  const frames: ((now: number) => void)[] = [];
  const handle = new TerminalTouchGesture({
    scroll: (delta) => scrolls.push(delta),
    tap: (x, y) => taps.push([x, y]),
    frame: (callback) => frames.push(callback),
    cancelFrame: () => { frames.length = 0; },
    now: () => 1000,
  });
  return { handle, scrolls, taps, frames };
}

test("a vertical drag scrolls and is kept from the page", () => {
  const { handle, scrolls, taps } = gesture();
  handle.start(event([point(100, 300)], 0));
  const small = event([point(100, 297)], 10);
  handle.move(small);
  assert.deepEqual(scrolls, [], "within the slop nothing scrolls yet");
  assert.equal(small.prevented, false);
  const drag = event([point(100, 260)], 200);
  handle.move(drag);
  handle.move(event([point(100, 240)], 400));
  assert.equal(drag.prevented, true);
  assert.deepEqual(scrolls, [37, 20], "dragging up moves toward newer output, from the last point seen");
  const end = event([], 600, [point(100, 240)]);
  handle.end(end);
  assert.equal(end.prevented, true);
  assert.deepEqual(taps, []);
});

test("a flick glides on and a new touch stops it", () => {
  const { handle, scrolls, frames } = gesture();
  handle.start(event([point(50, 400)], 0));
  handle.move(event([point(50, 380)], 8));
  handle.move(event([point(50, 300)], 16));
  handle.end(event([], 20, [point(50, 300)]));
  assert.equal(frames.length, 1);
  const before = scrolls.length;
  frames.shift()!(1016);
  assert.ok(scrolls.length > before && scrolls.at(-1)! > 0, "keeps scrolling toward newer output");
  handle.start(event([point(50, 300)], 40));
  assert.equal(frames.length, 0, "the glide stops");
});

test("a short tap focuses at its point; a horizontal drag or a second finger does nothing", () => {
  const { handle, scrolls, taps } = gesture();
  handle.start(event([point(10, 10)], 0));
  const tap = event([], 50, [point(13, 12)]);
  handle.end(tap);
  assert.deepEqual(taps, [[13, 12]]);
  assert.equal(tap.prevented, true);

  handle.start(event([point(10, 10)], 0));
  handle.move(event([point(60, 12)], 20));
  handle.end(event([], 40, [point(60, 12)]));
  handle.start(event([point(10, 10), point(30, 30, 2)], 0));
  handle.end(event([point(30, 30, 2)], 40, [point(10, 10)]));
  assert.deepEqual(taps, [[13, 12]]);
  assert.deepEqual(scrolls, []);
});
