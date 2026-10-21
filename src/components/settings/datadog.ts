/**
 * The Datadog section of Settings → Integrations: the orgs HUI reads Datadog links through (a pup session name and
 * the Datadog host its links use), their status, the *Add org* dialog (the default Datadog site preselected) and
 * pup's sign-in. Everything goes through the gateway's `pup`; this view never sees a token. While a sign-in runs,
 * the section polls for its result and, once it succeeds, tells the chat's Datadog cards to load again.
 */
import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { DATADOG_APP_HOSTS, DATADOG_CLI_URL, DEFAULT_DATADOG_SITE } from "../../lib/markdown/datadog-links.ts";
import type { DatadogConnection, DatadogOrg, DatadogOrgStatus } from "../../api/schema/datadog.ts";
import { datadogOrgLabel, datadogStatusLabel } from "../../lib/datadog.ts";
import { DATADOG_CHANGED, notifyDatadogChanged } from "../../lib/datadog-store.ts";
import { addDatadogOrg, cancelDatadogLogin, loadDatadogConnection, removeDatadogOrg, startDatadogLogin } from "../../api/datadog.ts";
import { icons } from "../../lib/icons.ts";
import { closeModal, ensureModal } from "../../lib/modal-dialog.ts";

const POLL_MS = 1_500;
/** The site picker's choice for a host it does not list (a vanity host, say). */
const OTHER_SITE = "other";
const STATUS_LABELS: Record<DatadogOrgStatus["status"], string> = { connected: "Connected", signed_out: "Sign in needed", unknown: "Status unknown" };
const sameOrg = (a: DatadogOrg, b: DatadogOrg) => a.name === b.name && a.site === b.site;

