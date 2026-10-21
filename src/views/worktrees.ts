/*
 * Presentation adapted from the OpenClaw Control UI v2026.9.5 sessions table.
 * Copyright (c) 2026 OpenClaw Foundation, used under the MIT License.
 * HUI owns the worktree inventory and every removal.
 */
import { html, nothing, type TemplateResult } from "lit";

import { pullRequestAccessibleLabel } from "../lib/pull-requests.ts";
import { pullRequestStateIcon } from "../components/pull-request-hovercard.ts";
import { icons } from "../lib/icons.ts";
import { navigationPath } from "../lib/navigation.ts";
import {
  formatBytes,
  isMergedCleanupCandidate,
  type WorktreeInventory,
  type WorktreeRemovalResult,
  type WorktreeRisk,
  type WorktreeRow,
} from "../lib/worktrees.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/openclaw-workspaces.css"));

export type WorktreeFilter = "all" | "hui" | "merged";

export type WorktreesPageProps = {
  inventory: WorktreeInventory | undefined;
  loading: boolean;
  error: string;
  query: string;
  filter: WorktreeFilter;
  /** A worktree path awaiting confirmation, or `merged` for the bulk cleanup. */
  confirm: string;
  /** Paths this browser asked to remove and is still waiting on. */
  removing: ReadonlySet<string>;
  /** Sizes of every path sent for removal since the queue was last empty. */
  removalSizes: ReadonlyMap<string, number>;
  results: readonly WorktreeRemovalResult[];
  onQuery: (value: string) => void;
  onFilter: (filter: WorktreeFilter) => void;
  onRefresh: () => void;
  onOpenSession: (id: string) => void;
  onRequestRemove: (path: string) => void;
  onRequestCleanup: () => void;
  onCancel: () => void;
  onDismissResults: () => void;
  onCopyPath: (path: string, trigger: HTMLElement) => void;
  onConfirmRemove: (path: string, acknowledged: readonly WorktreeRisk[]) => void;
  onConfirmCleanup: (paths: readonly string[]) => void;
};

