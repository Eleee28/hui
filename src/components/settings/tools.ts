/**
 * Settings → Tools: the shipped tool catalog, the configured PI sources and HUI's default prompt, plus a live look at
 * one session's tools and assembled prompt. Owns only this read-only surface; runtime protocol never enters the view.
 */
import { LitElement, html, nothing } from "lit";
import type { SessionView } from "../../api/sessions.ts";
import type { SessionTools, ToolsCatalog } from "../../api/schema/tools.ts";
import { inspectSessionTools, loadToolsCatalog } from "../../api/tools.ts";
import { loadViewAssets } from "../../lib/view-assets.ts";

loadViewAssets(() => import("../../styles/tools.css"));

export class HuiToolsSettings extends LitElement {
  static override properties = { sessions: { attribute: false } };
  declare sessions: readonly SessionView[];
  #catalog?: ToolsCatalog;
  #inspection?: SessionTools;
  #sessionId = "";
  #loading = true;
  #error = "";
  #request = 0;

  constructor() { super(); this.sessions = []; }
  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); void this.#load(); }
  override disconnectedCallback() { super.disconnectedCallback(); this.#request++; }

  async #load() {
    const request = ++this.#request;
    this.#loading = true;
    this.#error = "";
    this.#inspection = undefined;
    this.requestUpdate();
    try {
      const [catalog, inspection] = await Promise.all([
        loadToolsCatalog(), this.#sessionId ? inspectSessionTools(this.#sessionId) : undefined,
      ]);
      if (request !== this.#request) return;
      this.#catalog = catalog;
      this.#inspection = inspection;
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "Tools could not be loaded.";
    } finally {
      if (request === this.#request) { this.#loading = false; this.requestUpdate(); }
    }
  }

  override render() {
    const catalog = this.#catalog;
    const live = this.#inspection?.status === "live" ? this.#inspection : undefined;
    return html`
      <div class="tools-toolbar">
        <label for="tools-session">Inspect</label>
        <select id="tools-session" .value=${this.#sessionId} @change=${(event: Event) => {
          this.#sessionId = (event.target as HTMLSelectElement).value; void this.#load();
        }}>
          <option value="">Default catalog · no session</option>
          ${this.sessions.map((session) => html`<option value=${session.id}>${session.title || session.id}</option>`)}
        </select>
        <button class="btn btn--sm" ?disabled=${this.#loading} @click=${() => this.#load()}>Refresh tools</button>
      </div>
      ${this.#error ? html`<p role="alert" class="tools-error">${this.#error}</p>` : nothing}
      ${this.#loading ? html`<p role="status">Loading tools…</p>` : nothing}
      ${this.#inspection?.status === "cold" ? html`<p role="status">This session has no running backend. Open it in chat, then refresh here. Inspection does not start sessions.</p>` : nothing}
      ${this.#inspection?.status === "unsupported" ? html`<p role="status">This backend does not support live inspection. The CLI fallback still works for chat.</p>` : nothing}
      ${live ? html`
        <section class="settings-section">
          <h2 class="settings-section__heading">Live tools · ${live.tools.filter((tool) => tool.active).length} active / ${live.tools.length} registered</h2>
          <p class="settings-section__desc">${live.backend} ${live.version} · snapshot ${live.revision}. Refresh after extensions or active tools change.</p>
          <div class="settings-group">${live.tools.map((tool) => html`
            <details class="tools-definition" data-filter=${`${tool.name} ${tool.source} ${tool.description}`}>
              <summary><strong>${tool.name}</strong><span>${tool.source} · ${tool.active ? "Active" : "Inactive"}</span></summary>
              <p>${tool.description}</p><pre aria-label=${`${tool.name} schema`}>${JSON.stringify(tool.parameters, null, 2)}</pre>
            </details>`)}
          </div>
          <details class="tools-prompt"><summary>Effective session prompt · ${live.promptSource}</summary>
            <p>${live.promptPhase === "last-turn" ? "Last turn's assembled prompt; tool activation may have changed since then."
              : live.promptPhase === "current-turn" ? "Current turn's assembled prompt." : "Initialized prompt; turn-time extension changes have not been observed in this worker yet."}
              Includes workspace context and can contain private instructions.</p>
            <pre>${live.prompt}</pre>
          </details>
          ${live.diagnostics.map((message) => html`<p class="tools-error">${message}</p>`)}
        </section>` : nothing}
      ${catalog ? html`
        <section class="settings-section">
          <h2 class="settings-section__heading">Shipped tools · ${catalog.tools.length}</h2>
          <p class="settings-section__desc">New sessions use ${catalog.backend === "sdk" ? `HUI SDK ${catalog.sdkVersion}` : "the CLI fallback"}. Defaults below describe the SDK; settings and extensions can change a session's active tools.</p>
          <div class="settings-group">${[...catalog.tools].sort((a, b) => a.source.localeCompare(b.source)).map((tool) => html`
            <div class="settings-row" data-filter=${`${tool.name} ${tool.source} ${tool.description}`}>
              <div class="settings-row__text"><span class="settings-row__title">${tool.name}</span><span class="settings-row__desc">${tool.description}</span></div>
              <div class="settings-row__control"><span class="settings-row__muted">${tool.source} · ${tool.defaultEnabled ? "Default" : "Optional"}</span></div>
            </div>`)}</div>
        </section>
        <section class="settings-section">
          <h2 class="settings-section__heading">Configured sources · ${catalog.sources.length}</h2>
          <p class="settings-section__desc">Global PI packages and extensions, not verified tool definitions. A package may add commands, hooks or skills without adding tools. Workspace-specific loading is visible in live inspection.</p>
          <div class="settings-group">${catalog.sources.length ? catalog.sources.map((source) => html`
            <div class="settings-row"><span class="settings-row__title">${source}</span><span class="settings-row__muted">Configured · not inspected</span></div>`)
            : html`<div class="settings-row">No global sources configured.</div>`}</div>
          ${catalog.diagnostics.map((message) => html`<p class="tools-error">${message}</p>`)}
        </section>
        <details class="tools-prompt"><summary>HUI default prompt · ${catalog.prompt.revision}</summary>
          <p>SDK base prompt. SYSTEM.md overrides it; APPEND_SYSTEM.md, project instructions, skills and active-tool guidance are composed by the runtime. The CLI uses its own prompt.</p>
          <pre>${catalog.prompt.text}</pre>
        </details>` : nothing}
    `;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-tools-settings")) customElements.define("hui-tools-settings", HuiToolsSettings);
