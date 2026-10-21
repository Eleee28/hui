import assert from "node:assert/strict";
import { test } from "vitest";

import { CALL_LIMITS } from "./calls.ts";
import type { CallDelegationResult, CallLine, CallTaskResult } from "../../api/schema/calls.ts";
import {
  ActivityGate, CallTranscript, callStatusLabel, delegationAppends, GREETING_FALLBACK_MS, initialLiveCallState, LiveCall, livePhaseOf, MIC_GATE, parseLiveEvent, reduceLiveCall, sessionAppends, VOICE_GATE,
  type LiveCallPlatform, type LiveConnectionHandlers, type LiveEvent,
} from "./live-call.ts";

/* Events as ChatGPT's GPT-Live route sent them in the spike of 2026-10-06 (ids shortened). */
const EVENTS = {
  started: '{"type":"session.started","session":{"id":"rtc_u32_EVzf","status":"active","expires_at":1791301109}}',
  userCreated: '{"type":"turn.created","turn":{"id":"turn_U1","end_ms":6400,"role":"user","start_ms":6200,"transcript":" What\'s my"}}',
  userDelta: '{"type":"turn.delta","delta":" favorite color","end_ms":6600,"start_ms":6400,"turn_id":"turn_U1"}',
  delegation: '{"type":"delegation.created","item":{"id":"item_D1","type":"delegation","content":[{"type":"input_text","text":"What\'s my favorite color and what\'s my dog called"}],"handoff_id":"handoff_1","target":"client","user_bidi_turn_id":"turn_U1"},"offset_ms":8400}',
  userDone: '{"type":"turn.done","turn":{"id":"turn_U1","end_ms":9400,"role":"user","start_ms":6200,"transcript":" What\'s my favorite color and what\'s my dog called"}}',
  botCreated: '{"type":"turn.created","turn":{"id":"turn_A1","end_ms":9400,"role":"assistant","start_ms":9200,"transcript":" One sec,"}}',
  botDone: '{"type":"turn.done","turn":{"id":"turn_A1","end_ms":15400,"role":"assistant","start_ms":9200,"transcript":" One sec, let me check that. Your dog\'s called Pancho."}}',
  appended: '{"type":"delegation.context.appended","delegation_item_id":"item_D1","end_ms":8800,"start_ms":8600}',
  usage: '{"type":"session.usage.updated","usage":{"audio_duration_ms":14200,"backend_model_usage":[]},"usage_limit":{"status":null,"reset_seconds":null}}',
  closed: '{"type":"session.closed","reason":"client_request","usage":{"audio_duration_ms":41000,"backend_model_usage":[]}}',
};

test("the route's events parse into what the call acts on; everything else is ignored", () => {
  assert.deepEqual(parseLiveEvent(EVENTS.started), { kind: "started", expiresAt: 1791301109 });
  assert.deepEqual(parseLiveEvent(EVENTS.userCreated), { kind: "turn", phase: "created", id: "turn_U1", role: "user", text: " What's my" });
  assert.deepEqual(parseLiveEvent(EVENTS.userDelta), { kind: "turn", phase: "delta", id: "turn_U1", text: " favorite color" });
  assert.deepEqual(parseLiveEvent(EVENTS.userDone), { kind: "turn", phase: "done", id: "turn_U1", role: "user", text: " What's my favorite color and what's my dog called" });
  assert.deepEqual(parseLiveEvent(EVENTS.delegation), { kind: "delegation", id: "item_D1", request: "What's my favorite color and what's my dog called", turnId: "turn_U1" });
  assert.deepEqual(parseLiveEvent(EVENTS.closed), { kind: "closed", reason: "client_request" });
  assert.deepEqual(parseLiveEvent(EVENTS.appended), { kind: "ignored", type: "delegation.context.appended" });
  assert.deepEqual(parseLiveEvent(EVENTS.usage), { kind: "ignored", type: "session.usage.updated" }, "no limit reported");
  assert.deepEqual(parseLiveEvent('{"type":"session.usage.updated","usage_limit":{"status":"reached"}}'), { kind: "limit", status: "reached" });
  assert.deepEqual(parseLiveEvent('{"type":"error","error":{"message":"Token expired","code":"token_expired"}}'), { kind: "error", message: "Token expired", fatal: true });
  assert.deepEqual(parseLiveEvent('{"type":"error","error":{"message":"Slow down"}}'), { kind: "error", message: "Slow down", fatal: false });
  assert.deepEqual(parseLiveEvent('{"type":"delegation.created","item":{"id":"x","type":"delegation","target":"server"}}'), { kind: "ignored", type: "delegation.created" }, "only the client's");
  for (const raw of ["", "nope", "[]", '{"no":"type"}', 42]) assert.equal(parseLiveEvent(raw), undefined, String(raw));
});

