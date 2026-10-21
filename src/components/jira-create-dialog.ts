/**
 * "Create Jira work item" dialog for one session.
 *
 * The configured default project is preselected but can be changed. Choosing a
 * project asks the server for parent candidates and an agent draft (utility
 * model): parent default, summary and description. Fields the operator edits
 * are never overwritten by a later draft. Nothing is created until Create.
 */
import { LitElement, html, nothing } from "lit";
import type { JiraConnection, JiraDraft, JiraProject } from "../api/schema/jira.ts";
import { brandIcons } from "../lib/brand-icons.ts";
import { applyJiraDraft, jiraParentHint, mergeJiraProjects, type JiraDraftFields } from "../lib/jira.ts";
import { createJiraWorkItem, draftJiraWorkItem, loadJiraConnection, jiraProjectSearch, loadJiraProjects } from "../api/jira.ts";
import { ensureModal } from "../lib/modal-dialog.ts";
import type { SessionView } from "../api/sessions.ts";
import { taskSuggestionJiraDescription, type TaskSuggestion } from "../lib/task-suggestions.ts";
import { createBacklogJira, draftBacklogJira, type BacklogItem } from "../api/backlog.ts";
import { renderPicker } from "../views/settings-picker.ts";

export type JiraCreatedDetail = { key: string; url: string; session?: SessionView; warning?: string; suggestionId?: string; backlogItemId?: string };

export class HuiJiraCreateDialog extends LitElement {
  static override properties = { session: { attribute: false }, suggestion: { attribute: false }, backlogItem: { attribute: false } };
  declare session: SessionView | undefined;
  /** Filing a local backlog task instead of a session: title and problem/fix
   * prefill the fields and the created key is attached to the task. */
  declare backlogItem: BacklogItem | undefined;
  /** Filing a suggestion card: title is the summary, problem and proposed fix
   * the description, and the utility model only proposes a parent. Creating
   * resolves the card. */
  declare suggestion: TaskSuggestion | undefined;
  onClose: () => void = () => {};
  onCreated: (detail: JiraCreatedDetail) => void = () => {};
  onOpenSettings: () => void = () => {};

  #connection?: JiraConnection;
  #projects: JiraProject[] = [];
  readonly #searchProjects = jiraProjectSearch(
    (found) => { this.#projects = mergeJiraProjects(this.#projects, found); this.requestUpdate(); },
    (message) => { this.#error = message; this.requestUpdate(); },
  );
  #project = "";
  #draft?: JiraDraft;
  #fields: JiraDraftFields = { parent: "", summary: "", description: "" };
  #edited = new Set<keyof JiraDraftFields>();
  #assignToMe = true;
  #loading = true;
  #drafting = false;
  #creating = false;
  #error = "";
  #request = 0;
  /** Drafts have their own sequence so a draft never cancels the initial load. */
  #draftRequest = 0;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    const prefill = this.suggestion ?? (this.backlogItem ? { title: this.backlogItem.title, problem: this.backlogItem.problem ?? "", fix: this.backlogItem.fix ?? "" } : undefined);
    if (prefill) {
      this.#fields = { parent: "", summary: prefill.title.slice(0, 255), description: taskSuggestionJiraDescription(prefill) };
      this.#edited = new Set(["summary", "description"]);
    }
    void this.#load();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#request++;
    this.#draftRequest++;
  }

  override updated() {
    // A settle after Create/Cancel can re-render once the host has been removed.
    const dialog = this.querySelector("dialog");
    if (dialog && this.isConnected && dialog.isConnected) ensureModal(dialog);
  }

