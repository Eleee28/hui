/**
 * The dialog behind Fork from here: where the copy works. A Git checkout offers the same checkout (both sessions edit
 * the same files) or a new worktree on a new branch from the checkout's HEAD, which is the default. A folder outside
 * Git, or a session on a remote worker, forks into the same folder without asking twice. Nothing happens until Fork;
 * a failure stays here and Cancel changes nothing.
 */
import { LitElement, html, nothing } from "lit";
import { fallbackBranchName } from "../lib/backlog-start.ts";
import { icons } from "../lib/icons.ts";
import { ensureModal } from "../lib/modal-dialog.ts";
import { forkSession, loadGitCheckout, type GitCheckoutInfo, type SessionView } from "../api/sessions.ts";
// The radio cards and hints are the backlog Start dialog's.
import "../styles/kanban.css";

export type ForkTarget = { session: SessionView; entryId: string };
type Mode = "checkout" | "worktree";

const orbit = html`<span class="hui-orbit" aria-hidden="true"><i></i><i></i><i></i></span>`;

/** The branch suffix a fork's worktree gets unless the operator types one. */
export function forkBranchName(title: string): string {
  return `${fallbackBranchName(title)}-fork`;
}

export class HuiForkDialog extends LitElement {
  static override properties = { target: { attribute: false }, branchPrefix: { attribute: false } };
  declare target: ForkTarget | undefined;
  declare branchPrefix: string;
  onClose: () => void = () => {};
  onForked: (session: SessionView) => void = () => {};

  #checkout?: GitCheckoutInfo;
  #inspecting = true;
  #mode: Mode = "worktree";
  #name = "";
  #forking = false;
  #error = "";

  constructor() {
    super();
    this.branchPrefix = "";
  }

  protected override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    const session = this.target?.session;
    if (!session || session.worker) {
      this.#inspecting = false;
      return;
    }
    void loadGitCheckout(session.cwd)
      .then((checkout) => { this.#checkout = checkout; })
      .catch(() => { this.#checkout = undefined; })
      .finally(() => { this.#inspecting = false; this.requestUpdate(); });
  }

  protected override updated() {
    const dialog = this.querySelector("dialog");
    if (dialog) ensureModal(dialog);
  }

  get #canWorktree(): boolean {
    return Boolean(this.#checkout?.available && !this.target?.session.worker);
  }

  #close = () => {
    if (!this.#forking) this.onClose();
  };

  #submit = async (event: Event) => {
    event.preventDefault();
    const target = this.target;
    if (!target || this.#forking || this.#inspecting) return;
    this.#forking = true;
    this.#error = "";
    this.requestUpdate();
    const worktree = this.#canWorktree && this.#mode === "worktree";
    try {
      const session = await forkSession(target.session.id, target.entryId, worktree
        ? { worktree: true, ...(this.#name.trim() ? { branchName: this.#name.trim() } : {}) }
        : {});
      this.onForked(session);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "Could not fork that session.";
      this.#forking = false;
      if (this.isConnected) this.requestUpdate();
    }
  };

  #renderChoice(session: SessionView, checkout: GitCheckoutInfo) {
    const branch = checkout.headBranch || "HEAD";
    return html`<fieldset class="backlog-start__checkout">
      <legend>The fork works in</legend>
      <label class="backlog-start__radio">
        <input type="radio" name="fork-checkout" value="worktree" .checked=${this.#mode === "worktree"} ?disabled=${this.#forking}
          @change=${() => { this.#mode = "worktree"; this.requestUpdate(); }} />
        <span class="backlog-start__radio-icon" aria-hidden="true">${icons.gitBranch}</span>
        <span><strong>New worktree</strong><small>Separate checkout from ${branch}</small></span>
      </label>
      <label class="backlog-start__radio">
        <input type="radio" name="fork-checkout" value="checkout" .checked=${this.#mode === "checkout"} ?disabled=${this.#forking}
          @change=${() => { this.#mode = "checkout"; this.requestUpdate(); }} />
        <span class="backlog-start__radio-icon" aria-hidden="true">${icons.folder}</span>
        <span><strong>Same checkout</strong><small>${branch} · shared with “${session.title}”</small></span>
      </label>
    </fieldset>
    ${this.#mode === "worktree" ? this.#renderWorktree(session) : html`<p class="backlog-start__hint">Both sessions edit the same files.</p>`}`;
  }

  #renderWorktree(session: SessionView) {
    const suggested = forkBranchName(session.title);
    const name = this.#name.trim() || suggested;
    return html`<label class="field backlog-start__field">
      <span>Branch suffix</span>
      <input class="input" name="branchName" autocomplete="off" spellcheck="false" placeholder=${suggested}
        .value=${this.#name} ?disabled=${this.#forking}
        @input=${(event: InputEvent) => { this.#name = (event.currentTarget as HTMLInputElement).value; this.requestUpdate(); }} />
      <small class="backlog-start__hint">Creates branch <code>${this.branchPrefix}${name}</code> from the current commit.
        Uncommitted changes stay in the original checkout.</small>
    </label>`;
  }

  #renderBody(session: SessionView) {
    if (this.#inspecting) return html`<p class="backlog-start__note" role="status">${orbit} Inspecting the checkout…</p>`;
    if (session.worker) return html`<p class="backlog-start__note">Worktrees are not available on remote workers yet; the fork works in the same folder.</p>`;
    if (!this.#checkout?.available) return html`<p class="backlog-start__note">Not a Git repository; the fork works in the same folder.</p>`;
    return this.#renderChoice(session, this.#checkout);
  }

  override render() {
    const session = this.target?.session;
    if (!session) return nothing;
    const worktree = this.#canWorktree && this.#mode === "worktree";
    return html`<dialog class="hui-modal-dialog group-action-dialog backlog-start-dialog fork-dialog" aria-labelledby="fork-dialog-title"
      @cancel=${(event: Event) => { event.preventDefault(); this.#close(); }}>
      <form class="exec-approval-card backlog-start" @submit=${this.#submit}>
        <div class="exec-approval-title" id="fork-dialog-title">Fork from here</div>
        <div class="exec-approval-sub">A new session with the history up to this reply. “${session.title}” stays as it is.</div>
        ${this.#renderBody(session)}
        ${this.#forking ? html`<p class="backlog-start__note" role="status">${orbit} ${worktree ? "Creating the worktree and forking…" : "Forking…"}</p>` : nothing}
        ${this.#error ? html`<p class="group-action-dialog__error" role="alert">${this.#error}</p>` : nothing}
        <div class="exec-approval-actions">
          <button type="submit" class="btn primary" ?disabled=${this.#forking || this.#inspecting}>${this.#forking ? "Forking…" : "Fork"}</button>
          <button type="button" class="btn" ?disabled=${this.#forking} @click=${this.#close}>Cancel</button>
        </div>
      </form>
    </dialog>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-fork-dialog")) {
  customElements.define("hui-fork-dialog", HuiForkDialog);
}