test("results and progress go as delegation appends of at most 500 bytes; the greeting as session context", () => {
  assert.deepEqual(delegationAppends("item_D1", "speakable", "Pancho."), [
    { type: "delegation.context.append", delegation_item_id: "item_D1", channel: "speakable", content: [{ type: "input_text", text: "Pancho." }] },
  ]);
  const long = delegationAppends("item_D1", "commentary", "é".repeat(400)) as { content: { text: string }[] }[];
  assert.equal(long.length, 2);
  assert(long.every((event) => Buffer.byteLength(event.content[0]!.text, "utf8") <= 500));
  assert.deepEqual(sessionAppends("speakable", "Greet the user."), [{ type: "session.context.append", channel: "speakable", content: [{ type: "input_text", text: "Greet the user." }] }]);
});

test("activity gates open at once and close only after staying quiet", () => {
  const gate = new ActivityGate(VOICE_GATE);
  assert.equal(gate.update(0.1, 0), undefined);
  assert.equal(gate.update(0.5, 10), true);
  assert.equal(gate.update(0.35, 20), undefined, "between off and on: still active");
  assert.equal(gate.update(0.1, 30), undefined);
  assert.equal(gate.update(0.1, 400), undefined);
  assert.equal(gate.update(0.5, 450), undefined, "speech resumed: the quiet restarts");
  assert.equal(gate.update(0.1, 500), undefined);
  assert.equal(gate.update(0.1, 1_001), false);
  assert(MIC_GATE.on > VOICE_GATE.on, "a room's noise does not count as speech");
});

test("the phase follows the audio: speaking while the bot's voice plays, hearing while the user speaks, thinking while a task runs", () => {
  let state = initialLiveCallState(0);
  assert.equal(state.phase, "connecting");
  state = reduceLiveCall(state, { type: "connected", voice: "ember" }, 1);
  assert.deepEqual([state.phase, state.voice], ["listening", "ember"]);
  state = reduceLiveCall(state, { type: "turn", role: "user", text: " What's my", done: false }, 2);
  assert.deepEqual([state.phase, state.you], ["hearing", "What's my"]);
  state = reduceLiveCall(state, { type: "delegation", running: true }, 3);
  assert.equal(state.phase, "hearing", "the user still speaks");
  state = reduceLiveCall(state, { type: "turn", role: "user", text: "What's my dog called", done: true }, 4);
  assert.equal(state.phase, "thinking");
  state = reduceLiveCall(state, { type: "turn", role: "assistant", text: " One sec,", done: false }, 5);
  assert.deepEqual([state.phase, state.bot], ["thinking", "One sec,"], "a transcript is not sound: speaking waits for the audio");
  state = reduceLiveCall(state, { type: "bot-audio", active: true }, 6);
  assert.equal(state.phase, "speaking");
  state = reduceLiveCall(state, { type: "mute-speaker", muted: true }, 7);
  assert.equal(state.phase, "thinking", "a muted speaker plays nothing");
  state = reduceLiveCall(state, { type: "mute-speaker", muted: false }, 8);
  state = reduceLiveCall(state, { type: "bot-audio", active: false }, 9);
  state = reduceLiveCall(state, { type: "tool", name: "web_search" }, 10);
  assert.deepEqual([state.phase, state.tool], ["thinking", "web_search"]);
  state = reduceLiveCall(state, { type: "delegation", running: false }, 11);
  assert.deepEqual([state.phase, state.tool, state.delegating], ["listening", undefined, 0]);
  state = reduceLiveCall(state, { type: "mic-activity", active: true }, 12);
  assert.equal(state.phase, "hearing");
  state = reduceLiveCall(state, { type: "mute-mic", muted: true }, 13);
  assert.deepEqual([state.phase, state.micActive], ["listening", false]);
  assert.equal(livePhaseOf({ ...state, connected: false }), "connecting");
  const ended = reduceLiveCall(state, { type: "hang-up" }, 20);
  assert.deepEqual([ended.phase, ended.endedAt], ["ended", 20]);
  assert.equal(reduceLiveCall(ended, { type: "bot-audio", active: true }, 21), ended, "nothing changes an ended call");
  assert.deepEqual(reduceLiveCall(state, { type: "closed", reason: "expired" }, 30).notice, "The call reached GPT-Live's time limit.");
  assert.equal(reduceLiveCall(state, { type: "closed", reason: "connection_lost" }, 30).phase, "failed");
  assert.equal(reduceLiveCall(state, { type: "failed", message: "no" }, 30).error, "no");
});

