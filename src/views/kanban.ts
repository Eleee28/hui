/*
 * Kanban board of HUI sessions. Columns are the HUI-owned development stage;
 * lanes follow the chosen grouping and cards are ordered by what needs the
 * operator first. Presentation reuses OpenClaw Control UI v2026.9.5 page
 * chrome and menus (MIT); HUI owns the data and every mutation.
 */
import { html, nothing, svg, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { KANBAN_COLUMNS, SESSION_STAGE_LABELS, SESSION_STAGES, type KanbanColumn } from "../lib/kanban.ts";
import type { SessionStage } from "../api/schema/sessions.ts";
import { pullRequestAccessibleLabel } from "../lib/pull-requests.ts";
import { jiraIssueAccessibleLabel, jiraStatusLabel } from "../lib/jira.ts";
import type { SessionJiraIssue } from "../api/schema/sessions.ts";
import type { BacklogItem, BacklogJiraState } from "../api/schema/backlog.ts";
import type { JiraBadgeData } from "../components/jira-hovercard.ts";
import { brandIcons } from "../lib/brand-icons.ts";
import { icons } from "../lib/icons.ts";
import { navigationPath } from "../lib/navigation.ts";
import { closeDropdownOnEscape, labelDropdown } from "../lib/web-awesome.ts";
import {
  adjacentStage,
  backlogDrop,
  backlogLaneAccepts,
  isDefaultKanbanOptions,
  kanbanDropMove,
  laneAccepts,
  kanbanBoard,
  pullRequestSummary,
  kanbanStatus,
  KANBAN_STATUS_LABELS,
  normalizeKanbanOptions,
  sessionStage,
  toggleKanbanColumn,
  type KanbanLane,
  type KanbanMove,
  type KanbanOptions,
} from "../lib/kanban.ts";
import { type SessionGroup, type SessionView } from "../api/sessions.ts";
import { sessionGroupLabel, storedSessionGroup } from "../lib/session/sessions.ts";
import { formatUpdated } from "./sessions.ts";
import { taskSuggestionLocation, taskSuggestionPreview } from "../lib/task-suggestions.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(
  () => import("../styles/kanban.css"),
  () => import("../components/jira-hovercard.ts").then((module) => module.installJiraHovercard()),
);

/** Local: the shared icon set is pinned to upstream geometry. */
const kanbanIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M8 7v7M12 7v4M16 7v9" />`}</svg>`;
export { kanbanIcon };

export type KanbanPageProps = {
  groups: readonly SessionGroup[];
  loading: boolean;
  error: string;
  query: string;
  options: KanbanOptions;
  /** Session whose stage change is in flight; its card is inert meanwhile. */
  movePendingId: string;
  draggingId: string;
  dropTarget: string;
  onQuery: (value: string) => void;
  onOptions: (options: KanbanOptions) => void;
  onOpen: (session: SessionView) => void;
  /** Stage and/or custom group change; `stage: null` hands the stage back to
   * the agent and pull-request signals. */
  onMove: (session: SessionView, move: KanbanMove) => void;
  /** Id of the dragged session or backlog item. */
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDragOver: (cell: string) => void;
  onRefresh: () => void;
  /** Backlog items; `backlogJira` says whether the Jira half could be read. */
  backlog: readonly BacklogItem[];
  backlogLoading: boolean;
  backlogError: string;
  backlogJira: BacklogJiraState;
  /** Backlog item whose request is in flight; its card is inert meanwhile. */
  backlogPendingId: string;
  /** Only changes the item's group (a drop inside Backlog or Move to group). */
  onBacklogGroup: (item: BacklogItem, group: string) => void;
  /** Opens the start dialog; nothing is created until it is confirmed. */
  onBacklogStart: (item: BacklogItem, target: { stage: SessionStage; group: string; cwd?: string }) => void;
  onBacklogAction: (item: BacklogItem, action: BacklogCardAction) => void;
  onSessionAction: (session: SessionView, action: SessionCardAction) => void;
};

