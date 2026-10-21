import assert from "node:assert/strict";
import { test } from "vitest";
import type { LiveCallPlatform, LiveConnectionHandlers } from "../lib/voice/live-call.ts";
import { VoiceController } from "./voice-controller.ts";

const settle = async () => { for (let round = 0; round < 5; round++) await new Promise<void>((resolve) => setImmediate(resolve)); };

/** The app's calls over a fake GPT-Live: `open(bot)` opens that call's data channel. */
function harness(options: { microphone?: () => Promise<never> } = {}) {
  let ticks: (() => void) | undefined;
  const released = { microphone: 0, ended: 0 };
  const opened: string[] = [];
  const sent: object[] = [];
  const handlers = new Map<string, LiveConnectionHandlers>();
  const platform = (bot: { id: string }): LiveCallPlatform => ({
    openMicrophone: options.microphone ?? (async () => { opened.push(bot.id); return { setEnabled: () => undefined, level: () => 0.3, close: () => { released.microphone += 1; } }; }),
    connect: async (_microphone, events) => {
      handlers.set(bot.id, events);
      return { callId: `call-${bot.id}`, voice: "maple", send: (event) => { sent.push(event); return true; }, level: () => 0.9, setSpeakerMuted: () => undefined, close: () => undefined };
    },
    delegate: async () => ({ status: "answered", speak: "ok" }),
    waitTask: async () => ({ status: "answered", speak: "done" }),
    writeLines: async () => undefined,
    heartbeat: async () => undefined,
    end: async () => { released.ended += 1; },
    setTimer: () => () => undefined,
    setInterval: () => () => undefined,
    now: () => 5_000,
  });
  const voice = new VoiceController({ requestUpdate: () => undefined }, {
    platform,
    now: () => 5_000,
    setInterval: (callback) => { ticks = callback; return () => { ticks = undefined; }; },
  });
  const open = (bot: { id: string }) => handlers.get(bot.id)?.onOpen();
  const say = (bot: { id: string }, raw: string) => handlers.get(bot.id)?.onMessage(raw);
  return { voice, released, opened, sent, open, say, ticking: () => Boolean(ticks) };
}

const scout = { id: "bot-scout", sessionId: "session-scout", name: "Scout" };
const ledger = { id: "bot-ledger", sessionId: "session-ledger", name: "Ledger" };

test("one call at a time, on GPT-Live: the same bot brings it back, another bot waits", async () => {
  const { voice, released, opened, sent, open, say, ticking } = harness();
  assert.equal(voice.startCall(scout), true);
  await settle();
  assert.equal(voice.call?.state.phase, "connecting");
  open(scout);
  assert.deepEqual(opened, ["bot-scout"]);
  assert.equal(voice.call?.state.phase, "listening");
  assert.equal(voice.call?.state.voice, "maple", "the voice the gateway set the call up with");
  say(scout, '{"type":"session.started","session":{"id":"rtc_1","status":"active"}}');
  assert.equal(sent.length, 1, "the greeting cue, once the session started");
  assert.equal(ticking(), true, "the call's timer runs");
  voice.minimize();
  assert.equal(voice.call?.minimized, true);
  assert.equal(voice.startCall(ledger), false);
  assert.equal(voice.call?.bot.id, "bot-scout");
  assert.equal(voice.startCall(scout), true);
  assert.equal(voice.call?.minimized, false, "calling the same bot returns to its call");
  voice.toggleMic();
  assert.equal(voice.call?.state.micMuted, true);
  voice.toggleSpeaker();
  assert.equal(voice.call?.state.speakerMuted, true);
  voice.hangUp();
  assert.equal(voice.call, undefined, "hanging up returns to the chat");
  assert.equal(ticking(), false);
  assert.equal(released.microphone, 1);
  assert.deepEqual(sent.at(-1), { type: "session.close" }, "GPT-Live is asked to close the session");
  await settle();
  assert.equal(released.ended, 1, "and the gateway to end the call");
  assert.equal(voice.startCall(ledger), true, "now another bot can be called");
  voice.dispose();
});

test("the call's levels feed the bot's face: the microphone's and the bot's voice's, and nothing without a call", async () => {
  const { voice, open } = harness();
  assert.equal(voice.micLevel(), 0);
  assert.equal(voice.voiceLevel(), 0, "no call, no voice to follow");
  assert.equal(voice.startCall(scout), true);
  await settle();
  open(scout);
  assert.equal(voice.micLevel(), 0.3);
  assert.equal(voice.voiceLevel(), 0.9, "the remote stream's level");
  voice.toggleMic();
  assert.equal(voice.micLevel(), 0, "a muted microphone hears nothing");
  voice.dispose();
  assert.equal(voice.voiceLevel(), 0);
});

test("a failed call stays on screen with its reason until it is closed", async () => {
  const { voice } = harness({ microphone: async () => { throw new Error("Microphone access was denied."); } });
  voice.startCall(scout);
  await settle();
  assert.deepEqual([voice.call?.state.phase, voice.call?.state.error], ["failed", "Microphone access was denied."]);
  voice.closeCall();
  assert.equal(voice.call, undefined);
});
