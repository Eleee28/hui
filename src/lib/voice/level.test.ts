import assert from "node:assert/strict";
import { test } from "vitest";
import { LEVEL_CEILING_DB, LEVEL_FLOOR_DB, frameLevel, frameLevelDb, levelFromDb } from "./level.ts";

const tone = (amplitude: number, samples: number) => Float32Array.from({ length: samples }, (_, index) => amplitude * Math.sin((2 * Math.PI * 220 * index) / 16_000));

test("frames are measured in dBFS, digital silence at -120", () => {
  assert.equal(frameLevelDb(new Float32Array(320)), -120);
  // A sine's RMS is its amplitude over √2: 0.3 is about -13.5 dBFS.
  assert.ok(Math.abs(frameLevelDb(tone(0.3, 320)) - -13.5) < 0.5);
  assert.ok(frameLevelDb(tone(0.0005, 320)) < -65);
});

test("a level is 0 for a quiet room and 1 for loud speech, linear in decibels between", () => {
  assert.equal(levelFromDb(-120), 0);
  assert.equal(levelFromDb(LEVEL_FLOOR_DB), 0);
  assert.equal(levelFromDb(LEVEL_CEILING_DB), 1);
  assert.equal(levelFromDb(0), 1);
  assert.equal(levelFromDb((LEVEL_FLOOR_DB + LEVEL_CEILING_DB) / 2), 0.5);
  assert.equal(levelFromDb(Number.NaN), 0);
  assert.equal(frameLevel(new Float32Array(320)), 0, "digital silence");
  assert.ok(frameLevel(tone(0.3, 320)) > 0.9, "speech-loud");
  assert.ok(frameLevel(tone(0.0005, 320)) === 0, "room hiss");
});
