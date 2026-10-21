import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  agentReplyTo, agentTagPrefix, BOT_ACCESS_ANSWERS, BOT_FACE_COLORS, BOT_FACE_EARS, BOT_FACE_EARS_LABELS, BOT_FACE_SHAPE_LABELS, BOT_FACE_SHAPES, BOT_LIMITS,
  BOT_THINKING_LEVELS, botColorName, botFaceColor, botFaceEars, botFaceShape, botKickoffName, botLook, isBotFaceEars, isBotFaceShape, isBotTagging,
  previewLine, storedTagging,
} from "./bots-format.ts";
import { botTurnOrigin } from "./runtimes/turn-origins.ts";

test("bot limits, faces, labels, tagging and sender parsing match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./bots-format.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(BOT_LIMITS, fixture.limits);
  assert.deepEqual(BOT_THINKING_LEVELS, fixture.thinkingLevels);
  assert.deepEqual(BOT_ACCESS_ANSWERS, fixture.accessAnswers);
  assert.deepEqual({ shapes: BOT_FACE_SHAPES, shapeLabels: BOT_FACE_SHAPE_LABELS, ears: BOT_FACE_EARS, earsLabels: BOT_FACE_EARS_LABELS, colors: BOT_FACE_COLORS }, fixture.faces);
  for (const item of fixture.looks) assert.deepEqual(botLook(item.input), item.expected);
  for (const item of fixture.shapeChecks) assert.equal(isBotFaceShape(item.input), item.expected);
  for (const item of fixture.earsChecks) assert.equal(isBotFaceEars(item.input), item.expected);
  for (const item of fixture.colorNames) assert.equal(botColorName(item.input), item.expected);
  for (const item of fixture.previews) assert.equal(previewLine(item.input.text, item.input.max), item.expected);
  for (const item of fixture.tagging) assert.deepEqual([isBotTagging(item.input), storedTagging(item.input) ?? null], [item.valid, item.stored]);
  for (const item of fixture.kickoffNames) assert.equal(botKickoffName(item.input) ?? null, item.expected);
  for (const item of fixture.turnOrigins) assert.deepEqual(botTurnOrigin(item.input ?? undefined), item.expected);
  for (const item of fixture.replyTo) assert.equal(agentReplyTo(item.input ?? undefined) ?? null, item.expected);
});

test("a session's tag carries a sanitized title, its return address and the hop after the first", () => {
  assert.equal(agentTagPrefix("Fix [retry] · now", "9b2e-41", 2), "[from agent: Fix retry now · reply-to agent:9b2e-41 · hop 2] ");
  assert.equal(agentTagPrefix(" ", "s-1"), "[from agent: Untitled session · reply-to agent:s-1] ");
});

test("CLI names: shapes and ears by id or label, palette colors by name or hex", () => {
  assert.equal(botFaceShape("Pebble"), "round");
  assert.equal(botFaceShape(" HEART "), "heart");
  assert.equal(botFaceShape("dragon"), undefined);
  assert.equal(botFaceEars("Cat ears"), "cat");
  assert.equal(botFaceEars(" BUNNY "), "bunny");
  assert.equal(botFaceEars("wings"), undefined);
  assert.equal(botFaceColor("Mint")?.hex, "#2fc49a");
  assert.equal(botFaceColor("#FF6B4A")?.label, "Coral");
  assert.equal(botFaceColor("#123456"), undefined);
});
