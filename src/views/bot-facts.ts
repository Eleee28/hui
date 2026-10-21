/** Explicit memories in the bot panel: manually saved facts, preferences and decisions with inspectable provenance. */
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import type { BotFactKind } from "../api/schema/bots.ts";
import { BOT_FACT_KINDS, BOT_FACT_LIMITS, type BotFactsActions, type BotFactsState } from "../lib/bots/facts.ts";
import { closeModal, ensureModal } from "../lib/modal-dialog.ts";
import { loadViewAssets } from "../lib/view-assets.ts";
loadViewAssets(() => import("../styles/bot-facts.css"));
export function renderBotFacts(controller: { state: BotFactsState } & BotFactsActions) {
  const { state } = controller;
  const editing = state.editing;
  const disabled = state.pending || state.loading || !state.loaded;
  return html`<div class="bot-facts">
    <p class="muted">What this bot knows: facts, preferences and decisions you save explicitly. These complement its conversation memory, without automatic extraction.</p>
    <p class="muted">All saved memories are read on its next turn; pinned memories come first. Saving does not start a model call. Earlier chat and summaries are kept.</p>
    <div class="bot-facts__toolbar"><span>${state.loaded ? `${state.facts.length} / ${BOT_FACT_LIMITS.count} memories` : ""}</span>
      <button type="button" class="btn btn--sm" ?disabled=${state.loading || state.pending} @click=${() => controller.load(state.botId, true)}>Refresh memories</button></div>
    ${state.loading ? html`<p role="status">Loading memories…</p>` : nothing}
    ${state.error ? html`<p class="is-error" role="alert">${state.error}</p>` : nothing}
    ${state.loaded && !state.facts.length ? html`<p class="muted">No explicit memories yet. Save only what you want this bot to keep.</p>` : nothing}
    ${editing ? html`<p class="muted">Finish or cancel your edit before editing another memory.</p>` : nothing}
    <ul class="bot-facts__list">${state.facts.map((fact) => html`<li class="bot-facts__card">
      <div class="bot-facts__meta"><strong>${fact.kind[0]!.toUpperCase() + fact.kind.slice(1)}</strong>${fact.pinned ? html`<span>Pinned</span>` : nothing}</div>
      <p class="bot-facts__text">${fact.text}</p>
      <p class="bot-facts__source">Manually saved · ${fact.source}<br>Created ${new Date(fact.createdAt).toLocaleString()}${fact.revision > 1 ? html`<br>Updated ${new Date(fact.updatedAt).toLocaleString()} · revision ${fact.revision}` : nothing}</p>
      <div class="bot-facts__actions">
        <button type="button" class="btn btn--sm" ?disabled=${disabled || Boolean(editing)} @click=${() => controller.edit(fact)}>Edit memory</button>
        <button type="button" class="btn btn--sm" aria-pressed=${String(fact.pinned)} ?disabled=${disabled} @click=${() => controller.pin(fact)}>${fact.pinned ? "Unpin memory" : "Pin memory"}</button>
        <button type="button" class="btn btn--sm danger" ?disabled=${disabled} @click=${() => controller.remove(fact)}>Delete memory</button>
      </div>
    </li>`)}</ul>
    ${keyed(`${state.botId}:${editing?.id ?? "new"}`, html`<form class="bot-facts__form" @submit=${async (event: SubmitEvent) => {
      event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const data = new FormData(form);
      const saved = await controller.save({ kind: String(data.get("kind")) as BotFactKind, text: String(data.get("text") ?? ""), source: String(data.get("source") ?? ""), pinned: editing?.pinned ?? false });
      if (saved) form.reset();
    }}>
      <h3 class="bot-panel__heading">${editing ? "Edit memory" : "Add memory"}</h3>
      <label>Kind<select class="settings-select" name="kind" ?disabled=${disabled}>${BOT_FACT_KINDS.map((kind) => html`<option value=${kind} ?selected=${kind === (editing?.kind ?? "fact")}>${kind[0]!.toUpperCase() + kind.slice(1)}</option>`)}</select></label>
      <label>Memory<textarea class="settings-input" name="text" rows="3" required maxlength=${BOT_FACT_LIMITS.text} .value=${editing?.text ?? ""} ?disabled=${disabled}></textarea></label>
      ${editing ? html`<p class="muted">Original source is kept: ${editing.source}</p>` : html`<label>Source (optional)<input class="settings-input" name="source" maxlength=${BOT_FACT_LIMITS.source} placeholder="For example: our planning conversation" ?disabled=${disabled}></label>`}
      <div class="bot-facts__actions"><button type="submit" class="btn primary" ?disabled=${disabled}>${state.pending ? "Saving…" : editing ? "Save changes" : "Save memory"}</button>
        ${editing ? html`<button type="button" class="btn" ?disabled=${state.pending} @click=${() => controller.edit()}>Cancel edit</button>` : nothing}</div>
    </form>`)}
    ${state.removing ? html`<dialog class="hui-modal-dialog group-action-dialog" aria-labelledby="bot-fact-delete-title"
      ${ref((element) => { if (element) queueMicrotask(() => { if (element.isConnected) ensureModal(element as HTMLDialogElement); }); })}
      @cancel=${(event: Event) => { event.preventDefault(); if (!state.pending) { closeModal(event.currentTarget as HTMLDialogElement); controller.remove(); } }}>
      <form class="exec-approval-card" @submit=${async (event: SubmitEvent) => { event.preventDefault(); const dialog = (event.currentTarget as HTMLFormElement).closest("dialog"); if (await controller.confirmDelete()) closeModal(dialog ?? undefined); }}>
        <h3 class="exec-approval-title" id="bot-fact-delete-title">Delete this memory?</h3>
        <p class="exec-approval-sub">This removes the saved memory from future turns. It cannot be undone. Earlier conversation messages and summaries are not erased.</p>
        <p class="bot-facts__text">${state.removing.text}</p>
        ${state.error ? html`<p class="is-error" role="alert">${state.error}</p>` : nothing}
        <div class="exec-approval-actions"><button type="submit" class="btn danger" ?disabled=${state.pending}>Delete saved memory</button>
          <button type="button" class="btn" ?disabled=${state.pending} @click=${(event: Event) => { closeModal((event.currentTarget as HTMLElement).closest("dialog") ?? undefined); controller.remove(); }}>Cancel</button></div>
      </form></dialog>` : nothing}
  </div>`;
}
