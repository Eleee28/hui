/**
 * "Link Jira work item" dialog for one session.
 *
 * Empty input lists the operator's recently viewed work items; typing a key,
 * pasting a `/browse/KEY-N` URL or entering text searches Jira. Choosing a
 * result links it to the session; nothing is created in Jira.
 */
import { LitElement, html, nothing } from "lit";
import type { JiraConnection, JiraIssueMatch } from "../api/schema/jira.ts";
import { brandIcons } from "../lib/brand-icons.ts";
import { linkJiraWorkItem, loadJiraConnection, searchJiraIssues } from "../api/jira.ts";
import { ensureModal } from "../lib/modal-dialog.ts";
import type { SessionView } from "../api/sessions.ts";
import type { JiraCreatedDetail } from "./jira-create-dialog.ts";
import { linkBacklogJira, type BacklogItem } from "../api/backlog.ts";

const SEARCH_DELAY_MS = 250;

export class HuiJiraLinkDialog extends LitElement {
  static override properties = { session: { attribute: false }, backlogItem: { attribute: false } };
  declare session: SessionView | undefined;
  /** Linking a local backlog task instead of a session. */
  declare backlogItem: BacklogItem | undefined;
  onClose: () => void = () => {};
  onLinked: (detail: JiraCreatedDetail) => void = () => {};
  onOpenSettings: () => void = () => {};

