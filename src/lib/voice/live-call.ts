/**
 * A GPT-Live call with a bot (HUI-18): full-duplex speech with ChatGPT's voice
 * model over WebRTC, and the bot's own turns for whatever needs its tools,
 * files or memory. The gateway sets the call up and keeps the ChatGPT
 * credential; the browser carries the audio and the call's data channel.
 *
 *   connecting → listening ⇄ hearing ⇄ speaking, thinking while a task runs → ended | failed
 *
 * GPT-Live hears while it speaks and handles interruptions itself: the call
 * adds no barge-in of its own. Speaking follows the bot's audio as it plays
 * (the remote stream's level), hearing the microphone's level and the user's
 * turns as GPT-Live reports them. Every finished turn becomes a line of the
 * bot's chat, in the order the turns began; a task GPT-Live delegates goes to
 * the gateway as a bot turn, after the line of the request that asked for it,
 * and its reply comes back on the speakable channel.
 *
 * `reduceLiveCall` is the pure state machine; `LiveCall` wires it to injected
 * capabilities (the microphone, the WebRTC connection, the gateway), so both
 * run under test.
 */
import { boundText, CALL_LIMITS, chunkUtf8 } from "./calls.ts";
import type { CallDelegationResult, CallLine, CallTaskResult } from "../../api/schema/calls.ts";
import type { GptLiveVoice } from "../../api/schema/bots.ts";

/* ── what the call view reads ─────────────────────────────────────────── */

export type CallPhase = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended" | "failed";

/** What the call view, its minimized bar and the bot's face read of a call. */
export type CallView = Pick<LiveCallState, "phase" | "startedAt" | "endedAt" | "micMuted" | "speakerMuted" | "you" | "bot" | "voice" | "tool" | "delegating" | "notice" | "error">;

/** The call's status line, in its view and its bar. */
export function callStatusLabel(state: Pick<CallView, "phase" | "micMuted" | "tool" | "delegating">, summarizing = false, botName = ""): string {
  switch (state.phase) {
    case "connecting": return "Connecting…";
    case "listening": return state.micMuted ? "Microphone muted" : "Listening";
    case "hearing": return "Hearing you…";
    case "thinking":
      if (summarizing) return "Summarizing memory…";
      if (state.tool) return `Using ${state.tool}…`;
      return state.delegating ? `Asking ${botName || "the bot"}…` : "Thinking…";
    case "speaking": return "Speaking";
    case "ended": return "Call ended";
    case "failed": return "Call failed";
  }
}

/* ── what the data channel says ───────────────────────────────────────── */