export type BacklogCardAction = "jira:create" | "jira:link" | "open:jira" | "copy" | "remove";
export type SessionCardAction = "jira:create" | "jira:link" | "open:jira" | "copy:jira";

const STAGE_DRAG_TYPE = "application/x-hui-kanban-session";
const BACKLOG_DRAG_TYPE = "application/x-hui-kanban-backlog";

function optionsMenu(options: KanbanOptions, onChange: (options: KanbanOptions) => void) {
  const item = (value: string, label: string, checked: boolean) => html`
    <wa-dropdown-item class="session-menu__item sidebar-session-sort-menu__item" type="checkbox" .checked=${live(checked)} value=${value}>
      <span class="session-menu__text">${label}</span>
      <span slot="details" class="session-menu__check" aria-hidden="true">${checked ? icons.check : nothing}</span>
    </wa-dropdown-item>`;
  const section = <K extends "groupBy" | "sortBy" | "archive" | "hideEmpty">(
    title: string, key: K, choices: readonly (readonly [KanbanOptions[K], string])[],
  ) => html`
    <div class="sidebar-session-sort-menu__label">${title}</div>
    ${choices.map(([value, label]) => item(`${key}:${value}`, label, options[key] === value))}`;
  const separator = html`<div class="session-menu__separator" role="separator"></div>`;
  return html`
    <wa-dropdown class="session-menu sidebar-session-sort-menu kanban-options" placement="bottom-end" distance="8"
      aria-label="Board options" @wa-show=${labelDropdown} @keydown=${closeDropdownOnEscape}
      @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
        const [key, value] = event.detail.item.value.split(":");
        if (!key || !value) return;
        if (key === "column") onChange(toggleKanbanColumn(options, value as KanbanColumn));
        else if (key === "subagents") onChange(normalizeKanbanOptions({ ...options, subagents: !options.subagents }));
        else if (key === "reset") onChange(normalizeKanbanOptions(null));
        else onChange(normalizeKanbanOptions({ ...options, [key]: value }));
      }}>
      <button slot="trigger" type="button" class="btn btn--sm kanban-options__trigger ${isDefaultKanbanOptions(options) ? "" : "is-active"}"
        aria-label="Board options" title="Board options">${icons.filter}<span>View</span></button>
      ${section("Group by", "groupBy", [["project", "Project"], ["custom", "Custom groups"], ["none", "None"]])}
      ${separator}
      ${section("Sort by", "sortBy", [["status", "Status"], ["updated", "Last updated"], ["created", "Created"]])}
      ${separator}
      ${section("Status", "archive", [["active", "Active"], ["archived", "Archived"], ["all", "All"]])}
      ${separator}
      <div class="sidebar-session-sort-menu__label">Columns</div>
      ${KANBAN_COLUMNS.map((stage) => item(`column:${stage}`, SESSION_STAGE_LABELS[stage], options.columns.includes(stage)))}
      ${separator}
      ${item("subagents:toggle", "Show subagent sessions", options.subagents)}
      ${separator}
      ${section("Hide empty lanes", "hideEmpty", [["filtering", "When filtering"], ["always", "Always"], ["never", "Never"]])}
      ${separator}
      <wa-dropdown-item class="session-menu__item" value="reset:all" ?disabled=${isDefaultKanbanOptions(options)}>
        <span class="session-menu__text">Reset view</span>
      </wa-dropdown-item>
    </wa-dropdown>`;
}

function groupChoices(props: KanbanPageProps): string[] {
  const fromItems = props.backlog.map((item) => item.group);
  return [...new Set(["", ...props.groups.map((group) => storedSessionGroup(group.label)), ...fromItems].filter((group, index) => index === 0 || Boolean(group)))];
}

function groupItems(current: string, props: KanbanPageProps, disabled = false) {
  return html`${groupChoices(props).map((group) => html`
    <wa-dropdown-item class="session-menu__item sidebar-session-sort-menu__item" type="checkbox" value=${`group:${group}`} .checked=${live(group === current)} ?disabled=${disabled || group === current}>
      <span class="session-menu__text">${sessionGroupLabel(group)}</span>
      <span slot="details" class="session-menu__check" aria-hidden="true">${group === current ? icons.check : nothing}</span>
    </wa-dropdown-item>`)}`;
}