test("the call's status line says what the call is doing", () => {
  const base = initialLiveCallState(0);
  assert.equal(callStatusLabel(base), "Connecting…");
  assert.equal(callStatusLabel({ ...base, phase: "listening" }), "Listening");
  assert.equal(callStatusLabel({ ...base, phase: "listening", micMuted: true }), "Microphone muted");
  assert.equal(callStatusLabel({ ...base, phase: "hearing" }), "Hearing you…");
  assert.equal(callStatusLabel({ ...base, phase: "thinking" }), "Thinking…");
  assert.equal(callStatusLabel({ ...base, phase: "thinking", delegating: 1 }, false, "Juno"), "Asking Juno…");
  assert.equal(callStatusLabel({ ...base, phase: "thinking", tool: "web_search" }), "Using web_search…");
  assert.equal(callStatusLabel({ ...base, phase: "thinking", tool: "web_search" }, true), "Summarizing memory…");
  assert.equal(callStatusLabel({ ...base, phase: "speaking" }), "Speaking");
  assert.equal(callStatusLabel({ ...base, phase: "ended" }), "Call ended");
  assert.equal(callStatusLabel({ ...base, phase: "failed" }), "Call failed");
});

test("the call's lines are written in the order the turns began, each once, with what was actually said", () => {
  const transcript = new CallTranscript();
  const apply = (raw: string, now: number) => transcript.apply(parseLiveEvent(raw) as Extract<LiveEvent, { kind: "turn" }>, now);
  apply(EVENTS.userCreated, 100);
  apply(EVENTS.userDelta, 110);
  apply(EVENTS.botCreated, 120);
  apply('{"type":"turn.delta","delta":" let me","turn_id":"turn_A1"}', 130);
  assert.deepEqual(transcript.take(), [], "nothing finished yet");
  apply(EVENTS.botDone, 140);
  assert.deepEqual(transcript.take(), [], "the bot's turn waits for the user's, which began first");
  apply(EVENTS.userDone, 150);
  assert.deepEqual(transcript.take(), [
    { role: "user", text: "What's my favorite color and what's my dog called", at: 100 },
    { role: "assistant", text: "One sec, let me check that. Your dog's called Pancho.", at: 120 },
  ]);
  assert.deepEqual(transcript.take(), [], "written once");
  // Interrupted speech: GPT-Live's transcript stops where its audio did.
  apply('{"type":"turn.created","turn":{"id":"turn_A2","role":"assistant","transcript":" Sure. The story"}}', 200);
  apply('{"type":"turn.done","turn":{"id":"turn_A2","role":"assistant","transcript":" Sure. The story starts in the early 1800s, with the Draisine, a kind of"}}', 210);
  assert.deepEqual(transcript.take(), [{ role: "assistant", text: "Sure. The story starts in the early 1800s, with the Draisine, a kind of", at: 200 }]);
  // A delta for a turn never created is dropped; settling finishes what is pending with what it said so far.
  assert.equal(apply('{"type":"turn.delta","delta":"x","turn_id":"turn_unknown"}', 300), undefined);
  apply('{"type":"turn.created","turn":{"id":"turn_U9","role":"user","transcript":" Thanks,"}}', 310);
  apply('{"type":"turn.created","turn":{"id":"turn_A9","role":"assistant","transcript":""}}', 320);
  transcript.settle();
  assert.deepEqual(transcript.take(), [{ role: "user", text: "Thanks,", at: 310 }], "an empty turn writes nothing");
});

