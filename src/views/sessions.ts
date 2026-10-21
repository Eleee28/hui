/*
 * Presentation adapted from OpenClaw Control UI v2026.9.5.
 * Copyright (c) 2026 OpenClaw Foundation, used under the MIT License.
 * HUI retains ownership of session data and actions.
 */
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../lib/icons.ts";
import { navigationPath } from "../lib/navigation.ts";
import { type SessionGroup, type SessionSearchResult, type SessionStatus, type SessionView } from "../api/sessions.ts";
import { sessionGroupLabel } from "../lib/session/sessions.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/openclaw-workspaces.css"));

export type SessionsPageState = "all" | "active" | "archived";

/** Browser-only reading options for the Sessions table; the registry is unchanged. */
export type SessionsPageFilters = {
  status: "all" | Exclude<SessionStatus, "starting">;
  groupBy: "none" | "group" | "project";
};

export const DEFAULT_SESSIONS_PAGE_FILTERS: Readonly<SessionsPageFilters> = { status: "all", groupBy: "none" };

const STATE_OPTIONS = [["all", "All"], ["active", "Active"], ["archived", "Archived"]] as const;
const STATUS_OPTIONS = [["all", "Any"], ["running", "Running"], ["waiting", "Waiting"], ["idle", "Idle"], ["error", "Error"], ["reconnecting", "Reconnecting"], ["disconnected", "Disconnected"]] as const;
const GROUP_OPTIONS = [["none", "None"], ["group", "Group"], ["project", "Project"]] as const;

/** The transcript search box and the outcome of the last search it ran. */
export type TranscriptSearchState = {
  query: string;
  searching: boolean;
  /** The query the shown result or error belongs to. */
  searched: string;
  result?: SessionSearchResult;
  error?: string;
};

export type SessionsPageProps = {
  groups: readonly SessionGroup[];
  loading: boolean;
  error: string;
  query: string;
  state: SessionsPageState;
  filters: SessionsPageFilters;
  onQuery: (value: string) => void;
  onState: (state: SessionsPageState) => void;
  onFilters: (filters: SessionsPageFilters) => void;
  onOpen: (session: SessionView) => void;
  onRestore: (session: SessionView) => void;
  onCopyPath: (path: string, trigger: HTMLElement) => void;
  onNew: () => void;
  onRefresh: () => void;
  /** Checked rows; only the visible ones are acted on. */
  selected: ReadonlySet<string>;
  onSelect: (ids: readonly string[], checked: boolean) => void;
  confirmingDelete: boolean;
  deleting: boolean;
  /** Outcome of the last bulk delete. */
  onDeleteSelected: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: (ids: readonly string[], removeWorktrees: boolean) => void;
  transcriptSearch: TranscriptSearchState;
  onTranscriptQuery: (value: string) => void;
  onTranscriptSearch: () => void;
};

/** Starting sessions are about to run, so the Running filter includes them. */
function statusMatches(session: SessionView, status: SessionsPageFilters["status"]): boolean {
  if (status === "all") return true;
  return status === "running" ? session.status === "running" || session.status === "starting" : session.status === status;
}

export function matchingSessions(
  groups: readonly SessionGroup[],
  query: string,
  state: SessionsPageState = "all",
  status: SessionsPageFilters["status"] = "all",
): Array<{ group: string; session: SessionView }> {
  const needle = query.trim().toLocaleLowerCase();
  return groups.flatMap((group) =>
    group.sessions
      .filter((session) =>
        (state === "all" || Boolean(session.archived) === (state === "archived")) &&
        statusMatches(session, status) &&
        (!needle || `${session.title} ${session.cwd} ${session.tool} ${group.label} ${sessionGroupLabel(group.label)}`
          .toLocaleLowerCase()
          .includes(needle)),
      )
      .map((session) => ({ group: group.label, session })),
  );
}

export type SessionRowGroup = {
  key: string;
  label: string;
  title?: string;
  rows: Array<{ group: string; session: SessionView }>;
};

