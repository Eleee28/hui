/**
 * The Jira section of Settings → Integrations. Owns only this section; the token is write-only here and never
 * returned by the server. Connecting and disconnecting go through the gateway, which also lists the projects to pick.
 */
import { LitElement, html, nothing } from "lit";
import { JIRA_API_TOKEN_URL } from "../../lib/jira.ts";
import type { JiraConnection, JiraProject } from "../../api/schema/jira.ts";
import { icons } from "../../lib/icons.ts";
import { mergeJiraProjects } from "../../lib/jira.ts";
import { connectJira, disconnectJira, jiraProjectSearch, loadJiraConnection, loadJiraProjects, setJiraDefaultProject } from "../../api/jira.ts";
import { renderPicker } from "../../views/settings-picker.ts";

export class HuiJiraSettings extends LitElement {
  #connection?: JiraConnection;
  #projects: JiraProject[] = [];
  #projectsError = "";
  #projectTotal = 0;
  readonly #searchProjects = jiraProjectSearch(
    (found) => { this.#projects = mergeJiraProjects(this.#projects, found); this.#projectsError = ""; this.requestUpdate(); },
    (message) => { this.#projectsError = message; this.requestUpdate(); },
  );
  #loading = true;
  #saving = false;
  #editing = false;
  #error = "";
  #notice = "";
  #request = 0;

  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); void this.#load(); }
  override disconnectedCallback() { super.disconnectedCallback(); this.#request++; }

  async #load() {
    const request = ++this.#request;
    this.#loading = true;
    this.requestUpdate();
    try {
      this.#connection = await loadJiraConnection();
      if (request === this.#request && this.#connection.configured) void this.#loadProjects();
    } catch (error) {
      if (request === this.#request) this.#error = error instanceof Error ? error.message : "Jira settings could not be loaded.";
    } finally {
      if (request === this.#request) { this.#loading = false; this.requestUpdate(); }
    }
  }

  async #loadProjects() {
    this.#projectsError = "";
    try {
      const preferred = this.#connection?.defaultProject ?? "";
      const [result, match] = await Promise.all([
        loadJiraProjects(),
        preferred ? loadJiraProjects(preferred).catch(() => ({ projects: [], total: 0 })) : Promise.resolve({ projects: [], total: 0 }),
      ]);
      this.#projects = mergeJiraProjects(result.projects, match.projects.filter((project) => project.key === preferred));
      this.#projectTotal = result.total;
    } catch (error) {
      this.#projectsError = error instanceof Error ? error.message : "Jira projects could not be loaded.";
    }
    this.requestUpdate();
  }

  #submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    this.#saving = true;
    this.#error = "";
    this.#notice = "";
    this.requestUpdate();
    try {
      this.#connection = await connectJira({
        site: String(data.get("site") ?? ""),
        email: String(data.get("email") ?? ""),
        token: String(data.get("token") ?? ""),
        defaultProject: this.#connection?.defaultProject ?? "",
      });
      this.#editing = false;
      this.#notice = this.#connection.accountName ? `Connected as ${this.#connection.accountName}.` : "Connected.";
      form.reset();
      void this.#loadProjects();
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "Jira could not be connected.";
    } finally {
      this.#saving = false;
      this.requestUpdate();
    }
  };

  async #setDefault(project: string) {
    this.#error = "";
    try {
      this.#connection = await setJiraDefaultProject(project);
      this.#notice = project ? `New work items default to ${project}.` : "No default project.";
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "The default project could not be saved.";
    }
    this.requestUpdate();
  }

  async #disconnect() {
    this.#error = "";
    try {
      this.#connection = await disconnectJira();
      this.#projects = [];
      this.#notice = "Jira disconnected. The API token was removed from this machine.";
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "Jira could not be disconnected.";
    }
    this.requestUpdate();
  }

  #renderForm(connection: JiraConnection | undefined) {
    const reconnecting = Boolean(connection?.configured);
    return html`<form class="jira-settings__form" @submit=${this.#submit}>
      <ol class="jira-settings__steps">
        <li>Open <a href=${JIRA_API_TOKEN_URL} target="_blank" rel="noopener noreferrer">Atlassian API tokens ${icons.externalLink}</a> while signed in to the account you use for Jira.</li>
        <li>Choose <strong>Create API token</strong>, name it “HUI”, pick an expiry and copy the token.</li>
        <li>Paste it below together with your Jira site and the account email.</li>
      </ol>
      <label class="field"><span>Jira site</span>
        <input class="input" name="site" required autocomplete="off" spellcheck="false" placeholder="your-company.atlassian.net" .value=${connection?.site ?? ""} /></label>
      <label class="field"><span>Atlassian account email</span>
        <input class="input" name="email" type="email" required autocomplete="off" spellcheck="false" placeholder="you@company.com" .value=${connection?.email ?? ""} /></label>
      <label class="field"><span>API token</span>
        <input class="input" name="token" type="password" autocomplete="off" spellcheck="false" ?required=${!reconnecting}
          placeholder=${reconnecting ? "Leave empty to keep the saved token" : "Paste the API token"} /></label>
      <p class="settings-row__desc">HUI verifies the token with Jira, then stores it only in <code>~/.config/hui/jira.json</code> (readable by you only). It is never sent to the browser or to any host other than your Jira site.</p>
      <div class="jira-settings__actions">
        <button type="submit" class="btn primary" ?disabled=${this.#saving}>${this.#saving ? "Verifying…" : reconnecting ? "Save connection" : "Connect Jira"}</button>
        ${reconnecting ? html`<button type="button" class="btn" @click=${() => { this.#editing = false; this.requestUpdate(); }}>Cancel</button>` : nothing}
      </div>
    </form>`;
  }

  override render() {
    const connection = this.#connection;
    const connected = connection?.configured === true;
    const projectOptions = [
      { value: "", label: "No default" },
      ...this.#projects.map((project) => ({ value: project.key, label: `${project.name} (${project.key})` })),
    ];
    const status = this.#loading ? "Checking…" : connected ? "Connected to Jira Cloud." : "Not connected.";
    return html`
      <section class="settings-section" data-integration="jira">
        <div class="settings-section__header"><div class="settings-section__copy">
          <h2 class="settings-section__heading">Jira</h2>
          <p class="settings-section__desc">Link sessions to Jira Cloud work items: linked items show a Jira mark beside the session name, and the session menu creates new ones drafted by the utility model. ${status}</p>
        </div></div>
        ${this.#error ? html`<p class="jira-settings__error" role="alert">${this.#error}</p>` : nothing}
        ${this.#notice ? html`<p class="jira-settings__notice" role="status">${this.#notice}</p>` : nothing}
        <div class="settings-group">
          ${this.#loading ? nothing : connected && !this.#editing ? html`
            <div class="settings-row">
              <div class="settings-row__text">
                <span class="settings-row__title">${connection.site.replace(/^https?:\/\//u, "")}</span>
                <span class="settings-row__desc">${connection.accountName ? `${connection.accountName} · ` : ""}${connection.email} · API token saved</span>
              </div>
              <div class="settings-row__control jira-settings__actions">
                <button type="button" class="btn btn--sm" @click=${() => { this.#editing = true; this.#notice = ""; this.requestUpdate(); }}>Change</button>
                <button type="button" class="btn btn--sm danger" @click=${() => this.#disconnect()}>Disconnect</button>
              </div>
            </div>
            <div class="settings-row">
              <div class="settings-row__text">
                <span class="settings-row__title">Default project</span>
                <span class="settings-row__desc">Preselected when creating a work item; you can still pick another there. ${this.#projectsError || (this.#projects.length ? `${this.#projectTotal || this.#projects.length} projects; type to search them all.` : "Loading projects…")}</span>
              </div>
              <div class="settings-row__control">${renderPicker({
                id: "jira-default-project",
                label: "Default project",
                value: connection.defaultProject,
                options: projectOptions,
                searchable: true,
                searchPlaceholder: "Search projects by name or key",
                onQuery: this.#searchProjects,
                disabled: !this.#projects.length,
                onChange: (value) => void this.#setDefault(value),
              })}</div>
            </div>` : html`<div class="settings-row settings-row--stacked">${this.#renderForm(connection)}</div>`}
        </div>
      </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-jira-settings")) customElements.define("hui-jira-settings", HuiJiraSettings);