/* ── LiveCall with a scripted platform ── */

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function platform(options: { connect?: () => Promise<void>; micError?: Error } = {}) {
  let now = 1_000;
  const timers = new Set<{ at: number; callback: () => void; every?: number }>();
  const log: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const lines: (CallLine & { at: number })[][] = [];
  const delegations: { id: string; request: string; signal: AbortSignal; result: Deferred<CallDelegationResult> }[] = [];
  const tasks: { task: string; signal: AbortSignal; result: Deferred<CallTaskResult> }[] = [];
  let handlers: LiveConnectionHandlers | undefined;
  let micLevel = 0;
  let voiceLevel = 0;
  let channelOpen = true;
  let heartbeatError: Error | undefined;
  const live: LiveCallPlatform = {
    openMicrophone: async () => {
      if (options.micError) throw options.micError;
      log.push("mic");
      return { setEnabled: (enabled) => log.push(`mic ${enabled ? "on" : "off"}`), level: () => micLevel, close: () => log.push("mic closed") };
    },
    connect: async (_microphone, connectionHandlers) => {
      handlers = connectionHandlers;
      await options.connect?.();
      log.push("connected");
      return {
        callId: "call-1", voice: "cove",
        send: (event) => { if (!channelOpen) return false; sent.push(event as Record<string, unknown>); return true; },
        level: () => voiceLevel,
        setSpeakerMuted: (muted) => log.push(`speaker ${muted ? "off" : "on"}`),
        close: () => log.push("closed"),
      };
    },
    delegate: (_callId, id, request, signal) => {
      const result = deferred<CallDelegationResult>();
      delegations.push({ id, request, signal, result });
      log.push(`delegate ${request}`);
      signal.addEventListener("abort", () => result.reject(new DOMException("aborted", "AbortError")), { once: true });
      return result.promise;
    },
    waitTask: (_callId, task, signal) => {
      const result = deferred<CallTaskResult>();
      tasks.push({ task, signal, result });
      log.push(`task ${task}`);
      signal.addEventListener("abort", () => result.reject(new DOMException("aborted", "AbortError")), { once: true });
      return result.promise;
    },
    writeLines: async (_callId, batch) => { lines.push([...batch]); log.push(`lines ${batch.map((line) => line.role).join(",")}`); },
    heartbeat: async () => { if (heartbeatError) throw heartbeatError; log.push("heartbeat"); },
    end: async (_callId, leaving) => { log.push(leaving ? "end leaving" : "end"); },
    setTimer: (callback, ms) => { const timer = { at: now + ms, callback }; timers.add(timer); return () => timers.delete(timer); },
    setInterval: (callback, ms) => { const timer = { at: now + ms, callback, every: ms }; timers.add(timer); return () => timers.delete(timer); },
    now: () => now,
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else timers.delete(next);
      next.callback();
    }
    now = until;
  };
  return {
    live, log, sent, lines, delegations, tasks, advance,
    message: (raw: string) => handlers!.onMessage(raw),
    open: () => handlers!.onOpen(),
    lose: (why: string) => handlers!.onLost(why),
    setMic: (level: number) => { micLevel = level; },
    setVoice: (level: number) => { voiceLevel = level; },
    closeChannel: () => { channelOpen = false; },
    failHeartbeats: (error: Error) => { heartbeatError = error; },
  };
}

