/**
 * "Start session" dialog for a Kanban backlog item.
 *
 * The form grows step by step (rules in `lib/backlog-start.ts`): first only the
 * folder or repository (with the new-session page's working-directory
 * suggestions). A folder that is not a Git checkout ends the form. A checkout
 * defaults to Branch with the repository default selected in a shared picker.
 * New worktree keeps that selection and asks for a suffix the utility
 * model suggests (requested as soon as the folder is known to be a checkout)
 * without changing the selected base ref. Nothing is created
 * until Start; a failure keeps the item in the backlog and shows the error
 * here. Cancel changes nothing.
 */
import { LitElement, html, nothing } from "lit";
import { SESSION_STAGE_LABELS } from "../lib/kanban.ts";
import type { SessionStage } from "../api/schema/sessions.ts";
import type { BacklogItem } from "../api/schema/backlog.ts";
import { fallbackBranchName } from "../lib/backlog-start.ts";
import { startBacklogItem, suggestBacklogBranchName } from "../api/backlog.ts";
import {
  backlogBranchOptions,
  backlogStartRequest,
  backlogStartStep,
  backlogWorktreeName,
  canStartBacklog,
  type BacklogStartMode,
  type BacklogStartState,
} from "../lib/backlog-start.ts";
import { icons } from "../lib/icons.ts";
import { ensureModal } from "../lib/modal-dialog.ts";
import { loadGitCheckout, type GitCheckoutInfo, type SessionView } from "../api/sessions.ts";
import { sessionGroupLabel } from "../lib/session/sessions.ts";
import { loadWorkingDirectorySuggestions } from "../api/working-directories.ts";
import { renderPicker } from "../views/settings-picker.ts";
import { renderDirectoryPicker } from "../views/directory-picker.ts";

export type BacklogStartTarget = { stage: SessionStage; group: string; cwd?: string };

const orbit = html`<span class="hui-orbit" aria-hidden="true"><i></i><i></i><i></i></span>`;

export class HuiBacklogStartDialog extends LitElement {
  static override properties = { item: { attribute: false }, target: { attribute: false }, branchPrefix: { attribute: false } };
  declare item: BacklogItem | undefined;
  declare target: BacklogStartTarget | undefined;
  declare branchPrefix: string;
  onClose: () => void = () => {};
  onStarted: (session: SessionView, item: BacklogItem) => void = () => {};

  #cwd = "";
  #suggestions: string[] = [];
  #suggestionRequest = 0;
  #checkout?: GitCheckoutInfo;
  #checkoutFor = "";
  #checkoutLoading = false;
  #checkoutRequest = 0;
  #mode: BacklogStartMode = "branch";
  #name = "";
  /** The operator typed in the name field; a late suggestion never replaces it. */
  #nameTouched = false;
  #suggestedName = "";
  #suggesting = false;
  #nameRequest = 0;
  #nameAbort?: AbortController;
  #baseRef = "";
  #starting = false;
  #error = "";

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    this.#cwd = this.target?.cwd ?? this.item?.cwd ?? "";
    if (this.#cwd) this.#inspect(this.#cwd);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.#suggestionRequest++;
    this.#checkoutRequest++;
    this.#cancelNameSuggestion();
  }

  override updated() {
    const dialog = this.querySelector("dialog");
    if (dialog && this.isConnected && dialog.isConnected) ensureModal(dialog);
  }

  get #state(): BacklogStartState {
    return {
      cwd: this.#cwd,
      ...(this.#checkout ? { checkout: this.#checkout } : {}),
      loading: this.#checkoutLoading,
      mode: this.#mode,
      name: this.#name,
      suggestedName: this.#suggestedName,
      baseRef: this.#baseRef,
    };
  }

