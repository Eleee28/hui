import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expectTypeOf, test } from "vitest";
import type * as Calls from "./api/calls.ts";
import type { GptLiveVoice } from "./api/bots.ts";
import { boundText, CALL_LIMITS, callMinutes, callTranscriptText, callVoice, DEFAULT_GPT_LIVE_VOICE, GPT_LIVE_VOICES, gptLiveVoice, gptLiveVoiceLabel, parseCallRecord } from "./calls-format.ts";

type LegacyGptLiveVoice = (typeof GPT_LIVE_VOICES)[number];
type LegacyCallsStatus = {
  model: string;
  voices: readonly LegacyGptLiveVoice[];
  chatgpt: { signedIn: boolean; account?: { name: string; email?: string }; waitingUntil?: number };
  active: number;
  limit: number;
};
type LegacyCallStartRequest = { sdp: string };
type LegacyCallStarted = {
  callId: string; answer: string; model: string; voice: LegacyGptLiveVoice; account: { name: string }; instructionsBytes: number; memoryBytes: number;
};
type LegacyCallLine = { role: "user" | "assistant"; text: string };
type LegacyCallRecordLine = { role: "user" | "assistant" | "helper" | "handoff"; text: string; at: number; request?: string };
type LegacyCallRecord = { call: string; bot?: string; startedAt: number; endedAt: number; summary?: string; summaryUnavailable?: true; lines: LegacyCallRecordLine[] };
type LegacyCallDelegationRequest = { id: string; request: string };
type LegacyCallDelegationResult = { status: "answered" | "handed-off" | "failed" | "timeout" | "limit"; speak: string; task?: string };
type LegacyCallTaskResult = { status: "answered" | "failed" | "needs-input" | "timeout"; speak: string };

test("call payload schemas say what the hand-written call types said", () => {
  expectTypeOf<LegacyGptLiveVoice>().toEqualTypeOf<GptLiveVoice>();
  expectTypeOf<LegacyCallsStatus>().toEqualTypeOf<Calls.CallsStatus>();
  expectTypeOf<LegacyCallStartRequest>().toEqualTypeOf<Calls.CallStartRequest>();
  expectTypeOf<LegacyCallStarted>().toEqualTypeOf<Calls.CallStarted>();
  expectTypeOf<LegacyCallLine>().toEqualTypeOf<Calls.CallLine>();
  expectTypeOf<LegacyCallRecordLine>().toEqualTypeOf<Calls.CallRecordLine>();
  expectTypeOf<LegacyCallRecord>().toEqualTypeOf<Calls.CallRecord>();
  expectTypeOf<LegacyCallDelegationRequest>().toEqualTypeOf<Calls.CallDelegationRequest>();
  expectTypeOf<LegacyCallDelegationResult>().toEqualTypeOf<Calls.CallDelegationResult>();
  expectTypeOf<LegacyCallTaskResult>().toEqualTypeOf<Calls.CallTaskResult>();
});

test("call limits, voices and record helpers match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./calls-format.fixture.json", import.meta.url), "utf8"));
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
