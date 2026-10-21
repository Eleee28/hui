/**
 * How a bot's chat shows its GPT-Live calls (HUI-18), in one place. A call
 * leaves one record (the gateway writes a `hui.call` entry at hang-up; no turn
 * runs for it): this module draws it as a card with the call's duration, the
 * summary the bot's utility model wrote and the whole transcript, both sides,
 * the helper's answers and the tasks handed to the chat included.
 */
import { html, nothing } from "lit";
import { callLineSpeaker, callMinutes } from "../lib/voice/calls.ts";
import type { CallRecord, CallRecordLine } from "../api/schema/calls.ts";
import { renderMarkdown } from "../lib/markdown/markdown.ts";
import { voiceIcons } from "./bot-voice.ts";

/** "3 min", or seconds for a short one. */
export function callDuration(record: Pick<CallRecord, "startedAt" | "endedAt">): string {
  const seconds = Math.max(0, Math.round((record.endedAt - record.startedAt) / 1000));
  return seconds < 60 ? `${seconds} s` : `${callMinutes(record)} min`;
}

function renderLine(line: CallRecordLine, bot: string) {
  return html`<li class="chat-call-card__line" data-role=${line.role}>
    <span class="chat-call-card__speaker">${callLineSpeaker(line, bot)}</span>
    ${line.role === "helper" && line.request ? html`<span class="chat-call-card__asked">asked “${line.request}”</span>` : nothing}
    <span class="chat-call-card__text">${line.text}</span>
  </li>`;
}

/** One call: its duration and time, the summary (or why there is none) and the transcript, expandable. */
export function renderCallCard(record: CallRecord & { id: string }) {
  const bot = record.bot ?? "Bot";
  const started = new Date(record.startedAt);
  return html`<article class="chat-call-card" data-chat-row-key=${record.id} aria-label=${`Call with ${bot}, ${callDuration(record)}`}>
    <header class="chat-call-card__header">
      <span class="chat-call-card__icon" aria-hidden="true">${voiceIcons.phone}</span>
      <span class="chat-call-card__title">Call with ${bot}</span>
      <span class="chat-call-card__meta"><time datetime=${started.toISOString()} title=${started.toLocaleString()}>${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time> · ${callDuration(record)}</span>
    </header>
    ${record.summary
      ? html`<div class="chat-text chat-call-card__summary">${renderMarkdown(record.summary)}</div>`
      : html`<p class="chat-call-card__unavailable">The summary is unavailable: the utility model did not write it. The transcript is complete.</p>`}
    <details class="chat-call-card__transcript">
      <summary>Transcript · ${record.lines.length} ${record.lines.length === 1 ? "line" : "lines"}</summary>
      <ol class="chat-call-card__lines">${record.lines.map((line) => renderLine(line, bot))}</ol>
    </details>
  </article>`;
}
