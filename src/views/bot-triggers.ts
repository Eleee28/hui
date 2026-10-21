/**
 * The Triggers page of a bot's panel (HUI-18): its triggers with what they let through, when they last fired, their
 * cooldown, what their listener last reported, an on/off switch, Test, New URL and Delete; the latest runs; and the add
 * form. A trigger's URL shows once, right after it was made or replaced. Rendering only: `BotTriggersController`
 * (`src/controllers/bot-triggers-controller.ts`) owns the state and every request.
 */
import { html, nothing } from "lit";
import type { BotTrigger, BotTriggerRun } from "../api/schema/bot-triggers.ts";
import type { BotView } from "../api/schema/bots.ts";
import { icons } from "../lib/icons.ts";
import { BOT_TRIGGER_LIMITS, botTriggerFilterSummary, cooldownLabel, TriggerFormError, triggerFormInput, type BotTriggersActions, type BotTriggersState, type RevealedHook } from "../lib/bots/triggers.ts";
import { renderSettingsToggle } from "./settings-toggle.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/bot-triggers.css"));

/** `adding`: the page opened on its add form (the overview's +). */
export type BotTriggersProps = { bot: BotView; now: number; state: BotTriggersState; adding?: boolean } & BotTriggersActions;

export const TRIGGER_RUN_LABELS: Record<BotTriggerRun["status"], string> = { fired: "Fired", coalesced: "Coalesced", skipped: "Skipped", failed: "Failed" };
/** The cooldowns the form offers, in seconds. */
export const COOLDOWN_CHOICES: readonly number[] = [0, 60, 300, 900, 3_600];

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`, or the date. */
export function agoLabel(at: string | undefined, now: number): string {
  const time = Date.parse(at ?? "");
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1_000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** `14:05` today, or a date and time. */
export function whenLabel(at: string, now: number): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return at;
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderTrigger(trigger: BotTrigger, props: BotTriggersProps) {
  const { state } = props;
  const fired = trigger.lastFiredAt ? `Last fired ${agoLabel(trigger.lastFiredAt, props.now)}` : "Never fired";
  return html`<li class="bot-trigger ${trigger.enabled ? "" : "bot-trigger--paused"}" data-trigger=${trigger.id}>
    <div class="bot-trigger__head">
      <span class="bot-trigger__source" aria-hidden="true">${icons.radio}</span>
      <span class="bot-trigger__name">${trigger.name}</span>
      ${renderSettingsToggle(`Enable ${trigger.name}`, trigger.enabled, (checked) => props.onToggle(trigger, checked), state.pending)}
    </div>
    <p class="bot-trigger__filter" title=${botTriggerFilterSummary(trigger)}>${botTriggerFilterSummary(trigger)}</p>
    <p class="bot-trigger__meta">${fired} · cooldown ${cooldownLabel(trigger.cooldownSeconds)}${trigger.delivery === "steer" ? " · steers with summaries and links" : ""}${trigger.createdBy === "bot" ? ` · added by ${props.bot.name}` : ""}</p>
    ${trigger.pending ? html`<p class="bot-trigger__meta bot-trigger__meta--pending">${trigger.pending.events} event${trigger.pending.events === 1 ? "" : "s"} wait${trigger.pending.events === 1 ? "s" : ""}, sent together at ${whenLabel(trigger.pending.until, props.now)}</p>` : nothing}
    ${renderWatch(trigger, props.now)}
    <p class="bot-trigger__meta">URL …/hooks/${trigger.tokenHint ?? ""}… · shown when it was made</p>
    ${trigger.prompt ? html`<p class="bot-trigger__prompt" title=${trigger.prompt}>${trigger.prompt}</p>` : nothing}
    <div class="bot-trigger__actions">
      <button type="button" class="btn btn--sm bot-trigger__test" ?disabled=${state.pending} aria-label=${`Test ${trigger.name}`} @click=${() => props.onTest(trigger)}>${icons.zap}<span>Test</span></button>
      <button type="button" class="btn btn--sm btn--ghost bot-trigger__rotate" ?disabled=${state.pending} aria-label=${`New URL for ${trigger.name}`} @click=${() => props.onRotate(trigger)}>${icons.refresh}<span>New URL</span></button>
      <button type="button" class="btn btn--sm btn--ghost bot-trigger__delete" ?disabled=${state.pending} aria-label=${`Delete ${trigger.name}`} @click=${() => props.onDelete(trigger)}>${icons.trash}<span>Delete</span></button>
    </div>
  </li>`;
}

/** What the trigger's listener last did: the problem it (or its silence) reported, or when it last reported. */
function renderWatch(trigger: BotTrigger, now: number) {
  if (trigger.watch?.error) return html`<p class="bot-trigger__meta bot-trigger__meta--error" role="status">${trigger.watch.error}</p>`;
  const polled = trigger.watch?.polledAt;
  return trigger.enabled && polled ? html`<p class="bot-trigger__meta">Listener reported ${agoLabel(polled, now)}</p>` : nothing;
}

function renderRevealed(revealed: RevealedHook, props: BotTriggersProps) {
  return html`<div class="bot-trigger-url" role="status" aria-live="polite">
    <p class="bot-trigger-url__title">${revealed.name}: its URL</p>
    <p class="bot-panel__hint">Copy it now: HUI keeps only a fingerprint of it and can't show it again. Give it to your listener: after every check it POSTs <code>{ "events": [...] }</code> to it from this machine or your tailnet, the list empty when nothing happened.</p>
    <code class="bot-trigger-url__value" aria-label=${`URL of ${revealed.name}`}>${revealed.url}</code>
    <div class="bot-trigger-url__actions">
      <button type="button" class="btn btn--sm bot-trigger-url__copy" @click=${props.onCopy}>${revealed.copied ? icons.check : icons.copy}<span>${revealed.copied ? "Copied" : "Copy"}</span></button>
      <button type="button" class="btn btn--sm btn--ghost" @click=${props.onDismissUrl}>Done</button>
    </div>
  </div>`;
}

function renderRun(run: BotTriggerRun, now: number) {
  const tags = [...(run.test ? ["test"] : []), ...(run.catchUp ? ["catch-up"] : []), ...(run.events > 1 ? [`${run.events} events`] : [])];
  return html`<li class="bot-run bot-trigger-run" data-run=${run.id} data-status=${run.status}>
    <div class="bot-run__head"><span class="bot-run__name">${run.triggerName}</span><span class="bot-run__status">${TRIGGER_RUN_LABELS[run.status]}</span></div>
    <p class="bot-run__facts">${agoLabel(run.at, now)}${tags.length ? ` · ${tags.join(" · ")}` : ""}</p>
    ${run.summary ? html`<p class="bot-run__body">${run.summary}</p>` : nothing}
    ${run.reason ? html`<p class="bot-run__body ${run.status === "failed" ? "bot-run__body--error" : ""}" role=${run.status === "failed" ? "alert" : nothing}>${run.reason}</p>` : nothing}
  </li>`;
}

const formText = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

function submitTrigger(event: SubmitEvent, props: BotTriggersProps) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  try {
    const input = triggerFormInput({
      name: formText(data, "name"),
      prompt: formText(data, "prompt"),
      cooldown: formText(data, "cooldown"),
      matchField: formText(data, "matchField"),
      matchOp: formText(data, "matchOp"),
      matchValue: formText(data, "matchValue"),
      prLinks: data.get("prLinks") !== null,
      external: data.get("external") !== null,
      bots: data.get("bots") !== null,
      steer: data.get("steer") !== null,
    });
    // Only an accepted trigger clears the form; a refusal keeps what was typed.
    void props.onCreate(input).then((created) => {
      if (created) form.reset();
    });
  } catch (error) {
    props.onFormError(error instanceof TriggerFormError ? error.message : "Could not read the trigger form.");
  }
}

function renderForm(props: BotTriggersProps, open: boolean) {
  const { state } = props;
  const name = props.bot.name;
  return html`<details class="bot-trigger-form" ?open=${open}>
    <summary class="bot-trigger-form__summary">${icons.plus}<span>Add trigger</span></summary>
    <form class="bot-trigger-form__body" novalidate @submit=${(event: SubmitEvent) => submitTrigger(event, props)}>
      <label class="bot-field"><span class="bot-field__label">Name</span>
        <input class="settings-input" name="name" type="text" maxlength=${BOT_TRIGGER_LIMITS.name} placeholder="Reviews" autocomplete="off" /></label>
      <p class="bot-field__hint">A program you run, a listener, watches something HUI doesn't read itself and, after every check, POSTs what it found to a URL HUI makes and shows once. Each event wakes ${name} once, events from before the trigger never do, and an empty report only says the listener is alive.</p>
      <fieldset class="bot-field">
        <legend class="bot-field__label">Only events where (optional)</legend>
        <div class="bot-trigger-form__match">
          <input class="settings-input" name="matchField" type="text" placeholder="fields.channel" aria-label="Event field" autocomplete="off" spellcheck="false" />
          <select class="settings-input" name="matchOp" aria-label="Comparison"><option value="equals" selected>equals</option><option value="contains">contains</option></select>
          <input class="settings-input" name="matchValue" type="text" placeholder="C0123ABCD" aria-label="Value" autocomplete="off" />
        </div>
      </fieldset>
      <label class="bot-trigger-form__check"><input type="checkbox" name="prLinks" /><span>Only events that link a GitHub pull request</span></label>
      <label class="bot-trigger-form__check"><input type="checkbox" name="external" /><span>Also events it marks as from outside your organization</span></label>
      <label class="bot-trigger-form__check"><input type="checkbox" name="bots" /><span>Also events it marks as from bots and apps</span></label>
      <label class="bot-trigger-form__check"><input type="checkbox" name="steer" /><span>Steer the current turn with summaries and PR links only</span></label>
      <p class="bot-field__hint">When selected, a busy bot receives the update before its next model call, without event details or fetched PR diffs. An idle bot starts a turn. Otherwise updates wait as full-context follow-ups.</p>
      <label class="bot-field"><span class="bot-field__label">Prompt</span>
        <textarea class="settings-input" name="prompt" rows="2" maxlength=${BOT_TRIGGER_LIMITS.prompt} placeholder=${`What should ${name} do when it fires?`}></textarea></label>
      <label class="bot-field bot-trigger-form__cooldown"><span class="bot-field__label">Cooldown</span>
        <select class="settings-input" name="cooldown">
          ${COOLDOWN_CHOICES.map((seconds) => html`<option value=${String(seconds)} ?selected=${seconds === BOT_TRIGGER_LIMITS.cooldownDefault}>${seconds ? cooldownLabel(seconds) : "None"}</option>`)}
        </select></label>
      <p class="bot-field__hint">Events within the cooldown of the last delivery arrive together, as one message. ${name} takes at most ${BOT_TRIGGER_LIMITS.perHour} trigger deliveries an hour; more wait.</p>
      ${state.formError ? html`<p class="bot-field__error" role="alert">${state.formError}</p>` : nothing}
      <div class="bot-trigger-form__actions"><button type="submit" class="btn primary btn--sm" ?disabled=${state.pending}>Add trigger</button></div>
    </form>
  </details>`;
}

/** The Triggers page; the panel's header names it. */
export function renderBotTriggers(props: BotTriggersProps) {
  const { state } = props;
  const list = state.list;
  let body;
  if (!list) {
    body = state.error
      ? html`<div class="bot-panel__state" role="alert">${state.error} <button type="button" class="btn btn--sm" @click=${props.onRetry}>Retry</button></div>`
      : html`<p class="bot-panel__state" role="status">Reading triggers…</p>`;
  } else {
    body = html`
      ${state.actionError ? html`<p class="bot-field__error" role="alert">${state.actionError}</p>` : nothing}
      ${state.notice ? html`<p class="bot-panel__hint bot-triggers__notice" role="status">${state.notice}</p>` : nothing}
      ${state.revealed ? renderRevealed(state.revealed, props) : nothing}
      ${list.triggers.length
        ? html`<ul class="bot-triggers__list" aria-label="Triggers">${list.triggers.map((trigger) => renderTrigger(trigger, props))}</ul>`
        : html`<p class="bot-panel__hint">No triggers yet. A trigger wakes ${props.bot.name} when a listener you run reports something: a program that watches what HUI doesn't read itself, such as a Slack or a Jira board, and sends what it finds to the trigger's URL.</p>`}
      ${renderForm(props, list.triggers.length === 0 || Boolean(props.adding))}
      ${list.runs.length ? html`<h4 class="bot-triggers__subheading">Latest trigger runs</h4><ul class="bot-runs">${list.runs.slice(0, 10).map((run) => renderRun(run, props.now))}</ul>` : nothing}
      <p class="bot-panel__hint">${list.deliveries.lastHour} of ${list.deliveries.perHour} trigger deliveries in the last hour.</p>
      ${state.error ? html`<p class="bot-field__error" role="alert">Refresh failed: ${state.error}</p>` : nothing}`;
  }
  return html`<section class="bot-panel__section bot-triggers">${body}</section>`;
}
