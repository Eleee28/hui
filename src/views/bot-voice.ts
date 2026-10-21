/**
 * Calls with bots (HUI-18), rendering only: the bot header's Call button, the
 * call view and its minimized bar. State and actions come from props owned by
 * `hui-app.ts` (src/lib/voice/live-call.ts and src/controllers/voice-controller.ts hold the logic).
 */
import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { botLook, type BotView } from "../lib/bots/bots.ts";
import { callStatusLabel, type CallView } from "../lib/voice/live-call.ts";
import { gptLiveVoiceLabel, isGptLiveVoice } from "../lib/voice/calls.ts";
import { formatCallTime } from "../lib/voice/voice.ts";
import { renderBotAvatar } from "./bots.ts";
import { callFaceState } from "../lib/bots/face.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/voice.css"));

// Lucide geometry (ISC) for controls the pinned OpenClaw icon set lacks.
function lucide(body: SVGTemplateResult): TemplateResult {
  return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const voiceIcons = {
  mic: lucide(svg`<path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" />`),
  micOff: lucide(svg`<path d="M2 2l20 20" /><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" /><path d="M5 10v2a7 7 0 0 0 12 5" /><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" /><path d="M9 9v3a3 3 0 0 0 5.12 2.12" /><path d="M12 19v3" />`),
  phone: lucide(svg`<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />`),
  phoneOff: lucide(svg`<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" /><path d="M22 2 2 22" />`),
  volume: lucide(svg`<path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" />`),
  volumeOff: lucide(svg`<path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6" /><path d="m16 9 6 6" />`),
  minimize: lucide(svg`<path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="m14 10 7-7" /><path d="m3 21 7-7" />`),
};

/* ── bot header ── */

export function renderCallButton(options: { botName: string; inCall: boolean; onCall: () => void }) {
  return html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-call-toggle ${options.inCall ? "bot-call-toggle--active" : ""}"
    aria-label=${options.inCall ? `Return to the call with ${options.botName}` : `Call ${options.botName}`} title=${options.inCall ? "Return to the call" : "Call"}
    @click=${options.onCall}>${voiceIcons.phone}</button>`;
}

/* ── the call ── */

export type CallViewProps = {
  bot: Pick<BotView, "id" | "name" | "title" | "avatar">;
  state: CallView;
  now: number;
  /** The bot's turn waits on its memory ("Summarizing memory…"). */
  summarizing: boolean;
  /** The audio level (0–1) the face follows: the microphone while it listens, the bot's voice while it speaks. */
  level?: () => number | undefined;
  onToggleMic: () => void;
  onToggleSpeaker: () => void;
  onMinimize: () => void;
  onExpand: () => void;
  onHangUp: () => void;
  /** Leaves a call that failed. */
  onClose: () => void;
};

const elapsed = (props: CallViewProps) => formatCallTime((props.state.endedAt ?? props.now) - props.state.startedAt);

/** Where a call's audio goes, as the call view says it. */
function privacyLine(props: CallViewProps): string {
  const { state, bot } = props;
  const voice = state.voice && isGptLiveVoice(state.voice) ? ` · voice ${gptLiveVoiceLabel(state.voice)}` : "";
  return `GPT-Live through your ChatGPT account${voice}. Audio goes to OpenAI; ${bot.name}'s chat keeps the call's summary and transcript. HUI stores no audio.`;
}

export function renderCallView(props: CallViewProps) {
  const { state, bot } = props;
  const failed = state.phase === "failed";
  const time = elapsed(props);
  const look = botLook(bot);
  // The call takes the bot's color, as Dots' call screen does; a face's eyes follow the pointer anywhere in it.
  return html`<section class="bot-call" data-phase=${state.phase} role="region" aria-label=${`Call with ${bot.name}`} style=${`--bot-color: ${look.color}`} data-face-stage
    @keydown=${(event: KeyboardEvent) => {
      if (event.key !== "Escape" || failed || event.defaultPrevented) return;
      event.preventDefault();
      props.onMinimize();
    }}>
    <header class="bot-call__header">
      <span class="bot-call__badge">${voiceIcons.phone}<span>Voice call</span></span>
      <time class="bot-call__timer" role="timer" aria-label=${`Call time ${time}`}>${time}</time>
      ${failed ? nothing : html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-call__minimize" aria-label="Minimize the call" title="Minimize" @click=${props.onMinimize}>${voiceIcons.minimize}</button>`}
    </header>
    <div class="bot-call__stage">
      <div class="bot-call__orb ${look.kind === "face" ? "bot-call__orb--face" : ""}" data-phase=${state.phase}>${renderBotAvatar(bot, "xl", { state: callFaceState(state, props.summarizing), ...(props.level ? { level: props.level } : {}) })}</div>
      <h2 class="bot-call__name">${bot.name}</h2>
      <p class="bot-call__status" role="status" aria-live="polite">${callStatusLabel(state, props.summarizing, bot.name)}</p>
    </div>
    <div class="bot-call__captions">
      <div class="bot-call__caption bot-call__caption--you"><span class="bot-call__speaker">You</span>
        <p class="bot-call__line" data-empty=${String(!state.you)}>${state.you || "Talk whenever you like; you can interrupt."}</p></div>
      <div class="bot-call__caption bot-call__caption--bot" aria-live="polite"><span class="bot-call__speaker">${bot.name}</span>
        <p class="bot-call__line" data-empty=${String(!state.bot)}>${state.bot || "…"}</p></div>
    </div>
    ${state.notice && !failed ? html`<p class="bot-call__notice" role="status">${state.notice}</p>` : nothing}
    ${failed ? html`<p class="bot-call__error" role="alert">${state.error}</p>` : nothing}
    <div class="bot-call__controls" role="toolbar" aria-label="Call controls">
      ${failed ? html`<button type="button" class="btn bot-call__close" @click=${props.onClose}>Back to the chat</button>` : html`
        <button type="button" class="bot-call__control" aria-pressed=${String(state.micMuted)} aria-label="Mute microphone" @click=${props.onToggleMic}>
          ${state.micMuted ? voiceIcons.micOff : voiceIcons.mic}<span>${state.micMuted ? "Muted" : "Mute"}</span></button>
        <button type="button" class="bot-call__control" aria-pressed=${String(state.speakerMuted)} aria-label="Mute speaker" @click=${props.onToggleSpeaker}>
          ${state.speakerMuted ? voiceIcons.volumeOff : voiceIcons.volume}<span>${state.speakerMuted ? "Speaker off" : "Speaker"}</span></button>
        <button type="button" class="bot-call__control bot-call__control--hangup" aria-label="Hang up" @click=${props.onHangUp}>${voiceIcons.phoneOff}<span>Hang up</span></button>`}
    </div>
    <p class="bot-call__privacy">${privacyLine(props)}</p>
  </section>`;
}

/** The minimized call: a bar that keeps the call in sight over the chat or anywhere else in HUI. */
export function renderCallBar(props: CallViewProps & { floating: boolean }) {
  const { state, bot } = props;
  return html`<div class="bot-call-bar ${props.floating ? "bot-call-bar--floating" : ""}" data-phase=${state.phase} role="region" aria-label=${`Call with ${bot.name}, minimized`}>
    <button type="button" class="bot-call-bar__open" aria-label=${`Return to the call with ${bot.name}`} @click=${props.onExpand}>
      ${renderBotAvatar(bot, "sm", { state: callFaceState(state, props.summarizing) })}
      <span class="bot-call-bar__pulse" aria-hidden="true"></span>
      <span class="bot-call-bar__name">${bot.name}</span>
      <span class="bot-call-bar__status">${callStatusLabel(state, props.summarizing, bot.name)}</span>
      <time class="bot-call-bar__time">${elapsed(props)}</time>
    </button>
    <button type="button" class="bot-call-bar__button" aria-pressed=${String(state.micMuted)} aria-label="Mute microphone" title=${state.micMuted ? "Unmute" : "Mute"} @click=${props.onToggleMic}>
      ${state.micMuted ? voiceIcons.micOff : voiceIcons.mic}</button>
    <button type="button" class="bot-call-bar__button bot-call-bar__button--hangup" aria-label="Hang up" title="Hang up" @click=${props.onHangUp}>${voiceIcons.phoneOff}</button>
  </div>`;
}