const separator = html`<div class="session-menu__separator" role="separator"></div>`;
const jiraMenuIcon = html`<span slot="icon" class="session-menu__icon session-menu__icon--jira" aria-hidden="true">${brandIcons.jira}</span>`;

function sessionMenu(session: SessionView, props: KanbanPageProps) {
  const current = sessionStage(session);
  const currentGroup = storedSessionGroup(session.group);
  const linked = session.jiraIssues?.at(-1);
  return html`
    <wa-dropdown class="session-menu kanban-card__stage-menu" placement="bottom-end" distance="4"
      aria-label=${`Options for ${session.title}`} @wa-show=${labelDropdown} @keydown=${closeDropdownOnEscape}
      @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
        const value = event.detail.item.value;
        if (value.startsWith("group:")) props.onMove(session, { group: value.slice(6) });
        else if (value === "jira:create" || value === "jira:link" || value === "open:jira" || value === "copy:jira") queueMicrotask(() => props.onSessionAction(session, value));
        else props.onMove(session, { stage: value === "auto" ? null : value as SessionStage });
      }}>
      <button slot="trigger" type="button" class="kanban-card__stage-trigger" ?disabled=${props.movePendingId === session.id}
        aria-label=${`Stage: ${SESSION_STAGE_LABELS[current]}. Options for ${session.title}`}
        title="Options">${icons.moreHorizontal}</button>
      <div class="sidebar-session-sort-menu__label">Move to</div>
      ${SESSION_STAGES.map((stage) => html`
        <wa-dropdown-item class="session-menu__item sidebar-session-sort-menu__item" type="checkbox" value=${stage} .checked=${live(stage === current)} ?disabled=${stage === current && session.stageOrigin === "operator"}>
          <span class="session-menu__text">${SESSION_STAGE_LABELS[stage]}</span>
          <span slot="details" class="session-menu__check" aria-hidden="true">${stage === current ? icons.check : nothing}</span>
        </wa-dropdown-item>`)}
      ${separator}
      <wa-dropdown-item class="session-menu__item" value="auto" ?disabled=${session.stageOrigin !== "operator"}>
        <span class="session-menu__text">Let the agent decide</span>
      </wa-dropdown-item>
      ${separator}
      <div class="sidebar-session-sort-menu__label">Move to group</div>
      ${groupItems(currentGroup, props)}
      ${separator}
      ${linked ? html`
        <wa-dropdown-item class="session-menu__item" value="open:jira">${jiraMenuIcon}<span class="session-menu__text">Open in Jira · ${linked.key}</span></wa-dropdown-item>
        <wa-dropdown-item class="session-menu__item" value="copy:jira"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span><span class="session-menu__text">Copy Jira link</span></wa-dropdown-item>` : html`
        <wa-dropdown-item class="session-menu__item" value="jira:create">${jiraMenuIcon}<span class="session-menu__text">Create Jira work item…</span></wa-dropdown-item>
        <wa-dropdown-item class="session-menu__item" value="jira:link">${jiraMenuIcon}<span class="session-menu__text">Link Jira work item…</span></wa-dropdown-item>`}
    </wa-dropdown>`;
}

