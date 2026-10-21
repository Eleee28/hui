/**
 * Settings → Models → Providers: the model providers the gateway can sign in to, their login prompts, the models
 * chosen per provider, account priority and quotas, all through `/__hui/providers`. A sign-in or sign-out is
 * announced with a `providers-changed` event so sections that depend on a login can refresh.
 */
import { LitElement, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ProviderLogin, ProviderQuota, ProviderSnapshot, ProviderSummary } from "../../api/schema/providers.ts";
import { loadProviderQuota, loadProviders, providerRequest } from "../../api/providers.ts";
import { renderProviderBrandIcon } from "../../lib/provider-icons.ts";
import { connectionMethods, connectionName, providerBrand, providerBrands } from "../../lib/provider-choices.ts";
import { loadViewAssets } from "../../lib/view-assets.ts";

loadViewAssets(() => import("../../styles/providers.css"));
type AccountDrag = { provider: string; id: string; name: string; order: string[]; from: number; to: number; handle: HTMLElement; pointer?: number; y: number; startY: number; moved: boolean };
type ModelDraft = { models: Set<string>; query: string };

export class HuiProviderSettings extends LitElement {
  #snapshot?: ProviderSnapshot;
  #drag?: AccountDrag;
  #dragFrame = 0;
  #dragNotice = "";
  #brand = "";
  #selected = "";
  #accountId?: string;
  #accountName = "";
  #busy = false;
  #error = "";
  #notice = "";
  #confirm = "";
  #drafts = new Map<string, ModelDraft>();
  #quotas = new Map<string, ProviderQuota>();
  #quotaLoading = new Set<string>();
  #poll?: ReturnType<typeof setTimeout>;
  #generation = 0;
  #finishAttempt = "";
  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); void this.#refresh(); }
  override disconnectedCallback() { super.disconnectedCallback(); this.#endDrag(false); clearTimeout(this.#poll); this.#generation++; }
  #dialog() { return this.querySelector<HTMLDialogElement>(".hui-provider-dialog"); }
  override updated() {
    const dialog = this.#dialog();
    // Step changes replace the focused button. Keep keyboard input (including
    // Escape) inside the modal instead of leaking into Settings shortcuts.
    if (dialog?.open && !dialog.contains(document.activeElement)) {
      (dialog.querySelector<HTMLElement>("input, select, .hui-provider-choice") ?? dialog.querySelector("button"))?.focus();
    }
  }
  #changed() { this.dispatchEvent(new CustomEvent("providers-changed", { bubbles: true, composed: true })); }
  #schedule() {
    clearTimeout(this.#poll);
    if (this.isConnected && this.#snapshot?.login?.phase === "pending") this.#poll = setTimeout(() => void this.#refresh(), 1200);
  }
  async #refresh() {
    const generation = this.#generation;
    try {
      const next = await loadProviders();
      if (generation !== this.#generation || !this.isConnected) return;
      this.#snapshot = next;
      this.#error = "";
      const login = next.login;
      // A reload can resume the host's pending sign-in, including device flows.
      if (login?.phase === "pending" && !this.#dialog()?.open) await this.#open(providerBrand(login.provider)?.id ?? login.provider, login.provider);
      if (login?.phase === "complete" && login.provider === this.#selected && this.#finishAttempt !== login.id) {
        this.#finishAttempt = login.id;
        const provider = next.providers.find((entry) => entry.id === login.provider);
        if (provider?.authenticated) {
          const busy = this.#busy; this.#busy = true; this.requestUpdate();
          try { await this.#finish(provider); } finally { this.#busy = busy; }
        }
      }
      for (const provider of this.#snapshot.providers) {
        if (provider.configured && provider.authenticated) {
          for (const account of provider.accounts ?? []) if (account.authenticated && !this.#quotas.has(`${provider.id}/accounts/${account.id}`)) void this.#loadQuota(`${provider.id}/accounts/${account.id}`);
        }
      }
    } catch (error) { if (generation === this.#generation) this.#error = error instanceof Error ? error.message : "Providers could not be loaded."; }
    finally { if (generation === this.#generation && this.isConnected) { this.#schedule(); this.requestUpdate(); } }
  }
  async #mutate(path: string, method: string, body?: unknown, notice = "") {
    clearTimeout(this.#poll);
    this.#busy = true; this.#error = ""; this.#notice = ""; this.requestUpdate();
    let success = false;
    try {
      await providerRequest(path, method, body);
      this.#notice = notice;
      await this.#refresh();
      this.#changed();
      success = true;
    } catch (error) { this.#error = error instanceof Error ? error.message : "Provider operation failed."; }
    finally { this.#busy = false; this.#schedule(); this.requestUpdate(); }
    return success;
  }
  async #open(brand = "", selected = "", accountId?: string) {
    this.#accountId = accountId;
    this.#accountName = selected === "opencode-go" && accountId ? this.#snapshot?.providers.find((provider) => provider.id === selected)?.accounts?.find((account) => account.id === accountId)?.name ?? "" : "";
    this.#brand = brand; this.#selected = selected; this.#error = ""; this.#notice = "";
    this.requestUpdate(); await this.updateComplete;
    this.#dialog()?.showModal();
  }
  #dismiss() {
    this.#dialog()?.close(); this.#brand = ""; this.#selected = ""; this.requestUpdate();
  }
  async #close() {
    if (this.#busy) return;
    const login = this.#snapshot?.login;
    if (login?.phase === "pending" && !await this.#mutate(`login/${login.id}`, "DELETE")) return;
    this.#dismiss();
  }
  async #finish(provider: ProviderSummary) {
    // Auth and adding the connection are separate writes. Keep an explicit retry
    // in the modal if selection persistence fails; never announce optimistic success.
    await providerRequest(provider.id, "PUT", { models: provider.selected });
    this.#snapshot = await loadProviders();
    this.#quotas.clear();
    this.#notice = `${connectionName(provider)} added. Choose the models you want to use.`;
    this.#changed(); this.#dismiss();
  }
  async #useConnection(provider: ProviderSummary) {
    this.#busy = true; this.#error = ""; this.requestUpdate();
    try { await this.#finish(provider); await this.#refresh(); }
    catch (error) { this.#error = error instanceof Error ? error.message : "Connection could not be added. Try again."; }
    finally { this.#busy = false; this.requestUpdate(); }
  }
  async #loadQuota(id: string) {
    if (this.#quotaLoading.has(id)) return;
    const generation = this.#generation;
    this.#quotaLoading.add(id); this.requestUpdate();
    try {
      const quota = await loadProviderQuota(id);
      if (generation === this.#generation) { this.#quotas.set(id, quota); await this.#refresh(); }
    } catch {
      if (generation === this.#generation) this.#quotas.set(id, { status: "unavailable", checkedAt: Date.now(), windows: [], message: "Usage could not be retrieved. Try refreshing limits." });
    } finally { this.#quotaLoading.delete(id); this.requestUpdate(); }
  }
  #login(login: ProviderLogin) {
    const prompt = login.prompt;
    return html`<div class="hui-provider-login">
      <p role="status">${login.message ?? "Complete sign-in to continue."}</p>
      ${login.url ? html`<a class="btn primary" href=${login.url} target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>` : nothing}
      ${login.code ? html`<p>Device code: <strong>${login.code}</strong></p>` : nothing}
      ${prompt ? html`<form @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const value = new FormData(form).get("answer"); form.reset();
        void this.#mutate(`login/${login.id}`, "POST", { promptId: prompt.id, value });
      }}>
        <label class="hui-provider-field">${prompt.message}
          ${prompt.type === "select" ? html`<select name="answer" required>${prompt.options?.map((option) => html`<option value=${option.id}>${option.label}</option>`)}</select>`
          : html`<input name="answer" type=${prompt.type === "secret" || prompt.type === "manual_code" ? "password" : "text"} autocomplete="off" spellcheck="false" required />`}
        </label><button class="btn primary" type="submit" ?disabled=${this.#busy}>Continue</button>
      </form>` : nothing}
      ${login.phase === "pending" ? html`<button class="btn" ?disabled=${this.#busy} @click=${() => this.#mutate(`login/${login.id}`, "DELETE")}>Cancel sign-in</button>` : nothing}
    </div>`;
  }
  #modal() {
    const brand = providerBrands.find((entry) => entry.id === this.#brand) ?? this.#snapshot?.providers.find((entry) => entry.id === this.#brand && entry.configured);
    const login = this.#snapshot?.login;
    const pending = login?.phase === "pending";
    const nameRequired = brand?.id === "opencode-go";
    const selected = this.#snapshot?.providers.find((entry) => entry.id === this.#selected);
    return html`<dialog class="hui-provider-dialog" aria-labelledby="hui-provider-dialog-title" @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void this.#close(); } }} @cancel=${(event: Event) => { event.preventDefault(); void this.#close(); }}>
      <div class="hui-provider-heading"><h3 id="hui-provider-dialog-title">${brand ? `Connect ${brand.name}` : "Add provider"}</h3><button class="btn" aria-label="Close provider dialog" ?disabled=${this.#busy} @click=${() => this.#close()}>✕</button></div>
      <p class="settings-section__desc">${brand ? "Choose how you want to sign in." : "Choose a provider to connect your account."}</p>
      ${this.#error ? html`<p role="alert" class="hui-provider-error">${this.#error}</p>` : nothing}
      ${!brand ? html`<div class="hui-provider-choices">${providerBrands.map((entry) => html`<button class="hui-provider-choice" @click=${() => { this.#brand = entry.id; this.requestUpdate(); }}>${renderProviderBrandIcon(entry.id, "hui-provider-icon")}<span><strong>${entry.name}</strong><small>${entry.description}</small></span><span aria-hidden="true">›</span></button>`)}</div>` : html`
        ${!pending ? html`<div class="hui-provider-field">
          <label for="hui-provider-account-name">${nameRequired ? "Account name" : "Label when email is unavailable (optional)"}</label>
          <input id="hui-provider-account-name" maxlength="80" ?required=${nameRequired} aria-describedby=${nameRequired ? "hui-provider-account-name-help" : nothing} .value=${this.#accountName} placeholder="Personal, Work…" @input=${(event: Event) => { this.#accountName = (event.target as HTMLInputElement).value; }} />
          ${nameRequired ? html`<small id="hui-provider-account-name-help" class="hui-provider-field-help">A name is required because OpenCode does not report the account name or email.</small>` : nothing}
        </div><div class="hui-provider-choices">${connectionMethods(brand.id, this.#snapshot?.providers ?? []).map((choice) => html`<button class="hui-provider-choice" ?disabled=${this.#busy} @click=${() => {
          if (nameRequired && !this.#accountName.trim()) {
            this.#error = "Enter a name for this OpenCode account.";
            this.querySelector<HTMLInputElement>("#hui-provider-account-name")?.focus();
            this.requestUpdate(); return;
          }
          if (this.#selected && this.#selected !== choice.provider.id) this.#accountId = undefined;
          this.#selected = choice.provider.id; this.#error = ""; this.requestUpdate();
          void this.#mutate(`${choice.provider.id}/login`, "POST", { method: choice.method, ...(this.#accountId ? { accountId: this.#accountId } : {}), ...(this.#accountName.trim() ? { name: this.#accountName.trim() } : {}) });
        }}><span><strong>${choice.label}</strong><small>${choice.description}</small></span><span aria-hidden="true">›</span></button>`)}</div>` : nothing}
        ${login?.provider === this.#selected && login.phase !== "complete" ? this.#login(login) : nothing}
        ${selected?.authenticated && !pending && login?.phase === "complete" ? html`<button class="btn primary" ?disabled=${this.#busy} @click=${() => this.#useConnection(selected)}>Use this connection</button>` : nothing}
        ${!pending ? html`<div class="hui-provider-actions"><button class="btn" ?disabled=${this.#busy} @click=${() => { this.#brand = ""; this.#selected = ""; this.#error = ""; this.requestUpdate(); }}>Back to providers</button></div>` : nothing}
      `}
    </dialog>`;
  }
  #modelPicker(provider: ProviderSummary) {
    let draft = this.#drafts.get(provider.id);
    if (!draft) { draft = { models: new Set(provider.selected), query: "" }; this.#drafts.set(provider.id, draft); }
    const state = draft;
    const query = state.query.toLowerCase().trim().split(/\s+/);
    const models = provider.models.filter((model) => query.every((term) => `${model.id} ${model.name}`.toLowerCase().includes(term)));
    return html`<details class="hui-provider-picker">
      <summary>Models <span>${provider.selected.length ? `${provider.selected.length} selected` : "Choose models"}</span></summary>
      <div class="hui-provider-picker-panel">
        <label class="hui-provider-field">Search ${connectionName(provider)} models<input type="search" .value=${state.query} placeholder="Name or model ID" @input=${(event: Event) => { state.query = (event.target as HTMLInputElement).value; this.requestUpdate(); }} /></label>
        <div class="hui-provider-actions"><button class="btn" @click=${() => { for (const model of models) state.models.add(model.id); this.requestUpdate(); }}>Select visible</button><button class="btn" @click=${() => { state.models.clear(); this.requestUpdate(); }}>Clear selection</button><span class="hui-provider-method">${state.models.size} selected</span></div>
        <div class="hui-provider-models">${models.length ? models.map((model) => html`<label class="hui-provider-model"><input type="checkbox" .checked=${state.models.has(model.id)} @change=${(event: Event) => { if ((event.target as HTMLInputElement).checked) state.models.add(model.id); else state.models.delete(model.id); this.requestUpdate(); }} /><span><strong>${model.name}</strong><code>${model.id}</code><small>Context: ${model.contextWindow?.toLocaleString() ?? "reported during the session"} · Max output: ${model.maxTokens?.toLocaleString() ?? "CLI-managed"}</small></span></label>`) : html`<p>No matching models.</p>`}</div>
        <div class="hui-provider-actions"><button class="btn primary" ?disabled=${this.#busy} @click=${async (event: Event) => {
          const details = (event.currentTarget as HTMLElement).closest("details");
          if (await this.#mutate(provider.id, "PUT", { models: [...state.models] }, "Model selection saved.")) { details?.removeAttribute("open"); details?.querySelector("summary")?.focus(); }
        }}>Save models</button><button class="btn" ?disabled=${this.#busy} @click=${(event: Event) => { this.#drafts.delete(provider.id); const details = (event.currentTarget as HTMLElement).closest("details"); details?.removeAttribute("open"); details?.querySelector("summary")?.focus(); this.requestUpdate(); }}>Cancel</button></div>
      </div>
    </details>`;
  }
  #accountQuota(key: string) {
    const quota = this.#quotas.get(key);
    return html`<section class="hui-provider-quota" aria-label="Subscription and limits"><div class="hui-provider-heading"><h4>Subscription and limits</h4><button class="btn" ?disabled=${this.#quotaLoading.has(key)} @click=${() => this.#loadQuota(key)}>${this.#quotaLoading.has(key) ? "Checking…" : "Refresh limits"}</button></div>
      ${quota ? html`
        <dl class="hui-subscription-status">
          <div><dt>Plan</dt><dd>${quota.plan ?? "Not reported"}</dd></div>
          <div><dt>Subscription status</dt><dd>Not reported</dd></div>
          <div><dt>Usage status</dt><dd>${quota.access === "limited" ? "Limit reached" : quota.access === "available" ? "Available" : quota.status === "available" ? "Usage reported" : quota.status === "unsupported" ? "Not supported" : "Unavailable"}</dd></div>
        </dl>
        <p class="hui-subscription-note">Billing status and renewal dates are not exposed by this connection.</p>
        <div class="hui-provider-windows">${quota.windows.map((window) => html`<div class="hui-provider-window" data-exhausted=${window.usedPercent >= 100}>
          <div><strong>${window.label}</strong><span>${Number(window.usedPercent.toFixed(1))}% used</span></div>
          <progress max="100" value=${Math.min(100, window.usedPercent)} aria-label=${`${window.label}: ${Number(window.usedPercent.toFixed(1))}% used`}></progress>
          <small>${window.resetAt ? `Resets ${new Date(window.resetAt).toLocaleString()}` : "Reset not reported"}</small>
        </div>`)}</div>
        ${quota.message ? html`<p>${quota.message}</p>` : nothing}
        <small>Checked ${new Date(quota.checkedAt).toLocaleString()}</small>
      ` : html`<p role="status">Loading subscription and limits…</p>`}
    </section>`;
  }

  #accountLabel(provider: ProviderSummary, account: NonNullable<ProviderSummary["accounts"]>[number]) {
    return this.#quotas.get(`${provider.id}/accounts/${account.id}`)?.email ?? account.email ?? account.name;
  }
  #beginDrag(event: PointerEvent | KeyboardEvent, provider: ProviderSummary, id: string) {
    if (this.#busy || this.#drag || (provider.accounts?.length ?? 0) < 2) return;
    if (event instanceof PointerEvent && (event.button !== 0 || !event.isPrimary)) return;
    const accounts = provider.accounts!;
    const from = accounts.findIndex((account) => account.id === id);
    const handle = event.currentTarget as HTMLElement;
    event.preventDefault(); handle.focus();
    this.#drag = { provider: provider.id, id, name: this.#accountLabel(provider, accounts[from]!), order: accounts.map((a) => a.id), from, to: from, handle,
      y: 0, startY: 0, moved: false };
    if (event instanceof PointerEvent) {
      Object.assign(this.#drag, { pointer: event.pointerId, y: event.clientY, startY: event.clientY });
      handle.setPointerCapture(event.pointerId);
      this.#dragFrame = requestAnimationFrame(() => this.#dragTick());
    }
    this.#dragNotice = `Picked up ${this.#accountLabel(provider, accounts[from]!)}. Use arrow keys to choose a position, Space to drop, or Escape to cancel.`;
    this.requestUpdate();
  }
  #dragTick() {
    const drag = this.#drag;
    if (!drag || drag.pointer === undefined) return;
    if (drag.moved) {
      let scroll = drag.handle.parentElement;
      while (scroll && !(scroll.scrollHeight > scroll.clientHeight && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
      if (scroll) {
        const rect = scroll.getBoundingClientRect();
        const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
        const delta = drag.y < top + 48 ? -10 : drag.y > bottom - 48 ? 10 : 0;
        if (delta) scroll.scrollTop += delta;
      }
      this.#dragPosition();
    }
    this.#dragFrame = requestAnimationFrame(() => this.#dragTick());
  }
  #dragPosition() {
    const drag = this.#drag;
    const section = drag?.handle.closest(".hui-provider-accounts");
    if (!drag || !section) return;
    const cards = [...section.querySelectorAll<HTMLElement>(".hui-provider-account")].filter((card) => card.dataset.accountId !== drag.id);
    const before = cards.findIndex((card) => { const rect = card.getBoundingClientRect(); return drag.y < rect.top + rect.height / 2; });
    const to = before < 0 ? cards.length : before;
    if (to !== drag.to) { drag.to = to; this.#dragNotice = `${drag.name}, position ${to + 1} of ${drag.order.length}.`; this.requestUpdate(); }
  }
  #moveDrag(event: PointerEvent) {
    const drag = this.#drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    drag.y = event.clientY;
    if (Math.abs(drag.y - drag.startY) > 5) drag.moved = true;
    if (drag.moved) this.#dragPosition();
  }
  #dragKey(event: KeyboardEvent, provider: ProviderSummary, id: string) {
    if (!this.#drag && (event.key === " " || event.key === "Enter")) { this.#beginDrag(event, provider, id); return; }
    const drag = this.#drag;
    if (!drag || drag.id !== id || drag.provider !== provider.id) return;
    if (!["Escape", " ", "Enter", "ArrowUp", "ArrowDown", "Home", "End", "Tab"].includes(event.key)) return;
    event.stopPropagation();
    if (event.key === "Tab") { this.#endDrag(false); return; }
    event.preventDefault();
    if (event.key === "Escape") { this.#endDrag(false); return; }
    if (event.key === " " || event.key === "Enter") { this.#endDrag(true); return; }
    drag.to = event.key === "Home" ? 0 : event.key === "End" ? drag.order.length - 1 : Math.max(0, Math.min(drag.order.length - 1, drag.to + (event.key === "ArrowUp" ? -1 : 1)));
    drag.moved = true;
    this.#dragNotice = `${drag.name}, position ${drag.to + 1} of ${drag.order.length}.`;
    this.requestUpdate();
  }
  #endDrag(save: boolean) {
    const drag = this.#drag;
    if (!drag) return;
    this.#drag = undefined; cancelAnimationFrame(this.#dragFrame);
    if (drag.pointer !== undefined && drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    this.#dragNotice = save ? "" : "Reordering cancelled.";
    this.requestUpdate();
    if (!save || !drag.moved || drag.from === drag.to) return;
    const order = drag.order.filter((id) => id !== drag.id); order.splice(drag.to, 0, drag.id);
    void this.#mutate(`${drag.provider}/accounts`, "PUT", { order }, "Account priority saved.").then(async () => {
      await this.updateComplete;
      if (this.isConnected) drag.handle.focus();
    });
  }
  #accounts(provider: ProviderSummary) {
    const accounts = provider.accounts ?? [];
    const firstReady = accounts.find((a) => a.authenticated && (a.cooldownUntil ?? 0) <= Date.now())?.id;
    return html`<section class="hui-provider-accounts" aria-label=${`${connectionName(provider)} accounts`}>
      <div class="hui-provider-heading"><h4>Account priority</h4><button class="btn" ?disabled=${this.#busy} @click=${() => this.#open(providerBrand(provider.id)?.id ?? provider.id, provider.id)}>Add account</button></div>
      <p class="settings-section__desc">Use the first available account. When it reaches a limit, try the next; return to the preferred account after its cooldown.</p>
      <p class="hui-account-drag-help" id=${`account-drag-help-${provider.id}`}>Drag the grip to set priority. With a keyboard, press Space, use ↑ / ↓, then Space to drop. Escape cancels.</p>
      ${repeat(accounts, (account) => account.id, (account, index) => {
        const key = `${provider.id}/accounts/${account.id}`;
        const waiting = (account.cooldownUntil ?? 0) > Date.now();
        const drag = this.#drag?.provider === provider.id ? this.#drag : undefined;
        const label = this.#accountLabel(provider, account);
        const at = label.lastIndexOf("@");
        const remaining = accounts.filter((a) => a.id !== drag?.id);
        const before = drag && drag.to !== drag.from && remaining[drag.to]?.id === account.id;
        const after = drag && drag.to !== drag.from && drag.to === remaining.length && remaining.at(-1)?.id === account.id;
        return html`<article class="hui-provider-account ${drag?.id === account.id ? "is-dragging" : ""} ${before ? "drop-before" : after ? "drop-after" : ""}" data-account-id=${account.id} aria-label=${this.#accountLabel(provider, account)}>
          <div class="hui-provider-heading">
            <button class="hui-account-grip" type="button" aria-label=${`Reorder ${this.#accountLabel(provider, account)}`} aria-describedby=${`account-drag-help-${provider.id}`} aria-pressed=${drag?.id === account.id ? "true" : "false"} ?disabled=${this.#busy || accounts.length < 2}
              @pointerdown=${(event: PointerEvent) => this.#beginDrag(event, provider, account.id)}
              @pointermove=${(event: PointerEvent) => this.#moveDrag(event)}
              @pointerup=${(event: PointerEvent) => { if (this.#drag?.pointer === event.pointerId) {
                const rect = (event.currentTarget as HTMLElement).closest(".hui-provider-accounts")!.getBoundingClientRect();
                this.#endDrag(event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
              } }}
              @pointercancel=${() => this.#endDrag(false)} @lostpointercapture=${() => this.#endDrag(false)}
              @blur=${() => { if (this.#drag) this.#endDrag(false); }}
              @keydown=${(event: KeyboardEvent) => this.#dragKey(event, provider, account.id)}>
              <svg width="18" height="24" viewBox="0 0 18 24" aria-hidden="true" fill="currentColor"><circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="6" cy="18" r="1.6"/><circle cx="12" cy="18" r="1.6"/></svg>
            </button>
            <div><strong class="hui-account-name"><span>${index + 1}.</span><span>${at > 0 ? html`${label.slice(0, at)}<wbr>${label.slice(at)}` : label}</span></strong><p>${!account.authenticated ? "Sign in to reconnect" : waiting ? `Waiting until ${new Date(account.cooldownUntil!).toLocaleString()}` : account.id === firstReady ? "Next to use" : "Standby"}</p></div>
          </div>
          <div class="hui-provider-actions"><button class="btn" ?disabled=${this.#busy} @click=${() => this.#open(providerBrand(provider.id)?.id ?? provider.id, provider.id, account.id)}>${account.authenticated ? "Reconnect" : "Sign in"}</button><button class="btn" aria-label=${`Remove account ${this.#accountLabel(provider, account)}`} ?disabled=${this.#busy} @click=${() => { this.#confirm = key; this.requestUpdate(); }}>Remove account</button></div>
          ${this.#confirm === key ? html`<p>Remove ${this.#accountLabel(provider, account)}? Other accounts and model selections are kept.</p><button class="btn" ?disabled=${this.#busy} @click=${async () => { if (await this.#mutate(key, "DELETE", undefined, "Account removed.")) { this.#confirm = ""; this.#quotas.delete(key); } }}>Confirm removal</button> <button class="btn" @click=${() => { this.#confirm = ""; this.requestUpdate(); }}>Keep account</button>` : nothing}
          ${account.authenticated ? this.#accountQuota(key) : nothing}
        </article>`;
      })}
    </section>`;
  }
  #provider(provider: ProviderSummary) {
    return html`<article class="hui-provider-detail" aria-label=${connectionName(provider)}>
      <div class="hui-provider-heading">${renderProviderBrandIcon(provider.id, "hui-provider-icon")}<div><h3>${connectionName(provider)}</h3><p>${provider.authenticated ? "Credentials available" : "Sign in to reconnect"}</p></div>
        ${!provider.authenticated ? html`<button class="btn primary" ?disabled=${this.#busy} @click=${() => this.#open(providerBrand(provider.id)?.id ?? provider.id, provider.id)}>Sign in</button>` : html`<button class="btn" aria-label=${`Remove ${connectionName(provider)}`} ?disabled=${this.#busy} @click=${() => { this.#confirm = provider.id; this.requestUpdate(); }}>Remove</button>`}
      </div>
      ${provider.authenticated ? html`
        ${this.#accounts(provider)}
        ${this.#modelPicker(provider)}
      ` : nothing}
      ${this.#confirm === provider.id ? html`<div class="hui-provider-login"><p>Remove this HUI connection and its saved credentials? PI configuration is kept. Existing sessions keep their current runtime until reopened.</p><button class="btn" ?disabled=${this.#busy} @click=${async () => {
        if (await this.#mutate(provider.id, "DELETE", undefined, "Connection removed. PI configuration is unchanged.")) { this.#confirm = ""; this.#drafts.delete(provider.id); this.#quotas.delete(provider.id); this.requestUpdate(); }
      }}>Confirm removal</button> <button class="btn" @click=${() => { this.#confirm = ""; this.requestUpdate(); }}>Keep connection</button></div>` : nothing}
    </article>`;
  }
  override render() {
    const providers = this.#snapshot?.providers.filter((provider) => provider.configured) ?? [];
    return html`<section class="settings-section hui-providers">
      <div class="settings-section__header"><div class="settings-section__copy"><h2 class="settings-section__heading">Model providers</h2><p class="settings-section__desc">Connect an account, check its limits and choose your models.</p></div><button class="btn primary" ?disabled=${this.#busy || !this.#snapshot} @click=${() => this.#open()}>Add provider</button></div>
      ${this.#error && !this.#dialog()?.open ? html`<p role="alert" class="hui-provider-error">${this.#error}</p><button class="btn" @click=${() => this.#refresh()}>Retry loading providers</button>` : nothing}
      ${this.#notice ? html`<p role="status" class="hui-provider-notice">${this.#notice}</p>` : nothing}
      <span class="hui-account-drag-status" role="status">${this.#dragNotice}</span>
      <div class="hui-provider-cards">${!this.#snapshot ? html`<p>Loading providers…</p>` : providers.length ? repeat(providers, (provider) => provider.id, (provider) => this.#provider(provider)) : html`<p class="hui-provider-empty">No providers added yet. Add one to get started.</p>`}</div>
      ${this.#modal()}
    </section>`;
  }
}
if (typeof customElements !== "undefined" && !customElements.get("hui-provider-settings")) customElements.define("hui-provider-settings", HuiProviderSettings);