  #directoryInput = (value: string) => {
    this.#cwd = value;
    const request = ++this.#suggestionRequest;
    void loadWorkingDirectorySuggestions(value).then(
      (found) => { if (request === this.#suggestionRequest) { this.#suggestions = found; this.requestUpdate(); } },
      () => { if (request === this.#suggestionRequest) { this.#suggestions = []; this.requestUpdate(); } },
    );
    this.#inspect(value);
    this.requestUpdate();
  };

  /** Everything after the folder belongs to the folder it was chosen for. */
  #resetLaterSteps() {
    this.#checkout = undefined;
    this.#mode = "branch";
    this.#name = "";
    this.#nameTouched = false;
    this.#suggestedName = "";
    this.#baseRef = "";
    this.#cancelNameSuggestion();
  }

  #inspect(value: string) {
    const directory = value.trim();
    if (directory === this.#checkoutFor) return;
    this.#checkoutFor = directory;
    const request = ++this.#checkoutRequest;
    this.#resetLaterSteps();
    if (!directory) {
      this.#checkoutLoading = false;
      return;
    }
    this.#checkoutLoading = true;
    void loadGitCheckout(directory).then((checkout) => {
      if (request !== this.#checkoutRequest) return;
      this.#checkout = checkout;
      this.#baseRef = checkout.defaultBranch || checkout.headBranch;
      if (checkout.available) this.#suggestName(directory);
    }, () => {
      // Discovery failed: work in the folder as it is, like a plain folder.
      if (request === this.#checkoutRequest) this.#checkout = { available: false, headBranch: "", defaultBranch: "", branches: [] };
    }).finally(() => {
      if (request === this.#checkoutRequest) { this.#checkoutLoading = false; this.requestUpdate(); }
    });
  }

  #cancelNameSuggestion() {
    this.#nameRequest++;
    this.#nameAbort?.abort();
    this.#nameAbort = undefined;
    this.#suggesting = false;
  }

  /** Prefetched as soon as the folder is a checkout, so the name is usually
   * ready by the time New worktree is chosen. */
  #suggestName(directory: string) {
    const item = this.item;
    if (!item) return;
    this.#cancelNameSuggestion();
    const request = this.#nameRequest;
    const abort = new AbortController();
    this.#nameAbort = abort;
    this.#suggesting = true;
    const apply = (name: string) => {
      if (request !== this.#nameRequest) return;
      this.#suggestedName = name;
      if (!this.#nameTouched) this.#name = name;
    };
    void suggestBacklogBranchName(item.id, directory, abort.signal)
      .then(({ name }) => apply(name), () => apply(fallbackBranchName(item.title, item.jira?.key)))
      .finally(() => {
        if (request !== this.#nameRequest) return;
        this.#suggesting = false;
        this.#nameAbort = undefined;
        if (this.isConnected) this.requestUpdate();
      });
  }

  #choose(mode: BacklogStartMode) {
    this.#mode = mode;
    this.requestUpdate();
  }

  #close = () => {
    if (this.#starting) return;
    this.querySelector("dialog")?.close();
    this.onClose();
  };

  #submit = async (event: Event) => {
    event.preventDefault();
    const item = this.item;
    const target = this.target;
    const request = backlogStartRequest(this.#state);
    if (!item || !target || this.#starting || !request) return;
    this.#starting = true;
    this.#error = "";
    this.requestUpdate();
    try {
      const { session } = await startBacklogItem(item.id, { ...request, stage: target.stage, group: target.group });
      this.#starting = false;
      this.querySelector("dialog")?.close();
      this.onStarted(session, item);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "The session could not be started.";
      this.#starting = false;
      if (this.isConnected) this.requestUpdate();
    }
  };

  #renderChoice(checkout: GitCheckoutInfo) {
    return html`<fieldset class="backlog-start__checkout backlog-start__step">
      <legend>Work on</legend>
      <label class="backlog-start__radio">
        <input type="radio" name="checkout" value="branch" .checked=${this.#mode === "branch"} ?disabled=${this.#starting}
          @change=${() => this.#choose("branch")} />
        <span class="backlog-start__radio-icon" aria-hidden="true">${icons.folder}</span>
        <span><strong>Branch</strong><small>Current checkout · ${checkout.headBranch || "HEAD"}</small></span>
      </label>
      <label class="backlog-start__radio">
        <input type="radio" name="checkout" value="worktree" .checked=${this.#mode === "worktree"} ?disabled=${this.#starting}
          @change=${() => this.#choose("worktree")} />
        <span class="backlog-start__radio-icon" aria-hidden="true">${icons.gitBranch}</span>
        <span><strong>New worktree</strong><small>Separate checkout, new branch</small></span>
      </label>
    </fieldset>`;
  }

  #renderRefPicker(checkout: GitCheckoutInfo, label: string, value: string, onChange: (value: string) => void) {
    return renderPicker({
      label,
      value,
      options: backlogBranchOptions(checkout)
        .map((branch) => ({ value: branch, label: branch })),
      disabled: this.#starting,
      searchable: true,
      searchPlaceholder: "Search branches or enter a commit",
      customOption: (query) => query.trim() ? { value: query.trim(), label: query.trim() } : null,
      onChange: (next) => { onChange(next); this.requestUpdate(); },
    });
  }

  #renderBranch(checkout: GitCheckoutInfo) {
    return html`<div class="field backlog-start__field backlog-start__step">
      <span>Branch</span>
      ${this.#renderRefPicker(checkout, "Branch", this.#baseRef, (value) => { this.#baseRef = value; })}
      <small class="backlog-start__hint">${checkout.branchesUnavailable
        ? "Branch suggestions are unavailable. Enter any branch or commit."
        : this.#mode === "worktree"
          ? "The new worktree starts from this branch or commit."
          : "A different branch switches this checkout before the session starts."}</small>
    </div>`;
  }

  #renderWorktree() {
    const prefix = this.branchPrefix || "";
    const name = backlogWorktreeName(this.#state);
    const pending = this.#suggesting && !this.#nameTouched && !this.#name;
    return html`<div class="backlog-start__worktree backlog-start__step">
      <label class="field backlog-start__field">
        <span>Branch suffix</span>
        <div class="backlog-start__name">
          <input class="input" name="branchName" autocomplete="off" spellcheck="false"
            placeholder=${pending ? "Suggesting a name…" : this.#suggestedName || "short-description"}
            aria-busy=${pending ? "true" : "false"}
            .value=${this.#name} ?disabled=${this.#starting}
            @input=${(event: InputEvent) => { this.#name = (event.currentTarget as HTMLInputElement).value; this.#nameTouched = true; this.requestUpdate(); }} />
          ${pending ? html`<div class="backlog-start__name-status" role="status" aria-label="Suggesting a name">${orbit}</div>` : nothing}
        </div>
        <small class="backlog-start__hint">Creates branch <code>${prefix}${name || "<name>"}</code> in a separate checkout.</small>
      </label>
    </div>`;
  }

  #renderSteps() {
    const step = backlogStartStep(this.#state);
    const checkout = this.#checkout;
    if (this.#checkoutLoading) return html`<p class="backlog-start__note" role="status">Inspecting the folder…</p>`;
    if (step === "folder" || !checkout) return nothing;
    if (step === "plain") return html`<p class="backlog-start__note backlog-start__step">Not a Git repository; the session works in this folder as it is.</p>`;
    return html`${this.#renderChoice(checkout)}
      ${this.#renderBranch(checkout)}
      ${step === "worktree" ? this.#renderWorktree() : nothing}`;
  }

  override render() {
    const item = this.item;
    const target = this.target;
    if (!item || !target) return nothing;
    return html`<dialog class="hui-modal-dialog group-action-dialog backlog-start-dialog" aria-labelledby="backlog-start-title"
      @cancel=${(event: Event) => { event.preventDefault(); this.#close(); }}>
      <form class="exec-approval-card backlog-start" @submit=${this.#submit}>
        <div class="exec-approval-title" id="backlog-start-title">Start session</div>
        <div class="exec-approval-sub">
          “${item.title}”${item.jira ? html` · ${item.jira.key}` : nothing} → ${SESSION_STAGE_LABELS[target.stage]} · ${sessionGroupLabel(target.group)}
        </div>
        <div class="field input-dialog__field"><label for="backlog-start-cwd">Folder or repository</label>
          ${renderDirectoryPicker({ id: "backlog-start-cwd", label: "Folder or repository", value: this.#cwd, suggestions: this.#suggestions, onInput: this.#directoryInput, inputClass: "settings-input", required: true, externalLabel: true })}
        </div>
        ${this.#renderSteps()}
        ${this.#starting ? html`<p class="backlog-start__note" role="status">${orbit} ${this.#mode === "worktree" ? "Creating the worktree and starting the session…" : "Starting the session…"}</p>` : nothing}
        ${this.#error ? html`<p class="group-action-dialog__error" role="alert">${this.#error}</p>` : nothing}
        <div class="exec-approval-actions">
          <button type="submit" class="btn primary" ?disabled=${this.#starting || !canStartBacklog(this.#state)}>${this.#starting ? "Starting…" : "Start session"}</button>
          <button type="button" class="btn" ?disabled=${this.#starting} @click=${this.#close}>Cancel</button>
        </div>
      </form>
    </dialog>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-backlog-start-dialog")) {
  customElements.define("hui-backlog-start-dialog", HuiBacklogStartDialog);
}
