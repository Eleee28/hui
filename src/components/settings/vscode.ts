/**
 * Settings → Tools → VS Code: which VS Code the Work pane's VS Code view runs (the one in use, its version and path,
 * and a choice when several are available), the Microsoft license consent that `code serve-web` needs (revocable),
 * the openvscode-server HUI can install or remove (Linux), a custom executable path, and the one server's state with
 * Stop. Saving goes through the shared settings store, merged into its current VS Code settings so a consent recorded
 * by the gateway is never overwritten; the status comes from the gateway, polled while this section is open.
 */
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { DEFAULT_VSCODE_SETTINGS, type VscodeSettings } from "../../lib/settings/settings.ts";
import { currentSettings } from "../../lib/settings/settings-store.ts";
import { loadVscodeStatus, vscodeAction } from "../../lib/vscode-store.ts";
import {
  formatVscodeBytes, OPENVSCODE_SERVER_LICENSE_URL, VSCODE_SERVER_LICENSE_URL, vscodeProviderSource,
} from "../../lib/vscode.ts";
import type { VscodeAction, VscodeProvider, VscodeStatus } from "../../api/schema/vscode.ts";
import type { VscodeProviderPreference } from "../../api/schema/settings.ts";
import { renderPicker } from "../../views/settings-picker.ts";
import { loadViewAssets } from "../../lib/view-assets.ts";

loadViewAssets(() => import("../../styles/tools.css"));

const POLL_MS = 4_000;
const TASK_POLL_MS = 1_000;

/** The pill: what the operator most needs to know at a glance. */
export function vscodeStatusLabel(status: VscodeStatus | undefined): { kind: "muted" | "ok" | "warn" | "danger"; label: string } {
  if (!status) return { kind: "muted", label: "Checking…" };
  switch (status.state) {
    case "setup": return status.activeError ? { kind: "danger", label: "Path does not run" } : { kind: "muted", label: "Not set up" };
    case "starting": return { kind: "warn", label: status.preparing ? "Preparing" : "Starting" };
    case "running": return { kind: "ok", label: "Running" };
    case "failed": return { kind: "danger", label: "Stopped after an error" };
    default: return { kind: "ok", label: "Ready" };
  }
}

/** "Visual Studio Code 1.137.0 · your VS Code". */
export function vscodeProviderCaption(provider: Pick<VscodeProvider, "kind" | "name" | "version">): string {
  return `${provider.name} ${provider.version} · ${vscodeProviderSource(provider.kind)}`;
}

/** The choices of the provider picker: Automatic, then every VS Code found here. */
export function vscodeProviderOptions(status: Pick<VscodeStatus, "providers">): { value: VscodeProviderPreference; label: string }[] {
  return [
    { value: "auto", label: "Automatic" },
    ...status.providers.map((provider) => ({ value: provider.kind, label: vscodeProviderCaption(provider) })),
  ];
}

export class HuiVscodeSettings extends LitElement {
  static override properties = {
    settings: { attribute: false },
    onChange: { attribute: false },
  };
  declare settings: VscodeSettings;
  declare onChange: (next: VscodeSettings) => Promise<unknown> | void;
  #status?: VscodeStatus;
  #error = "";
  #busy = "";
  #confirmRemove = false;
  #request = 0;
  #poll?: ReturnType<typeof setTimeout>;