test("a call greets once its session started, follows the audio for its phase and writes every finished turn", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  assert.equal(call.state.phase, "connecting");
  p.open();
  assert.equal(call.state.phase, "listening");
  assert.deepEqual(p.sent, [], "the greeting waits for session.started");
  p.message(EVENTS.started);
  assert.deepEqual(p.sent, sessionAppends("speakable", "The call just connected. Greet the user briefly, as yourself."));
  p.open();
  p.message(EVENTS.started);
  p.advance(GREETING_FALLBACK_MS);
  assert.equal(p.sent.length, 1, "one greeting");

  p.message('{"type":"turn.created","turn":{"id":"turn_A0","role":"assistant","transcript":" Hey!"}}');
  p.setVoice(0.8);
  p.advance(50);
  assert.equal(call.state.phase, "speaking");
  assert(call.voiceLevel > 0.5, "the face follows the bot's voice");
  p.message('{"type":"turn.done","turn":{"id":"turn_A0","role":"assistant","transcript":" Hey! Good to hear from you."}}');
  p.setVoice(0);
  p.advance(600);
  assert.equal(call.state.phase, "listening");
  await flush();
  assert.deepEqual(p.lines, [[{ role: "assistant", text: "Hey! Good to hear from you.", at: 1_000 + GREETING_FALLBACK_MS }]]);

  p.setMic(0.7);
  p.advance(50);
  assert.equal(call.state.phase, "hearing");
  assert(call.micLevel > 0.5);
  call.setMicMuted(true);
  assert.deepEqual([call.state.phase, call.micLevel], ["listening", 0]);
  assert(p.log.includes("mic off"));
  call.setMicMuted(false);
  p.setMic(0);
  p.advance(30_000);
  assert(p.log.includes("heartbeat"), "the gateway hears from the call every 30 s");
  call.setSpeakerMuted(true);
  assert(p.log.includes("speaker off"));
});

test("a delegated task waits for the request's own line, then runs, then its result is spoken", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  p.message(EVENTS.userCreated);
  p.message(EVENTS.userDelta);
  p.message(EVENTS.delegation);
  await flush();
  assert.equal(call.state.delegating, 1);
  assert.equal(p.delegations.length, 0, "the user's turn has not finished: its line goes first");
  p.message(EVENTS.userDone);
  await flush();
  await flush();
  assert.deepEqual(p.lines, [[{ role: "user", text: "What's my favorite color and what's my dog called", at: 1_000 }]]);
  assert.deepEqual(p.delegations.map((delegation) => delegation.request), ["What's my favorite color and what's my dog called"]);
  assert.deepEqual(p.log.filter((entry) => entry.startsWith("lines") || entry.startsWith("delegate")), ["lines user", "delegate What's my favorite color and what's my dog called"]);
  p.message(EVENTS.botCreated);
  assert.equal(call.state.phase, "thinking");
  p.delegations[0]!.result.resolve({ status: "answered", speak: "Dani's dog is called Pancho." });
  await flush();
  assert.deepEqual(p.sent.at(-1), delegationAppends("item_D1", "speakable", "Dani's dog is called Pancho.")[0]);
  assert.equal(call.state.delegating, 0);
  assert.equal(call.state.phase, "listening");
});