  #connection?: JiraConnection;
  #query = "";
  #results: JiraIssueMatch[] = [];
  #active = 0;
  #loading = true;
  #searching = false;
  #linking = "";
  #error = "";
  #searchRequest = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #abort?: AbortController;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    void this.#load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#cancel();
  }

  override updated() {
    const dialog = this.querySelector("dialog");
    if (dialog && this.isConnected && dialog.isConnected) ensureModal(dialog);
  }

  #cancel() {
    this.#searchRequest++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#abort?.abort();
  }

  async #load() {
    try {
      this.#connection = await loadJiraConnection();
      if (this.#connection.configured) void this.#search("");
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "Jira could not be loaded.";
    } finally {
      this.#loading = false;
      if (this.isConnected) this.requestUpdate();
      void this.updateComplete.then(() => this.querySelector<HTMLInputElement>(".jira-link__search")?.focus());
    }
  }

  async #search(query: string) {
    const request = ++this.#searchRequest;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.#searching = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const results = await searchJiraIssues(query, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]));
      if (request !== this.#searchRequest) return;
      const linked = new Set(this.session?.jiraIssues?.map((issue) => issue.key) ?? []);
      this.#results = results.filter((issue) => !linked.has(issue.key));
      this.#active = 0;
    } catch (error) {
      if (request === this.#searchRequest && !abort.signal.aborted) this.#error = error instanceof Error ? error.message : "Jira could not be searched.";
    } finally {
      if (request === this.#searchRequest) { this.#searching = false; if (this.isConnected) this.requestUpdate(); }
    }
  }

  #input = (event: InputEvent) => {
    this.#query = (event.currentTarget as HTMLInputElement).value;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#search(this.#query), SEARCH_DELAY_MS);
  };

  #keydown = (event: KeyboardEvent) => {
    if (!this.#results.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.#active = (this.#active + step + this.#results.length) % this.#results.length;
      this.requestUpdate();
      void this.updateComplete.then(() => this.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" }));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const issue = this.#results[this.#active];
      if (issue) void this.#link(issue);
    }
  };

  async #link(issue: JiraIssueMatch) {
    const session = this.session;
    const item = this.backlogItem;
    if ((!session && !item) || this.#linking) return;
    this.#linking = issue.key;
    this.#error = "";
    this.requestUpdate();
    try {
      if (item) {
        const result = await linkBacklogJira(item.id, issue.key);
        this.#cancel();
        this.querySelector("dialog")?.close();
        this.onLinked({ ...result.issue, backlogItemId: item.id });
        return;
      }
      const result = await linkJiraWorkItem(session!.id, issue.key);
      this.#cancel();
      this.querySelector("dialog")?.close();
      this.onLinked({ ...result.issue, ...(result.session ? { session: result.session } : {}) });
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "The work item could not be linked.";
    } finally {
      this.#linking = "";
      if (this.isConnected) this.requestUpdate();
    }
  }

  #close = () => {
    this.#cancel();
    this.querySelector("dialog")?.close();
    this.onClose();
  };

  #renderResults() {
    if (this.#searching && !this.#results.length) return html`<p class="jira-create__status" role="status"><span class="hui-orbit" aria-hidden="true"><i></i><i></i><i></i></span> Searching Jira…</p>`;
    if (!this.#results.length) {
      return html`<p class="jira-create__status" role="status">${this.#query.trim()
        ? "No matching work items. Try a key such as CI-123 or paste its URL."
        : "No recently viewed work items. Type a key, URL or words from the summary."}</p>`;
    }
    return html`<div class="jira-link__heading">${this.#query.trim() ? "Results" : "Recently viewed"}</div>
      <ul class="jira-link__results" role="listbox" id="jira-link-results" aria-label="Jira work items">
        ${this.#results.map((issue, index) => html`<li
          id=${`jira-link-option-${index}`}
          role="option"
          class="jira-link__result"
          aria-selected=${String(index === this.#active)}
          ?data-active=${index === this.#active}
          data-state=${issue.statusCategory ?? "unknown"}
          @pointerenter=${() => { this.#active = index; this.requestUpdate(); }}
          @click=${() => void this.#link(issue)}
        >
          <span class="jira-link__key">${issue.key}</span>
          <span class="jira-link__summary">${issue.summary}</span>
          <span class="jira-link__meta">${this.#linking === issue.key ? "Linking…" : [issue.issueType, issue.status].filter(Boolean).join(" · ")}</span>
        </li>`)}
      </ul>`;
  }

  override render() {
    const subject = this.session?.title ?? this.backlogItem?.title;
    if (subject === undefined) return nothing;
    const notConnected = this.#connection && !this.#connection.configured;
    return html`<dialog class="hui-modal-dialog jira-create-dialog jira-link-dialog" aria-labelledby="jira-link-title"
      @cancel=${(event: Event) => { event.preventDefault(); this.#close(); }}>
      <div class="exec-approval-card jira-create">
        <div class="jira-create__header">
          <span class="jira-create__logo" aria-hidden="true">${brandIcons.jira}</span>
          <div>
            <div class="exec-approval-title" id="jira-link-title">Link Jira work item</div>
            <div class="exec-approval-sub">To “${subject}”.</div>
          </div>
          <button type="button" class="btn btn--icon jira-create__close" aria-label="Close" @click=${this.#close}>×</button>
        </div>
        ${this.#loading ? html`<p class="jira-create__status" role="status">Loading Jira…</p>` : notConnected ? html`
          <p class="jira-create__status">Connect Jira with an API token before linking work items.</p>
          <div class="exec-approval-actions">
            <button type="button" class="btn primary" @click=${() => { this.#close(); this.onOpenSettings(); }}>Open Integrations</button>
            <button type="button" class="btn" @click=${this.#close}>Cancel</button>
          </div>` : html`
          <input class="input jira-link__search" type="search" autocomplete="off" spellcheck="false"
            role="combobox" aria-expanded="true" aria-controls="jira-link-results" aria-autocomplete="list"
            aria-activedescendant=${this.#results.length ? `jira-link-option-${this.#active}` : nothing}
            aria-label="Search Jira work items" placeholder="Key, URL or summary text"
            .value=${this.#query} ?disabled=${Boolean(this.#linking)}
            @input=${this.#input} @keydown=${this.#keydown} />
          ${this.#renderResults()}
          ${this.#error ? html`<p class="jira-create__error" role="alert">${this.#error}</p>` : nothing}`}
      </div>
    </dialog>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-jira-link-dialog")) {
  customElements.define("hui-jira-link-dialog", HuiJiraLinkDialog);
}