function backlogMenu(item: BacklogItem, props: KanbanPageProps) {
  const pending = props.backlogPendingId === item.id;
  const local = item.kind === "local";
  return html`
    <wa-dropdown class="session-menu kanban-card__stage-menu" placement="bottom-end" distance="4"
      aria-label=${`Options for ${item.title}`} @wa-show=${labelDropdown} @keydown=${closeDropdownOnEscape}
      @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
        const value = event.detail.item.value;
        // Act after Web Awesome restores trigger focus, so dialogs keep theirs.
        if (value.startsWith("group:")) props.onBacklogGroup(item, value.slice(6));
        else if (value === "start") queueMicrotask(() => props.onBacklogStart(item, { stage: "investigation", group: item.group, ...(item.cwd ? { cwd: item.cwd } : {}) }));
        else queueMicrotask(() => props.onBacklogAction(item, value as BacklogCardAction));
      }}>
      <button slot="trigger" type="button" class="kanban-card__stage-trigger" ?disabled=${pending}
        aria-label=${`Options for ${item.title}`} title="Options">${icons.moreHorizontal}</button>
      <wa-dropdown-item class="session-menu__item" value="start"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.messageSquare}</span><span class="session-menu__text">Start session…</span></wa-dropdown-item>
      ${separator}
      <div class="sidebar-session-sort-menu__label">Move to group</div>
      ${groupItems(item.group, props)}
      ${separator}
      ${local && !item.jira ? html`
        <wa-dropdown-item class="session-menu__item" value="jira:create">${jiraMenuIcon}<span class="session-menu__text">Create Jira task…</span></wa-dropdown-item>
        <wa-dropdown-item class="session-menu__item" value="jira:link">${jiraMenuIcon}<span class="session-menu__text">Link existing Jira work item…</span></wa-dropdown-item>` : nothing}
      ${item.jira ? html`<wa-dropdown-item class="session-menu__item" value="open:jira">${jiraMenuIcon}<span class="session-menu__text">Open in Jira · ${item.jira.key}</span></wa-dropdown-item>` : nothing}
      <wa-dropdown-item class="session-menu__item" value="copy"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span><span class="session-menu__text">Copy</span></wa-dropdown-item>
      ${local ? html`${separator}<wa-dropdown-item class="session-menu__item session-menu__item--destructive" variant="danger" value="remove"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span><span class="session-menu__text">Remove from backlog…</span></wa-dropdown-item>` : nothing}
    </wa-dropdown>`;
}

const ORIGIN_LABELS = { operator: "Placed by you", agent: "Reported by the agent", pullRequest: "From pull requests", default: "Not placed yet" } as const;

/** Jira key and status for a card; hover previews it like the sidebar mark. */
function jiraChip(issues: readonly SessionJiraIssue[] | undefined) {
  const issue = issues?.at(-1);
  if (!issue) return nothing;
  const data: JiraBadgeData = { issue, others: (issues ?? []).slice(0, -1) };
  return html`<a class="kanban-card__jira session-jira-badge-anchor" href=${issue.url} target="_blank" rel="noopener noreferrer" draggable="false"
    aria-label=${jiraIssueAccessibleLabel(issue, issues?.length ?? 1)}>
    <span class="session-jira-badge kanban-card__jira-mark" data-state=${issue.statusCategory ?? "unknown"} .jira=${data}>${brandIcons.jira}</span>
    <span class="kanban-card__jira-key">${issue.key}</span>
    <span class="kanban-card__jira-status" data-state=${issue.statusCategory ?? "unknown"}>${jiraStatusLabel(issue)}</span>
  </a>`;
}

function pullRequestChip(session: SessionView) {
  const summary = pullRequestSummary(session.pullRequests);
  if (!summary) return nothing;
  const first = session.pullRequests!.length === 1 ? session.pullRequests![0]! : undefined;
  const label = session.pullRequests!.map(pullRequestAccessibleLabel).join("; ");
  return first
    ? html`<a class="kanban-card__prs" data-state=${summary.dominant} href=${first.url} target="_blank" rel="noopener noreferrer" draggable="false"
        aria-label=${label} title=${label}>${icons.gitBranch}<span>${summary.label}</span></a>`
    : html`<span class="kanban-card__prs" data-state=${summary.dominant} title=${label} aria-label=${label}>${icons.gitBranch}<span>${summary.label}</span></span>`;
}

function isInteractive(event: MouseEvent): boolean {
  return Boolean((event.target as Element).closest("a, button, wa-dropdown"));
}

