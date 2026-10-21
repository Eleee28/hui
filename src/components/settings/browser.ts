/**
 * Settings → Tools → Browser. The switches and path save through the shared settings store; the gateway reports the
 * process, its tabs and previews, which this page polls and captures while it is open.
 */
import { LitElement, html, nothing, type PropertyValues } from "lit";
import type { BrowserStatus, BrowserTabView } from "../../api/schema/browser.ts";
import { browserStatusLabel, browserVersionLabel } from "../../lib/browser-status.ts";
import { controlBrowser, loadBrowserStatus, previewBrowserTab } from "../../api/browser.ts";
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from "../../lib/settings/settings.ts";
import { renderSettingsToggle } from "../../views/settings-toggle.ts";
import { loadViewAssets } from "../../lib/view-assets.ts";

loadViewAssets(() => import("../../styles/tools.css"));

/** Tabs and state change as agents work; this page is the only reader. */
const POLL_MS = 4_000;

export class HuiBrowserSettings extends LitElement {
  static override properties = {
    settings: { attribute: false },
    onChange: { attribute: false },
  };
  declare settings: BrowserSettings;
  declare onChange: (next: BrowserSettings) => Promise<unknown> | void;
  #status?: BrowserStatus;
  #loading = true;
  #busy = false;
  #error = "";
  #request = 0;
  #poll?: ReturnType<typeof setTimeout>;
  /** Preview data URLs keyed by tab id, with the URL they were captured for. */
  readonly #previews = new Map<string, { url: string; image?: string; error?: string }>();

  constructor() {
    super();
    this.settings = DEFAULT_BROWSER_SETTINGS;
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
    if (changed.has("settings") && !this.settings) this.settings = DEFAULT_BROWSER_SETTINGS;
  }

  #schedule() {
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = this.isConnected ? setTimeout(() => void this.#refresh(), POLL_MS) : undefined;
  }

  /** keepError preserves the message of the action that triggered this read. */
  async #refresh(keepError = false) {
    const request = ++this.#request;
    try {
      const status = await loadBrowserStatus();
      if (request !== this.#request) return;
      this.#status = status;
      if (!keepError) this.#error = "";
      this.#syncPreviews(status.tabs);
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "Browser status could not be loaded.";
    } finally {
      if (request === this.#request) {
        this.#loading = false;
        this.requestUpdate();
        this.#schedule();
      }
    }
  }

  /** Capture a tab when it first appears or navigates; drop closed tabs. */
  #syncPreviews(tabs: readonly BrowserTabView[]) {
    const open = new Set(tabs.map((tab) => tab.id));
    for (const id of this.#previews.keys()) if (!open.has(id)) this.#previews.delete(id);
    for (const tab of tabs) {
      if (this.#previews.get(tab.id)?.url !== tab.url) void this.#capture(tab);
    }
  }

  async #capture(tab: BrowserTabView) {
    const previous = this.#previews.get(tab.id);
    this.#previews.set(tab.id, { url: tab.url, ...(previous?.image ? { image: previous.image } : {}) });
    try {
      const image = await previewBrowserTab(tab.id);
      if (this.#previews.get(tab.id)?.url === tab.url) this.#previews.set(tab.id, { url: tab.url, image });
    } catch (error) {
      if (this.#previews.get(tab.id)?.url === tab.url) {
        this.#previews.set(tab.id, { url: tab.url, error: error instanceof Error ? error.message : "Preview unavailable." });
      }
    }
    this.requestUpdate();
  }

  async #save(next: BrowserSettings) {
    this.#error = "";
    this.requestUpdate();
    try {
      await this.onChange(next);
    } finally {
      await this.#refresh();
    }
  }

