import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { boundText, CALL_LIMITS, callMinutes, callTranscriptText, callVoice, chunkUtf8, DEFAULT_GPT_LIVE_VOICE, GPT_LIVE_VOICES, gptLiveVoice, gptLiveVoiceLabel, parseCallRecord } from "./calls.ts";

test("call limits, voices and record helpers match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./calls.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(CALL_LIMITS, fixture.limits);
  assert.deepEqual(GPT_LIVE_VOICES, fixture.voices);
  assert.equal(DEFAULT_GPT_LIVE_VOICE, fixture.defaultVoice);
  for (const item of fixture.voiceChecks) assert.equal(gptLiveVoice(item.input) ?? null, item.expected);
  for (const item of fixture.voiceLabels) assert.equal(gptLiveVoiceLabel(item.input), item.expected);
  for (const item of fixture.callVoices) assert.equal(callVoice(item.input[0] ?? undefined, item.input[1] ?? undefined), item.expected);
  for (const item of fixture.records) assert.deepEqual(parseCallRecord(item.input) ?? null, item.expected);
  for (const item of fixture.transcripts) assert.equal(callTranscriptText(item.input.lines, item.input.bot, item.input.operator), item.expected);
  for (const item of fixture.minutes) assert.equal(callMinutes(item.input), item.expected);
  for (const item of fixture.bounds) assert.equal(boundText(item.input.text, item.input.max), item.expected);
});

test("appends stay within 500 bytes without splitting characters", () => {
  assert.deepEqual(chunkUtf8("short"), ["short"]);
  const text = "ñ".repeat(600);
  const chunks = chunkUtf8(text);
  assert.equal(chunks.join(""), text);
  assert(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 500));
  assert.equal(chunks.length, 3);
});