export function matchingWorktrees(
  rows: readonly WorktreeRow[],
  query: string,
  filter: WorktreeFilter,
): WorktreeRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) =>
    (filter === "all" || (filter === "hui" ? row.managed : row.merged)) &&
    (!needle || `${row.branch} ${row.path} ${row.sessions.map((s) => s.title).join(" ")} ${
      row.pullRequests?.map((pr) => `#${pr.number} ${pr.title ?? ""}`).join(" ") ?? ""
    }`.toLocaleLowerCase().includes(needle)));
}

function label(row: WorktreeRow): string {
  return row.branch || row.displayPath;
}

function branchIcon(): TemplateResult {
  return html`${icons.gitBranch}`;
}

function emptyRow(message: string, description: string, kind: "status" | "alert") {
  return html`<tr>
    <td colspan="6" class="data-table-empty-cell">
      <div class="data-table-empty-state" role=${kind}>
        <div class="data-table-empty-state__message">${branchIcon()}<span>${message}</span></div>
        <p>${description}</p>
      </div>
    </td>
  </tr>`;
}

function pending(row: WorktreeRow, fact: "pullRequests" | "dirty" | "bytes", label: string) {
  return row.unavailable?.includes(fact)
    ? html`<span class="muted worktree-unavailable" tabindex="0" data-hui-tooltip=${`${label} could not be read`}>Unavailable</span>`
    : html`<span class="muted worktree-pending" data-hui-tooltip=${`${label} is being computed`}>…</span>`;
}

function renderSessions(props: WorktreesPageProps, row: WorktreeRow) {
  if (row.sessions.length === 0) return html`<span class="muted">No session</span>`;
  return html`<span class="worktree-sessions">${row.sessions.map((session) => html`<a
    href=${navigationPath({ kind: "session", id: session.id })}
    class="session-link worktree-session-link"
    data-hui-tooltip=${session.title}
    @click=${(event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      props.onOpenSession(session.id);
    }}
  >${session.title}${session.archived ? html` <span class="session-label-chip">Archived</span>` : nothing}</a>`)}</span>`;
}

function renderPullRequests(row: WorktreeRow) {
  if (!row.branch) return html`<span class="muted">—</span>`;
  if (!row.pullRequests) return pending(row, "pullRequests", "Pull request state");
  if (row.pullRequests.length === 0) return html`<span class="muted">None</span>`;
  return html`<span class="worktree-prs">${row.pullRequests.map((pr) => html`<a
    class="session-pr-badge worktree-pr"
    data-state=${pr.state ?? "unknown"}
    href=${pr.url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label=${pullRequestAccessibleLabel(pr)}
    .pullRequest=${pr}
  ><span aria-hidden="true">${pullRequestStateIcon(pr.state)}</span><span class="worktree-pr__number">#${pr.number}</span></a>`)}</span>`;
}

function renderChanges(row: WorktreeRow) {
  if (row.dirty === undefined) return pending(row, "dirty", "Local change state");
  return html`<span class="settings-status ${row.dirty ? "settings-status--warn" : ""}">
    <span class="settings-status__dot" aria-hidden="true"></span><span>${row.dirty ? "changes" : "clean"}</span>
  </span>`;
}

const RISK_COPY: Record<WorktreeRisk, { label: string; detail: string }> = {
  dirty: { label: "Has changes", detail: "It has uncommitted or untracked files. They will be permanently deleted." },
  unknown: { label: "Changes unknown", detail: "HUI could not read its local changes. Any uncommitted files will be permanently deleted." },
  locked: { label: "Locked", detail: "Git has it locked, usually by another tool. The lock will be overridden." },
  running: { label: "Running", detail: "A session in this worktree is running. HUI will stop it first." },
  missing: { label: "Missing", detail: "Its directory no longer exists. Only Git's record of it is removed." },
  external: { label: "External", detail: "HUI did not create it. Make sure no other tool still uses it." },
};

/** The riskiest fact about a row, shown as a hint next to its remove button. */
function riskHint(row: WorktreeRow) {
  const risk = row.risks.find((item) => item !== "external");
  return risk ? html`<span class="worktree-risk" data-risk=${risk}>${RISK_COPY[risk].label}</span>` : nothing;
}

/** The server knows which removal runs; a request it has not started is queued. */
function removalState(props: Pick<WorktreesPageProps, "removing">, row: WorktreeRow): WorktreeRow["removal"] {
  return row.removal ?? (props.removing.has(row.path) ? "queued" : undefined);
}

function renderActions(props: WorktreesPageProps, row: WorktreeRow) {
  const removal = removalState(props, row);
  if (removal) {
    return html`<span class="worktree-actions worktree-removal" data-removal=${removal}>
      ${removal === "removing"
        ? html`<span class="session-run-spinner" aria-hidden="true" data-hui-tooltip="Removing…"></span><span class="sr-only">Removing…</span>`
        : "Queued"}
    </span>`;
  }
  return html`<span class="worktree-actions">
    ${riskHint(row)}
    <button type="button" class="btn btn--sm"
      data-hui-tooltip="Remove this worktree"
      aria-label=${`Remove ${label(row)}`}
      @click=${() => props.onRequestRemove(row.path)}>${icons.trash}</button>
  </span>`;
}

function branchNote(row: WorktreeRow): string {
  if (!row.branch) return "It has no branch; nothing else is deleted.";
  return row.merged
    ? `Branch ${row.branch} is deleted too if its merged pull request matches the current commit; otherwise it is kept.`
    : `Branch ${row.branch} is kept.`;
}

/** The "are you sure?" modal for one worktree, listing everything it will do. */
export function renderRemoveDialog(props: WorktreesPageProps): TemplateResult | typeof nothing {
  const row = props.inventory?.worktrees.find((item) => item.path === props.confirm);
  if (!row) return nothing;
  const destructive = row.risks.includes("dirty") || row.risks.includes("unknown");
  return html`<dialog
    class="hui-modal-dialog worktree-remove-dialog"
    aria-labelledby="worktree-remove-title"
    @cancel=${(event: Event) => { event.preventDefault(); props.onCancel(); }}
    @keydown=${(event: KeyboardEvent) => {
      // HUI's document-level Escape handler would otherwise swallow the key.
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onCancel();
      }
    }}
  >
    <div class="exec-approval-card">
      <div class="exec-approval-header"><div>
        <div class="exec-approval-title" id="worktree-remove-title">Remove ${label(row)}?</div>
        <div class="exec-approval-sub mono worktree-remove-dialog__path">${row.path}</div>
      </div></div>
      ${row.risks.length ? html`<ul class="worktree-remove-dialog__risks">
        ${row.risks.map((risk) => html`<li data-risk=${risk}><strong>${RISK_COPY[risk].label}.</strong> ${RISK_COPY[risk].detail}</li>`)}
      </ul>` : nothing}
      <p class="exec-approval-sub">${row.sessions.length
        ? `${row.sessions.length === 1 ? "Its session stays" : "Its sessions stay"} in HUI but will point at a missing directory. `
        : ""}${branchNote(row)}</p>
      <div class="exec-approval-actions">
        <button type="button" class="btn danger"
          @click=${() => props.onConfirmRemove(row.path, row.risks)}>${destructive ? "Delete worktree and changes" : "Remove worktree"}</button>
        <button type="button" class="btn worktree-remove-cancel" autofocus @click=${props.onCancel}>Cancel</button>
      </div>
    </div>
  </dialog>`;
}

function body(props: WorktreesPageProps): TemplateResult {
  if (props.loading && !props.inventory) return emptyRow("Loading worktrees…", "Reading Git worktrees for registered repositories.", "status");
  if (props.error && !props.inventory) return emptyRow(props.error, "The worktree inventory could not be loaded.", "alert");
  const rows = matchingWorktrees(props.inventory?.worktrees ?? [], props.query, props.filter);
  if (rows.length === 0) {
    return emptyRow(
      props.query.trim() || props.filter !== "all" ? "No matching worktrees" : "No worktrees yet",
      props.query.trim() || props.filter !== "all"
        ? "Try another branch, path, session or filter."
        : "Create one from New Session with the New worktree option.",
      "status",
    );
  }
  return html`${rows.map((row) => html`
    <tr class="session-data-row worktree-row" data-worktree-path=${row.path} data-removal=${removalState(props, row) ?? nothing}>
      <td class="data-table-key-col">
        <div class="session-key-cell">
          <span class="session-avatar session-avatar--direct" aria-hidden="true">${branchIcon()}</span>
          <span class="session-key-cell__text">
            <span class="session-key-cell__primary">
              <span class="worktree-branch">${row.branch || (row.detached ? `Detached ${row.head.slice(0, 8)}` : "Worktree")}</span>
              ${!row.managed ? html`<span class="session-label-chip worktree-origin-chip" data-hui-tooltip="Created outside HUI, by hand or by another tool">External</span>` : nothing}
            </span>
            <span class="worktree-path">
              <span class="muted session-key-display-name worktree-path__text" data-hui-tooltip=${row.path}><bdi dir="ltr">${row.displayPath}</bdi></span>
              <button type="button" class="worktree-path__copy" aria-label=${`Copy path of ${label(row)}`} data-hui-tooltip="Copy full path"
                @click=${(event: Event) => props.onCopyPath(row.path, event.currentTarget as HTMLElement)}>${icons.copy}</button>
            </span>
          </span>
        </div>
      </td>
      <td class="worktree-sessions-col">${renderSessions(props, row)}</td>
      <td>${renderPullRequests(row)}</td>
      <td class="session-status-col">${renderChanges(row)}</td>
      <td class="worktree-size">${row.bytes === undefined ? pending(row, "bytes", "Disk usage") : formatBytes(row.bytes)}</td>
      <td class="session-actions-cell">${renderActions(props, row)}</td>
    </tr>
  `)}`;
}

function renderCleanupConfirm(props: WorktreesPageProps, candidates: readonly WorktreeRow[]) {
  const bytes = candidates.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  return html`<div class="settings-group worktree-cleanup" role="region" aria-label="Confirm merged cleanup">
    <div class="worktree-cleanup__copy">
      <strong>Remove ${candidates.length} merged worktree${candidates.length === 1 ? "" : "s"}?</strong>
      <span class="muted">Frees about ${formatBytes(bytes)}. Only worktrees HUI created with a merged pull request, no active session and no local changes; nothing is forced. Their local branches are deleted when the merged head matches. Remove any other worktree from its row.</span>
      <ul class="worktree-cleanup__list">
        ${candidates.map((row) => html`<li><span class="mono">${row.branch}</span> <span class="muted">${formatBytes(row.bytes)}</span></li>`)}
      </ul>
    </div>
    <div class="worktree-cleanup__actions">
      <button type="button" class="btn btn--sm" @click=${props.onCancel}>Cancel</button>
      <button type="button" class="btn btn--sm danger"
        @click=${() => props.onConfirmCleanup(candidates.map((row) => row.path))}>Remove ${candidates.length}</button>
    </div>
  </div>`;
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Share of the bytes sent for removal that are gone: finished rows count in
 * full, the one Git is deleting by what is left of it, queued ones not yet.
 * Undefined while no size is known. */
export function removalProgress(props: Pick<WorktreesPageProps, "removing" | "removalSizes">, rows: readonly WorktreeRow[]): number | undefined {
  // A reload forgets this browser's requests; the gateway still reports its own.
  const sizes = new Map(props.removalSizes);
  for (const row of rows) if (row.removal) sizes.set(row.path, row.bytes ?? sizes.get(row.path) ?? 0);
  let total = 0;
  let done = 0;
  for (const [path, size] of sizes) {
    const row = rows.find((item) => item.path === path);
    const state = row && removalState(props, row);
    total += size;
    if (!state) done += size;
    else if (state === "removing" && row.remainingBytes !== undefined) done += Math.max(0, size - row.remainingBytes);
  }
  return total > 0 ? Math.min(done / total, 1) : undefined;
}

/** Git deletes a large checkout file by file, which can take minutes; say what
 * is happening while the rest of the page stays usable. */
function renderProgress(props: WorktreesPageProps, rows: readonly WorktreeRow[]) {
  const pending = rows.filter((row) => removalState(props, row));
  if (pending.length === 0) return nothing;
  // Between two requests nothing is removing for a moment; keep the line.
  const current = pending.find((row) => removalState(props, row) === "removing");
  const queued = pending.length - 1;
  const progress = removalProgress(props, rows);
  // Floor, so it never says 100% while Git is still deleting. The first
  // measurement of a huge tree takes a while; a 0% bar would look stuck.
  const percent = progress === undefined ? 0 : Math.floor(progress * 100);
  return html`<div class="callout worktree-progress">
    <span class="session-run-spinner" aria-hidden="true"></span>
    <span role="status">${current
      ? html`Removing <span class="mono">${label(current)}</span>${current.bytes === undefined ? "" : ` (${formatBytes(current.bytes)})`}…`
      : "Starting the next removal…"}${queued ? ` ${queued} more queued.` : ""} Large worktrees can take a few minutes; you can keep using HUI.</span>
    ${percent > 0 ? html`<span class="worktree-progress__percent">
      <progress max="100" value=${percent} aria-label="Worktree removal progress"></progress>${percent}%
    </span>` : nothing}
  </div>`;
}

function renderResults(props: WorktreesPageProps) {
  const results = props.results;
  if (results.length === 0) return nothing;
  const removed = results.filter((result) => result.removed);
  const branches = removed.filter((result) => result.branchDeleted).length;
  const failed = results.filter((result) => !result.removed);
  const notes = removed.filter((result) => result.error);
  return html`<div class="callout ${failed.length || notes.length ? "warning" : ""} worktree-results" role=${failed.length ? "alert" : "status"}>
    <div class="worktree-results__body">
      ${removed.length ? html`<p><strong>Removed ${plural(removed.length, "worktree")}</strong>${branches ? ` and deleted ${plural(branches, "merged branch", "merged branches")}` : ""}.</p>` : nothing}
      ${failed.length ? html`<p><strong>Couldn't remove ${plural(failed.length, "worktree")}.</strong> Nothing was deleted from ${failed.length === 1 ? "it" : "them"}.</p>` : nothing}
      ${failed.length || notes.length ? html`<ul class="worktree-results__list">
        ${[...failed, ...notes].map((result) => html`<li><span class="mono" data-hui-tooltip=${result.path}>${result.label}</span>: ${result.error ?? "not removed"}</li>`)}
      </ul>` : nothing}
    </div>
    <button type="button" class="btn btn--sm" aria-label="Dismiss" @click=${props.onDismissResults}>${icons.close}</button>
  </div>`;
}

export function renderWorktreesPage(props: WorktreesPageProps): TemplateResult {
  const rows = props.inventory?.worktrees ?? [];
  const candidates = rows.filter((row) => isMergedCleanupCandidate(row) && !removalState(props, row));
  const managed = rows.filter((row) => row.managed).length;
  return html`
    <p class="settings-page__intro">Linked worktrees of the Git repositories your HUI sessions use, plus those New Session created in ~/.config/hui/worktrees. Main checkouts are not listed.</p>
          <section class="settings-section worktrees-section">
            <div class="settings-section__header">
              <div class="settings-section__copy">
                <h2 class="settings-section__heading">
                  Worktrees <span class="settings-count">${rows.length}</span>
                  <span class="sessions-heading-facts">
                    <span class="sessions-heading-fact"><strong>${managed}</strong> HUI</span>
                    <span class="sessions-heading-fact__separator" aria-hidden="true">·</span>
                    <span class="sessions-heading-fact"><strong>${candidates.length}</strong> Ready to clean</span>
                  </span>
                </h2>
              </div>
              <div class="settings-section__actions">
                <button type="button" class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>${icons.refresh} Refresh</button>
                <span class="worktree-tooltip-wrap" data-hui-tooltip=${candidates.length ? "Remove HUI worktrees with a merged PR, no active session and no local changes" : "No HUI worktree has a merged PR, no active session and no local changes"}>
                  <button type="button" class="btn btn--sm" data-worktree-cleanup
                    ?disabled=${candidates.length === 0}
                    @click=${props.onRequestCleanup}>${icons.trash} Clean up merged${candidates.length ? ` (${candidates.length})` : ""}</button>
                </span>
              </div>
            </div>
            ${props.confirm === "merged" && candidates.length ? renderCleanupConfirm(props, candidates) : nothing}
            ${renderProgress(props, rows)}
            ${renderResults(props)}
            ${renderRemoveDialog(props)}
            ${props.error && props.inventory ? html`<div class="callout warning" role="alert">${props.error}</div>` : nothing}
            ${props.inventory?.diagnostics.map((note) => html`<div class="callout warning">${note}</div>`)}
            <div class="settings-group">
              <div class="sessions-toolbar sessions-filter-bar" aria-label="Worktree filters">
                <label class="data-table-search sessions-toolbar__search">
                  ${icons.search}
                  <input type="search" aria-label="Filter worktrees" placeholder="Filter by branch, path, session, PR…"
                    .value=${props.query} @input=${(event: Event) => props.onQuery((event.target as HTMLInputElement).value)} />
                </label>
                <div class="settings-segmented sessions-view-segment" role="group" aria-label="Worktree scope">
                  ${([["all", "All"], ["hui", "HUI"], ["merged", "Merged"]] as const).map(([filter, label]) => html`
                    <button type="button" class="settings-segmented__btn ${props.filter === filter ? "settings-segmented__btn--active" : ""}"
                      aria-pressed=${String(props.filter === filter)} @click=${() => props.onFilter(filter)}>${label}</button>
                  `)}
                </div>
              </div>
              <div class="data-table-container">
                <table class="data-table sessions-table worktrees-table">
                  <thead>
                    <tr>
                      <th class="data-table-key-col">Worktree</th>
                      <th class="worktree-sessions-col">Session</th>
                      <th>Pull requests</th>
                      <th class="session-status-col">Changes</th>
                      <th>Size</th>
                      <th class="session-actions-col"><span class="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>${body(props)}</tbody>
                </table>
              </div>
            </div>
          </section>
  `;
}