function card(session: SessionView, props: KanbanPageProps): TemplateResult {
  const status = kanbanStatus(session);
  const stage = sessionStage(session);
  const pending = props.movePendingId === session.id;
  const move = (direction: -1 | 1) => {
    const next = adjacentStage(stage, direction);
    if (next) props.onMove(session, { stage: next });
  };
  return html`
    <article class="kanban-card ${props.draggingId === session.id ? "kanban-card--dragging" : ""} ${pending ? "kanban-card--pending" : ""}"
      data-session-id=${session.id} data-status=${status}
      .draggable=${!pending}
      @dragstart=${(event: DragEvent) => {
        if (pending || !event.dataTransfer) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(STAGE_DRAG_TYPE, session.id);
        event.dataTransfer.setData("text/plain", session.title);
        props.onDragStart(session.id);
      }}
      @dragend=${props.onDragEnd}
      @click=${(event: MouseEvent) => {
        // The whole card opens its session; links, buttons and the menu keep
        // their own behaviour, and modified clicks stay with the browser.
        if (pending || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (isInteractive(event)) return;
        props.onOpen(session);
      }}>
      <div class="kanban-card__head">
        <a class="kanban-card__title" href=${navigationPath({ kind: "session", id: session.id })} draggable="false"
          aria-keyshortcuts="Shift+ArrowLeft Shift+ArrowRight"
          aria-label=${`${session.title}, ${KANBAN_STATUS_LABELS[status]}, ${SESSION_STAGE_LABELS[stage]}`}
          @click=${(event: MouseEvent) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            props.onOpen(session);
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (!event.shiftKey || pending || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
            event.preventDefault();
            move(event.key === "ArrowLeft" ? -1 : 1);
          }}>
          ${session.icon ? html`<span class="kanban-card__icon" aria-hidden="true">${session.icon}</span>` : nothing}
          <span class="kanban-card__title-text">${session.title}</span>
        </a>
        ${sessionMenu(session, props)}
      </div>
      <div class="kanban-card__meta">
        <span class="kanban-status kanban-status--${status}">
          <span class="kanban-status__dot" aria-hidden="true"></span>${KANBAN_STATUS_LABELS[status]}
        </span>
        ${pullRequestChip(session)}
        ${jiraChip(session.jiraIssues)}
        <span class="kanban-card__updated" title=${`${ORIGIN_LABELS[session.stageOrigin ?? "default"]} · updated ${session.updatedAt}`}>
          ${session.stageOrigin === "operator" ? html`<span class="kanban-card__pin" aria-label="Stage placed by you">${icons.pin}</span>` : nothing}
          ${formatUpdated(session.updatedAt)}
        </span>
      </div>
    </article>`;
}

function backlogCard(item: BacklogItem, props: KanbanPageProps): TemplateResult {
  const pending = props.backlogPendingId === item.id;
  const start = () => props.onBacklogStart(item, { stage: "investigation", group: item.group, ...(item.cwd ? { cwd: item.cwd } : {}) });
  return html`
    <article class="kanban-card kanban-card--backlog ${props.draggingId === item.id ? "kanban-card--dragging" : ""} ${pending ? "kanban-card--pending" : ""}"
      data-backlog-id=${item.id} data-kind=${item.kind}
      .draggable=${!pending}
      @dragstart=${(event: DragEvent) => {
        if (pending || !event.dataTransfer) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(BACKLOG_DRAG_TYPE, item.id);
        event.dataTransfer.setData("text/plain", item.title);
        props.onDragStart(item.id);
      }}
      @dragend=${props.onDragEnd}>
      <div class="kanban-card__head">
        <button type="button" class="kanban-card__title kanban-card__title--button" draggable="false"
          aria-label=${`${item.title}, ${item.kind === "jira" ? "Jira work item" : "local task"}. Start a session`}
          title="Start a session" @click=${start}>
          <span class="kanban-card__title-text">${item.title}</span>
        </button>
        ${backlogMenu(item, props)}
      </div>
      ${item.kind === "local" && item.problem ? html`<p class="kanban-card__summary">${taskSuggestionPreview(item.problem)}</p>` : nothing}
      <div class="kanban-card__meta">
        <span class="kanban-card__kind">${item.kind === "jira" ? item.jira?.issueType || "Jira" : "Local task"}</span>
        ${jiraChip(item.jira ? [item.jira] : undefined)}
        ${item.kind === "local" && item.cwd ? html`<span class="kanban-card__updated" title=${item.cwd}>${taskSuggestionLocation(item.cwd)}</span>` : nothing}
      </div>
    </article>`;
}

