/**
 * <hui-vscode-view>: the Work pane's VS Code view, a frame of the gateway's VS Code server opened on the
 * conversation's folder. The first open on a machine where nothing can run yet shows the applicable choice: use the
 * installed VS Code (after accepting Microsoft's VS Code Server license), install openvscode-server (Linux), or set a
 * path, with a link to download VS Code where nothing else applies. It shows a start, including serve-web's first
 * download, says why it cannot open (a remote conversation, a missing folder), shows a crash with Retry, reloads, and
 * opens the same folder in a new tab through a fresh one-use ticket. It stays mounted while hidden so the editor
 * keeps its state.
 */
import { LitElement, html, nothing, svg, type PropertyValues } from "lit";
import { icons } from "../lib/icons.ts";
import { writeClipboardText } from "../lib/clipboard.ts";
import { connectVscode, loadVscodeStatus, onVscodeStatus, vscodeAction } from "../lib/vscode-store.ts";
import { VscodeConnectError } from "../api/vscode.ts";
import { readVscodeTheme } from "../lib/theme/vscode-theme.ts";
import {
  formatVscodeBytes, MICROSOFT_PRIVACY_URL, OPENVSCODE_SERVER_LICENSE_URL, OPENVSCODE_SERVER_URL, VSCODE_DOWNLOAD_URL, VSCODE_SERVER_LICENSE_URL,
} from "../lib/vscode.ts";
import type { VscodeConnection, VscodeStatus } from "../api/schema/vscode.ts";
import { loadViewAssets } from "../lib/view-assets.ts";
import { requestOpenSettings } from "../lib/open-settings.ts";

loadViewAssets(() => import("../styles/vscode-view.css"));