  async #control(action: "start" | "stop") {
    const request = ++this.#request;
    this.#busy = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const status = await controlBrowser(action);
      if (request === this.#request) {
        this.#status = status;
        this.#syncPreviews(status.tabs);
      }
    } catch (error) {
      if (request === this.#request) {
        this.#error = error instanceof Error ? error.message : `The browser could not ${action}.`;
        // The gateway recorded the failure too; show its current state.
        void this.#refresh(true);
      }
    } finally {
      this.#busy = false;
      this.#loading = false;
      this.requestUpdate();
      if (request === this.#request) this.#schedule();
    }
  }

  #renderExecutable(status: BrowserStatus | undefined) {
    const settings = this.settings;
    const detail = !status
      ? "Leave empty to auto-detect Google Chrome, Brave, Microsoft Edge or Chromium."
      : status.executable
        ? html`${status.executable.source === "configured" ? "Using" : "Detected"} ${status.executable.name} · <code class="browser-settings__path">${status.executable.path}</code>`
        : html`<span class="browser-settings__problem">${status.executableError}</span>`;
    return html`<form class="settings-row pi-install-form browser-settings__executable" @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget as HTMLFormElement).get("executablePath") ?? "").trim();
      void this.#save({ ...settings, executablePath: value });
    }}>
      <div class="settings-row__text">
        <span class="settings-row__title">Browser executable</span>
        <span class="settings-row__desc">${detail}</span>
      </div>
      <div class="settings-row__control">
        <input class="settings-input" name="executablePath" aria-label="Browser executable" spellcheck="false" autocomplete="off"
          placeholder="Auto-detect" .value=${settings.executablePath} />
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`;
  }

  #renderProcess(status: BrowserStatus) {
    const running = status.state === "running";
    const pending = status.state === "starting" || status.state === "stopping";
    const started = status.startedAt ? new Date(status.startedAt) : undefined;
    const description = running
      ? `${browserVersionLabel(status)} · ${status.mode === "windowed" ? "visible window" : "headless, no window"}${started ? ` · started ${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
      : "Starts when an agent opens a page and stops when its last tab closes. Stopping a turn closes its tabs; unused tabs close after 10 minutes.";
    return html`<div class="settings-row" data-browser-process=${status.state}>
      <div class="settings-row__text">
        <span class="settings-row__title">Managed browser</span>
        <span class="settings-row__desc">${description}</span>
        ${!running && status.lastError && status.lastError !== this.#error ? html`<span class="settings-row__desc browser-settings__problem">${status.lastError}</span>` : nothing}
      </div>
      <div class="settings-row__control jira-settings__actions">
        ${running || status.state === "stopping"
          ? html`<button type="button" class="btn btn--sm" ?disabled=${this.#busy || pending} @click=${() => void this.#control("stop")}>Stop</button>`
          : html`<button type="button" class="btn btn--sm" ?disabled=${this.#busy || pending || !status.enabled || !status.executable} @click=${() => void this.#control("start")}>Start</button>`}
      </div>
    </div>`;
  }

  #renderTab(tab: BrowserTabView) {
    const preview = this.#previews.get(tab.id);
    return html`<div class="settings-row browser-tab" data-browser-tab=${tab.id}>
      <div class="settings-row__text">
        <span class="settings-row__title">${tab.id} · ${tab.title || "Untitled"}</span>
        <span class="settings-row__desc"><span class="browser-tab__url">${tab.url}</span></span>
        <span class="settings-row__desc">Opened by ${tab.ownerTitle || "a removed conversation"}</span>
      </div>
      <div class="settings-row__control">
        <button type="button" class="btn btn--sm" aria-label=${`Refresh preview of ${tab.id}`} @click=${() => void this.#capture(tab)}>Refresh preview</button>
      </div>
      ${preview?.image
        ? html`<img class="browser-tab__preview" src=${preview.image} alt=${`Preview of ${tab.title || tab.url}`} />`
        : preview?.error ? html`<p class="browser-tab__preview-note">${preview.error}</p>` : nothing}
    </div>`;
  }

  override render() {
    const status = this.#status;
    const settings = this.settings;
    const pill = browserStatusLabel(this.#loading ? undefined : status);
    return html`
      <section class="settings-section browser-settings" data-settings-section="browser">
        <div class="settings-section__header">
          <div class="settings-section__copy">
            <h2 class="settings-section__heading">Browser</h2>
            <p class="settings-section__desc">Agents get a dedicated Chromium-family browser with its own HUI profile. It never uses your browser windows, tabs, cookies or passwords.</p>
          </div>
          <div class="settings-section__actions">
            <span class="settings-status ${pill.kind === "muted" ? "" : `settings-status--${pill.kind}`}" data-browser-status=${pill.kind} role="status">
              <span class="settings-status__dot" aria-hidden="true"></span>${pill.label}
            </span>
          </div>
        </div>
        ${this.#error ? html`<p class="jira-settings__error" role="alert">${this.#error}</p>` : nothing}
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">Browser tool</span>
              <span class="settings-row__desc">Offer the browser tool to new and restarted sessions. Off, calls from sessions that are already running are refused too.</span>
            </div>
            <div class="settings-row__control">${renderSettingsToggle("Browser tool", settings.enabled, (checked) => void this.#save({ ...settings, enabled: checked }))}</div>
          </div>
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">Run headless</span>
              <span class="settings-row__desc">No window, Dock icon or focus change while you work. Turn off to watch the agent in a visible window; a running browser restarts in the new mode on its next use.</span>
            </div>
            <div class="settings-row__control">${renderSettingsToggle("Run headless", settings.headless, (checked) => void this.#save({ ...settings, headless: checked }))}</div>
          </div>
          ${this.#renderExecutable(status)}
          ${status ? this.#renderProcess(status) : nothing}
          ${status?.profileDir ? html`<div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">Profile</span>
              <span class="settings-row__desc">Cookies and logins created by agents stay in this HUI-only directory.</span>
            </div>
            <div class="settings-row__control"><code class="settings-row__value settings-row__value--mono browser-settings__path">${status.profileDir}</code></div>
          </div>` : nothing}
        </div>
        ${status && status.tabs.length > 0 ? html`
          <h3 class="browser-settings__subheading">Open tabs · ${status.tabs.length}</h3>
          <div class="settings-group browser-settings__tabs">${status.tabs.map((tab) => this.#renderTab(tab))}</div>` : nothing}
      </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-browser-settings")) customElements.define("hui-browser-settings", HuiBrowserSettings);
