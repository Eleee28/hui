/**
 * The GitHub section of Settings → Integrations. Status and sign-in go through the gateway's `gh` CLI; this view
 * never sees a token. While `gh` waits for the device approval, the section keeps polling for the result.
 */
import { LitElement, html, nothing } from "lit";
import { GITHUB_CLI_URL } from "../../lib/github.ts";
import type { GitHubConnection } from "../../api/schema/github.ts";
import { writeClipboardText } from "../../lib/clipboard.ts";
import { gitHubStatusLabel } from "../../lib/github.ts";
import { cancelGitHubLogin, loadGitHubConnection, startGitHubLogin } from "../../api/github.ts";
import { icons } from "../../lib/icons.ts";

const POLL_MS = 2_000;

export class HuiGitHubSettings extends LitElement {
  #connection?: GitHubConnection;
  #loading = true;
  #busy = false;
  #error = "";
  #notice = "";
  #copied = false;
  #request = 0;
  #poll?: ReturnType<typeof setTimeout>;

  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); void this.#refresh(); }
  override disconnectedCallback() { super.disconnectedCallback(); this.#request++; this.#stopPolling(); }

  #stopPolling() {
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = undefined;
  }

  /** Applies a server view; keeps polling while gh waits for approval. */
  #apply(next: GitHubConnection) {
    const previous = this.#connection;
    const wasWaiting = previous?.login.phase === "pending" || previous?.login.phase === "starting";
    this.#connection = next;
    if (wasWaiting && next.status === "connected" && next.login.phase === "idle") {
      this.#notice = `Connected as ${next.account?.login ?? "your GitHub account"}.`;
    }
    this.#stopPolling();
    if (next.login.phase === "pending" || next.login.phase === "starting") {
      this.#poll = setTimeout(() => void this.#refresh(), POLL_MS);
    }
  }

  async #refresh() {
    const request = ++this.#request;
    try {
      const next = await loadGitHubConnection();
      if (request !== this.#request) return;
      this.#apply(next);
      this.#error = "";
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "GitHub status could not be loaded.";
      // A dropped poll must not strand a pending login on screen.
      if (this.#connection?.login.phase === "pending") this.#poll = setTimeout(() => void this.#refresh(), POLL_MS * 2);
    } finally {
      if (request === this.#request) { this.#loading = false; this.requestUpdate(); }
    }
  }

  async #connect() {
    const request = ++this.#request;
    this.#busy = true;
    this.#error = "";
    this.#notice = "";
    this.#copied = false;
    if (this.#connection) this.#connection = { ...this.#connection, login: { phase: "starting" } };
    this.requestUpdate();
    try {
      const next = await startGitHubLogin();
      if (request === this.#request) this.#apply(next);
    } catch (error) {
      if (request === this.#request) {
        this.#error = error instanceof Error ? error.message : "GitHub sign-in could not be started.";
        void this.#refresh();
      }
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  async #cancel() {
    const request = ++this.#request;
    this.#stopPolling();
    this.#busy = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const next = await cancelGitHubLogin();
      if (request === this.#request) this.#apply(next);
    } catch (error) {
      if (request === this.#request) this.#error = error instanceof Error ? error.message : "The sign-in could not be cancelled.";
    } finally {
      this.#busy = false;
      this.requestUpdate();
    }
  }

  async #copy(code: string) {
    this.#copied = await writeClipboardText(code);
    this.requestUpdate();
  }

  #renderStatus(connection: GitHubConnection | undefined) {
    const { kind, label } = gitHubStatusLabel(this.#loading ? undefined : connection);
    return html`<span class="settings-status ${kind === "muted" ? "" : `settings-status--${kind}`}" data-github-status=${kind}><span class="settings-status__dot" aria-hidden="true"></span>${label}</span>`;
  }

  #renderBody(connection: GitHubConnection) {
    if (!connection.cli.installed) {
      return html`<div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">GitHub CLI not found</span>
          <span class="settings-row__desc">HUI signs in and reads GitHub through <code>gh</code> on the machine running the HUI gateway. Install it, make sure it is on the gateway's <code>PATH</code>, then check again.</span>
        </div>
        <div class="settings-row__control jira-settings__actions">
          <a class="btn btn--sm" href=${GITHUB_CLI_URL} target="_blank" rel="noopener noreferrer">Install gh ${icons.externalLink}</a>
          <button type="button" class="btn btn--sm" @click=${() => void this.#refresh()}>Check again</button>
        </div>
      </div>`;
    }
    const login = connection.login;
    if (login.phase === "starting") {
      return html`<div class="settings-row">
        <div class="settings-row__text"><span class="settings-row__title">Authorization</span>
          <span class="settings-row__desc">Running <code>gh auth login --web</code>…</span></div>
      </div>`;
    }
    if (login.phase === "pending") {
      const expires = new Date(login.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return html`
        <div class="settings-row">
          <div class="settings-row__text"><span class="settings-row__title">Authorization</span>
            <span class="settings-row__desc">Open GitHub yourself, then enter the one-time code shown here. HUI turns this into Connected as soon as GitHub confirms.</span></div>
        </div>
        <div class="settings-row">
          <div class="settings-row__text"><span class="settings-row__title">One-time code</span>
            <span class="settings-row__desc">Expires at ${expires}.</span></div>
          <div class="settings-row__control github-settings__code">
            <code class="settings-row__value settings-row__value--mono github-device-code" data-github-code>${login.userCode}</code>
            <button type="button" class="btn btn--sm" @click=${() => void this.#copy(login.userCode)}>${this.#copied ? icons.check : icons.copy}<span>${this.#copied ? "Copied" : "Copy code"}</span></button>
          </div>
        </div>
        <div class="settings-row settings-row--actions">
          <div class="settings-row__control">
            <a class="btn primary" href=${login.verificationUri} target="_blank" rel="noopener noreferrer">Open github.com/login/device ${icons.externalLink}</a>
            <button type="button" class="btn" ?disabled=${this.#busy} @click=${() => void this.#cancel()}>Cancel</button>
          </div>
        </div>`;
    }
    if (connection.status === "connected" && connection.account) {
      const account = connection.account;
      return html`<div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">${account.login}</span>
          <span class="settings-row__desc">${account.host} · gh ${connection.cli.version}${account.scopes.length ? ` · ${account.scopes.join(", ")}` : ""}</span>
        </div>
        <div class="settings-row__control jira-settings__actions">
          <button type="button" class="btn btn--sm" ?disabled=${this.#busy} @click=${() => void this.#connect()}>Reconnect</button>
        </div>
      </div>`;
    }
    const failed = login.phase === "failed" ? login.message : "";
    return html`<div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${connection.status === "invalid" ? "Sign in again" : connection.status === "unknown" ? "GitHub could not be verified" : "Sign in with GitHub"}</span>
        <span class="settings-row__desc">${failed || connection.message || "Runs gh auth login on the HUI machine and shows a one-time code to approve at github.com."}</span>
      </div>
      <div class="settings-row__control jira-settings__actions">
        <button type="button" class="btn primary btn--sm" ?disabled=${this.#busy} @click=${() => void this.#connect()}>${failed ? "Try again" : "Connect GitHub"}</button>
      </div>
    </div>`;
  }

  override render() {
    const connection = this.#connection;
    return html`
      <section class="settings-section" data-integration="github">
        <div class="settings-section__header"><div class="settings-section__copy">
          <h2 class="settings-section__heading">GitHub</h2>
          <p class="settings-section__desc">Pull request badges and agent <code>gh</code> commands use the GitHub CLI login of the machine running HUI. The token stays in gh's own keyring or config.</p>
        </div>
        <div class="settings-section__actions">${this.#renderStatus(connection)}</div></div>
        ${this.#error ? html`<p class="jira-settings__error" role="alert">${this.#error}</p>` : nothing}
        ${this.#notice ? html`<p class="jira-settings__notice" role="status">${this.#notice}</p>` : nothing}
        <div class="settings-group">${this.#loading || !connection ? nothing : this.#renderBody(connection)}</div>
      </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-github-settings")) customElements.define("hui-github-settings", HuiGitHubSettings);