type Dragged = { kind: "session"; session: SessionView } | { kind: "item"; item: BacklogItem };

function accepts(dragged: Dragged, lane: KanbanLane, stage: KanbanColumn): boolean {
  return dragged.kind === "session" ? laneAccepts(dragged.session, lane, stage) : backlogLaneAccepts(dragged.item, lane, stage);
}

function dropHandlers(cellKey: string, lane: KanbanLane, stage: KanbanColumn, dragged: Dragged | undefined, lookup: (type: string, id: string) => Dragged | undefined, props: KanbanPageProps) {
  return {
    dragover: (event: DragEvent) => {
      const types = event.dataTransfer?.types ?? [];
      if (!dragged || !(types.includes(STAGE_DRAG_TYPE) || types.includes(BACKLOG_DRAG_TYPE))) return;
      // Refused cells (Backlog for sessions, another project) never show a drop.
      if (!accepts(dragged, lane, stage)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      if (props.dropTarget !== cellKey) props.onDragOver(cellKey);
    },
    drop: (event: DragEvent) => {
      const sessionId = event.dataTransfer?.getData(STAGE_DRAG_TYPE);
      const itemId = event.dataTransfer?.getData(BACKLOG_DRAG_TYPE);
      const found = sessionId ? lookup(STAGE_DRAG_TYPE, sessionId) : itemId ? lookup(BACKLOG_DRAG_TYPE, itemId) : undefined;
      if (!found) return;
      event.preventDefault();
      props.onDragEnd();
      if (!accepts(found, lane, stage)) return;
      if (found.kind === "session") {
        const move = kanbanDropMove(found.session, lane, stage);
        if (move) props.onMove(found.session, move);
        return;
      }
      const drop = backlogDrop(found.item, lane, stage);
      if (drop?.kind === "group") props.onBacklogGroup(found.item, drop.group);
      else if (drop?.kind === "start") props.onBacklogStart(found.item, { stage: drop.stage, group: drop.group, ...(drop.cwd ? { cwd: drop.cwd } : {}) });
    },
  };
}

function backlogNote(props: KanbanPageProps) {
  if (!props.options.columns.includes("backlog")) return nothing;
  if (props.backlogError) return html`<p class="kanban-backlog-note is-error" role="status">Backlog unavailable: ${props.backlogError}</p>`;
  if (props.backlogJira.status === "unavailable") return html`<p class="kanban-backlog-note" role="status">${brandIcons.jira}<span>Jira items are not shown: ${props.backlogJira.message}</span></p>`;
  if (props.backlogJira.status === "unconfigured" && !props.backlogLoading) return html`<p class="kanban-backlog-note" role="status">${brandIcons.jira}<span>Connect Jira in Settings → Integrations to list the work items assigned to you.</span></p>`;
  return nothing;
}

function board(props: KanbanPageProps) {
  if (props.loading && props.groups.length === 0) return html`<p class="kanban-empty" role="status">Loading sessions…</p>`;
  if (props.error && props.groups.length === 0) return html`<p class="kanban-empty is-error" role="alert">${props.error}</p>`;
  const lanes = kanbanBoard(props.groups, props.query, props.options, props.backlog);
  const sessions = new Map(props.groups.flatMap((group) => group.sessions).map((session) => [session.id, session]));
  const items = new Map(props.backlog.map((item) => [item.id, item]));
  const lookup = (type: string, id: string): Dragged | undefined => {
    if (type === STAGE_DRAG_TYPE) { const session = sessions.get(id); return session ? { kind: "session", session } : undefined; }
    const item = items.get(id);
    return item ? { kind: "item", item } : undefined;
  };
  const dragged = props.draggingId ? lookup(STAGE_DRAG_TYPE, props.draggingId) ?? lookup(BACKLOG_DRAG_TYPE, props.draggingId) : undefined;
  if (lanes.every((lane) => lane.count === 0) && (props.query.trim() || props.options.archive !== "active")) {
    return html`<p class="kanban-empty" role="status">No matching cards. Try another search or view.</p>`;
  }
  return html`
    <div class="kanban-board" role="region" aria-label="Kanban board" style=${`--kanban-columns:${props.options.columns.length}`}>
      <div class="kanban-board__inner">
      ${lanes.map((lane) => html`
        <section class="kanban-lane" aria-label=${lane.label || "Sessions"}>
          ${lane.kind !== "none" ? html`<header class="kanban-lane__head">
            <span class="kanban-lane__label" title=${lane.cwd ?? lane.label}>${lane.label}</span>
            <span class="settings-count">${lane.count}</span>
            ${lane.cwd ? html`<span class="kanban-lane__path muted" title=${lane.cwd}>${lane.cwd}</span>` : nothing}
          </header>` : nothing}
          <div class="kanban-lane__cells">
            ${lane.cells.map((cell) => {
              const key = `${lane.key}\u0001${cell.stage}`;
              const handlers = dropHandlers(key, lane, cell.stage, dragged, lookup, props);
              const refused = Boolean(dragged && !accepts(dragged, lane, cell.stage));
              const count = cell.sessions.length + cell.items.length;
              // Each section carries its own stage title so it reads next to
              // its cards instead of at the top of a long board.
              return html`<div class="kanban-cell kanban-cell--${cell.stage} ${props.dropTarget === key ? "kanban-cell--drop" : ""} ${dragged && !refused ? "kanban-cell--droppable" : ""} ${refused ? "kanban-cell--refused" : ""}"
                data-stage=${cell.stage}
                @dragover=${handlers.dragover} @drop=${handlers.drop}>
                <div class="kanban-cell__head kanban-cell__head--${cell.stage}">
                  <span class="kanban-cell__dot" aria-hidden="true"></span>
                  <span class="kanban-cell__title">${SESSION_STAGE_LABELS[cell.stage]}</span>
                  <span class="settings-count">${count}</span>
                </div>
                <div class="kanban-cell__cards" role="list" aria-label=${`${lane.label ? `${lane.label}, ` : ""}${SESSION_STAGE_LABELS[cell.stage]}`}>
                  ${cell.items.map((item) => html`<div role="listitem">${backlogCard(item, props)}</div>`)}
                  ${cell.sessions.map((session) => html`<div role="listitem">${card(session, props)}</div>`)}
                </div>
              </div>`;
            })}
          </div>
        </section>`)}
      </div>
    </div>`;
}

export function renderKanbanPage(props: KanbanPageProps): TemplateResult {
  return html`
    <section class="settings-workspace hui-workspace-page kanban-workspace">
      <header class="content-header content-header--settings content-header--page kanban-header">
        <div>
          <div class="page-title">Kanban</div>
          <div class="page-subtitle">Backlog items and where each session is in development. Drag a backlog item to a stage to start a session; drag a session to change stage or group.</div>
        </div>
        <div class="kanban-header__actions">
          <label class="data-table-search kanban-search">
            <span class="sr-only">Filter the board</span>
            <input type="search" placeholder="Filter cards…" .value=${live(props.query)}
              @input=${(event: Event) => props.onQuery((event.target as HTMLInputElement).value)} />
          </label>
          ${optionsMenu(props.options, props.onOptions)}
          <button type="button" class="btn btn--sm" @click=${props.onRefresh}>${icons.refresh} Refresh</button>
        </div>
      </header>
      ${backlogNote(props)}
      ${board(props)}
    </section>`;
}