test("a task handed to the bot's chat is followed: its answer is spoken while the call is up, and hanging up lets it go", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  p.message(EVENTS.userCreated);
  p.message(EVENTS.userDelta);
  p.message(EVENTS.delegation);
  await flush();
  p.message(EVENTS.userDone);
  await flush();
  await flush();
  p.delegations[0]!.result.resolve({ status: "handed-off", task: "task-1", speak: "Handed to Juno's chat: check the files." });
  await flush();
  assert.deepEqual(p.sent.at(-1), delegationAppends("item_D1", "commentary", "Handed to Juno's chat: check the files.")[0], "silent background for GPT-Live");
  assert.deepEqual(p.tasks.map((task) => task.task), ["task-1"]);
  assert.deepEqual([call.state.delegating, call.state.tasks], [0, 1], "the question is answered; the task goes on");
  assert.match(call.state.notice ?? "", /Juno is working on it in the chat/u);
  p.tasks[0]!.result.resolve({ status: "answered", speak: "Three files: a, b and c." });
  await flush();
  assert.deepEqual(p.sent.at(-1), delegationAppends("item_D1", "speakable", "Three files: a, b and c.")[0], "the task's result is the delegation's answer");
  assert.equal(call.state.tasks, 0);

  // A second task still running at the hang-up: the wait ends, the task goes on in the chat.
  p.message(EVENTS.delegation.replace("item_D1", "item_D2").replace(',"user_bidi_turn_id":"turn_U1"', ""));
  await flush();
  await flush();
  p.delegations[1]!.result.resolve({ status: "handed-off", task: "task-2", speak: "On it." });
  await flush();
  const before = p.sent.length;
  call.hangUp();
  await flush();
  assert.equal(p.tasks[1]!.signal.aborted, true);
  assert.equal(p.sent.length, before + 1, "only the session's close goes out");
  assert.equal(p.sent.at(-1)!["type"], "session.close");
});

test("a delegation while a turn runs: each answer goes to its own delegation, never to one asked meanwhile", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  p.message(EVENTS.started);
  const withoutTurn = (id: string) => EVENTS.delegation.replace("item_D1", id).replace(',"user_bidi_turn_id":"turn_U1"', "");
  p.message(withoutTurn("item_D1"));
  await flush();
  await flush();
  p.delegations[0]!.result.resolve({ status: "handed-off", task: "task-1", speak: "Handed to Juno's chat: list the files." });
  await flush();
  // The bot's turn for task-1 is running when the next question comes, and that question is answered first.
  p.message(withoutTurn("item_D2"));
  await flush();
  await flush();
  p.delegations[1]!.result.resolve({ status: "answered", speak: "Teal." });
  await flush();
  assert.deepEqual(p.sent.at(-1), delegationAppends("item_D2", "speakable", "Teal.")[0]);
  p.tasks[0]!.result.resolve({ status: "answered", speak: "Three files." });
  await flush();
  assert.deepEqual(p.sent.at(-1), delegationAppends("item_D1", "speakable", "Three files.")[0], "the task's reply answers its own delegation");
  assert.equal(p.sent.filter((event) => event["delegation_item_id"] === "item_D2").length, 1, "and never the one asked meanwhile");
  assert.deepEqual([call.state.delegating, call.state.tasks], [0, 0]);
});

test("the speaking phase follows the bot's audio, not GPT-Live's turn events", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  p.message('{"type":"turn.created","turn":{"id":"turn_A5","role":"assistant","transcript":" Sure, here"}}');
  p.advance(100);
  assert.equal(call.state.phase, "listening", "a reply GPT-Live has begun but not yet played");
  p.setVoice(0.8);
  p.advance(50);
  assert.equal(call.state.phase, "speaking");
  p.message('{"type":"turn.done","turn":{"id":"turn_A5","role":"assistant","transcript":" Sure, here it is."}}');
  p.advance(50);
  assert.equal(call.state.phase, "speaking", "still playing after its transcript ended");
  p.setVoice(0);
  p.advance(600);
  assert.equal(call.state.phase, "listening");
});