/** Table sections in first-seen order, or undefined for a flat table. */
export function groupSessionRows(
  rows: ReadonlyArray<{ group: string; session: SessionView }>,
  groupBy: SessionsPageFilters["groupBy"],
): SessionRowGroup[] | undefined {
  if (groupBy === "none") return undefined;
  const sections = new Map<string, SessionRowGroup>();
  for (const row of rows) {
    const key = groupBy === "group" ? row.group : row.session.cwd;
    let section = sections.get(key);
    if (!section) {
      section = groupBy === "group"
        ? { key, label: sessionGroupLabel(key), rows: [] }
        : { key, label: key.split("/").filter(Boolean).at(-1) || key || "No directory", title: key, rows: [] };
      sections.set(key, section);
    }
    section.rows.push(row);
  }
  return [...sections.values()];
}

function searchIcon(): TemplateResult {
  return html`${icons.search}`;
}

function messageIcon(): TemplateResult {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
  </svg>`;
}

export function formatUpdated(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const difference = timestamp - Date.now();
  const seconds = Math.round(Math.abs(difference) / 1000);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  if (seconds < 60 && difference <= 0) return "just now";
  const [amount, unit] = seconds < 60
    ? [seconds, "second"] as const
    : minutes < 60
      ? [minutes, "minute"] as const
      : hours < 48
        ? [hours, "hour"] as const
        : [Math.round(hours / 24), "day"] as const;
  return new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" })
    .format(difference <= 0 ? -amount : amount, unit);
}

function emptyRow(message: string, description: string, kind: "status" | "alert") {
  return html`<tr>
    <td colspan="8" class="data-table-empty-cell">
      <div class="data-table-empty-state" role=${kind}>
        <div class="data-table-empty-state__message">
          ${messageIcon()}<span>${message}</span>
        </div>
        <p>${description}</p>
      </div>
    </td>
  </tr>`;
}

export function formatRuntimeMemory(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const mib = bytes / (1024 * 1024);
  return mib < 10 ? `${mib.toFixed(1)} MB` : `${Math.round(mib)} MB`;
}

export function formatBootDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function sessionRow(session: SessionView, props: SessionsPageProps): TemplateResult {
  return html`
      <tr class="session-data-row ${session.archived ? "session-data-row--archived" : ""}" data-session-id=${session.id}>
        <td class="data-table-checkbox-col">
          <input type="checkbox" aria-label=${`Select ${session.title}`} .checked=${props.selected.has(session.id)}
            @change=${(event: Event) => props.onSelect([session.id], (event.target as HTMLInputElement).checked)} />
        </td>
        <td class="data-table-key-col">
          <div class="session-key-cell">
            <span class="session-avatar session-avatar--direct" aria-hidden="true">
              ${session.icon || messageIcon()}
              ${session.status === "running" || session.status === "starting" ? html`<span class="session-avatar__status"></span>` : nothing}
            </span>
            <span class="session-key-cell__text">
              <span class="session-key-cell__primary">
                <a
                  href=${navigationPath({ kind: "session", id: session.id })}
                  class="session-link"
                  @click=${(event: MouseEvent) => {
                    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    props.onOpen(session);
                  }}
                >${session.title}</a>
                ${session.pinned
                  ? html`<span class="session-label-chip">Pinned</span>`
                  : nothing}
                ${session.unread ? html`<span class="session-label-chip">Unread</span>` : nothing}
                ${session.archived ? html`<span class="session-label-chip">Archived</span>` : nothing}
              </span>
              ${session.cwd ? html`<span class="worktree-path">
                <span class="muted session-key-display-name worktree-path__text" data-hui-tooltip=${session.cwd}><bdi dir="ltr">${session.displayCwd || session.cwd}</bdi></span>
                <button type="button" class="worktree-path__copy" aria-label=${`Copy path of ${session.title}`} data-hui-tooltip="Copy full path"
                  @click=${(event: Event) => props.onCopyPath(session.cwd, event.currentTarget as HTMLElement)}>${icons.copy}</button>
              </span>` : nothing}
            </span>
          </div>
        </td>
        <td class="session-runtime-col">
          <span class="session-runtime-name">${session.tool}</span>
          <span class="session-runtime-state">${session.runtime ? "Active" : "Cold"}</span>
        </td>
        <td class="session-status-col">
          <div class="session-status-stack">
            <span class="settings-status ${session.status === "error" ? "settings-status--danger" : session.status === "waiting" ? "settings-status--warn" : session.status === "running" || session.status === "starting" ? "settings-status--ok" : ""}">
              <span class="settings-status__dot"></span>
              <span>${session.archived ? "archived" : session.status}</span>
            </span>
          </div>
        </td>
        <td title=${session.updatedAt}>${formatUpdated(session.updatedAt)}</td>
        <td class="session-memory-cell" title=${session.runtime?.memoryBytes === undefined
          ? session.runtime ? "Runtime memory is not available on this host yet" : "The runtime is not loaded"
          : "Resident memory for the runtime process tree"}>${session.runtime
            ? formatRuntimeMemory(session.runtime.memoryBytes)
            : "—"}</td>
        <td class="session-startup-cell" title="Time from runtime launch until the session became ready">${session.status === "starting"
          ? "Measuring…"
          : session.runtime?.bootDurationMs !== undefined
            ? formatBootDuration(session.runtime.bootDurationMs)
            : "—"}</td>
        <td class="session-actions-cell">
          ${session.archived
            ? html`<button type="button" class="btn btn--sm" aria-label=${`Restore ${session.title}`} @click=${() => props.onRestore(session)}>Restore</button>`
            : html`<button type="button" class="btn btn--sm" aria-label=${`Open ${session.title}`} @click=${() => props.onOpen(session)}>Open</button>`}
        </td>
      </tr>
    `;
}

function groupRow(section: SessionRowGroup): TemplateResult {
  return html`<tr class="session-group-row" data-group-key=${section.key}>
    <td colspan="8">
      <div class="session-group-row__header">
        <span class="session-group-row__icon" aria-hidden="true">${icons.folder}</span>
        <span class="session-group-row__label" title=${section.title ?? nothing}>${section.label}</span>
        <span class="session-group-row__count">${section.rows.length === 1 ? "1 session" : `${section.rows.length} sessions`}</span>
      </div>
    </td>
  </tr>`;
}

function visibleRows(props: SessionsPageProps) {
  return props.loading || props.error ? [] : matchingSessions(props.groups, props.query, props.state, props.filters.status);
}

function deleteDialog(props: SessionsPageProps, ids: readonly string[]): TemplateResult | typeof nothing {
  if (!props.confirmingDelete) return nothing;
  const count = ids.length === 1 ? "1 session" : `${ids.length} sessions`;
  return html`<dialog class="hui-modal-dialog sessions-delete-dialog" aria-labelledby="sessions-delete-title"
    @cancel=${(event: Event) => { event.preventDefault(); props.onCancelDelete(); }}
    @keydown=${(event: KeyboardEvent) => {
      // HUI's document-level Escape handler would otherwise swallow the key.
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancelDelete(); }
    }}>
    <form class="exec-approval-card" method="dialog" @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      props.onConfirmDelete(ids, new FormData(event.currentTarget as HTMLFormElement).has("worktrees"));
    }}>
      <div class="exec-approval-title" id="sessions-delete-title">Delete ${count} from HUI?</div>
      <div class="exec-approval-sub">HUI will remove ${ids.length === 1 ? "this session" : "these sessions"} and all their subagents, and stop their runtimes. Their PI transcripts remain on disk and are not deleted.</div>
      <label class="sessions-delete-dialog__option">
        <input type="checkbox" name="worktrees" ?disabled=${props.deleting} />
        <span>Also remove their worktrees
          <small class="exec-approval-sub">Only HUI-created worktrees without local changes and not used by another session. Others are kept.</small></span>
      </label>
      <div class="exec-approval-actions">
        <button type="submit" class="btn danger" ?disabled=${props.deleting}>${props.deleting ? "Deleting…" : `Delete ${count}`}</button>
        <button type="button" class="btn sessions-delete-cancel" autofocus ?disabled=${props.deleting} @click=${props.onCancelDelete}>Cancel</button>
      </div>
    </form>
  </dialog>`;
}

function body(props: SessionsPageProps): TemplateResult {
  if (props.loading) {
    return emptyRow("Loading sessions…", "Reading the HUI session registry.", "status");
  }
  if (props.error) {
    return emptyRow(props.error, "The registry could not be loaded.", "alert");
  }
  const rows = matchingSessions(props.groups, props.query, props.state, props.filters.status);
  if (rows.length === 0) {
    const filtered = Boolean(props.query.trim()) || props.state !== "all" || props.filters.status !== "all";
    return emptyRow(
      filtered ? "No matching sessions" : "No sessions yet",
      filtered
        ? "Try another search, state or status filter."
        : "Create a PI session to start working.",
      "status",
    );
  }
  const sections = groupSessionRows(rows, props.filters.groupBy);
  return sections
    ? html`${sections.map((section) => html`${groupRow(section)}${section.rows.map(({ session }) => sessionRow(session, props))}`)}`
    : html`${rows.map(({ session }) => sessionRow(session, props))}`;
}

function transcriptResults(props: SessionsPageProps): TemplateResult | typeof nothing {
  const { searched, result, error } = props.transcriptSearch;
  if (error) return html`<p class="sessions-transcript-search__notice sessions-transcript-search__notice--danger" role="alert">${error}</p>`;
  if (!result) return nothing;
  const sessions = new Map(props.groups.flatMap((group) => group.sessions).map((session) => [session.id, session]));
  const hits = result.hits.flatMap((hit) => {
    const session = sessions.get(hit.id);
    return session ? [{ hit, session }] : [];
  }).toSorted((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));
  return html`
    ${hits.length
      ? html`<div class="sessions-transcript-search__summary muted">${hits.length === 1 ? "1 session mentions" : `${hits.length} sessions mention`} “${searched}”</div>
        <div class="sessions-transcript-search__list">
          ${hits.map(({ hit, session }) => html`<button type="button" class="sessions-transcript-search__result" @click=${() => props.onOpen(session)}>
            <span class="sessions-transcript-search__result-header">
              <strong>${session.title}</strong>
              ${session.archived ? html`<span class="session-label-chip">Archived</span>` : nothing}
              <span class="muted">${hit.matches === 1 ? "1 message" : `${hit.matches} messages`}</span>
            </span>
            <span class="sessions-transcript-search__snippet">${hit.snippet}</span>
            ${session.cwd ? html`<span class="sessions-transcript-search__key">${session.displayCwd || session.cwd}</span>` : nothing}
          </button>`)}
        </div>`
      : html`<div class="sessions-transcript-search__empty">No transcript mentions “${searched}”.</div>`}
    ${result.unsearched.map(({ worker, error: reason }) => html`<p class="sessions-transcript-search__notice">Could not search ${worker}: ${reason}</p>`)}`;
}

function transcriptSearch(props: SessionsPageProps): TemplateResult {
  const { query, searching } = props.transcriptSearch;
  const ready = query.trim().length >= 2 && !searching;
  return html`<div class="settings-group sessions-transcript-search">
    <form class="sessions-transcript-search__form" @submit=${(event: Event) => {
      event.preventDefault();
      if (ready) props.onTranscriptSearch();
    }}>
      <label class="data-table-search sessions-transcript-search__input">
        <span class="sr-only">Search transcript messages</span>
        <input type="search" placeholder="Search transcript messages…" maxlength="200" .value=${query}
          @input=${(event: Event) => props.onTranscriptQuery((event.target as HTMLInputElement).value)} />
      </label>
      <button class="btn btn--sm" type="submit" ?disabled=${!ready}>${searching ? "Searching…" : "Search"}</button>
    </form>
    <div class="sessions-transcript-search__status" aria-live="polite">${transcriptResults(props)}</div>
  </div>`;
}

function filterSegment<Value extends string>(
  label: string,
  value: Value,
  options: ReadonlyArray<readonly [Value, string]>,
  onChange: (value: Value) => void,
): TemplateResult {
  return html`<div class="sessions-filter-popover__field">
    <span class="session-groupby__label">${label}</span>
    <div class="settings-segmented sessions-filter-popover__segment" role="group" aria-label=${label}>
      ${options.map(([option, text]) => html`
        <button type="button" class="settings-segmented__btn ${value === option ? "settings-segmented__btn--active" : ""}"
          aria-pressed=${String(value === option)} @click=${() => onChange(option)}>${text}</button>
      `)}
    </div>
  </div>`;
}

function filtersPopover(props: SessionsPageProps): TemplateResult {
  const { filters } = props;
  const changed = filters.status !== DEFAULT_SESSIONS_PAGE_FILTERS.status || filters.groupBy !== DEFAULT_SESSIONS_PAGE_FILTERS.groupBy;
  const setExpanded = (event: Event, open: boolean) =>
    (event.currentTarget as Element).previousElementSibling?.setAttribute("aria-expanded", String(open));
  return html`
    <button id="sessions-filter-popover-trigger" type="button"
      class="btn btn--sm sessions-filter-popover__trigger ${changed ? "active" : ""}"
      data-hui-tooltip="Filters" aria-label=${changed ? "Filters (active)" : "Filters"}
      aria-haspopup="dialog" aria-expanded="false">${icons.filter}</button>
    <wa-popover class="sessions-filter-popover" for="sessions-filter-popover-trigger" placement="bottom-end" without-arrow
      @wa-show=${(event: Event) => setExpanded(event, true)} @wa-hide=${(event: Event) => setExpanded(event, false)}>
      <div class="sessions-filter-popover__panel" role="group" aria-label="Session filters">
        ${filterSegment("Status", filters.status, STATUS_OPTIONS, (status) => props.onFilters({ ...filters, status }))}
        ${filterSegment("Group by", filters.groupBy, GROUP_OPTIONS, (groupBy) => props.onFilters({ ...filters, groupBy }))}
        <button type="button" class="btn btn--sm sessions-filter-popover__reset" ?disabled=${!changed}
          @click=${() => props.onFilters({ ...DEFAULT_SESSIONS_PAGE_FILTERS })}>Reset filters</button>
      </div>
    </wa-popover>
  `;
}

export function renderSessionsPage(props: SessionsPageProps): TemplateResult {
  const allSessions = props.groups.flatMap((group) => group.sessions);
  const sessions = allSessions.filter((session) => !session.archived);
  const active = sessions.filter(
    (session) => session.status === "running" || session.status === "waiting" || session.status === "starting",
  ).length;
  const loaded = allSessions.filter((session) => session.runtime?.active);
  const working = loaded.filter((session) => session.status === "running" || session.status === "waiting" || session.status === "starting").length;
  const measured = loaded.filter((session) => session.runtime?.memoryBytes !== undefined);
  const totalMemory = measured.reduce((total, session) => total + (session.runtime?.memoryBytes ?? 0), 0);
  const startupTimes = loaded.flatMap((session) => session.runtime?.bootDurationMs === undefined ? [] : [session.runtime.bootDurationMs]);
  const averageStartup = startupTimes.length
    ? startupTimes.reduce((total, value) => total + value, 0) / startupTimes.length
    : undefined;
  const visibleIds = visibleRows(props).map(({ session }) => session.id);
  const selectedIds = visibleIds.filter((id) => props.selected.has(id));
  const archivedIds = props.loading || props.error ? [] : matchingSessions(props.groups, props.query, "archived", props.filters.status).map(({ session }) => session.id);
  const heaviest = measured.toSorted((a, b) => (b.runtime?.memoryBytes ?? 0) - (a.runtime?.memoryBytes ?? 0))[0];
  return html`
    <section class="settings-workspace hui-workspace-page sessions-workspace">
      <header class="content-header content-header--settings content-header--page">
        <div><div class="page-title">Sessions</div><div class="page-subtitle">Active sessions and defaults.</div></div>
      </header>
      <div class="settings-workspace__body">
        <div class="settings-page settings-page--wide sessions-page">
          <section class="settings-section">
            <div class="settings-section__header">
              <div class="settings-section__copy">
                <h2 class="settings-section__heading">Search transcripts</h2>
              </div>
            </div>
            ${transcriptSearch(props)}
          </section>
          <section class="settings-section">
            <div class="settings-section__header">
              <div class="settings-section__copy">
                <h2 class="settings-section__heading">
                  Sessions <span class="settings-count">${allSessions.length}</span>
                  <span class="sessions-heading-facts">
                    <span class="sessions-heading-fact sessions-heading-fact--active"
                      ><strong>${active}</strong> Live</span
                    >
                  </span>
                </h2>
              </div>
              <div class="settings-section__actions">
                <button type="button" class="btn btn--sm" @click=${props.onRefresh}>
                  ${icons.refresh} Refresh
                </button>
              </div>
            </div>
            <div class="sessions-runtime-summary" aria-label="Runtime resource summary">
              <div class="sessions-runtime-summary__item">
                <span>Loaded runtimes</span>
                <strong>${loaded.length}</strong>
                <small>${working} working now</small>
              </div>
              <div class="sessions-runtime-summary__item">
                <span>Total memory</span>
                <strong>${measured.length ? formatRuntimeMemory(totalMemory) : "Unavailable"}</strong>
                <small>${measured.length === loaded.length ? "All loaded runtimes" : `${measured.length} of ${loaded.length} measured`}</small>
              </div>
              <div class="sessions-runtime-summary__item">
                <span>Heaviest runtime</span>
                <strong title=${heaviest?.title ?? nothing}>${heaviest?.title ?? "Unavailable"}</strong>
                <small>${heaviest ? formatRuntimeMemory(heaviest.runtime?.memoryBytes) : "No runtime measurement"}</small>
              </div>
              <div class="sessions-runtime-summary__item">
                <span>Average startup</span>
                <strong>${formatBootDuration(averageStartup)}</strong>
                <small>${startupTimes.length ? `${startupTimes.length} ready runtime${startupTimes.length === 1 ? "" : "s"}` : "No ready runtimes"}</small>
              </div>
            </div>
            <div class="settings-group">
              <div class="sessions-toolbar sessions-filter-bar" aria-label="Session filters">
                <label class="data-table-search sessions-toolbar__search">
                  ${searchIcon()}
                  <input
                    type="search"
                    aria-label="Search session registry"
                    placeholder="Filter by key, agent, label, kind…"
                    .value=${props.query}
                    @input=${(event: Event) =>
                      props.onQuery((event.target as HTMLInputElement).value)}
                  />
                </label>
                <div class="settings-segmented sessions-view-segment" role="group" aria-label="Session state">
                  ${STATE_OPTIONS.map(([state, label]) => html`
                    <button type="button" class="settings-segmented__btn ${props.state === state ? "settings-segmented__btn--active" : ""}"
                      aria-pressed=${String(props.state === state)} @click=${() => props.onState(state)}>${label}</button>
                  `)}
                </div>
                ${filtersPopover(props)}
                ${archivedIds.length ? html`<button type="button" class="btn btn--sm"
                  @click=${() => { props.onState("archived"); props.onSelect(archivedIds, true); }}>Select archived (${archivedIds.length})</button>` : nothing}
              </div>
              ${selectedIds.length ? html`<div class="sessions-bulk-bar">
                <span class="sessions-bulk-bar__count">${selectedIds.length} selected</span>
                <button type="button" class="btn btn--sm danger" @click=${props.onDeleteSelected}>${icons.trash} Delete…</button>
                <button type="button" class="btn btn--sm" @click=${() => props.onSelect(selectedIds, false)}>Clear selection</button>
              </div>` : nothing}
              <div class="data-table-container">
                <table class="data-table sessions-table">
                  <thead>
                    <tr>
                      <th class="data-table-checkbox-col"><input type="checkbox" aria-label="Select all shown sessions"
                        ?disabled=${!visibleIds.length}
                        .checked=${visibleIds.length > 0 && selectedIds.length === visibleIds.length}
                        .indeterminate=${selectedIds.length > 0 && selectedIds.length < visibleIds.length}
                        @change=${(event: Event) => props.onSelect(visibleIds, (event.target as HTMLInputElement).checked)} /></th>
                      <th class="data-table-key-col">Key</th>
                      <th class="session-runtime-col">Runtime</th>
                      <th class="session-status-col">Status</th>
                      <th>Updated</th>
                      <th class="session-memory-col">Memory</th>
                      <th class="session-startup-col">Startup</th>
                      <th class="session-actions-col"><span class="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>${body(props)}</tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>
      ${deleteDialog(props, selectedIds)}
    </section>
  `;
}
