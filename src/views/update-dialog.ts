/**
 * The Update HUI dialog: what the release check found and how an install is going. Checking, installing and the
 * update job itself run in the gateway; the dialog shows the snapshot and sends the operator's choices to the app.
 */
import { html, nothing } from "lit";
import type { UpdateSnapshot } from "../api/schema/updates.ts";

export function renderUpdateDialog(props: {
  open: boolean; checking: boolean; starting: boolean; readOnly: boolean; error: string; reconnecting: boolean;
  snapshot: UpdateSnapshot | null; onCheck(): void; onInstall(): void; onClose(): void; onReload(): void;
}) {
  if (!props.open) return nothing;
  const { check, job, currentVersion } = props.snapshot ?? { check: null, job: null, currentVersion: null };
  const running = job?.status === "running" || props.starting;
  const installedLatest = job?.status === "succeeded" && job.version === check?.latest?.version && job.version === currentVersion;
  return html`<dialog class="hui-modal-dialog hui-update-dialog" aria-labelledby="hui-update-title"
    @cancel=${(event: Event) => { event.preventDefault(); props.onClose(); }}>
    <section class="exec-approval-card">
      <h2 class="exec-approval-title" id="hui-update-title">Update HUI</h2>
      <div class="exec-approval-sub">${currentVersion ? `Installed version ${currentVersion}` : "HUI gateway"}</div>
      <div class="hui-update-status" role="status" aria-live="polite">
        ${props.checking ? html`<p>Checking GitHub Releases…</p>` : nothing}
        ${props.reconnecting ? html`<p>Reconnecting to the gateway…</p>` : nothing}
        ${job ? html`<p>${job.message}</p>` : nothing}
        ${check && !running ? html`
          ${check.latest ? html`<p>Latest stable: <a href=${check.latest.url} target="_blank" rel="noopener noreferrer">${check.latest.version}</a></p>` : nothing}
          <p>${check.message}</p>` : nothing}
      </div>
      ${props.error ? html`<p class="group-action-dialog__error" role="alert">${props.error}</p>` : nothing}
      ${check?.canInstall && !props.readOnly && !running && !installedLatest ? html`<p class="exec-approval-sub">Updating restarts the gateway. Active sessions must finish first. Your settings and chat history are kept.</p>` : nothing}
      ${props.readOnly ? html`<p class="exec-approval-sub">Check only. Run /update to install an available release.</p>` : nothing}
      <p class="exec-approval-sub">This operation is kept in the HUI update session. If it fails, close this dialog and resend /update to retry.</p>
      <div class="exec-approval-actions">
        ${job?.status === "succeeded" && job.version === currentVersion ? html`<button class="btn primary" @click=${props.onReload}>Reload HUI</button>` : nothing}
        ${check?.canInstall && !props.readOnly && !installedLatest ? html`<button class="btn primary" ?disabled=${running || props.checking} @click=${props.onInstall}>${running ? "Updating…" : `Update to ${check.latest?.version}`}</button>` : nothing}
        <button class="btn" ?disabled=${props.checking || running} @click=${props.onCheck}>Check again</button>
        <button class="btn" autofocus @click=${props.onClose}>Close</button>
      </div>
    </section>
  </dialog>`;
}