test("without session.started, the greeting is asked for after a while", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  p.advance(GREETING_FALLBACK_MS - 1);
  assert.deepEqual(p.sent, []);
  p.advance(1);
  assert.deepEqual(p.sent, sessionAppends("speakable", "The call just connected. Greet the user briefly, as yourself."));
  void call;
});

test("a call ends by itself after its time limit", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  p.advance(CALL_LIMITS.maxMinutes * 60_000 - 1);
  assert.equal(call.state.phase === "ended" || call.state.phase === "failed", false);
  p.advance(1);
  await flush();
  assert.equal(call.state.phase, "ended");
  assert(p.log.includes("end"), "the gateway is told");
});

test("a request whose turn never finishes goes after two seconds with what was heard; a failed task is still answered", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno", requestWaitMs: 2_000 });
  await call.start();
  p.open();
  p.message(EVENTS.userCreated);
  p.message(EVENTS.delegation);
  await flush();
  p.advance(2_000);
  await flush();
  await flush();
  assert.deepEqual(p.lines, [[{ role: "user", text: "What's my", at: 1_000 }]]);
  p.message(EVENTS.userDone);
  await flush();
  assert.equal(p.lines.length, 1, "the late end of a written turn writes nothing more");
  p.delegations[0]!.result.reject(new Error("The bot's chat runtime failed."));
  await flush();
  const spoken = (p.sent.at(-1) as { content: { text: string }[] }).content[0]!.text;
  assert.match(spoken, /^Juno could not do it: The bot's chat runtime failed\. Tell the user and offer to try again\.$/u);
  assert.match(call.state.notice ?? "", /Juno could not take the task/u, "and the call view says so");
  // An empty request is not a task.
  p.message('{"type":"delegation.created","item":{"id":"item_E","type":"delegation","target":"client","content":[]}}');
  await flush();
  await flush();
  assert.match(((p.sent.at(-1) as { content: { text: string }[] }).content[0]!.text), /Ask the user to repeat their request/u);
  assert.equal(p.delegations.length, 1);
});

test("tool progress of a running task goes to the commentary channel at most every ten seconds", async () => {
  const p = platform();
  let onTool: ((name: string | undefined) => void) | undefined;
  p.live.watchTools = (listener) => { onTool = listener; return () => { onTool = undefined; }; };
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  onTool!("read");
  assert.equal(call.state.tool, undefined, "no task, no tool");
  p.message(EVENTS.delegation);
  await flush();
  await flush();
  onTool!("web_search");
  assert.equal(call.state.tool, "web_search");
  onTool!("read");
  const notes = p.sent.filter((event) => event["channel"] === "commentary");
  assert.deepEqual(notes, delegationAppends("item_D1", "commentary", "Juno is working on it: using web_search."));
  p.advance(10_000);
  onTool!("bash");
  assert.equal(p.sent.filter((event) => event["channel"] === "commentary").length, 2);
  call.hangUp();
  assert.equal(onTool, undefined, "the watch stops with the call");
});

test("hanging up closes the session, writes the last lines, then ends the call; a running task goes on in the chat", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  p.message(EVENTS.userCreated);
  p.message(EVENTS.delegation);
  p.message(EVENTS.userDone);
  await flush();
  await flush();
  const task = p.delegations[0]!;
  p.message('{"type":"turn.created","turn":{"id":"turn_A5","role":"assistant","transcript":" Let me check"}}');
  call.hangUp();
  assert.equal(call.state.phase, "ended");
  assert(task.signal.aborted, "the wait ends; the gateway keeps the turn");
  assert.deepEqual(p.sent.at(-1), { type: "session.close" });
  assert(p.log.includes("mic closed"));
  assert(!p.log.includes("closed"), "the connection stays until GPT-Live confirms");
  p.message(EVENTS.closed);
  assert(p.log.includes("closed"));
  await flush();
  await flush();
  assert.deepEqual(p.lines.at(-1), [{ role: "assistant", text: "Let me check", at: 1_000 }], "what was said last is written");
  assert.equal(p.log.at(-1), "end", "after the lines");
  assert.equal(p.sent.filter((event) => event["type"] === "delegation.context.append").length, 0, "nothing is sent for the abandoned wait");
  call.hangUp();
  assert.equal(p.log.filter((entry) => entry === "end").length, 1);
});