export class HuiDatadogSettings extends LitElement {
  #connection?: DatadogConnection;
  #loading = true;
  #busy = false;
  #error = "";
  #notice = "";
  /** The *Add org* dialog: open, its fields, and the host typed for *Other host…*. */
  #adding = false;
  #name = "";
  #site: string = DEFAULT_DATADOG_SITE;
  #otherSite = "";
  #request = 0;
  #poll?: ReturnType<typeof setTimeout>;
  /** A sign-in finished from a chat card: show its org as connected. */
  readonly #changed = () => void this.#refresh();

  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); window.addEventListener(DATADOG_CHANGED, this.#changed); void this.#refresh(); }
  override disconnectedCallback() { super.disconnectedCallback(); window.removeEventListener(DATADOG_CHANGED, this.#changed); this.#request++; this.#stopPolling(); }
  override updated() {
    const dialog = this.querySelector<HTMLDialogElement>("dialog.datadog-add-dialog");
    if (dialog) ensureModal(dialog);
  }

  #stopPolling() {
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = undefined;
  }

  /** Applies a gateway view; keeps polling while pup waits for the browser. */
  #apply(next: DatadogConnection) {
    const previous = this.#connection?.login;
    this.#connection = next;
    if (previous?.phase === "pending" && next.login.phase === "idle") {
      const org = next.orgs.find((entry) => sameOrg(entry, previous.org));
      if (org?.status === "connected") {
        this.#notice = `Signed in to ${datadogOrgLabel(org)}.`;
        notifyDatadogChanged();
      }
    }
    this.#stopPolling();
    if (next.login.phase === "pending") this.#poll = setTimeout(() => void this.#refresh(), POLL_MS);
  }

  /** `keepError`: after a failed action, so its message stays on screen. */
  async #refresh(keepError = false) {
    const request = ++this.#request;
    try {
      const next = await loadDatadogConnection();
      if (request !== this.#request) return;
      this.#apply(next);
      if (!keepError) this.#error = "";
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "Datadog status could not be loaded.";
      // A dropped poll must not strand a pending sign-in on screen.
      if (this.#connection?.login.phase === "pending") this.#poll = setTimeout(() => void this.#refresh(), POLL_MS * 2);
    } finally {
      if (request === this.#request) { this.#loading = false; this.requestUpdate(); }
    }
  }

  /** `changesOrgs`: an add or a removal, after which the chat's cards load again. */
  async #run(action: () => Promise<DatadogConnection>, notice = "", changesOrgs = false) {
    const request = ++this.#request;
    this.#stopPolling();
    this.#busy = true;
    this.#error = "";
    this.#notice = "";
    this.requestUpdate();
    try {
      const next = await action();
      if (request !== this.#request) return false;
      this.#apply(next);
      this.#notice = notice;
      if (changesOrgs) notifyDatadogChanged();
      return true;
    } catch (error) {
      if (request === this.#request) {
        this.#error = error instanceof Error ? error.message : "The Datadog request failed.";
        void this.#refresh(true);
      }
      return false;
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  #openAdd() {
    this.#adding = true;
    this.#name = "";
    this.#site = DEFAULT_DATADOG_SITE;
    this.#otherSite = "";
    this.#error = "";
    this.requestUpdate();
  }

  #closeAdd() {
    closeModal(this.querySelector<HTMLDialogElement>("dialog.datadog-add-dialog") ?? undefined);
    this.#adding = false;
    this.#error = "";
    this.requestUpdate();
  }

  async #add(event: SubmitEvent) {
    event.preventDefault();
    const org = { name: this.#name.trim(), site: this.#site === OTHER_SITE ? this.#otherSite.trim() : this.#site };
    if (await this.#run(() => addDatadogOrg(org), `Added ${datadogOrgLabel(org)}.`, true)) this.#closeAdd();
  }

  #renderStatus(connection: DatadogConnection | undefined) {
    const { kind, label } = datadogStatusLabel(this.#loading ? undefined : connection);
    return html`<span class="settings-status ${kind === "muted" ? "" : `settings-status--${kind}`}" data-datadog-status=${kind}><span class="settings-status__dot" aria-hidden="true"></span>${label}</span>`;
  }

  #renderLogin(connection: DatadogConnection) {
    const login = connection.login;
    if (login.phase === "pending") {
      return html`<div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">Signing in to ${datadogOrgLabel(login.org)}</span>
          <span class="settings-row__desc" role="status">Approve the sign-in in your browser… pup opened it on the computer running HUI and waits up to five minutes.</span>
        </div>
        <div class="settings-row__control jira-settings__actions">
          ${login.url ? html`<a class="btn primary btn--sm" href=${login.url} target="_blank" rel="noopener noreferrer">Open sign-in page ${icons.externalLink}</a>` : nothing}
          <button type="button" class="btn btn--sm" ?disabled=${this.#busy} @click=${() => void this.#run(cancelDatadogLogin)}>Cancel</button>
        </div>
      </div>`;
    }
    if (login.phase === "failed") {
      return html`<div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">Sign-in to ${datadogOrgLabel(login.org)} did not finish</span>
          <span class="settings-row__desc datadog-settings__failure" role="alert">${login.message}</span>
        </div>
        <div class="settings-row__control jira-settings__actions">
          <button type="button" class="btn btn--sm" ?disabled=${this.#busy} @click=${() => void this.#run(() => startDatadogLogin(login.org))}>Try again</button>
          <button type="button" class="btn btn--sm" ?disabled=${this.#busy} @click=${() => void this.#run(cancelDatadogLogin)}>Dismiss</button>
        </div>
      </div>`;
    }
    return nothing;
  }

  #renderOrg(connection: DatadogConnection, org: DatadogOrgStatus) {
    const label = datadogOrgLabel(org);
    const signingIn = connection.login.phase === "pending";
    return html`<div class="settings-row" data-datadog-org=${`${org.site}/${org.name}`}>
      <div class="settings-row__text">
        <span class="settings-row__title">${org.name || "Default session"}</span>
        <span class="settings-row__desc">${org.site} · <span class="datadog-settings__status" data-status=${org.status}>${STATUS_LABELS[org.status]}</span></span>
      </div>
      <div class="settings-row__control jira-settings__actions">
        ${org.status === "signed_out" && connection.cli.installed
          ? html`<button type="button" class="btn primary btn--sm" ?disabled=${this.#busy || signingIn} @click=${() => void this.#run(() => startDatadogLogin(org))}>Sign in</button>`
          : nothing}
        <button type="button" class="btn btn--sm" aria-label=${`Remove ${label}`} ?disabled=${this.#busy} @click=${() => void this.#run(() => removeDatadogOrg(org), `Removed ${label} from HUI. pup keeps its session.`, true)}>Remove</button>
      </div>
    </div>`;
  }

  /** *Add org*: the default Datadog site preselected, the org name suggesting pup's logins for that site. */
  #renderAddDialog(connection: DatadogConnection) {
    if (!this.#adding) return nothing;
    const site = this.#site === OTHER_SITE ? this.#otherSite.trim().toLowerCase() : this.#site;
    const names = [...new Set(connection.pupOrgs.filter((org) => org.site === site).map((org) => org.name).filter(Boolean))];
    const close = () => { if (!this.#busy) this.#closeAdd(); };
    return html`<dialog class="hui-modal-dialog group-action-dialog datadog-add-dialog" aria-labelledby="datadog-add-title"
      @cancel=${(event: Event) => { event.preventDefault(); close(); }}
      @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <form class="exec-approval-card datadog-add" @submit=${(event: SubmitEvent) => void this.#add(event)}>
        <div class="exec-approval-title" id="datadog-add-title">Add Datadog org</div>
        <div class="exec-approval-sub">Dashboard links on this site are read through the org's pup login. When pup has none yet, signing in starts right away.</div>
        <label class="field input-dialog__field"><span>Site</span>
          <select class="settings-input" name="site" ?disabled=${this.#busy} @change=${(event: Event) => { this.#site = (event.target as HTMLSelectElement).value; this.requestUpdate(); }}>
            ${DATADOG_APP_HOSTS.map((host) => html`<option value=${host} ?selected=${this.#site === host}>${host === DEFAULT_DATADOG_SITE ? `${host} (default)` : host}</option>`)}
            <option value=${OTHER_SITE} ?selected=${this.#site === OTHER_SITE}>Other host…</option>
          </select></label>
        ${this.#site === OTHER_SITE ? html`<label class="field input-dialog__field"><span>Host</span>
          <input class="settings-input" name="host" required autocomplete="off" spellcheck="false" placeholder="mycompany.datadoghq.com" ?disabled=${this.#busy}
            .value=${live(this.#otherSite)} @input=${(event: Event) => { this.#otherSite = (event.target as HTMLInputElement).value; this.requestUpdate(); }} /></label>` : nothing}
        <label class="field input-dialog__field"><span>Org name</span>
          <input class="settings-input" name="name" list="datadog-pup-orgs" autocomplete="off" spellcheck="false" maxlength="100" autofocus
            placeholder="Empty: pup's default login" ?disabled=${this.#busy} .value=${live(this.#name)} @input=${(event: Event) => { this.#name = (event.target as HTMLInputElement).value; }} /></label>
        <datalist id="datadog-pup-orgs">${names.map((name) => html`<option value=${name}></option>`)}</datalist>
        <p class="exec-approval-sub">The org name is pup's login name, as in <code>pup auth login --org &lt;name&gt;</code>.${names.length ? " pup already has logins for this site; pick one from the suggestions." : ""}</p>
        ${this.#error ? html`<p class="jira-settings__error" role="alert">${this.#error}</p>` : nothing}
        <div class="exec-approval-actions">
          <button type="submit" class="btn primary" ?disabled=${this.#busy}>${this.#busy ? "Adding…" : "Add org"}</button>
          <button type="button" class="btn" ?disabled=${this.#busy} @click=${close}>Cancel</button>
        </div>
      </form>
    </dialog>`;
  }

  #renderBody(connection: DatadogConnection) {
    if (!connection.cli.installed) {
      return html`<div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">Datadog CLI not found</span>
          <span class="settings-row__desc">HUI signs in and reads Datadog through <code>pup</code> on the machine running the HUI gateway. Install it, make sure it is on the gateway's <code>PATH</code>, then check again.</span>
        </div>
        <div class="settings-row__control jira-settings__actions">
          <a class="btn btn--sm" href=${DATADOG_CLI_URL} target="_blank" rel="noopener noreferrer">Install pup ${icons.externalLink}</a>
          <button type="button" class="btn btn--sm" @click=${() => void this.#refresh()}>Check again</button>
        </div>
      </div>`;
    }
    return html`
      ${this.#renderLogin(connection)}
      ${connection.orgs.length
        ? connection.orgs.map((org) => this.#renderOrg(connection, org))
        : html`<div class="settings-row"><div class="settings-row__text">
            <span class="settings-row__title">No orgs yet</span>
            <span class="settings-row__desc">Share links preview without one. Add the pup orgs whose dashboard links HUI should draw; a link tries the orgs of its site in this order.</span>
          </div></div>`}
      ${this.#renderAddDialog(connection)}`;
  }

  override render() {
    const connection = this.#connection;
    return html`
      <section class="settings-section" data-integration="datadog">
        <div class="settings-section__header"><div class="settings-section__copy">
          <h2 class="settings-section__heading">Datadog</h2>
          <p class="settings-section__desc">Chat cards for Datadog share links and dashboard widgets come from the Datadog CLI (<code>pup</code>) of the machine running HUI. Tokens stay in pup; HUI keeps only org names and sites.</p>
        </div>
        <div class="settings-section__actions">
          ${this.#renderStatus(connection)}
          ${connection?.cli.installed ? html`<button type="button" class="btn primary btn--sm" ?disabled=${this.#busy} @click=${() => this.#openAdd()}>Add org</button>` : nothing}
        </div></div>
        ${this.#error && !this.#adding ? html`<p class="jira-settings__error" role="alert">${this.#error}</p>` : nothing}
        ${this.#notice ? html`<p class="jira-settings__notice" role="status">${this.#notice}</p>` : nothing}
        <div class="settings-group">${this.#loading || !connection ? nothing : this.#renderBody(connection)}</div>
      </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-datadog-settings")) customElements.define("hui-datadog-settings", HuiDatadogSettings);