  async #load() {
    const request = ++this.#request;
    try {
      this.#connection = await loadJiraConnection();
      if (request !== this.#request) return;
      if (!this.#connection.configured) return;
      const preferred = this.#connection.defaultProject;
      // The default can sit beyond the first page on large sites; fetch it too.
      const [first, match] = await Promise.all([
        loadJiraProjects(),
        preferred ? loadJiraProjects(preferred).catch(() => ({ projects: [], total: 0 })) : Promise.resolve({ projects: [], total: 0 }),
      ]);
      if (request !== this.#request) return;
      this.#projects = mergeJiraProjects(first.projects, match.projects.filter((project) => project.key === preferred));
      this.#project = this.#projects.some((project) => project.key === preferred) ? preferred : preferred || this.#projects[0]?.key || "";
      if (this.#project) void this.#loadDraft(this.#project);
    } catch (error) {
      if (request === this.#request) this.#error = error instanceof Error ? error.message : "Jira could not be loaded.";
    } finally {
      if (request === this.#request) { this.#loading = false; this.requestUpdate(); }
    }
  }

  async #loadDraft(project: string) {
    const session = this.session;
    const item = this.backlogItem;
    if (!session && !item) return;
    const request = ++this.#draftRequest;
    this.#drafting = true;
    this.#error = "";
    // The parent list belongs to the project; a stale choice is meaningless.
    this.#edited.delete("parent");
    this.#fields = { ...this.#fields, parent: "" };
    this.#draft = undefined;
    this.requestUpdate();
    try {
      const draft = item ? await draftBacklogJira(item.id, project) : await draftJiraWorkItem(session!.id, project, this.suggestion?.id);
      if (request !== this.#draftRequest || project !== this.#project) return;
      this.#draft = draft;
      this.#fields = applyJiraDraft(this.#fields, this.#edited, draft);
    } catch (error) {
      if (request === this.#draftRequest) this.#error = error instanceof Error ? error.message : "The draft could not be prepared.";
    } finally {
      if (request === this.#draftRequest) { this.#drafting = false; this.requestUpdate(); }
    }
  }

  #edit(field: keyof JiraDraftFields, value: string) {
    this.#edited.add(field);
    this.#fields = { ...this.#fields, [field]: value };
    this.requestUpdate();
  }

  #close = () => {
    this.#request++;
    this.#draftRequest++;
    this.querySelector("dialog")?.close();
    this.onClose();
  };

  #submit = async (event: Event) => {
    event.preventDefault();
    const session = this.session;
    const item = this.backlogItem;
    if ((!session && !item) || this.#creating || !this.#project || !this.#fields.summary.trim()) return;
    this.#creating = true;
    this.#error = "";
    this.requestUpdate();
    try {
      if (item) {
        const result = await createBacklogJira(item.id, { project: this.#project, ...this.#fields, assignToMe: this.#assignToMe });
        this.querySelector("dialog")?.close();
        this.onCreated({ ...result.issue, ...(result.warning ? { warning: result.warning } : {}), backlogItemId: item.id });
        return;
      }
      const suggestionId = this.suggestion?.id;
      const result = await createJiraWorkItem(session!.id, { project: this.#project, ...this.#fields, assignToMe: this.#assignToMe, ...(suggestionId ? { suggestionId } : {}) });
      this.querySelector("dialog")?.close();
      this.onCreated({ ...result.issue, ...(result.session ? { session: result.session } : {}), ...(result.warning ? { warning: result.warning } : {}), ...(suggestionId ? { suggestionId } : {}) });
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "The work item could not be created.";
    } finally {
      this.#creating = false;
      if (this.isConnected) this.requestUpdate();
    }
  };

  #renderBody() {
    if (this.#loading) return html`<p class="jira-create__status" role="status">Loading Jira projects…</p>`;
    if (this.#connection && !this.#connection.configured) {
      return html`<p class="jira-create__status">Connect Jira with an API token before creating work items.</p>
        <div class="exec-approval-actions">
          <button type="button" class="btn primary" @click=${() => { this.#close(); this.onOpenSettings(); }}>Open Integrations</button>
          <button type="button" class="btn" @click=${this.#close}>Cancel</button>
        </div>`;
    }
    const parents = this.#draft?.parents ?? [];
    const parentOptions = [
      { value: "", label: "No parent" },
      ...parents.map((parent) => ({ value: parent.key, label: `${parent.key} · ${parent.summary}`, description: parent.issueType })),
    ];
    const busy = this.#drafting || this.#creating;
    const parentHint = jiraParentHint(this.#draft, this.#edited.has("parent"));
    return html`
      <div class="jira-create__fields">
        <div class="field jira-create__field">
          <span id="jira-create-project-label">Project</span>
          ${renderPicker({
            id: "jira-create-project",
            label: "Project",
            value: this.#project,
            options: this.#projects.map((project) => ({ value: project.key, label: `${project.name} (${project.key})` })),
            searchable: true,
            searchPlaceholder: "Search projects by name or key",
            onQuery: this.#searchProjects,
            disabled: this.#creating,
            onChange: (value) => { this.#project = value; void this.#loadDraft(value); },
          })}
        </div>
        <div class="field jira-create__field">
          <span>Parent ${parentHint.suggested ? html`<em class="jira-create__hint">suggested</em>` : nothing}</span>
          ${renderPicker({
            id: "jira-create-parent",
            label: "Parent",
            value: this.#fields.parent,
            options: parentOptions,
            searchable: true,
            disabled: busy || !this.#draft,
            onChange: (value) => this.#edit("parent", value),
          })}
          ${parentHint.reason ? html`<p class="jira-create__field-note">${parentHint.reason}</p>` : nothing}
        </div>
        <label class="field jira-create__field">
          <span>Summary</span>
          <input class="input" name="summary" required maxlength="255" autocomplete="off"
            placeholder=${this.#drafting ? "Drafting…" : "What needs to be done"}
            .value=${this.#fields.summary} ?disabled=${this.#creating}
            @input=${(event: InputEvent) => this.#edit("summary", (event.currentTarget as HTMLInputElement).value)} />
        </label>
        <label class="field jira-create__field">
          <span>Description <em class="jira-create__hint">Markdown</em></span>
          <textarea class="jira-create__description" name="description" rows="9"
            placeholder=${this.#drafting ? "The utility model is drafting a description…" : "Context, scope and acceptance criteria"}
            .value=${this.#fields.description} ?disabled=${this.#creating}
            @input=${(event: InputEvent) => this.#edit("description", (event.currentTarget as HTMLTextAreaElement).value)}></textarea>
        </label>
        <label class="jira-create__assign">
          <input type="checkbox" .checked=${this.#assignToMe} ?disabled=${this.#creating}
            @change=${(event: Event) => { this.#assignToMe = (event.currentTarget as HTMLInputElement).checked; this.requestUpdate(); }} />
          <span>Assign to me${this.#connection?.accountName ? html` <em class="jira-create__hint">${this.#connection.accountName}</em>` : nothing}</span>
        </label>
      </div>
      <p class="jira-create__status" role="status" aria-live="polite">${this.#drafting
        ? html`<span class="hui-orbit" aria-hidden="true"><i></i><i></i><i></i></span> Drafting with the utility model…`
        : this.#draft?.note
          ? this.#draft.note
          : this.#draft?.model ? `Drafted by ${this.#draft.model}. Review before creating.` : nothing}</p>
      ${this.#error ? html`<p class="jira-create__error" role="alert">${this.#error}</p>` : nothing}
      <div class="exec-approval-actions">
        <button type="submit" class="btn primary" ?disabled=${busy || !this.#project || !this.#fields.summary.trim()}>${this.#creating ? "Creating…" : "Create"}</button>
        <button type="button" class="btn" @click=${this.#close}>Cancel</button>
      </div>`;
  }

  override render() {
    const subject = this.session?.title ?? this.backlogItem?.title;
    if (subject === undefined) return nothing;
    return html`<dialog class="hui-modal-dialog jira-create-dialog" aria-labelledby="jira-create-title"
      @cancel=${(event: Event) => { event.preventDefault(); this.#close(); }}>
      <form class="exec-approval-card jira-create" @submit=${this.#submit}>
        <div class="jira-create__header">
          <span class="jira-create__logo" aria-hidden="true">${brandIcons.jira}</span>
          <div>
            <div class="exec-approval-title" id="jira-create-title">Create Jira work item</div>
            <div class="exec-approval-sub">${this.backlogItem ? html`From the backlog task “${subject}”.` : this.suggestion ? html`From a suggested task · linked to “${subject}”.` : html`Linked to “${subject}”.`}</div>
          </div>
          <button type="button" class="btn btn--icon jira-create__close" aria-label="Close" @click=${this.#close}>×</button>
        </div>
        ${this.#renderBody()}
      </form>
    </dialog>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-jira-create-dialog")) {
  customElements.define("hui-jira-create-dialog", HuiJiraCreateDialog);
}