test("a hang-up without GPT-Live's confirmation closes the connection after 800 ms; a page leaving ends at once", async () => {
  const p = platform();
  const call = new LiveCall(p.live, { botName: "Juno" });
  await call.start();
  p.open();
  call.hangUp();
  p.advance(799);
  assert(!p.log.includes("closed"));
  p.advance(1);
  assert(p.log.includes("closed"));

  const q = platform();
  const leaving = new LiveCall(q.live, { botName: "Juno" });
  await leaving.start();
  q.open();
  leaving.hangUp(true);
  assert(q.log.includes("closed"));
  await flush();
  assert.equal(q.log.at(-1), "end leaving");
});

test("failures show in the call: the microphone, the setup, a lost connection, a refused login, a released call", async () => {
  const denied = new LiveCall(platform({ micError: new Error("Microphone access was denied.") }).live, { botName: "Juno" });
  await denied.start();
  assert.deepEqual([denied.state.phase, denied.state.error], ["failed", "Microphone access was denied."]);

  const p = platform({ connect: async () => { throw new Error("GPT-Live is not available on this ChatGPT account or plan."); } });
  const setup = new LiveCall(p.live, { botName: "Juno" });
  await setup.start();
  assert.deepEqual([setup.state.phase, setup.state.error], ["failed", "GPT-Live is not available on this ChatGPT account or plan."]);
  assert(p.log.includes("mic closed"));

  const q = platform();
  const lost = new LiveCall(q.live, { botName: "Juno" });
  await lost.start();
  q.open();
  q.lose("The call's connection to GPT-Live failed.");
  assert.deepEqual([lost.state.phase, lost.state.error], ["failed", "The call's connection to GPT-Live failed."]);
  assert(q.log.includes("closed"));

  const r = platform();
  const refused = new LiveCall(r.live, { botName: "Juno" });
  await refused.start();
  r.open();
  r.message('{"type":"error","error":{"message":"Slow down"}}');
  assert.deepEqual([refused.state.phase, refused.state.notice], ["listening", "GPT-Live: Slow down"]);
  r.message('{"type":"error","error":{"message":"Token expired","code":"token_expired"}}');
  assert.deepEqual([refused.state.phase, refused.state.error], ["failed", "GPT-Live refused the call: Token expired"]);

  const s = platform();
  const released = new LiveCall(s.live, { botName: "Juno" });
  await released.start();
  s.open();
  s.failHeartbeats(new Error("This call has ended. Start a new one."));
  s.advance(30_000);
  await flush();
  assert.deepEqual([released.state.phase, released.state.error], ["failed", "The gateway released this call."]);
  assert(s.sent.some((event) => event["type"] === "session.close"), "the session at ChatGPT is asked to close");

  const t = platform();
  const expired = new LiveCall(t.live, { botName: "Juno" });
  await expired.start();
  t.open();
  t.message('{"type":"session.closed","reason":"expired"}');
  assert.deepEqual([expired.state.phase, expired.state.notice], ["ended", "The call reached GPT-Live's time limit."]);
  assert(t.log.includes("closed"), "GPT-Live closed it: nothing to ask");
  assert(!t.sent.some((event) => event["type"] === "session.close"));
});

test("a hang-up while the call is still being set up ends it as soon as it connects", async () => {
  const gate = deferred<void>();
  const p = platform({ connect: () => gate.promise });
  const call = new LiveCall(p.live, { botName: "Juno" });
  const starting = call.start();
  await flush();
  call.hangUp();
  gate.resolve();
  await starting;
  await flush();
  assert(p.log.includes("closed"));
  assert(p.log.includes("end"));
  assert.equal(call.state.phase, "ended");
});
