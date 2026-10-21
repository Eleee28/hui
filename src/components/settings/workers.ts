/**
 * Settings → Workers: machines HUI runs sessions on. The gateway owns the worker list and their connections; this
 * page adds, edits, removes and acts on workers, and polls faster while a worker is changing state.
 */
import { LitElement, html, nothing } from "lit";
import { createWorker, loadWorkers, removeWorker, updateWorker, workerAction, type WorkerView } from "../../api/workers.ts";

const POLL_FAST_MS = 1_500;
const POLL_MS = 10_000;

const STATUS: Record<WorkerView["state"], { kind: string; label: string }> = {
  connected: { kind: "ok", label: "Connected" },
  connecting: { kind: "warn", label: "Connecting" },
  error: { kind: "danger", label: "Not connected" },
  disconnected: { kind: "", label: "Disconnected" },
};

export class HuiWorkersSettings extends LitElement {
  #workers: WorkerView[] = [];
  #loading = true;
  #error = "";
  #notice = "";
  #busy = new Set<string>();
  /** Editing keeps the worker's sessions; only the next connection changes. */
  #editingWorker: WorkerView | undefined;
  #poll?: ReturnType<typeof setTimeout>;
  #request = 0;

  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); void this.#refresh(); }
  override disconnectedCallback() { super.disconnectedCallback(); this.#request++; if (this.#poll) clearTimeout(this.#poll); }

  async #refresh() {
    const request = ++this.#request;
    if (this.#poll) clearTimeout(this.#poll);
    try {
      const workers = await loadWorkers();
      if (request !== this.#request) return;
      this.#workers = workers;
      this.#error = "";
    } catch (error) {
      if (request !== this.#request) return;
      this.#error = error instanceof Error ? error.message : "Workers could not be loaded.";
    }
    this.#loading = false;
    this.requestUpdate();
    const fast = this.#workers.some((worker) => worker.state === "connecting");
    this.#poll = setTimeout(() => void this.#refresh(), fast ? POLL_FAST_MS : POLL_MS);
  }

  async #act(key: string, action: () => Promise<unknown>, notice = "") {
    this.#busy.add(key);
    this.#error = "";
    this.#notice = "";
    this.requestUpdate();
    try {
      await action();
      this.#notice = notice;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "That did not work.";
    } finally {
      this.#busy.delete(key);
      await this.#refresh();
    }
  }

  #saveWorker(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const input = {
      name: String(data.get("name") ?? ""), command: String(data.get("command") ?? ""),
      extraPaths: String(data.get("extraPaths") ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
    };
    const editing = this.#editingWorker;
    void this.#act("add", async () => {
      if (editing) await updateWorker(editing.id, input);
      else await workerAction((await createWorker(input)).id, "connect");
      this.#editingWorker = undefined;
      form.reset();
    }, editing ? "Worker saved. Connect again to use the new command." : "Worker added. HUI is setting it up now.");
  }

  /** The form sits below every worker, often out of view: bring it to the user. */
  async #edit(worker: WorkerView) {
    this.#editingWorker = worker;
    this.requestUpdate();
    await this.updateComplete;
    const form = this.querySelector<HTMLFormElement>("[data-worker-form]");
    form?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    form?.querySelector<HTMLInputElement>("input[name=name]")?.focus({ preventScroll: true });
  }

  #renderWorker(worker: WorkerView) {
    const status = STATUS[worker.state];
    const busy = this.#busy.has(worker.id);
    return html`<div class="settings-group" data-worker=${worker.id}>
      <div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">${worker.name}
            <span class="settings-status ${status.kind ? `settings-status--${status.kind}` : ""}" data-worker-state=${worker.state}><span class="settings-status__dot" aria-hidden="true"></span>${status.label}</span></span>
          <span class="settings-row__desc"><code>${worker.command}</code></span>
          ${worker.host ? html`<span class="settings-row__desc" data-worker-host>${worker.host.hostname} · ${worker.host.platform}/${worker.host.arch} · Node ${worker.host.node} · home ${worker.host.home}</span>` : nothing}
        </div>
        <div class="settings-row__control jira-settings__actions">
          ${worker.state === "connected"
            ? html`<button type="button" class="btn btn--sm" ?disabled=${busy} @click=${() => void this.#act(worker.id, () => workerAction(worker.id, "sync"), "Sync started.")}>Sync now</button>
              <button type="button" class="btn btn--sm" ?disabled=${busy} @click=${() => void this.#act(worker.id, () => workerAction(worker.id, "disconnect"))}>Disconnect</button>`
            : html`<button type="button" class="btn btn--sm primary" ?disabled=${busy || worker.state === "connecting"} @click=${() => void this.#act(worker.id, () => workerAction(worker.id, "connect"))}>Connect</button>`}
          <button type="button" class="btn btn--sm" @click=${() => void this.#edit(worker)}>Edit</button>
          <button type="button" class="btn btn--sm" ?disabled=${busy} @click=${() => {
            if (confirm(`Remove ${worker.name}? Sessions on it must be deleted first; nothing on the remote is deleted.`)) void this.#act(worker.id, () => removeWorker(worker.id));
          }}>Remove</button>
        </div>
      </div>
      ${worker.state === "connecting" ? html`<div class="settings-row"><div class="settings-row__text"><span class="settings-row__desc" role="status">${worker.phase ?? "Connecting"}…</span></div></div>` : nothing}
      ${worker.state === "error" && worker.error ? html`<div class="settings-row"><div class="settings-row__text"><span class="settings-row__desc" role="alert" data-worker-error>${worker.error}</span></div></div>` : nothing}
      ${worker.sync ? html`<div class="settings-row"><div class="settings-row__text">
        <span class="settings-row__title">Configuration</span>
        <span class="settings-row__desc" data-worker-sync>Synced ${worker.sync.files} files (${worker.sync.uploaded} sent${worker.sync.deleted ? `, ${worker.sync.deleted} removed` : ""}) at ${new Date(worker.sync.at).toLocaleTimeString()}${worker.sync.installed.length ? ` · installed ${worker.sync.installed.join(", ")}` : ""}${worker.sync.skipped.length ? ` · skipped ${worker.sync.skipped.join("; ")}` : ""}${worker.sync.errors.length ? ` · ${worker.sync.errors.join("; ")}` : ""}</span>
      </div></div>` : nothing}
      ${worker.extraPaths.length ? html`<div class="settings-row"><div class="settings-row__text"><span class="settings-row__title">Extra paths</span><span class="settings-row__desc">${worker.extraPaths.join(", ")}</span></div></div>` : nothing}
    </div>`;
  }

  override render() {
    const editing = this.#editingWorker;
    return html`
      <section class="settings-section" data-settings-workers>
        <div class="settings-section__header"><div class="settings-section__copy">
          <h2 class="settings-section__heading">Remote workers</h2>
          <p class="settings-section__desc">Run sessions on another machine. A worker is any command that opens a shell there — <code>ssh devbox</code>, <code>docker exec -i box</code>, <code>kubectl exec -i pod --</code>. HUI installs what it needs under <code>~/.local/share/hui-worker</code>, mirrors your HUI and PI settings, skills and extensions, and lends credentials without writing them to its disk. Sessions keep running there when HUI disconnects, on credentials kept in memory until they expire.</p>
        </div></div>
        ${this.#error ? html`<p class="jira-settings__error" role="alert">${this.#error}</p>` : nothing}
        ${this.#notice ? html`<p class="jira-settings__notice" role="status">${this.#notice}</p>` : nothing}
        ${this.#loading ? nothing : this.#workers.map((worker) => this.#renderWorker(worker))}
        <form class="settings-group" data-worker-form @submit=${(event: SubmitEvent) => this.#saveWorker(event)}>
          <div class="settings-row"><div class="settings-row__text"><span class="settings-row__title">${editing ? `Edit ${editing.name}` : "Add a worker"}</span></div></div>
          <label class="settings-row"><span class="settings-row__text"><span class="settings-row__title">Name</span></span><span class="settings-row__control"><span class="cron-control">
            <input class="settings-input" name="name" required maxlength="60" placeholder="devbox" .value=${editing?.name ?? ""} /></span></span></label>
          <label class="settings-row"><span class="settings-row__text"><span class="settings-row__title">Connect command</span><span class="settings-row__desc">Must work without a password prompt.</span></span><span class="settings-row__control"><span class="cron-control">
            <input class="settings-input" name="command" required spellcheck="false" placeholder="ssh devbox" .value=${editing?.command ?? ""} /></span></span></label>
          <label class="settings-row settings-row--stacked"><span class="settings-row__text"><span class="settings-row__title">Extra paths to mirror</span><span class="settings-row__desc">Optional, one per line: files your extensions read, such as <code>~/.pi/agent/mcp.json</code>.</span></span><span class="settings-row__control"><span class="cron-control">
            <textarea class="settings-input" name="extraPaths" spellcheck="false" .value=${editing?.extraPaths.join("\n") ?? ""}></textarea></span></span></label>
          <div class="automation-actions cron-editor-actions">
            <button type="submit" class="btn primary" ?disabled=${this.#busy.has("add")}>${editing ? "Save worker" : "Add worker"}</button>
            ${editing ? html`<button type="button" class="btn" @click=${() => { this.#editingWorker = undefined; this.requestUpdate(); }}>Cancel</button>` : nothing}
          </div>
        </form>
      </section>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-workers-settings")) customElements.define("hui-workers-settings", HuiWorkersSettings);