/** The events of ChatGPT's GPT-Live route the call acts on; everything else is `ignored`. */
export type LiveEvent =
  | { kind: "started"; expiresAt?: number }
  | { kind: "turn"; phase: "created" | "delta" | "done"; id: string; role?: "user" | "assistant"; text: string }
  | { kind: "delegation"; id: string; request: string; turnId?: string }
  | { kind: "closed"; reason: string }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "limit"; status: string }
  | { kind: "ignored"; type: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const text = (value: unknown) => typeof value === "string" ? value : "";
const roleOf = (value: unknown) => value === "user" || value === "assistant" ? value : undefined;

/** One data-channel message; undefined for anything that is not a JSON event. */
export function parseLiveEvent(raw: unknown): LiveEvent | undefined {
  let data: Record<string, unknown> | undefined;
  try { data = record(JSON.parse(String(raw))); } catch { return undefined; }
  const type = text(data?.["type"]);
  if (!data || !type) return undefined;
  switch (type) {
    case "session.started": {
      const expires = record(data["session"])?.["expires_at"];
      return { kind: "started", ...(typeof expires === "number" && Number.isFinite(expires) ? { expiresAt: expires } : {}) };
    }
    case "turn.created":
    case "turn.done": {
      const turn = record(data["turn"]);
      const id = text(turn?.["id"]);
      const role = roleOf(turn?.["role"]);
      if (!id) return { kind: "ignored", type };
      return { kind: "turn", phase: type === "turn.done" ? "done" : "created", id, ...(role ? { role } : {}), text: text(turn?.["transcript"]) };
    }
    case "turn.delta": {
      const id = text(data["turn_id"]);
      return id ? { kind: "turn", phase: "delta", id, text: text(data["delta"]) } : { kind: "ignored", type };
    }
    case "delegation.created": {
      const item = record(data["item"]);
      const id = text(item?.["id"]);
      if (!id || item?.["type"] !== "delegation" || item["target"] !== "client") return { kind: "ignored", type };
      const parts = Array.isArray(item["content"]) ? item["content"] : [];
      const request = parts.map((part) => record(part)).filter((part) => part?.["type"] === "input_text").map((part) => text(part?.["text"])).join("").trim();
      const turnId = text(item["user_bidi_turn_id"]);
      return { kind: "delegation", id, request, ...(turnId ? { turnId } : {}) };
    }
    case "session.closed":
      return { kind: "closed", reason: text(data["reason"]) || "unknown" };
    case "session.usage.updated": {
      const status = record(data["usage_limit"])?.["status"];
      return typeof status === "string" && status ? { kind: "limit", status } : { kind: "ignored", type };
    }
    case "error": {
      const error = record(data["error"]);
      const message = text(error?.["message"]) || text(data["message"]) || text(error?.["code"]) || "GPT-Live reported an error.";
      const status = error?.["status"] ?? data["status"];
      const code = (text(error?.["code"]) || text(data["code"])).toLowerCase();
      return { kind: "error", message, fatal: status === 401 || status === "401" || ["authentication_error", "invalid_token", "token_expired", "invalid_api_key"].includes(code) };
    }
    default:
      return { kind: "ignored", type };
  }
}

/** A result or progress note for a delegation, cut into appends the data channel takes. */
export function delegationAppends(delegationId: string, channel: "speakable" | "commentary", note: string): object[] {
  return chunkUtf8(note).map((chunk) => ({ type: "delegation.context.append", delegation_item_id: delegationId, channel, content: [{ type: "input_text", text: chunk }] }));
}

/** Context for the session without a delegation: the greeting cue, say. */
export function sessionAppends(channel: "speakable" | "commentary", note: string): object[] {
  return chunkUtf8(note).map((chunk) => ({ type: "session.context.append", channel, content: [{ type: "input_text", text: chunk }] }));
}

/* ── audio activity ───────────────────────────────────────────────────── */

/**
 * Whether a source is active from its level (0–1, see level.ts), with hysteresis: on at `on`, off only after
 * staying under `off` for `holdMs`. `update` returns the new state when it changes.
 */
export class ActivityGate {
  readonly on: number;
  readonly off: number;
  readonly holdMs: number;
  active = false;
  #quietSince: number | undefined;

  constructor(options: { on: number; off: number; holdMs: number }) {
    this.on = options.on;
    this.off = options.off;
    this.holdMs = options.holdMs;
  }

  update(level: number, now: number): boolean | undefined {
    if (!this.active) {
      if (level < this.on) return undefined;
      this.active = true;
      this.#quietSince = undefined;
      return true;
    }
    if (level >= this.off) {
      this.#quietSince = undefined;
      return undefined;
    }
    this.#quietSince ??= now;
    if (now - this.#quietSince < this.holdMs) return undefined;
    this.active = false;
    this.#quietSince = undefined;
    return false;
  }

  reset(): void {
    this.active = false;
    this.#quietSince = undefined;
  }
}

/** The bot's voice: GPT-Live's stream is near silence between replies. */
export const VOICE_GATE = { on: 0.4, off: 0.3, holdMs: 500 } as const;
/** How long a connected call waits for session.started before it asks for the greeting anyway. */
export const GREETING_FALLBACK_MS = 8_000;
/** The microphone: a quiet room stays under it, speech near the microphone goes well over. */
export const MIC_GATE = { on: 0.55, off: 0.4, holdMs: 700 } as const;

/* ── the state machine ────────────────────────────────────────────────── */

export type LiveCallState = {
  phase: CallPhase;
  startedAt: number;
  endedAt?: number;
  /** The session is up: the data channel opened. */
  connected: boolean;
  micMuted: boolean;
  speakerMuted: boolean;
  /** The microphone hears speech. */
  micActive: boolean;
  /** GPT-Live reports a turn of the user's in progress. */
  userTurn: boolean;
  /** The bot's voice is playing. */
  botAudio: boolean;
  /** Questions GPT-Live delegated that the bot's helper is answering. */
  delegating: number;
  /** Tasks handed to the bot's chat that the call still follows. */
  tasks: number;
  /** A tool the bot's task uses. */
  tool?: string;
  /** Captions: the user's current or last turn, and the bot's. */
  you: string;
  bot: string;
  voice?: GptLiveVoice;
  /** The latest problem the call survived. */
  notice?: string;
  /** Why the call could not go on. */
  error?: string;
};

export type LiveCallEvent =
  | { type: "connected"; voice?: GptLiveVoice }
  | { type: "failed"; message: string }
  | { type: "closed"; reason: string }
  | { type: "turn"; role: "user" | "assistant"; text: string; done: boolean }
  | { type: "mic-activity"; active: boolean }
  | { type: "bot-audio"; active: boolean }
  | { type: "delegation"; running: boolean }
  | { type: "task"; running: boolean }
  | { type: "tool"; name?: string }
  | { type: "notice"; message?: string }
  | { type: "mute-mic"; muted: boolean }
  | { type: "mute-speaker"; muted: boolean }
  | { type: "hang-up" };

export function initialLiveCallState(now: number): LiveCallState {
  return {
    phase: "connecting", startedAt: now, connected: false, micMuted: false, speakerMuted: false,
    micActive: false, userTurn: false, botAudio: false, delegating: 0, tasks: 0, you: "", bot: "",
  };
}

const terminal = (phase: CallPhase) => phase === "ended" || phase === "failed";

/** Speaking only while the bot's audio actually plays; hearing while the user speaks; thinking while a task runs. */
export function livePhaseOf(state: LiveCallState): CallPhase {
  if (terminal(state.phase)) return state.phase;
  if (!state.connected) return "connecting";
  if (state.botAudio && !state.speakerMuted) return "speaking";
  if ((state.micActive || state.userTurn) && !state.micMuted) return "hearing";
  if (state.delegating > 0) return "thinking";
  return "listening";
}

/** What a session that closed by itself means for the call. */
function closedMessage(reason: string): { notice?: string; error?: string } {
  if (reason === "client_request") return {};
  if (reason === "expired") return { notice: "The call reached GPT-Live's time limit." };
  if (reason === "content") return { error: "GPT-Live ended the call: it refused the content." };
  if (reason === "connection_lost") return { error: "The call's connection to GPT-Live was lost." };
  return { notice: "GPT-Live ended the call." };
}

export function reduceLiveCall(state: LiveCallState, event: LiveCallEvent, now: number): LiveCallState {
  if (terminal(state.phase)) return state;
  const next: LiveCallState = { ...state };
  switch (event.type) {
    case "connected":
      next.connected = true;
      if (event.voice) next.voice = event.voice;
      break;
    case "failed":
      return { ...next, phase: "failed", error: event.message, endedAt: now, botAudio: false, micActive: false, userTurn: false };
    case "closed": {
      const outcome = closedMessage(event.reason);
      if (outcome.error) return { ...next, phase: "failed", error: outcome.error, endedAt: now, botAudio: false };
      return { ...next, phase: "ended", endedAt: now, botAudio: false, micActive: false, userTurn: false, ...(outcome.notice ? { notice: outcome.notice } : {}) };
    }
    case "turn":
      if (event.role === "user") {
        next.you = event.text.trim() || next.you;
        next.userTurn = !event.done;
      } else {
        next.bot = event.text.trim() || next.bot;
      }
      break;
    case "mic-activity":
      next.micActive = event.active;
      break;
    case "bot-audio":
      next.botAudio = event.active;
      break;
    case "delegation":
      next.delegating = Math.max(0, next.delegating + (event.running ? 1 : -1));
      if (!next.delegating) delete next.tool;
      break;
    case "task":
      next.tasks = Math.max(0, next.tasks + (event.running ? 1 : -1));
      break;
    case "tool":
      if (event.name && next.delegating) next.tool = event.name;
      else delete next.tool;
      break;
    case "notice":
      if (event.message) next.notice = event.message;
      else delete next.notice;
      break;
    case "mute-mic":
      next.micMuted = event.muted;
      if (event.muted) next.micActive = false;
      break;
    case "mute-speaker":
      next.speakerMuted = event.muted;
      break;
    case "hang-up":
      return { ...next, phase: "ended", endedAt: now, botAudio: false, micActive: false, userTurn: false };
  }
  next.phase = livePhaseOf(next);
  return next;
}

/* ── the call's lines ─────────────────────────────────────────────────── */

type Turn = { id: string; role: "user" | "assistant"; text: string; done: boolean; at: number };

/**
 * The call's turns in the order they began, written to the chat once finished: a turn waits for every turn that began
 * before it, so the chat reads in order. `settle` finishes a turn that will not finish by itself (the request a task
 * answers, a turn cut off by the hang-up) with what it said so far. A turn of interrupted speech says what was spoken
 * before the interruption: GPT-Live's transcript follows its audio.
 */
export class CallTranscript {
  readonly #turns = new Map<string, Turn>();
  readonly #order: string[] = [];
  /** Turns already written (the latest few hundred): a late event of one changes nothing. */
  readonly #written = new Set<string>();

  /** Applies a turn event; returns the turn's role and text so far (undefined for a delta of an unknown turn, or any
   * event of a turn already written). */
  apply(event: Extract<LiveEvent, { kind: "turn" }>, now: number): Turn | undefined {
    if (this.#written.has(event.id)) return undefined;
    let turn = this.#turns.get(event.id);
    if (!turn) {
      if (!event.role) return undefined;
      turn = { id: event.id, role: event.role, text: "", done: false, at: now };
      this.#turns.set(event.id, turn);
      this.#order.push(event.id);
    }
    if (turn.done) return turn;
    if (event.phase === "delta") turn.text += event.text;
    else if (event.text || event.phase === "created") turn.text = event.text || turn.text;
    if (event.phase === "done") turn.done = true;
    return turn;
  }

  has(id: string): boolean { return this.#turns.has(id); }
  done(id: string): boolean { return this.#turns.get(id)?.done === true; }

  /** Finishes a turn with what it said so far; every turn when `id` is undefined. */
  settle(id?: string): void {
    for (const turn of this.#turns.values()) if (id === undefined || turn.id === id) turn.done = true;
  }

  /** The finished turns at the front, in order, removed: what to write now. Empty turns are skipped. */
  take(): (CallLine & { at: number })[] {
    const lines: (CallLine & { at: number })[] = [];
    while (this.#order.length) {
      const turn = this.#turns.get(this.#order[0]!)!;
      if (!turn.done) break;
      this.#order.shift();
      this.#turns.delete(turn.id);
      this.#written.add(turn.id);
      if (this.#written.size > 500) this.#written.delete(this.#written.values().next().value!);
      const said = turn.text.replace(/\s+/gu, " ").trim();
      if (said) lines.push({ role: turn.role, text: boundText(said, CALL_LIMITS.line), at: turn.at });
    }
    return lines;
  }
}

/* ── the call ─────────────────────────────────────────────────────────── */

export type LiveMicrophone = {
  setEnabled(enabled: boolean): void;
  /** Its level (0–1) now. */
  level(): number;
  close(): void;
};

export type LiveConnectionHandlers = {
  onOpen(): void;
  onMessage(data: unknown): void;
  /** The connection or its data channel went away without a hang-up. */
  onLost(message: string): void;
};

export type LiveConnection = {
  /** HUI's id for the call. */
  callId: string;
  voice: GptLiveVoice;
  /** False while the data channel is not open. */
  send(event: object): boolean;
  /** The bot's voice's level (0–1) now. */
  level(): number;
  setSpeakerMuted(muted: boolean): void;
  close(): void;
};

export type LiveCallPlatform = {
  /** Asks for the microphone (the call was started by a click), with echo cancellation. */
  openMicrophone(): Promise<LiveMicrophone>;
  /** The peer connection with the microphone and the data channel; the gateway exchanges its offer with ChatGPT. */
  connect(microphone: LiveMicrophone, handlers: LiveConnectionHandlers): Promise<LiveConnection>;
  /** Asks the bot's helper (or hands the request to the bot's chat) and resolves with what to tell GPT-Live. */
  delegate(callId: string, id: string, request: string, signal: AbortSignal): Promise<CallDelegationResult>;
  /** Resolves once a task handed to the bot's chat ends, with what to tell GPT-Live. */
  waitTask(callId: string, task: string, signal: AbortSignal): Promise<CallTaskResult>;
  writeLines(callId: string, lines: readonly (CallLine & { at: number })[]): Promise<void>;
  heartbeat(callId: string): Promise<void>;
  /** Hangs up in the gateway; `leaving` when the page goes away (the request must outlive it). */
  end(callId: string, leaving?: boolean): Promise<void>;
  /** Tool calls of the bot's turns while a task runs: a name when one starts, undefined when it ends. */
  watchTools?(onTool: (name: string | undefined) => void): () => void;
  setTimer(callback: () => void, ms: number): () => void;
  setInterval(callback: () => void, ms: number): () => void;
  now(): number;
};

export type LiveCallOptions = {
  botName: string;
  /** How long a task's request may wait for the end of the user's turn that asked it. */
  requestWaitMs?: number;
  /** Level sampling period, for activity and faces. */
  sampleMs?: number;
  heartbeatMs?: number;
};

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The text ending in one full stop (or its own ending punctuation). */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

export class LiveCall {
  readonly #platform: LiveCallPlatform;
  readonly #options: LiveCallOptions;
  readonly #listeners = new Set<(state: LiveCallState) => void>();
  readonly #transcript = new CallTranscript();
  readonly #micGate = new ActivityGate(MIC_GATE);
  readonly #voiceGate = new ActivityGate(VOICE_GATE);
  readonly #abort = new AbortController();
  #state: LiveCallState;
  #microphone: LiveMicrophone | undefined;
  #connection: LiveConnection | undefined;
  #stops: (() => void)[] = [];
  /** Writes go one after another, in order. */
  #writes: Promise<void> = Promise.resolve();
  #turnWaiters = new Map<string, () => void>();
  /** The task the latest progress note belongs to, and when the last one went. */
  #activeDelegation: string | undefined;
  #lastProgress = Number.NEGATIVE_INFINITY;
  #greeted = false;
  /** The data channel opened before `connect` resolved. */
  #openedEarly = false;
  #ended = false;
  #closed = false;

  constructor(platform: LiveCallPlatform, options: LiveCallOptions) {
    this.#platform = platform;
    this.#options = options;
    this.#state = initialLiveCallState(platform.now());
  }

  get state(): LiveCallState { return this.#state; }
  get callId(): string | undefined { return this.#connection?.callId; }

  /** The microphone's level (0–1) for the bot's face: 0 while muted or after the call. */
  get micLevel(): number {
    if (this.#state.micMuted || terminal(this.#state.phase)) return 0;
    return this.#microphone?.level() ?? 0;
  }

  /** The bot's voice's level (0–1) as it plays. */
  get voiceLevel(): number {
    if (terminal(this.#state.phase)) return 0;
    return this.#connection?.level() ?? 0;
  }

  onChange(listener: (state: LiveCallState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    let microphone: LiveMicrophone;
    try {
      microphone = await this.#platform.openMicrophone();
    } catch (error) {
      this.#dispatch({ type: "failed", message: message(error, "The microphone could not be opened.") });
      return;
    }
    if (terminal(this.#state.phase)) { microphone.close(); return; }
    this.#microphone = microphone;
    let connection: LiveConnection;
    try {
      connection = await this.#platform.connect(microphone, {
        onOpen: () => this.#opened(),
        onMessage: (data) => this.#onMessage(data),
        onLost: (lost) => { if (!this.#ended) this.#fail(lost, false); },
      });
    } catch (error) {
      this.#fail(message(error, "GPT-Live could not start the call."), false);
      return;
    }
    if (terminal(this.#state.phase)) {
      connection.close();
      void this.#platform.end(connection.callId).catch(() => {});
      return;
    }
    this.#connection = connection;
    if (this.#openedEarly) this.#opened();
    this.#stops.push(this.#platform.setInterval(() => this.#sample(), this.#options.sampleMs ?? 50));
    this.#stops.push(this.#platform.setInterval(() => {
      void this.#platform.heartbeat(connection.callId).catch((error: unknown) => {
        // The session is still up at ChatGPT: it is asked to close.
        if (/ended|not found|404/iu.test(message(error, ""))) this.#fail("The gateway released this call.", true);
      });
    }, this.#options.heartbeatMs ?? 30_000));
    if (this.#platform.watchTools) this.#stops.push(this.#platform.watchTools((name) => this.#onTool(name)));
    // OpenDots' rule: a call ends after its time limit.
    this.#stops.push(this.#platform.setTimer(() => {
      this.#dispatch({ type: "notice", message: `Calls end after ${CALL_LIMITS.maxMinutes} minutes.` });
      this.hangUp();
    }, CALL_LIMITS.maxMinutes * 60_000));
  }

  setMicMuted(muted: boolean): void {
    this.#microphone?.setEnabled(!muted);
    if (muted) this.#micGate.reset();
    this.#dispatch({ type: "mute-mic", muted });
  }

  setSpeakerMuted(muted: boolean): void {
    this.#connection?.setSpeakerMuted(muted);
    this.#dispatch({ type: "mute-speaker", muted });
  }

  /** Ends the session, writes the last lines, then hangs up in the gateway. A task still running finishes in the chat. */
  hangUp(leaving = false): void {
    if (this.#ended) return;
    this.#dispatch({ type: "hang-up" });
    this.#finish(leaving);
  }

  #opened(): void {
    if (terminal(this.#state.phase)) return;
    if (!this.#connection) {
      this.#openedEarly = true;
      return;
    }
    this.#dispatch({ type: "connected", voice: this.#connection.voice });
    // The greeting cue waits for session.started: sent before it, GPT-Live may drop it while its session rolls over.
    this.#stops.push(this.#platform.setTimer(() => this.#greet(), GREETING_FALLBACK_MS));
  }

  /** Asks GPT-Live to greet, once, when its session has started (or after `GREETING_FALLBACK_MS` without it). */
  #greet(): void {
    if (this.#greeted || this.#ended || !this.#connection) return;
    this.#greeted = true;
    for (const event of sessionAppends("speakable", "The call just connected. Greet the user briefly, as yourself.")) this.#connection.send(event);
  }

  #onMessage(data: unknown): void {
    const event = parseLiveEvent(data);
    if (!event) return;
    if (this.#ended) {
      // Hung up: GPT-Live confirms the session closed, and the connection can go.
      if (event.kind === "closed") this.#closeConnection();
      return;
    }
    switch (event.kind) {
      case "turn": {
        const turn = this.#transcript.apply(event, this.#platform.now());
        if (!turn) return;
        this.#dispatch({ type: "turn", role: turn.role, text: turn.text, done: event.phase === "done" });
        if (event.phase === "done") {
          this.#turnWaiters.get(event.id)?.();
          this.#write();
        }
        return;
      }
      case "delegation":
        void this.#delegate(event);
        return;
      case "started":
        this.#greet();
        return;
      case "closed":
        this.#dispatch({ type: "closed", reason: event.reason });
        this.#finish(false, true);
        return;
      case "error":
        if (event.fatal) this.#fail(`GPT-Live refused the call: ${event.message}`, false);
        else this.#dispatch({ type: "notice", message: `GPT-Live: ${event.message}` });
        return;
      case "limit":
        this.#dispatch({ type: "notice", message: `ChatGPT's voice limit: ${event.status}.` });
        return;
      default:
        return;
    }
  }

  /** A task GPT-Live hands over: the request's own line first, then the bot's turn, then its result, spoken. */
  async #delegate(event: Extract<LiveEvent, { kind: "delegation" }>): Promise<void> {
    const connection = this.#connection;
    if (!connection) return;
    this.#dispatch({ type: "delegation", running: true });
    this.#activeDelegation = event.id;
    const request = event.request.trim();
    try {
      if (event.turnId) await this.#turnFinished(event.turnId, this.#options.requestWaitMs ?? 2_000);
      this.#write();
      await this.#writes;
      if (!request) {
        this.#send(delegationAppends(event.id, "speakable", "Ask the user to repeat their request; it did not come through."));
        return;
      }
      const result = await this.#platform.delegate(connection.callId, event.id, request, this.#abort.signal);
      // A hand-off is silent background: the task's own result is this delegation's spoken answer, once it comes.
      this.#send(delegationAppends(event.id, result.status === "handed-off" ? "commentary" : "speakable", result.speak));
      if (result.task) void this.#followTask(event.id, result.task);
    } catch (error) {
      // Hung up: the task goes on in the bot's chat, and its reply lands there.
      if (this.#abort.signal.aborted) return;
      const why = sentence(message(error, "the gateway did not answer"));
      this.#dispatch({ type: "notice", message: `${this.#options.botName} could not take the task: ${why}` });
      this.#send(delegationAppends(event.id, "speakable", boundText(`${this.#options.botName} could not do it: ${why} Tell the user and offer to try again.`, CALL_LIMITS.result)));
    } finally {
      if (this.#activeDelegation === event.id) this.#activeDelegation = undefined;
      this.#dispatch({ type: "delegation", running: false });
    }
  }

  /** A task handed to the bot's chat: its result is spoken if it comes while the call goes on; otherwise it stays in the
   * chat. */
  async #followTask(delegation: string, task: string): Promise<void> {
    const connection = this.#connection;
    if (!connection) return;
    this.#dispatch({ type: "task", running: true });
    this.#dispatch({ type: "notice", message: `${this.#options.botName} is working on it in the chat.` });
    try {
      const result = await this.#platform.waitTask(connection.callId, task, this.#abort.signal);
      if (this.#ended) return;
      this.#send(delegationAppends(delegation, "speakable", result.speak));
      this.#dispatch({ type: "notice", message: `${this.#options.botName} finished the task; its answer is in the chat too.` });
    } catch (error) {
      if (this.#abort.signal.aborted) return;
      this.#dispatch({ type: "notice", message: `The task's answer will be in ${this.#options.botName}'s chat (${message(error, "the gateway did not answer")}).` });
    } finally {
      this.#dispatch({ type: "task", running: false });
    }
  }

  /** Resolves once the turn is finished, or settles it with what it said after `ms`. */
  #turnFinished(id: string, ms: number): Promise<void> {
    if (this.#transcript.done(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        cancel();
        this.#turnWaiters.delete(id);
        this.#transcript.settle(id);
        resolve();
      };
      const cancel = this.#platform.setTimer(finish, ms);
      this.#turnWaiters.set(id, finish);
    });
  }

  #onTool(name: string | undefined): void {
    if (terminal(this.#state.phase) || !this.#state.delegating) return;
    this.#dispatch({ type: "tool", ...(name ? { name } : {}) });
    const delegation = this.#activeDelegation;
    const now = this.#platform.now();
    // Silent background, at most every 10 s: what the bot is doing, should the user ask.
    if (name && delegation && now - this.#lastProgress >= 10_000) {
      this.#lastProgress = now;
      this.#send(delegationAppends(delegation, "commentary", `${this.#options.botName} is working on it: using ${name}.`));
    }
  }

  #sample(): void {
    if (terminal(this.#state.phase)) return;
    const now = this.#platform.now();
    if (!this.#state.micMuted) {
      const mic = this.#micGate.update(this.#microphone?.level() ?? 0, now);
      if (mic !== undefined) this.#dispatch({ type: "mic-activity", active: mic });
    }
    const voice = this.#voiceGate.update(this.#connection?.level() ?? 0, now);
    if (voice !== undefined) this.#dispatch({ type: "bot-audio", active: voice });
  }

  #send(events: readonly object[]): void {
    for (const event of events) this.#connection?.send(event);
  }

  /** Writes the finished turns at the front, after every earlier write. */
  #write(): void {
    const connection = this.#connection;
    const lines = this.#transcript.take();
    if (!connection || !lines.length) return;
    this.#writes = this.#writes.then(() => this.#platform.writeLines(connection.callId, lines)).catch((error: unknown) => {
      if (!terminal(this.#state.phase)) this.#dispatch({ type: "notice", message: `What was said could not be saved in the chat: ${message(error, "the gateway did not answer")}` });
    });
  }

  /** `sessionAlive`: GPT-Live's session may still be up, so it is asked to close; otherwise the connection goes now. */
  #fail(why: string, sessionAlive: boolean): void {
    if (this.#ended) return;
    this.#dispatch({ type: "failed", message: why });
    this.#finish(false, !sessionAlive);
  }

  /**
   * Releases the call once: the microphone stops, the session is asked to close (unless GPT-Live closed it), the last
   * lines are written and the gateway is told. The connection goes once GPT-Live confirms, or after 800 ms.
   */
  #finish(leaving: boolean, sessionGone = false): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const stop of this.#stops.splice(0)) stop();
    for (const waiter of [...this.#turnWaiters.values()]) waiter();
    const connection = this.#connection;
    this.#abort.abort();
    this.#transcript.settle();
    this.#write();
    this.#microphone?.close();
    this.#microphone = undefined;
    if (connection && !sessionGone && !leaving && connection.send({ type: "session.close" })) {
      this.#stops.push(this.#platform.setTimer(() => this.#closeConnection(), 800));
    } else {
      this.#closeConnection();
    }
    if (connection) void this.#writes.then(() => this.#platform.end(connection.callId, leaving)).catch(() => {});
  }

  #closeConnection(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    this.#connection?.close();
  }

  #dispatch(event: LiveCallEvent): void {
    const state = reduceLiveCall(this.#state, event, this.#platform.now());
    if (state === this.#state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}
