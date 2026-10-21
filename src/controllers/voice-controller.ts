/**
 * The app's calls with bots (HUI-18): the one call, run by GPT-Live
 * (lib/voice/live-call.ts). The top-level app owns it and renders slices of it; a call
 * outlives navigating away from its bot (its bar stays in sight). Browser
 * capabilities are injected, so the rules run under test.
 */
import { LiveCall, type CallView, type LiveCallPlatform } from "../lib/voice/live-call.ts";

export type CallBot = { id: string; sessionId: string; name: string };
export type ActiveCall = { bot: CallBot; state: CallView; minimized: boolean };

/** What a call offers the controller. */
export type CallSession = {
  readonly state: CallView;
  /** The microphone's level (0–1), read every frame by the bot's face. */
  readonly micLevel: number;
  /** The bot's voice's level (0–1) as it plays; undefined while unmeasured. */
  readonly voiceLevel?: number;
  onChange(listener: (state: CallView) => void): () => void;
  start(): Promise<void>;
  /** `leaving`: the page is going away. */
  hangUp(leaving?: boolean): void;
  setMicMuted(muted: boolean): void;
  setSpeakerMuted(muted: boolean): void;
};

export type VoiceControllerDeps = {
  /** A GPT-Live call's capabilities (lib/voice/live-call-platform.ts). */
  platform(bot: CallBot): LiveCallPlatform;
  now(): number;
  setInterval(callback: () => void, ms: number): () => void;
};

export class VoiceController {
  call: ActiveCall | undefined;
  /** Ticks every second during a call, for its timer. */
  now: number;
  readonly #host: { requestUpdate(): void };
  readonly #deps: VoiceControllerDeps;
  #session: CallSession | undefined;
  #stopTicking: (() => void) | undefined;

  constructor(host: { requestUpdate(): void }, deps: VoiceControllerDeps) {
    this.#host = host;
    this.#deps = deps;
    this.now = deps.now();
  }

  /** The call's microphone level (0–1): what the bot's face hears while it listens. Read every frame, never rendered. */
  micLevel(): number {
    return this.call ? this.#session?.micLevel ?? 0 : 0;
  }

  /** The bot's voice's level (0–1) while it speaks in the call; undefined while unmeasured. */
  voiceLevel(): number | undefined {
    return this.call ? this.#session?.voiceLevel : 0;
  }

  /** Calls a bot, or brings its call back. Another bot's call must be hung up first (false). */
  startCall(bot: CallBot): boolean {
    if (this.call) {
      if (this.call.bot.id !== bot.id) return false;
      this.call = { ...this.call, minimized: false };
      this.#host.requestUpdate();
      return true;
    }
    const session: CallSession = new LiveCall(this.#deps.platform(bot), { botName: bot.name });
    this.#session = session;
    this.call = { bot, state: session.state, minimized: false };
    session.onChange((state) => {
      if (this.#session !== session || !this.call) return;
      // Hanging up returns to the chat at once; a failure stays on screen until it is read.
      if (state.phase === "ended") this.#endCall();
      else {
        this.call = { ...this.call, state };
        this.#host.requestUpdate();
      }
    });
    this.now = this.#deps.now();
    this.#stopTicking = this.#deps.setInterval(() => {
      this.now = this.#deps.now();
      this.#host.requestUpdate();
    }, 1_000);
    void session.start();
    this.#host.requestUpdate();
    return true;
  }

  hangUp(): void {
    if (this.#session && this.call?.state.phase !== "failed") this.#session.hangUp();
    else this.#endCall();
  }

  toggleMic(): void {
    if (this.call) this.#session?.setMicMuted(!this.call.state.micMuted);
  }

  toggleSpeaker(): void {
    if (this.call) this.#session?.setSpeakerMuted(!this.call.state.speakerMuted);
  }

  minimize(): void {
    if (!this.call) return;
    this.call = { ...this.call, minimized: true };
    this.#host.requestUpdate();
  }

  expand(): void {
    if (!this.call) return;
    this.call = { ...this.call, minimized: false };
    this.#host.requestUpdate();
  }

  /** Leaves a call that failed. */
  closeCall(): void {
    this.#endCall();
  }

  dispose(): void {
    this.#session?.hangUp(true);
    this.#endCall();
  }

  #endCall(): void {
    this.#session = undefined;
    this.call = undefined;
    this.#stopTicking?.();
    this.#stopTicking = undefined;
    this.#host.requestUpdate();
  }
}