/** VS Code's mark is not an OpenClaw icon, so it lives here, in the shared stroke shell (lucide "code"). */
export const vscodeIcon = html`<svg class="hui-vscode-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline>`}</svg>`;

/** While shown and open, how often the view checks that its server is still the one it loaded. */
const WATCH_MS = 10_000;
/** While VS Code starts or a server installs, how often the view follows the gateway's progress. */
const PROGRESS_MS = 1_000;

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; preparing: VscodeStatus["preparing"] }
  | { kind: "ready" }
  | { kind: "setup"; status: VscodeStatus }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; title: string; message: string };

/** "Downloading the VS Code server from Microsoft: 45% of 223 MB" while serve-web's first start fetches its build. */
export function vscodePreparingLabel(preparing: VscodeStatus["preparing"]): string | undefined {
  if (!preparing) return undefined;
  if (!preparing.total) return "Downloading the VS Code server from Microsoft (first start only)…";
  const percent = Math.min(100, Math.floor((preparing.received / preparing.total) * 100));
  return `Downloading the VS Code server from Microsoft: ${percent}% of ${formatVscodeBytes(preparing.total)} (first start only)`;
}

export class HuiVscodeView extends LitElement {
  static override properties = {
    sessionId: {},
    visible: { type: Boolean },
    narrow: { type: Boolean },
  };
  declare sessionId: string;
  declare visible: boolean;
  declare narrow: boolean;
  #phase: Phase = { kind: "idle" };
  #connection: VscodeConnection | undefined;
  #request = 0;
  #watch: ReturnType<typeof setTimeout> | undefined;
  #progress: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;
  #copied = false;
  #busy = "";
  #actionError = "";
  /** A connect request is in flight: its own answer decides, not a status poll meanwhile. */
  #connecting = false;

  constructor() {
    super();
    this.sessionId = "";
    this.visible = false;
    this.narrow = false;
  }

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    this.#unsubscribe = onVscodeStatus((status) => this.#follow(status));
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#unsubscribe?.();
    this.#request++;
    this.#stopWatching();
    this.#stopProgress();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("sessionId") && changed.get("sessionId") !== undefined) {
      this.#request++;
      this.#connection = undefined;
      this.#phase = { kind: "idle" };
    }
    if (this.visible && this.sessionId && this.#phase.kind === "idle") void this.#open();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("visible")) {
      if (this.visible && this.#phase.kind === "ready") this.#scheduleWatch();
      if (!this.visible) this.#stopWatching();
    }
  }

  #set(phase: Phase) {
    this.#phase = phase;
    if (phase.kind === "ready" && this.visible) this.#scheduleWatch();
    if (phase.kind !== "ready") this.#stopWatching();
    const following = phase.kind === "starting" || (phase.kind === "setup" && Boolean(phase.status.install.task));
    if (following) this.#scheduleProgress(); else this.#stopProgress();
    this.requestUpdate();
  }

  /** Asks the gateway for a frame URL, starting VS Code if it can run; otherwise shows what this machine offers. */
  async #open() {
    const request = ++this.#request;
    if (this.#phase.kind !== "starting") this.#set({ kind: "starting", preparing: null });
    this.#connecting = true;
    let connection: Awaited<ReturnType<typeof connectVscode>>;
    try {
      connection = await connectVscode(this.sessionId, readVscodeTheme());
    } catch (error) {
      if (request === this.#request) this.#connecting = false;
      await this.#refused(request, error);
      return;
    }
    if (request !== this.#request) return;
    this.#connecting = false;
    if ("pending" in connection) {
      // Still starting: the progress poll follows it and opens once it runs (#follow).
      this.#set({ kind: "starting", preparing: connection.pending.preparing });
      return;
    }
    this.#connection = connection;
    this.requestUpdate();
  }

  /** A refused open: the setup card while nothing can run, the reason for a conversation VS Code cannot open. */
  async #refused(request: number, error: unknown) {
    if (request !== this.#request) return;
    this.#connection = undefined;
    if (error instanceof VscodeConnectError && error.code === "setup") {
      try {
        const status = await loadVscodeStatus();
        if (request !== this.#request) return;
        if (status.setup.needed || status.activeError) { this.#set({ kind: "setup", status }); return; }
      } catch { /* reported below */ }
    }
    if (request !== this.#request) return;
    if (error instanceof VscodeConnectError && (error.code === "remote" || error.code === "folder")) {
      this.#set({ kind: "unavailable", reason: error.message });
    } else {
      this.#set({ kind: "error", title: "VS Code could not open", message: error instanceof Error ? error.message : "VS Code could not open." });
    }
  }

  /** The frame finished loading: VS Code's workbench, or one of the proxy's own refusal pages. */
  #loaded(event: Event) {
    const frame = event.currentTarget as HTMLIFrameElement;
    if (!this.#connection || frame.dataset["url"] !== this.#connection.url) return;
    let refusal: Element | null | undefined;
    try { refusal = frame.contentDocument?.querySelector('meta[name="hui-vscode-error"]'); } catch { refusal = undefined; }
    if (refusal) {
      this.#set({ kind: "error", title: "VS Code could not open", message: refusal.getAttribute("data-message") || "The gateway refused the VS Code frame." });
      return;
    }
    this.#set({ kind: "ready" });
  }

  /** A status from anywhere (Settings in this tab, this view's own polls) can end, revive or advance the view. */
  #follow(status: VscodeStatus) {
    const phase = this.#phase;
    if (phase.kind === "setup") {
      if (!status.setup.needed && !status.activeError) { this.#phase = { kind: "idle" }; if (this.visible) void this.#open(); else this.requestUpdate(); return; }
      this.#set({ kind: "setup", status });
      return;
    }
    if (phase.kind === "starting" && !this.#connection) {
      if (this.#connecting) return;
      if (status.state === "running") { void this.#open(); return; }
      if (status.state === "failed") {
        this.#request++;
        this.#set({ kind: "error", title: "VS Code could not start", message: status.lastError || "Its server stopped while starting." });
        return;
      }
      if (status.state === "setup") { this.#request++; this.#set({ kind: "setup", status }); return; }
      if (status.state === "starting") { this.#phase = { kind: "starting", preparing: status.preparing }; this.requestUpdate(); }
      return;
    }
    const connection = this.#connection;
    if (connection && phase.kind === "ready" && (status.state !== "running" || status.instance !== connection.instance)) {
      if (status.state === "setup") {
        // Settings took away what ran (a revoked license, a removed server): ask again.
        this.#request++;
        this.#connection = undefined;
        this.#set({ kind: "setup", status });
        return;
      }
      this.#set({
        kind: "error",
        title: status.state === "failed" ? "VS Code stopped unexpectedly" : "VS Code stopped",
        message: status.state === "failed" && status.lastError ? status.lastError : "Its server is no longer running. Retry starts it again; unsaved changes VS Code backed up come back.",
      });
    }
  }

  #scheduleWatch() {
    this.#stopWatching();
    this.#watch = setTimeout(() => {
      this.#watch = undefined;
      void loadVscodeStatus().catch(() => undefined).finally(() => { if (this.visible && this.#phase.kind === "ready") this.#scheduleWatch(); });
    }, WATCH_MS);
  }

  #stopWatching() {
    if (this.#watch) clearTimeout(this.#watch);
    this.#watch = undefined;
  }

  #scheduleProgress() {
    if (this.#progress) return;
    this.#progress = setTimeout(() => {
      this.#progress = undefined;
      void loadVscodeStatus().catch(() => undefined).finally(() => {
        const phase = this.#phase;
        if (this.isConnected && (phase.kind === "starting" || (phase.kind === "setup" && phase.status.install.task))) this.#scheduleProgress();
      });
    }, PROGRESS_MS);
  }

  #stopProgress() {
    if (this.#progress) clearTimeout(this.#progress);
    this.#progress = undefined;
  }

  async #act(action: "accept-license" | "install" | "cancel-install") {
    this.#busy = action;
    this.#actionError = "";
    this.requestUpdate();
    try {
      const status = await vscodeAction(action);
      if (action === "accept-license") { this.#phase = { kind: "idle" }; void this.#open(); } else this.#set({ kind: "setup", status });
    } catch (error) {
      this.#actionError = error instanceof Error ? error.message : "The request failed.";
    } finally {
      this.#busy = "";
      this.requestUpdate();
    }
  }

  /** The same folder in a browser tab, through its own ticket. The tab opens inside the click so no popup blocker
   * stops it, and loses its opener before it navigates. */
  async #openTab() {
    const tab = window.open("about:blank", "_blank");
    try {
      const connection = await connectVscode(this.sessionId, readVscodeTheme());
      if ("pending" in connection) { tab?.close(); return; }
      if (!tab) { window.location.assign(connection.url); return; }
      tab.opener = null;
      tab.location.href = connection.url;
    } catch (error) {
      tab?.close();
      this.#set({ kind: "error", title: "VS Code could not open in a new tab", message: error instanceof Error ? error.message : "VS Code could not open." });
    }
  }

  async #copyPath() {
    const folder = this.#connection?.folder;
    if (!folder) return;
    this.#copied = await writeClipboardText(folder);
    this.requestUpdate();
    setTimeout(() => { this.#copied = false; this.requestUpdate(); }, 1_500);
  }

  #openSettings(event: MouseEvent) {
    // The app navigates in place; without one (a standalone page) the link loads Settings itself.
    if (requestOpenSettings(this, { page: "tools", section: "vscode" })) event.preventDefault();
  }

  #settingsLink(label: string) {
    return html`<a class="btn btn--sm" href="/settings/tools" @click=${(event: MouseEvent) => this.#openSettings(event)}>${icons.settings}<span>${label}</span></a>`;
  }

  #external(href: string, label: string) {
    return html`<a class="hui-vscode-view__link" href=${href} target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  #renderSetup(status: VscodeStatus) {
    const { setup, install } = status;
    const desktop = setup.desktop;
    const task = install.task;
    const busy = Boolean(this.#busy);
    return html`<div class="hui-vscode-view__overlay hui-vscode-view__overlay--solid hui-vscode-view__overlay--scroll">
      <div class="hui-vscode-view__card hui-vscode-view__card--stacked hui-vscode-view__card--setup" data-vscode-setup>
        <div class="hui-vscode-view__card-head">${vscodeIcon}<strong>${status.activeError ? "VS Code cannot start" : "Choose how to run VS Code"}</strong></div>
        <p class="hui-vscode-view__message">${status.activeError
          || "VS Code opens this conversation's folder here, served by this machine and reachable only through HUI. Nothing is installed or started until you choose."}</p>
        ${this.#actionError ? html`<p class="hui-vscode-view__problem" role="alert">${this.#actionError}</p>` : nothing}
        ${desktop ? html`<section class="hui-vscode-view__option" data-vscode-option="desktop">
          <strong>Use your VS Code</strong>
          <p class="hui-vscode-view__message">${desktop.name} ${desktop.version} is installed here. HUI runs it as Microsoft's local web server (<code>code serve-web</code>); its first start downloads the matching VS Code server from Microsoft.</p>
          <p class="hui-vscode-view__message">Microsoft's ${this.#external(VSCODE_SERVER_LICENSE_URL, "VS Code Server License Terms")} and ${this.#external(MICROSOFT_PRIVACY_URL, "Privacy Statement")} apply. HUI records your acceptance; revoke it any time in Settings.</p>
          <button type="button" class="btn btn--sm primary" ?disabled=${busy} @click=${() => void this.#act("accept-license")}>
            ${this.#busy === "accept-license" ? "Accepting…" : "Accept and open"}</button>
        </section>` : nothing}
        ${setup.install || task ? html`<section class="hui-vscode-view__option" data-vscode-option="install">
          <strong>Install VS Code server</strong>
          <p class="hui-vscode-view__message">Downloads ${this.#external(OPENVSCODE_SERVER_URL, "openvscode-server")} ${install.version} (MIT, by Gitpod), about ${formatVscodeBytes(install.size)}, into HUI's own folder. Remove it any time in Settings.</p>
          ${install.hint ? html`<p class="hui-vscode-view__message hui-vscode-view__hint">${install.hint}</p>` : nothing}
          ${install.error ? html`<p class="hui-vscode-view__problem" role="alert">${install.error}</p>` : nothing}
          ${task ? html`<div class="hui-vscode-view__progress" role="status" aria-live="polite">
              <div class="hui-vscode-view__bar-track"><div class="hui-vscode-view__bar-fill" style="width: ${task.total ? Math.min(100, Math.round((task.received / task.total) * 100)) : 0}%"></div></div>
              <span>${task.phase === "downloading" ? `Downloading… ${formatVscodeBytes(task.received)} of ${formatVscodeBytes(task.total)}` : task.phase === "verifying" ? "Checking the download…" : "Unpacking…"}</span>
              <button type="button" class="btn btn--sm" ?disabled=${this.#busy === "cancel-install"} @click=${() => void this.#act("cancel-install")}>Cancel</button>
            </div>`
            : html`<button type="button" class="btn btn--sm ${desktop ? "" : "primary"}" ?disabled=${busy} @click=${() => void this.#act("install")}>
              ${icons.download}<span>${install.error ? "Try the install again" : `Install VS Code server (≈${formatVscodeBytes(install.size)})`}</span></button>`}
          <p class="hui-vscode-view__fineprint">${this.#external(OPENVSCODE_SERVER_LICENSE_URL, "openvscode-server's MIT license")}</p>
        </section>` : nothing}
        ${setup.download ? html`<section class="hui-vscode-view__option" data-vscode-option="download">
          <strong>Install VS Code</strong>
          <p class="hui-vscode-view__message">No VS Code was found on this machine. Install it from Microsoft, then open this view again: HUI uses it once you accept its server license.</p>
          <a class="btn btn--sm primary" href=${VSCODE_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">${icons.externalLink}<span>Download VS Code</span></a>
        </section>` : nothing}
        <section class="hui-vscode-view__option" data-vscode-option="path">
          <strong>${status.activeError ? "Fix the path" : "Set a path"}</strong>
          <p class="hui-vscode-view__message">Already have a VS Code server, such as ${this.#external(OPENVSCODE_SERVER_URL, "openvscode-server")}, or VS Code somewhere else? Name its executable in Settings.</p>
          ${this.#settingsLink("Open Settings → Tools → VS Code")}
        </section>
      </div>
    </div>`;
  }

  #renderOverlay() {
    const phase = this.#phase;
    if (phase.kind === "ready" || phase.kind === "idle") return nothing;
    if (phase.kind === "starting") {
      const preparing = vscodePreparingLabel(phase.preparing);
      return html`<div class="hui-vscode-view__overlay" role="status" aria-live="polite">
        <div class="hui-vscode-view__card">
          <span class="hui-vscode-view__spinner" aria-hidden="true"></span>
          <div class="hui-vscode-view__copy">
            <strong>${preparing ? "Preparing VS Code" : "Starting VS Code"}</strong>
            ${preparing ? html`<span class="hui-vscode-view__copy-wrap">${preparing}</span>` : this.#connection ? html`<span>Opening ${this.#connection.label}</span>` : nothing}
          </div>
        </div>
      </div>`;
    }
    if (phase.kind === "setup") return this.#renderSetup(phase.status);
    if (phase.kind === "unavailable") {
      return html`<div class="hui-vscode-view__overlay hui-vscode-view__overlay--solid">
        <div class="hui-vscode-view__card hui-vscode-view__card--stacked" data-vscode-unavailable>
          <div class="hui-vscode-view__card-head">${vscodeIcon}<strong>VS Code is not available here</strong></div>
          <p class="hui-vscode-view__message">${phase.reason}</p>
        </div>
      </div>`;
    }
    return html`<div class="hui-vscode-view__overlay hui-vscode-view__overlay--solid">
      <div class="hui-vscode-view__card hui-vscode-view__card--stacked" role="alert" data-vscode-error>
        <div class="hui-vscode-view__card-head">${icons.alertTriangle}<strong>${phase.title}</strong></div>
        <p class="hui-vscode-view__message">${phase.message}</p>
        <button type="button" class="btn btn--sm" @click=${() => void this.#open()}>${icons.refresh}<span>Retry</span></button>
      </div>
    </div>`;
  }

  override render() {
    const connection = this.#connection;
    const phase = this.#phase.kind;
    const actionable = phase === "ready" || phase === "error" || (phase === "starting" && Boolean(connection));
    return html`<div class="hui-vscode-view ${this.narrow ? "hui-vscode-view--narrow" : ""}" data-phase=${phase}>
      <div class="hui-vscode-view__bar">
        <span class="hui-vscode-view__title">${vscodeIcon}<span>VS Code</span></span>
        ${connection ? html`<span class="hui-vscode-view__path" data-hui-tooltip=${connection.folder}><bdi dir="ltr">${connection.label}</bdi></span>
          <button type="button" class="btn btn--icon btn--sm hui-vscode-view__action" aria-label="Copy folder path" data-hui-tooltip=${this.#copied ? "Copied" : "Copy folder path"}
            @click=${() => void this.#copyPath()}>${this.#copied ? icons.check : icons.copy}</button>` : html`<span class="hui-vscode-view__path"></span>`}
        ${actionable ? html`<span class="hui-vscode-view__actions">
          <button type="button" class="btn btn--icon btn--sm hui-vscode-view__action" aria-label="Reload VS Code" data-hui-tooltip="Reload VS Code"
            @click=${() => void this.#open()}>${icons.refresh}</button>
          <button type="button" class="btn btn--icon btn--sm hui-vscode-view__action" aria-label="Open VS Code in a new tab" data-hui-tooltip="Open in a new tab"
            @click=${() => void this.#openTab()}>${icons.externalLink}</button>
        </span>` : nothing}
      </div>
      <div class="hui-vscode-view__body">
        ${connection ? html`<iframe class="hui-vscode-view__frame" title="VS Code" src=${connection.url} data-url=${connection.url}
          allow="clipboard-read; clipboard-write; fullscreen" allowfullscreen @load=${(event: Event) => this.#loaded(event)}></iframe>` : nothing}
        ${this.#renderOverlay()}
      </div>
    </div>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-vscode-view")) customElements.define("hui-vscode-view", HuiVscodeView);