  constructor() {
    super();
    this.settings = DEFAULT_VSCODE_SETTINGS;
    this.onChange = () => undefined;
  }

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    void this.#refresh();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#request++;
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = undefined;
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("settings") && !this.settings) this.settings = DEFAULT_VSCODE_SETTINGS;
  }

  override updated() {
    const dialog = this.querySelector<HTMLDialogElement>("dialog.vscode-remove-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async #refresh(keepError = false) {
    const request = ++this.#request;
    try {
      const status = await loadVscodeStatus();
      if (request !== this.#request) return;
      this.#status = status;
      if (!keepError) this.#error = "";
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "VS Code status could not be loaded.";
    } finally {
      if (request === this.#request) {
        this.requestUpdate();
        if (this.#poll) clearTimeout(this.#poll);
        const busy = this.#status?.install.task || this.#status?.state === "starting";
        this.#poll = this.isConnected ? setTimeout(() => void this.#refresh(), busy ? TASK_POLL_MS : POLL_MS) : undefined;
      }
    }
  }

  /** Merged into the store's current VS Code settings: the gateway may have recorded a license since this page got
   * its copy. */
  async #save(change: Partial<VscodeSettings>) {
    this.#error = "";
    this.requestUpdate();
    try { await this.onChange({ ...DEFAULT_VSCODE_SETTINGS, ...currentSettings().vscode, ...change }); } finally { await this.#refresh(); }
  }

  async #act(action: VscodeAction) {
    this.#busy = action;
    this.#error = "";
    this.requestUpdate();
    try {
      this.#status = await vscodeAction(action);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "The VS Code request failed.";
    } finally {
      this.#busy = "";
      await this.#refresh(true);
    }
  }

  #renderProvider(status: VscodeStatus | undefined) {
    if (!status) return nothing;
    const active = status.active;
    const preference = status.preference;
    const preferred = preference !== "auto" && !status.providers.some((provider) => provider.kind === preference);
    const detail = active
      ? html`${vscodeProviderCaption(active)} · <code class="browser-settings__path">${active.path}</code>`
      : status.activeError
        ? html`<span class="browser-settings__problem" data-vscode-active-error>${status.activeError}</span>`
        : status.setup.desktop
          ? `${vscodeProviderCaption(status.setup.desktop)} is installed; accept its license in a VS Code view to use it.`
          : "No VS Code found yet. Open a VS Code view to install a server, or set a path below.";
    return html`<div class="settings-row" data-vscode-provider=${active?.kind ?? "none"}>
      <div class="settings-row__text">
        <span class="settings-row__title">VS Code in use</span>
        <span class="settings-row__desc vscode-settings__detail">${detail}</span>
        ${preferred ? html`<span class="settings-row__desc browser-settings__problem">The chosen VS Code is not available here; HUI uses the first that is.</span>` : nothing}
        ${status.problems.length ? html`<ul class="settings-row__desc vscode-settings__problems">${status.problems.map((problem) => html`<li>${problem}</li>`)}</ul>` : nothing}
      </div>
      <div class="settings-row__control">
        ${status.providers.length > 1
          ? renderPicker({
            label: "VS Code to use", value: preference, className: "vscode-settings__picker",
            options: vscodeProviderOptions(status),
            onChange: (value) => void this.#save({ provider: value as VscodeProviderPreference }),
          })
          : html`<span class="settings-row__desc">${status.providers.length === 1 ? "The only VS Code found here" : "Nothing to choose from yet"}</span>`}
      </div>
    </div>`;
  }

  #renderLicense(status: VscodeStatus) {
    const desktop = status.providers.some((provider) => provider.flavor === "serve-web");
    if (!desktop && !status.license.accepted) return nothing;
    const accepted = status.license.accepted ? new Date(status.license.acceptedAt) : undefined;
    return html`<div class="settings-row" data-vscode-license=${status.license.accepted ? "accepted" : "pending"}>
      <div class="settings-row__text">
        <span class="settings-row__title">VS Code Server license</span>
        <span class="settings-row__desc">${accepted
          ? `Accepted ${accepted.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}. HUI runs your VS Code as Microsoft's web server (code serve-web), which needs it. Revoking stops it.`
          : "Not accepted. Your VS Code runs here only after you accept Microsoft's license in a VS Code view."}
          <a class="hui-vscode-view__link" href=${VSCODE_SERVER_LICENSE_URL} target="_blank" rel="noopener noreferrer">Read the license</a></span>
      </div>
      <div class="settings-row__control">
        ${status.license.accepted
          ? html`<button type="button" class="btn btn--sm" ?disabled=${Boolean(this.#busy)} @click=${() => void this.#act("revoke-license")}>${this.#busy === "revoke-license" ? "Revoking…" : "Revoke"}</button>`
          : html`<span class="settings-row__desc">Not accepted</span>`}
      </div>
    </div>`;
  }

  #renderInstall(status: VscodeStatus) {
    const install = status.install;
    const task = install.task;
    const installed = install.installed;
    let description: unknown;
    if (!install.supported) description = install.reason;
    else if (task) description = task.phase === "downloading" ? `Downloading openvscode-server ${install.version}: ${formatVscodeBytes(task.received)} of ${formatVscodeBytes(task.total)}` : task.phase === "verifying" ? "Checking the download…" : "Unpacking…";
    else if (installed) description = html`openvscode-server ${installed.version} (MIT, by Gitpod) · <code class="browser-settings__path">${installed.path}</code>`;
    else description = `Not installed. HUI can download openvscode-server ${install.version} (MIT, by Gitpod, about ${formatVscodeBytes(install.size)}) into its own folder.`;
    return html`<div class="settings-row" data-vscode-install=${task ? "running" : installed ? "installed" : "absent"}>
      <div class="settings-row__text">
        <span class="settings-row__title">Server installed by HUI</span>
        <span class="settings-row__desc vscode-settings__detail">${description}</span>
        ${install.supported ? html`<span class="settings-row__desc"><a class="hui-vscode-view__link" href=${OPENVSCODE_SERVER_LICENSE_URL} target="_blank" rel="noopener noreferrer">openvscode-server's MIT license</a>${install.hint ? ` · ${install.hint}` : ""}</span>` : nothing}
        ${install.error ? html`<span class="settings-row__desc browser-settings__problem" role="alert">${install.error}</span>` : nothing}
      </div>
      <div class="settings-row__control jira-settings__actions">
        ${!install.supported ? nothing
          : task ? html`<button type="button" class="btn btn--sm" ?disabled=${this.#busy === "cancel-install"} @click=${() => void this.#act("cancel-install")}>Cancel</button>`
            : installed ? html`<button type="button" class="btn btn--sm danger" ?disabled=${Boolean(this.#busy)} @click=${() => { this.#confirmRemove = true; this.requestUpdate(); }}>Remove</button>`
              : html`<button type="button" class="btn btn--sm" ?disabled=${Boolean(this.#busy)} @click=${() => void this.#act("install")}>Install (≈${formatVscodeBytes(install.size)})</button>`}
      </div>
    </div>`;
  }

  #renderRemoveDialog(status: VscodeStatus) {
    const installed = status.install.installed;
    if (!this.#confirmRemove || !installed) return nothing;
    const cancel = () => { this.querySelector<HTMLDialogElement>("dialog.vscode-remove-dialog")?.close(); this.#confirmRemove = false; this.requestUpdate(); };
    const inUse = status.running?.kind === "managed";
    return html`<dialog class="hui-modal-dialog vscode-remove-dialog" aria-labelledby="vscode-remove-title"
      @cancel=${(event: Event) => { event.preventDefault(); cancel(); }}
      @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
      <div class="exec-approval-card">
        <div class="exec-approval-header"><div>
          <div class="exec-approval-title" id="vscode-remove-title">Remove openvscode-server ${installed.version}?</div>
          <div class="exec-approval-sub mono">${status.install.dir}</div>
        </div></div>
        <ul class="worktree-remove-dialog__risks">
          <li><strong>Deletes the server.</strong> Its files under ${status.install.dir} go; installing it again downloads about ${formatVscodeBytes(status.install.size)}.</li>
          ${inUse ? html`<li><strong>Stops VS Code.</strong> It is running from this server; open VS Code views show that it stopped.</li>` : nothing}
        </ul>
        <p class="exec-approval-sub">Your VS Code settings, extensions and state in ${status.dataDir} are kept.</p>
        <div class="exec-approval-actions">
          <button type="button" class="btn danger" ?disabled=${this.#busy === "uninstall"}
            @click=${async () => { await this.#act("uninstall"); cancel(); }}>${this.#busy === "uninstall" ? "Removing…" : "Remove server"}</button>
          <button type="button" class="btn" autofocus @click=${cancel}>Cancel</button>
        </div>
      </div>
    </dialog>`;
  }

  #renderExecutable() {
    const settings = this.settings;
    return html`<form class="settings-row pi-install-form browser-settings__executable" @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget as HTMLFormElement).get("vscodeExecutable") ?? "").trim();
      void this.#save({ executable: value });
    }}>
      <div class="settings-row__text">
        <span class="settings-row__title">Custom path</span>
        <span class="settings-row__desc">An openvscode-server (or compatible) executable, or VS Code's <code>code</code> CLI installed somewhere else. It takes precedence; leave empty to find one.</span>
      </div>
      <div class="settings-row__control">
        <input class="settings-input" name="vscodeExecutable" aria-label="VS Code executable" spellcheck="false" autocomplete="off"
          placeholder="Find automatically" .value=${settings.executable} />
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`;
  }

  #renderProcess(status: VscodeStatus) {
    const running = status.state === "running" || status.state === "starting";
    const started = status.startedAt ? new Date(status.startedAt) : undefined;
    const connections = `${status.connections} open connection${status.connections === 1 ? "" : "s"}`;
    const description = running
      ? `${status.running ? `${status.running.name} · ` : ""}${started ? `started ${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ` : ""}${connections} · stops ${status.idleMinutes} minutes after the last one closes`
      : `Starts when a VS Code view opens, on 127.0.0.1 behind HUI only. It stops ${status.idleMinutes} minutes after its last connection closes, and with the gateway.`;
    return html`<div class="settings-row" data-vscode-process=${status.state}>
      <div class="settings-row__text">
        <span class="settings-row__title">Server</span>
        <span class="settings-row__desc">${description}</span>
        ${!running && status.lastError ? html`<span class="settings-row__desc browser-settings__problem">${status.lastError}</span>` : nothing}
      </div>
      <div class="settings-row__control jira-settings__actions">
        ${running
          ? html`<button type="button" class="btn btn--sm" ?disabled=${Boolean(this.#busy)} @click=${() => void this.#act("stop")}>Stop</button>`
          : html`<span class="settings-row__desc">${status.state === "failed" ? "The next VS Code view starts it again." : "Not running"}</span>`}
      </div>
    </div>`;
  }

  override render() {
    const status = this.#status;
    const pill = vscodeStatusLabel(status);
    return html`
      <section class="settings-section browser-settings" id="vscode" data-settings-section="vscode">
        <div class="settings-section__header">
          <div class="settings-section__copy">
            <h2 class="settings-section__heading">VS Code</h2>
            <p class="settings-section__desc">Open a conversation's folder in VS Code inside the Work pane. HUI runs one VS Code server on this machine, reachable only through HUI; nothing starts or downloads until a VS Code view opens.</p>
          </div>
          <div class="settings-section__actions">
            <span class="settings-status ${pill.kind === "muted" ? "" : `settings-status--${pill.kind}`}" data-vscode-status=${pill.kind} role="status">
              <span class="settings-status__dot" aria-hidden="true"></span>${pill.label}
            </span>
          </div>
        </div>
        ${this.#error ? html`<p class="jira-settings__error" role="alert">${this.#error}</p>` : nothing}
        <div class="settings-group">
          ${this.#renderProvider(status)}
          ${status ? this.#renderLicense(status) : nothing}
          ${status ? this.#renderInstall(status) : nothing}
          ${this.#renderExecutable()}
          ${status && status.state !== "setup" ? this.#renderProcess(status) : nothing}
          ${status?.dataDir ? html`<div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">Data</span>
              <span class="settings-row__desc">VS Code's settings, extensions and state stay in this HUI-only directory.</span>
            </div>
            <div class="settings-row__control"><code class="settings-row__value settings-row__value--mono browser-settings__path">${status.dataDir}</code></div>
          </div>` : nothing}
        </div>
        ${status ? this.#renderRemoveDialog(status) : nothing}
      </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-vscode-settings")) customElements.define("hui-vscode-settings", HuiVscodeSettings);
