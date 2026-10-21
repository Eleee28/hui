// Shell markup adapted from OpenClaw Control UI v2026.9.5, MIT licensed.
// HUI retains ownership of routing, session state and every callback below.
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../lib/icons.ts";
import { icons as openclawIcons } from "../components/openclaw/icons.ts";
import { sessionMenuShortcuts } from "../lib/session/menu-shortcuts.ts";
import { labelDropdown, closeDropdownOnEscape } from "../lib/web-awesome.ts";
import { renderHoverMarquee } from "../lib/hover-marquee.ts";
import { type SessionGroup, type SessionView } from "../api/sessions.ts";
import { sessionGroupLabel, storedSessionGroup, unreachableHost } from "../lib/session/sessions.ts";
import { subagentElapsed, subagentVisualState } from "../lib/subagent-activity.ts";
import { customGroupOrder, sessionTreeRows, sidebarSessionGroups, type SidebarSessionGroup, type SidebarSessionOptions, type SidebarSessionTreeRow } from "../lib/session/sidebar-sessions.ts";
import { renderSidebarSessionOptions } from "./sidebar-session-options.ts";
import { kanbanIcon } from "./kanban.ts";
import { isSessionStage, SESSION_STAGE_LABELS } from "../lib/kanban.ts";
export { filterSessionGroups } from "../lib/session/sidebar-sessions.ts";
import { HUI_PAGES, type HuiPage } from "../lib/pages.ts";
import { navigationPath } from "../lib/navigation.ts";
import { writeSessionDrag } from "../lib/session/pane-layout.ts";
import { pullRequestAccessibleLabel } from "../lib/pull-requests.ts";
import { pullRequestStateIcon } from "../components/pull-request-hovercard.ts";
import { jiraIssueAccessibleLabel, primaryJiraIssue } from "../lib/jira.ts";
import { brandIcons } from "../lib/brand-icons.ts";
import { worktreeProgressLabel } from "../lib/worktree-progress.ts";
import type { JiraBadgeData } from "../components/jira-hovercard.ts";
import { renderBotRoster, renderNewBotButton, type BotPlace, type BotRosterProps } from "./bots.ts";
import { SIDEBAR_TABS, tabAfterKey, type SidebarTab } from "../lib/bots/roster.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

// The real browser entry loads these before this view can render.
loadViewAssets(
  () => import("../styles/openclaw-shell.css"),
  () => import("../components/openclaw/session-progress-hovercard.runtime.ts"),
  () => import("../components/pull-request-hovercard.ts").then((module) => module.installPullRequestHovercard()),
  () => import("../components/pull-request-strip.ts"),
  () => import("../components/jira-hovercard.ts").then((module) => module.installJiraHovercard()),
  () => import("../components/tooltip.ts").then((module) => module.installTooltips()),
);

/**
 * The app shell, following OpenClaw's Control UI regions:
 *
 *   header         new session and search on the left, collapse on the right
 *   nav            page destinations, ending with Settings
 *   session list   collapsible groups of session rows
 */

/** Sidebar destinations. Sessions are opened from the list below and New
 * Session from the header, so there is no separate Home entry. Automations,
 * Plugins and Skills live in Settings. */
export const PRIMARY_NAV = [
  { id: "contributions", label: "Contributions", icon: openclawIcons.gitPullRequest },
  { id: "sessions", label: "Sessions", icon: icons.messageSquare },
] as const;

/** Compact content geometry and the platform-aware browser drawer contract
 * are separate upstream rules (app/mobile-nav-layout.ts, v2026.9.5). */
export const SHELL_NARROW_MEDIA = "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";
export const APP_SHELL_DRAWER_MEDIA = "(max-width: 900px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";
export const SHELL_DRAWER_DEFAULT_OPEN = false;

export type DrawerMediaQuery = Pick<
  MediaQueryList,
  "matches" | "addEventListener" | "removeEventListener"
>;

const drawerMediaListeners = new WeakMap<HTMLElement, {
  media: DrawerMediaQuery;
  listener: (event: MediaQueryListEvent) => void;
}>();

/** A drawer is modal only while the narrow layout matches. Keep one listener
 * per mounted drawer and remove it on every close so detached views cannot be
 * retained by matchMedia. */
export function bindDrawerToNarrowMedia(
  drawer: HTMLElement,
  close: () => void,
  media: DrawerMediaQuery = matchMedia(APP_SHELL_DRAWER_MEDIA),
): boolean {
  unbindDrawerMedia(drawer);
  if (!media.matches) {
    return false;
  }
  const listener = (event: MediaQueryListEvent) => {
    if (event.matches) {
      return;
    }
    unbindDrawerMedia(drawer);
    close();
  };
  media.addEventListener("change", listener);
  drawerMediaListeners.set(drawer, { media, listener });
  return true;
}

export function unbindDrawerMedia(drawer: HTMLElement) {
  const binding = drawerMediaListeners.get(drawer);
  if (!binding) {
    return;
  }
  binding.media.removeEventListener("change", binding.listener);
  drawerMediaListeners.delete(drawer);
}

export type NavId = "home" | "surface" | "kanban" | "bot";
export type GroupMenuAction = "defaults" | "rename" | "new" | "delete";
export type SessionCopyAction = "link" | "markdown" | "id" | "jira";
export type SessionOpenAction = "tab" | "window" | "editor" | "jira";
export type GroupDropTarget = { group: string; position: "before" | "after" };

/** The Agents | Bots switch fills the sidebar's top row, right after the
 * collapse toggle, because each tab has a sidebar of its own: Agents is the
 * sidebar as before, and Bots shows only the roster. */
export type ShellBotsProps = {
  tab: SidebarTab;
  onTab: (tab: SidebarTab) => void;
  /** The roster has its own query, so switching tabs keeps each search. */
  search: string;
  onSearch: (value: string) => void;
  /** + creates a bot at once (Grok Bot's way: no form) and opens its chat. */
  onNew: () => void;
  /** Remote workers: while there is one, + is a menu that creates a bot on Local or on a worker (`onCreate`). */
  workers: readonly BotPlace[];
  onCreate: (worker: string | undefined) => void;
  /** +'s Import bot…: one from another platform's template, or a HUI export. */
  onImport: () => void;
  onWorkersMenu?: () => void;
  /** A bot is being created; + waits for it. */
  creating: boolean;
  /** An unread bot marks the Bots tab while Agents is shown. */
  unread: boolean;
  roster: BotRosterProps;
};

export type ShellProps = {
  view: NavId;
  activePage?: HuiPage;
  selectedSessionId: string;
  splitSessionId: string;
  openSessionIds?: ReadonlySet<string>;
  groups: readonly SessionGroup[];
  draftSessionIds: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  toggledSessionTrees: ReadonlySet<string>;
  onToggleSessionTree: (id: string) => void;
  loading: boolean;
  error: string;
  importNote: string;
  importFailed: boolean;
  search: string;
  sessionOptions: SidebarSessionOptions;
  onSessionOptions: (options: SidebarSessionOptions) => void;
  onNewGroup: () => void;
  /** Which session's row menu is open, by id. Empty means none. */
  menuFor: string;
  /** Which group menu is open. Empty means none. */
  groupMenuFor: string;
  onSelectView: (id: NavId) => void;
  onOpenKanban: () => void;
  onOpenPage: (page: HuiPage) => void;
  onSelectSession: (session: SessionView) => void;
  onSplitSession: (session: SessionView) => void;
  onToggleGroup: (label: string) => void;
  onOpenSettings: () => void;
  onSearch: (value: string) => void;
  onToggleMenu: (sessionId: string) => void;
  /** Idempotent close, kept separate from toggle for document-level dismissal. */
  onCloseMenu: () => void;
  onToggleGroupMenu: (group: string) => void;
  onCloseGroupMenu: () => void;
  onGroupAction: (action: GroupMenuAction, group: SessionGroup) => void;
  onNewSession: (group?: SessionGroup) => void;
  onRenameSession: (session: SessionView) => void;
  onTogglePin: (session: SessionView) => void;
  onUpdateSession: (
    session: SessionView,
    patch: { unread?: boolean; archived?: boolean; icon?: string },
    success: string,
  ) => void;
  onCopySession: (session: SessionView, action: SessionCopyAction) => void;
  onOpenSession: (session: SessionView, action: SessionOpenAction) => void;
  /** Opens the create-Jira-work-item dialog for this session. */
  onCreateJiraIssue: (session: SessionView) => void;
  /** Opens the link-existing-Jira-work-item dialog for this session. */
  onLinkJiraIssue: (session: SessionView) => void;
  draggingSessionId: string;
  sessionDropTarget: string;
  sessionMovePendingId: string;
  onSessionDragStart: (session: SessionView) => void;
  onSessionDragEnd: () => void;
  onSessionDragOver: (group: string) => void;
  onSessionDragLeave: (group: string) => void;
  onMoveSession: (session: SessionView, group: string) => void;
  /** Custom group being dragged by its header. Empty means none. */
  draggingGroup: string;
  groupDropTarget: GroupDropTarget | undefined;
  groupReorderPending: boolean;
  onGroupDragStart: (group: string) => void;
  onGroupDragEnd: () => void;
  onGroupDragOver: (target: GroupDropTarget) => void;
  onGroupDragLeave: (group: string) => void;
  /** Drops `group` before/after `target`; `ungrouped` as target means last. */
  onReorderGroup: (group: string, target: GroupDropTarget) => void;
  onDeleteSession: (session: SessionView) => void;
  bots: ShellBotsProps;
};

export function sessionMoveGroupOptions(groups: readonly SessionGroup[]): Array<{ label: string; value: string }> {
  const labels = ["ungrouped", ...groups.map((group) => group.label)];
  return [...new Set(labels.map((label) => label || "ungrouped"))]
    .map((label) => ({ label: sessionGroupLabel(label), value: storedSessionGroup(label) }));
}

export function sessionAccessibleName(session: SessionView): string {
  return [
    session.title,
    session.creating ? worktreeProgressLabel(session.creating) : `status ${session.status}`,
    ...(session.background && session.status !== "running" ? ["watcher or subagent running"] : []),
    `tool ${session.tool}`,
    ...(isSessionStage(session.stage) ? [`stage ${SESSION_STAGE_LABELS[session.stage].toLocaleLowerCase()}`] : []),
    ...(session.pinned ? ["pinned"] : []),
    ...(session.unread ? ["unread"] : []),
    ...(session.archived ? ["archived"] : []),
  ].join(", ");
}

const SESSION_ICONS = ["🦞", "🚀", "🐛", "✅", "🔥", "📦", "🧪", "📝", "🔍", "⚡", "🎯"] as const;
export function normalizeCustomSessionIcon(value: string): string | undefined {
  const icon = value.trim();
  return icon && icon.length <= 32 ? icon : undefined;
}

function shortcut(key: string) {
  return html`<kbd slot="details" class="session-menu__shortcut" aria-hidden="true">${key}</kbd>`;
}

function appearanceMenu(session: SessionView, props: ShellProps) {
  const choose = (event: Event, patch: { icon?: string }, success: string) => {
    event.preventDefault();
    event.stopPropagation();
    props.onCloseMenu();
    props.onUpdateSession(session, patch, success);
  };
  const showCustomIcon = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = (event.currentTarget as HTMLElement).closest<HTMLElement>(".session-menu__icon-panel");
    if (!panel) return;
    panel.dataset.mode = "custom";
    panel.querySelector<HTMLElement>(".session-menu__icon-options")?.setAttribute("inert", "");
    panel.querySelector<HTMLElement>(".session-menu__icon-options")?.setAttribute("aria-hidden", "true");
    const custom = panel.querySelector<HTMLElement>(".session-menu__icon-custom-entry");
    custom?.removeAttribute("inert");
    custom?.removeAttribute("aria-hidden");
    panel.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input")?.focus();
  };
  const showIconGrid = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = (event.currentTarget as HTMLElement).closest<HTMLElement>(".session-menu__icon-panel");
    if (!panel) return;
    panel.dataset.mode = "grid";
    const options = panel.querySelector<HTMLElement>(".session-menu__icon-options");
    options?.removeAttribute("inert");
    options?.removeAttribute("aria-hidden");
    const custom = panel.querySelector<HTMLElement>(".session-menu__icon-custom-entry");
    custom?.setAttribute("inert", "");
    custom?.setAttribute("aria-hidden", "true");
    panel.querySelector<HTMLButtonElement>(".session-menu__icon-choice--custom")?.focus();
  };
  const updateCustomIcon = (event: Event) => {
    event.stopPropagation();
    const input = event.currentTarget as HTMLTextAreaElement;
    const apply = input.closest(".session-menu__icon-custom-controls")?.querySelector<HTMLButtonElement>(".session-menu__icon-set");
    if (apply) apply.disabled = !normalizeCustomSessionIcon(input.value);
  };
  const applyCustomIcon = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const input = (event.currentTarget as HTMLElement).closest(".session-menu__icon-custom-controls")?.querySelector<HTMLTextAreaElement>(".session-menu__icon-custom-input");
    const icon = normalizeCustomSessionIcon(input?.value ?? "");
    if (icon) choose(event, { icon }, `Session icon set to ${icon}.`);
  };
  return html`
    <wa-dropdown-item class="session-menu__item">
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.palette}</span>
      <span class="session-menu__text">Icon</span>
      <div slot="submenu" class="session-menu__appearance">
        <div class="session-menu__icon-panel" data-mode="grid">
          <div class="session-menu__icon-options" role="group" aria-label="Session icon">
            <div class="session-menu__icon-section-label">Emoji</div>
            <div class="session-menu__icon-grid">
              ${SESSION_ICONS.map((icon) => html`<button type="button" class="session-menu__icon-choice" aria-label=${`Set icon ${icon}`}
                aria-pressed=${String(session.icon === icon)} @click=${(event: Event) => choose(event, { icon }, `Session icon set to ${icon}.`)}>${icon}</button>`)}
              <button type="button" class="session-menu__icon-choice session-menu__icon-choice--custom" aria-label="Custom emoji…"
                aria-pressed="false" @click=${showCustomIcon}>${icons.moreHorizontal}</button>
            </div>
            <div class="session-menu__icon-section-label">Icons</div>
            <div class="session-menu__icon-grid">
              <button type="button" class="session-menu__icon-choice session-menu__icon-choice--glyph" aria-label="No icon"
                aria-pressed=${String(!session.icon)} @click=${(event: Event) => choose(event, { icon: "" }, "Session icon removed.")}>${icons.circleX}</button>
            </div>
          </div>
          <div class="session-menu__icon-custom-entry" aria-hidden="true" inert>
            <div class="session-menu__icon-custom-header">
              <button type="button" class="session-menu__icon-back" aria-label="Back" @click=${showIconGrid}>${icons.arrowLeft}</button>
              <span>Custom emoji</span>
            </div>
            <div class="session-menu__icon-custom-controls">
              <textarea class="session-menu__icon-custom-input" rows="1" maxlength="32" autocomplete="off"
                aria-label="Custom emoji" @input=${updateCustomIcon} @keydown=${(event: KeyboardEvent) => {
                  event.stopPropagation();
                  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
                  event.preventDefault();
                  applyCustomIcon(event);
                }}></textarea>
              <button type="button" class="session-menu__icon-set" disabled @click=${applyCustomIcon}>Set</button>
            </div>
            <div class="session-menu__icon-custom-hint">Any emoji works.</div>
          </div>
        </div>
      </div>
    </wa-dropdown-item>
  `;
}

export function isSessionGroupCollapsed(
  collapsed: ReadonlySet<string>,
  groupLabel: string,
  search: string,
): boolean {
  return search.trim().length === 0 && collapsed.has(groupLabel);
}

function menuId(sessionId: string): string {
  return `session-actions-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function renderChildStatus(status: string) {
  const state = subagentVisualState(status);
  if (state === "running") return html`<span class="hui-orbit" aria-hidden="true"><i></i><i></i><i></i></span>`;
  const icon = state === "completed" ? icons.check : state === "cancelled" ? icons.circle : icons.alertTriangle;
  return html`<span class="sidebar-child-status sidebar-child-status--${state}">${icon}</span>`;
}

/** State-colored PR marks beside the title; each opens GitHub in a new tab.
 * The newest mark comes first in the DOM: the `row-reverse` strip shows it at
 * the trailing edge, makes that edge the scroll origin, and fades older marks
 * so a half-visible neighbour signals that the strip scrolls. */
function renderPullRequestBadges(session: SessionView) {
  const pullRequests = session.pullRequests;
  if (!pullRequests?.length) return nothing;
  return html`<hui-pull-request-strip class="session-pr-badges" role="group"
    aria-label=${`${pullRequests.length} pull request${pullRequests.length === 1 ? "" : "s"}`}>
    ${[...pullRequests].reverse().map((pullRequest) => html`<a
      class="session-pr-badge"
      data-state=${pullRequest.state ?? "unknown"}
      href=${pullRequest.url}
      target="_blank"
      rel="noopener noreferrer"
      draggable="false"
      aria-label=${pullRequestAccessibleLabel(pullRequest)}
      .pullRequest=${pullRequest}
    >${pullRequestStateIcon(pullRequest.state)}</a>`)}
  </hui-pull-request-strip>`;
}

/** The newest linked Jira work item, left of the title. It lives inside the
 * session link, so it is a span: hover previews it, clicking opens Jira. */
function renderJiraBadge(session: SessionView) {
  const primary = primaryJiraIssue(session.jiraIssues);
  if (!primary) return nothing;
  const data: JiraBadgeData = primary;
  return html`<span
    class="session-jira-badge"
    data-state=${primary.issue.statusCategory ?? "unknown"}
    data-jira-key=${primary.issue.key}
    .jira=${data}
    @click=${(event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      window.open(primary.issue.url, "_blank", "noopener,noreferrer");
    }}
  >${brandIcons.jira}</span>`;
}

function sessionRow(session: SessionView, selected: boolean, props: ShellProps, depth = 0, hasChildren = false, treeCollapsed = false) {
  const open = props.menuFor === session.id;
  const splitOpen = props.openSessionIds?.has(session.id) ?? props.splitSessionId === session.id;
  const hasDraft = props.draftSessionIds.has(session.id);
  const linkedJira = session.jiraIssues?.at(-1);
  const canDrag = props.sessionMovePendingId !== session.id;
  const dragging = props.draggingSessionId === session.id;
  const away = unreachableHost(session);
  const attention = session.status === "waiting"
    ? { label: "Waiting for your answer", icon: icons.hand, tone: "question" }
    : session.status === "error"
      ? { label: "Session failed", icon: icons.alertTriangle, tone: "error" }
      // Calm, not a failure: the session goes on on its machine.
      : away ? { label: away.status, icon: icons.plug, tone: "away" } : undefined;
  // Also shown as running while a watcher or a subagent below it still works.
  const background = session.status !== "running" && session.background === true && !attention;
  const busy = session.status === "running" || background;
  const unread = session.unread === true && !attention && !session.icon && !busy;
  // The Jira mark sits in the leading status column, aligned with child
  // status glyphs. Live status (attention, running, child result) takes the
  // column while it applies; the Jira mark outranks a custom icon.
  // Every session sits in a work stage (Investigation first); a legacy or
  // missing stage from an older gateway draws no bar.
  const stage = isSessionStage(session.stage) ? session.stage : undefined;
  const showJiraLead = Boolean(session.jiraIssues?.length) && !attention && !busy
    && !(depth > 0 && session.subagent);
  return html`
    <div
      class="session-row-wrap session-row-host sidebar-recent-session sidebar-recent-session--single-line ${depth > 0 ? "sidebar-recent-session--child" : ""} ${selected ? "sidebar-recent-session--active" : ""} ${splitOpen ? "sidebar-recent-session--split" : ""} ${session.pinned ? "session-row-host--pinned" : ""} ${session.unread ? "sidebar-recent-session--unread" : ""} ${stage ? "sidebar-recent-session--staged" : ""} ${session.status === "running" ? "session-row-host--running" : ""} ${hasDraft ? "sidebar-recent-session--has-draft" : ""} ${session.status === "error" ? "sidebar-recent-session--attention-danger" : ""} ${dragging ? "sidebar-recent-session--dragging" : ""} ${props.sessionMovePendingId === session.id ? "sidebar-recent-session--moving" : ""}"
      data-session-id=${session.id}
      data-session-key=${session.id}
      data-session-stage=${stage ?? nothing}
      data-session-depth=${depth}
      style=${depth > 0 ? `--session-tree-depth:${Math.min(depth, 3)}` : nothing}
      .draggable=${canDrag}
      @dragstart=${(event: DragEvent) => {
        if (!canDrag || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        (event.currentTarget as HTMLElement).dispatchEvent(new Event("openclaw-session-menu-open", { bubbles: true }));
        writeSessionDrag(event.dataTransfer, session);
        props.onSessionDragStart(session);
      }}
      @dragend=${props.onSessionDragEnd}
    >
      <a
        href=${navigationPath({ kind: "session", id: session.id })}
        class="session-row sidebar-recent-session__link"
        draggable="false"
        data-status=${session.status}
        aria-current=${selected ? "true" : "false"}
        aria-label=${`${sessionAccessibleName(session)}${hasDraft ? ", draft" : ""}${splitOpen ? ", open in split pane" : ""}${session.jiraIssues?.length ? `, ${jiraIssueAccessibleLabel(session.jiraIssues.at(-1)!, session.jiraIssues.length)}` : ""}`}
        @click=${(event: MouseEvent) => {
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          closeContainingDrawer(event, false, true);
          props.onSelectSession(session);
        }}
      >
        <span class="sidebar-session-indicator" title=${attention?.label ?? (background ? "Watcher or subagent running" : session.creating ? worktreeProgressLabel(session.creating) : unread ? "Unread activity" : nothing)} aria-hidden="true">
          ${attention ? html`<span class="session-glyph"><span class="session-glyph__content"><span class="sidebar-session-attention__icon sidebar-session-attention__icon--${attention.tone}">${attention.icon}</span></span></span>` : nothing}
          ${!attention && !busy && depth > 0 && session.subagent ? renderChildStatus(session.subagent.status) : nothing}
          ${busy || session.creating ? html`<span class="session-glyph session-glyph--running session-glyph--bare"><span class="session-glyph__content"></span><span class="session-glyph__ring"></span></span>` : nothing}
          ${showJiraLead ? renderJiraBadge(session) : nothing}
          ${!busy && !attention && !showJiraLead && session.icon ? html`<span class="sidebar-session-custom-icon">${session.icon}</span>` : nothing}
          ${unread
            ? showJiraLead
              ? html`<span class="sidebar-session-unread-dot sidebar-session-unread-dot--corner"></span>`
              : html`<span class="sidebar-session-unread-dot"></span>`
            : nothing}
        </span>
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row">${renderHoverMarquee(session.title, "sidebar-recent-session__name")}</span>
          <span class="sidebar-recent-session__details"></span>
          ${depth > 0 && session.subagent ? html`<span class="sidebar-recent-session__duration">${subagentElapsed(session.subagent) ?? ""}</span>` : nothing}
          ${session.creating?.percent !== undefined ? html`<span class="sidebar-recent-session__duration">${session.creating.percent}%</span>` : nothing}
        </span>
      </a>
      ${renderPullRequestBadges(session)}
      <span class="sidebar-recent-session__aside session-row-aside">
      <span class="session-row-actions">
      <button
        class="session-action session-action--pin"
        data-sidebar-session-pin="true"
        type="button"
        title=${session.pinned ? "Unpin session" : "Pin session"}
        aria-label=${session.pinned ? "Unpin session" : "Pin session"}
        @click=${() => props.onTogglePin(session)}
      >${icons.pin}</button>
      <wa-dropdown class="session-menu" placement="bottom-end" distance="4" .open=${open}
        id=${menuId(session.id)} aria-label=${`Actions for ${session.title}`}
        @keydown=${sessionMenuShortcuts}
        @wa-show=${(event: Event) => { (event.currentTarget as HTMLElement).dispatchEvent(new Event("openclaw-session-menu-open", { bubbles: true })); labelDropdown(event); if (!open) props.onToggleMenu(session.id); }}
        @wa-hide=${() => { if (open) props.onCloseMenu(); }}
        @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
          const trigger = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[slot="trigger"]');
          trigger?.focus();
          props.onCloseMenu();
          if (event.detail.item.value === "rename") { props.onRenameSession(session); closeContainingDrawer(event); }
          if (event.detail.item.value === "pin") props.onTogglePin(session);
          if (event.detail.item.value === "unread") props.onUpdateSession(session, { unread: !session.unread }, session.unread ? "Marked as read." : "Marked as unread.");
          if (event.detail.item.value === "archive") props.onUpdateSession(session, { archived: true }, "Session archived.");
          if (event.detail.item.value.startsWith("move:")) props.onMoveSession(session, event.detail.item.value.slice(5));
          if (event.detail.item.value.startsWith("copy:")) props.onCopySession(session, event.detail.item.value.slice(5) as SessionCopyAction);
          if (event.detail.item.value.startsWith("open:")) props.onOpenSession(session, event.detail.item.value.slice(5) as SessionOpenAction);
          if (event.detail.item.value === "split") { props.onSplitSession(session); closeContainingDrawer(event); }
          if (event.detail.item.value === "jira:create") { props.onCreateJiraIssue(session); closeContainingDrawer(event); }
          if (event.detail.item.value === "jira:link") { props.onLinkJiraIssue(session); closeContainingDrawer(event); }
          if (event.detail.item.value === "delete") { props.onDeleteSession(session); closeContainingDrawer(event); }
        }}>
        <button slot="trigger" type="button"
          class="session-action session-row__menu-btn ${hasDraft ? "session-row__menu-btn--draft" : ""}"
          aria-label=${`Actions for ${session.title}`} data-session-menu-trigger=${session.id}>
          <span class="session-row__draft-icon" aria-hidden="true">${icons.edit}</span>
          <span class="session-row__more-icon" aria-hidden="true">${icons.moreHorizontal}</span>
        </button>
        <wa-dropdown-item value="pin" aria-keyshortcuts="P" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.pin}</span><span class="session-menu__text">${session.pinned ? "Unpin session" : "Pin session"}</span>${shortcut("P")}</wa-dropdown-item>
        <wa-dropdown-item value="rename" aria-keyshortcuts="R" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span><span class="session-menu__text">Rename…</span>${shortcut("R")}</wa-dropdown-item>
        <wa-dropdown-item value="unread" aria-keyshortcuts="U" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.circle}</span><span class="session-menu__text">${session.unread ? "Mark as read" : "Mark as unread"}</span>${shortcut("U")}</wa-dropdown-item>
        <wa-dropdown-item value="archive" aria-keyshortcuts="A" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.box}</span><span class="session-menu__text">Archive session</span>${shortcut("A")}</wa-dropdown-item>
        <wa-dropdown-item value="split" class="session-menu__item" ?disabled=${!props.selectedSessionId || selected || splitOpen}><span class="session-menu__text">Open in split pane</span></wa-dropdown-item>
        ${linkedJira ? nothing : html`
        <wa-dropdown-item value="jira:create" class="session-menu__item"><span slot="icon" class="session-menu__icon session-menu__icon--jira" aria-hidden="true">${brandIcons.jira}</span><span class="session-menu__text">Create Jira work item…</span></wa-dropdown-item>
        <wa-dropdown-item value="jira:link" class="session-menu__item"><span slot="icon" class="session-menu__icon session-menu__icon--jira" aria-hidden="true">${brandIcons.jira}</span><span class="session-menu__text">Link Jira work item…</span></wa-dropdown-item>`}
        <div class="session-menu__separator" role="separator"></div>
        ${appearanceMenu(session, props)}
        <wa-dropdown-item class="session-menu__item session-menu__move-root">
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span><span class="session-menu__text">Move to group</span>
          ${sessionMoveGroupOptions(props.groups).map((group) => html`<wa-dropdown-item slot="submenu" value=${`move:${group.value}`}
            class="session-menu__item session-menu__move-item" type="checkbox" .checked=${storedSessionGroup(session.group) === group.value}
            ?disabled=${storedSessionGroup(session.group) === group.value || props.sessionMovePendingId === session.id}>
            <span class="session-menu__text">${group.label}</span>
          </wa-dropdown-item>`)}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item class="session-menu__item">
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.copy}</span><span class="session-menu__text">Copy</span>
          <wa-dropdown-item slot="submenu" value="copy:link" class="session-menu__item"><span slot="icon" class="session-menu__icon">${icons.externalLink}</span><span class="session-menu__text">Session link</span></wa-dropdown-item>
          <wa-dropdown-item slot="submenu" value="copy:markdown" class="session-menu__item" ?disabled=${props.selectedSessionId !== session.id}><span slot="icon" class="session-menu__icon">${icons.fileText}</span><span class="session-menu__text">Conversation as Markdown</span></wa-dropdown-item>
          <wa-dropdown-item slot="submenu" value="copy:id" class="session-menu__item"><span slot="icon" class="session-menu__icon">${icons.copy}</span><span class="session-menu__text">Session ID</span></wa-dropdown-item>
          ${linkedJira ? html`<wa-dropdown-item slot="submenu" value="copy:jira" class="session-menu__item"><span slot="icon" class="session-menu__icon session-menu__icon--jira">${brandIcons.jira}</span><span class="session-menu__text">Jira link · ${linkedJira.key}</span></wa-dropdown-item>` : nothing}
        </wa-dropdown-item>
        <wa-dropdown-item class="session-menu__item">
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.externalLink}</span><span class="session-menu__text">Open in</span>
          <wa-dropdown-item slot="submenu" value="open:tab" class="session-menu__item"><span slot="icon" class="session-menu__icon">${icons.externalLink}</span><span class="session-menu__text">New tab</span></wa-dropdown-item>
          <wa-dropdown-item slot="submenu" value="open:window" class="session-menu__item"><span slot="icon" class="session-menu__icon">${icons.grid}</span><span class="session-menu__text">New window</span></wa-dropdown-item>
          <wa-dropdown-item slot="submenu" value="open:editor" class="session-menu__item"><span slot="icon" class="session-menu__icon">${icons.squareTerminal}</span><span class="session-menu__text">Workspace · VS Code</span></wa-dropdown-item>
          ${linkedJira ? html`<wa-dropdown-item slot="submenu" value="open:jira" class="session-menu__item"><span slot="icon" class="session-menu__icon session-menu__icon--jira">${brandIcons.jira}</span><span class="session-menu__text">Jira · ${linkedJira.key}</span></wa-dropdown-item>` : nothing}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item value="delete" aria-keyshortcuts="D" variant="danger" class="session-menu__item session-menu__item--destructive"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span><span class="session-menu__text">Delete…</span>${shortcut("D")}</wa-dropdown-item>
      </wa-dropdown>
      </span>
      </span>
      ${hasChildren ? html`<button
        type="button"
        class="session-tree-toggle"
        aria-label=${`${treeCollapsed ? "Expand" : "Collapse"} subagents of ${session.title}`}
        aria-expanded=${String(!treeCollapsed)}
        @click=${() => props.onToggleSessionTree(session.id)}
      ><span aria-hidden="true">${icons.chevronDown}</span></button>` : nothing}
    </div>
  `;
}

function groupSection(group: SidebarSessionGroup, props: ShellProps, filtering: boolean): TemplateResult {
  const fold = filtering ? undefined : { selectedId: props.selectedSessionId, toggled: props.toggledSessionTrees };
  // Each root and its visible descendants form one tree; the selected session's
  // open tree shares a panel so the parent and its subagents read as one unit.
  const rows = () => {
    const trees: SidebarSessionTreeRow[][] = [];
    for (const row of sessionTreeRows(group.sessions, fold)) {
      if (row.depth === 0 || !trees.length) trees.push([row]);
      else trees.at(-1)!.push(row);
    }
    return trees.map((tree) => {
      const rendered = tree.map(({ session, depth, hasChildren, collapsed }) =>
        sessionRow(session, session.id === props.selectedSessionId, props, depth, hasChildren, collapsed));
      return tree.length > 1 && tree.some(({ session }) => session.id === props.selectedSessionId)
        ? html`<div class="session-tree session-tree--active" data-session-stage=${isSessionStage(tree[0]!.session.stage) ? tree[0]!.session.stage : nothing}>${rendered}</div>`
        : rendered;
    });
  };
  if (group.kind === "none") {
    return html`<div class="session-group__rows sidebar-recent-sessions__list">
      ${rows()}
    </div>`;
  }
  const isCollapsed = isSessionGroupCollapsed(
    props.collapsed,
    group.key,
    filtering ? "filtered" : "",
  );
  const draggedSession = props.groups.flatMap((entry) => entry.sessions)
    .find((session) => session.id === props.draggingSessionId);
  const targetGroup = storedSessionGroup(group.label);
  const acceptsDrop = group.kind === "custom" && Boolean(draggedSession)
    && storedSessionGroup(draggedSession?.group ?? "") !== targetGroup;
  const dropActive = acceptsDrop && props.sessionDropTarget === group.key;
  const order = customGroupOrder(props.groups);
  const orderIndex = order.indexOf(group.label);
  const canDragGroup = group.kind === "custom" && orderIndex >= 0 && !props.groupReorderPending;
  const acceptsGroup = group.kind === "custom" && Boolean(props.draggingGroup) && props.draggingGroup !== group.label;
  const groupDropPosition = (event: DragEvent): GroupDropTarget["position"] => {
    // OTHER is always last, so anything dropped on it lands just above it.
    if (group.label === "ungrouped") return "before";
    const head = (event.currentTarget as HTMLElement).querySelector(".sidebar-recent-sessions__head") ?? event.currentTarget as HTMLElement;
    const rect = head.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  const groupDrop = acceptsGroup && props.groupDropTarget?.group === group.label ? props.groupDropTarget.position : undefined;
  return html`
    <section
      class="session-group sidebar-recent-sessions__group ${dropActive ? "sidebar-recent-sessions__group--session-drop" : ""} ${groupDrop ? `sidebar-recent-sessions__group--section-drop-${groupDrop}` : ""} ${props.draggingGroup === group.label ? "sidebar-recent-sessions__group--dragging" : ""}"
      data-session-group=${group.key}
      @dragover=${(event: DragEvent) => {
        if (props.draggingGroup) {
          if (!acceptsGroup) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          const position = groupDropPosition(event);
          if (props.groupDropTarget?.group !== group.label || props.groupDropTarget.position !== position) {
            props.onGroupDragOver({ group: group.label, position });
          }
          return;
        }
        if (!acceptsDrop) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        props.onSessionDragOver(group.key);
      }}
      @dragleave=${(event: DragEvent) => {
        if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return;
        if (props.draggingGroup) {
          props.onGroupDragLeave(group.label);
          return;
        }
        props.onSessionDragLeave(group.key);
      }}
      @drop=${(event: DragEvent) => {
        if (props.draggingGroup) {
          if (!acceptsGroup) return;
          event.preventDefault();
          props.onReorderGroup(props.draggingGroup, { group: group.label, position: groupDropPosition(event) });
          props.onGroupDragEnd();
          return;
        }
        if (!acceptsDrop || !draggedSession) return;
        event.preventDefault();
        props.onMoveSession(draggedSession, targetGroup);
        props.onSessionDragEnd();
      }}
    >
      <div
        class="sidebar-recent-sessions__head ${canDragGroup ? "sidebar-recent-sessions__head--draggable" : ""}"
        draggable=${canDragGroup ? "true" : "false"}
        @mousedown=${(event: MouseEvent) => {
          // The label/toggle starts a group drag (a plain click still toggles);
          // the New session and menu actions never do.
          (event.currentTarget as HTMLElement).toggleAttribute("data-group-drag-blocked", Boolean((event.target as Element).closest(".sidebar-session-group-actions")));
        }}
        @mouseup=${(event: MouseEvent) => (event.currentTarget as HTMLElement).removeAttribute("data-group-drag-blocked")}
        @dragstart=${(event: DragEvent) => {
          const head = event.currentTarget as HTMLElement;
          const blocked = head.hasAttribute("data-group-drag-blocked");
          head.removeAttribute("data-group-drag-blocked");
          if (!canDragGroup || blocked || !event.dataTransfer || event.target !== head) {
            if (event.target === head) event.preventDefault();
            return;
          }
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-hui-session-group", group.label);
          event.dataTransfer.setData("text/plain", sessionGroupLabel(group.label));
          props.onGroupDragStart(group.label);
        }}
        @dragend=${(event: DragEvent) => {
          if (event.target === event.currentTarget) props.onGroupDragEnd();
        }}
      >
        ${canDragGroup ? html`<span class="sidebar-session-group-drag-handle" aria-hidden="true"></span>` : nothing}
        <button
          type="button"
          class="session-group__toggle sidebar-session-group-toggle"
          aria-expanded=${String(!isCollapsed)}
          title=${group.kind === "project" ? group.cwd : nothing}
          @click=${() => props.onToggleGroup(group.key)}
        >
          <span class="session-group__chevron" aria-hidden="true">${icons.chevron}</span>
          <span class="session-group__label sidebar-recent-sessions__label-text">${sessionGroupLabel(group.label)}</span>
        </button>
        <span class="sidebar-session-group-actions">
          <button type="button" aria-label=${`New session in ${sessionGroupLabel(group.label)}`} @click=${(event: Event) => {
            closeContainingDrawer(event);
            openNewSession(props, group.kind === "project" ? { label: "ungrouped", cwd: group.cwd, sessions: [] } : group);
          }}>${icons.plus}</button>
          ${group.kind !== "custom" || group.label === "ungrouped" ? nothing : html`
            <wa-dropdown class="session-menu sidebar-session-group-menu" placement="bottom-end" distance="4"
              .open=${props.groupMenuFor === group.label} aria-label=${`Group options for ${group.label}`}
              @keydown=${closeDropdownOnEscape}
              @wa-show=${(event: Event) => { labelDropdown(event); if (props.groupMenuFor !== group.label) props.onToggleGroupMenu(group.label); }}
              @wa-hide=${() => { if (props.groupMenuFor === group.label) props.onCloseGroupMenu(); }}
              @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
                const action = event.detail.item.value;
                if (action === "move-up" || action === "move-down") {
                  props.onCloseGroupMenu();
                  const target = order[orderIndex + (action === "move-up" ? -1 : 1)];
                  if (target) props.onReorderGroup(group.label, { group: target, position: action === "move-up" ? "before" : "after" });
                  (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[slot="trigger"]')?.focus();
                  return;
                }
                if (action !== "defaults" && action !== "rename" && action !== "new" && action !== "delete") return;
                (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[slot="trigger"]')?.focus();
                props.onCloseGroupMenu();
                props.onGroupAction(action, group);
                closeContainingDrawer(event);
              }}>
              <button slot="trigger" type="button" aria-label=${`Group options for ${group.label}`} data-group-menu-trigger=${group.label}>${icons.moreHorizontal}</button>
              ${([
                ["defaults", "New session defaults", icons.settings],
                ["rename", "Rename group", icons.edit],
                ["new", "New group", icons.folder],
              ] as const).map(([action, label, icon]) => html`
                <wa-dropdown-item value=${action} class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span><span class="session-menu__text">${label}</span></wa-dropdown-item>
              `)}
              <div class="session-menu__separator" role="separator"></div>
              <wa-dropdown-item value="move-up" class="session-menu__item" ?disabled=${orderIndex <= 0 || props.groupReorderPending}><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.arrowUp}</span><span class="session-menu__text">Move group up</span></wa-dropdown-item>
              <wa-dropdown-item value="move-down" class="session-menu__item" ?disabled=${orderIndex < 0 || orderIndex >= order.length - 1 || props.groupReorderPending}><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.arrowDown}</span><span class="session-menu__text">Move group down</span></wa-dropdown-item>
              <div class="session-menu__separator" role="separator"></div>
              <wa-dropdown-item value="delete" variant="danger" class="session-menu__item session-menu__item--destructive"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span><span class="session-menu__text">Delete group</span></wa-dropdown-item>
            </wa-dropdown>`}

        </span>
      </div>
      ${
        isCollapsed
          ? nothing
          : html`<div class="session-group__rows sidebar-recent-sessions__list">
              ${rows()}
            </div>`
      }
    </section>
  `;
}

function renderImportNote(props: ShellProps) {
  if (!props.importNote) {
    return nothing;
  }
  return html`<p class="sidebar-list__note ${props.importFailed ? "is-error" : ""}" role="status">
    ${props.importNote}
  </p>`;
}

/** Kanban is a HUI-owned route, not an OpenClaw catalogue page; it sits
 * directly below Contributions. */
function kanbanNavItem(props: ShellProps) {
  const active = props.view === "kanban";
  return html`<a
    href=${navigationPath({ kind: "kanban" })}
    class="nav-item sidebar-nav__item ${active ? "nav-item--active" : ""}"
    aria-current=${active ? "page" : "false"}
    @click=${(event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      closeContainingDrawer(event, false, true);
      props.onOpenKanban();
    }}
  >
    <span class="nav-item__icon" aria-hidden="true">${kanbanIcon}</span>
    <span class="nav-item__text">Kanban</span>
  </a>`;
}

/** "Agents | Bots" as WAI-ARIA tabs with automatic activation. Agents keeps the
 * `sessions` id that browsers already remember. */
function renderSidebarTabs(bots: ShellBotsProps) {
  const tabs = [["sessions", "Agents"], ["bots", "Bots"]] as const;
  return html`<div class="sidebar-tabs" role="tablist" aria-label="Sidebar lists">
    ${tabs.map(([tab, label]) => html`<button type="button" role="tab" class="sidebar-tabs__tab" id=${`sidebar-tab-${tab}`}
      aria-selected=${String(bots.tab === tab)} aria-controls="sidebar-tabpanel" tabindex=${bots.tab === tab ? "0" : "-1"}
      @click=${() => { if (bots.tab !== tab) bots.onTab(tab); }}
      @keydown=${(event: KeyboardEvent) => {
        const next = tabAfterKey(SIDEBAR_TABS, bots.tab, event.key);
        if (!next) return;
        event.preventDefault();
        if (next !== bots.tab) bots.onTab(next);
        const list = (event.currentTarget as HTMLElement).parentElement;
        queueMicrotask(() => list?.querySelector<HTMLElement>(`#sidebar-tab-${next}`)?.focus());
      }}>${label}${tab === "bots" && bots.unread && bots.tab !== "bots"
        ? html`<span class="sidebar-tabs__dot" aria-hidden="true"></span><span class="sidebar-tabs__sr">, unread</span>`
        : nothing}</button>`)}
  </div>`;
}

export function renderSidebar(props: ShellProps) {
  const query = props.search.trim().toLocaleLowerCase();
  const filtering = Boolean(query) || props.sessionOptions.status !== "all";
  const visibleGroups = sidebarSessionGroups(props.groups, props.search, props.sessionOptions);
  // On the Bots tab the sidebar is the roster alone, as in Hermes: the primary
  // navigation and New session stay under Agents.
  const botsTab = props.bots.tab === "bots" ? props.bots : undefined;
  const searchLabel = botsTab ? "Search bots" : "Search sessions";
  return html`<hui-session-hovercard-provider .sessions=${props.groups.flatMap((group) => group.sessions)}>
    <header class="topbar">
      <div class="topnav-shell">
        <button
          type="button"
          class="topbar-icon-btn topbar-nav-toggle"
          aria-label="Open navigation"
          aria-controls="primary-navigation-drawer"
          aria-expanded="false"
          @click=${toggleNavigationDrawer}
        >${icons.menu}</button>
        <div class="topnav-shell__content">
          <div class="topbar-brand" aria-label="PI">
            <img class="topbar-brand__logo" src="/pi-logo-3d.png" alt="" aria-hidden="true" />
            <span class="topbar-brand__title">PI</span>
          </div>
        </div>
        <div class="topnav-shell__actions">
          <button type="button" class="topbar-search" aria-label=${searchLabel} @click=${focusSessionSearch}>
            ${icons.search}
          </button>
        </div>
      </div>
    </header>
    <button
      type="button"
      class="shell-nav-backdrop sidebar-backdrop"
      tabindex="-1"
      aria-label="Close navigation"
      @click=${(event: Event) => closeContainingDrawer(event, true)}
    ></button>
    <div class="shell-nav" id="primary-navigation-drawer">
    <aside
      class="sidebar"
      data-open=${String(SHELL_DRAWER_DEFAULT_OPEN)}
      tabindex="-1"
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape" && props.groupMenuFor) {
          event.preventDefault();
          event.stopPropagation();
          const trigger = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-group-menu-trigger="${CSS.escape(props.groupMenuFor)}"]`);
          props.onCloseGroupMenu();
          queueMicrotask(() => trigger?.focus());
          return;
        }
        if (event.key === "Escape" && props.menuFor) {
          event.preventDefault();
          event.stopPropagation();
          const sidebar = event.currentTarget as HTMLElement;
          const trigger = [...sidebar.querySelectorAll<HTMLElement>("[data-session-menu-trigger]")]
            .find((candidate) => candidate.dataset.sessionMenuTrigger === props.menuFor);
          props.onCloseMenu();
          queueMicrotask(() => trigger?.focus());
          return;
        }
        closeDrawerOnEscape(event);
      }}
    >
        <div class="sidebar-shell sidebar-drawer__body">
          <div class="sidebar-brand">
            <button type="button" class="sidebar-brand__icon sidebar-brand__header-control sidebar-brand__collapse" aria-label="Collapse sidebar" title="Collapse sidebar" aria-expanded="true" @click=${toggleDesktopSidebar}>${icons.panelLeftClose}</button>
            <div class="sidebar-switch">${renderSidebarTabs(props.bots)}</div>
          </div>

          <label class="sidebar-search ${(botsTab ? botsTab.search.trim() : query) ? "sidebar-search--active" : ""}">
            <span class="sidebar-search__icon" aria-hidden="true">${icons.search}</span>
            <input
              type="search"
              placeholder=${searchLabel}
              aria-label=${searchLabel}
              .value=${botsTab ? botsTab.search : props.search}
              @input=${(event: Event) => (botsTab ? botsTab.onSearch : props.onSearch)((event.target as HTMLInputElement).value)}
            />
          </label>

          <div class="sidebar-shell__content">
          <div class="sidebar-shell__body" id="sidebar-tabpanel" role="tabpanel" aria-labelledby="sidebar-tab-${props.bots.tab}">
          ${botsTab ? nothing : html`<nav class="sidebar-nav" aria-label="Primary navigation">
            ${PRIMARY_NAV.map((item) => {
              const page = HUI_PAGES.find((candidate) => candidate.id === item.id);
              return page ? html`
                <a
                  href=${navigationPath({ kind: "page", page })}
                  class="nav-item sidebar-nav__item ${props.view === "surface" && props.activePage?.id === page.id ? "nav-item--active" : ""}"
                  aria-current=${props.view === "surface" && props.activePage?.id === page.id ? "page" : "false"}
                  @click=${(event: MouseEvent) => {
                    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    closeContainingDrawer(event, false, true);
                    props.onOpenPage(page);
                  }}
                >
                  <span class="nav-item__icon" aria-hidden="true">${item.icon}</span>
                  <span class="nav-item__text">${item.label}</span>
                </a>${item.id === "contributions" ? kanbanNavItem(props) : nothing}` : nothing;
            })}
            <a
              href="/settings/appearance"
              class="nav-item sidebar-nav__item sidebar-nav__settings"
              aria-current="false"
              @click=${(event: MouseEvent) => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                closeContainingDrawer(event, false, true);
                props.onOpenSettings();
              }}
            >
              <span class="nav-item__icon" aria-hidden="true">${icons.settings}</span>
              <span class="nav-item__text">Settings</span>
            </a>
          </nav>`}

          <div class=${botsTab ? "sidebar-sessions sidebar-sessions--bots" : "sidebar-sessions"}>
          <div class="sidebar-recent-sessions__toolbar sidebar-session-toolbar">
            <span>${botsTab ? "Bots" : "Sessions"}</span>
            <span>
              ${botsTab ? renderNewBotButton({
                workers: botsTab.workers, onNew: botsTab.onNew, onCreate: botsTab.onCreate, onImport: botsTab.onImport, creating: botsTab.creating,
                ...(botsTab.onWorkersMenu ? { onOpen: botsTab.onWorkersMenu } : {}),
                closeDrawer: (event) => closeContainingDrawer(event),
              }) : html`
              ${renderSidebarSessionOptions(props.sessionOptions, props.onSessionOptions)}
              <button type="button" aria-label="New group" title="New group" data-new-group-trigger @click=${(event: Event) => {
                props.onNewGroup();
                closeContainingDrawer(event);
              }}>${icons.plus}</button>`}
            </span>
          </div>

          ${botsTab ? html`<div class="sidebar-list sidebar-recent-sessions bot-roster" aria-label="Bots">
            ${renderBotRoster(botsTab.roster, {
              navigate: (event) => closeContainingDrawer(event, false, true),
              dialog: (event) => closeContainingDrawer(event),
            })}
          </div>` : html`<div class="sidebar-list sidebar-recent-sessions" aria-label="Sessions">
        ${
          props.error
            ? html`<p class="sidebar-list__note is-error">${props.error}</p>`
            : props.loading
              ? html`<p class="sidebar-list__note">Loading sessions…</p>`
            : visibleGroups.length === 0
              ? html`
                    <div class="sidebar-empty">
                      <p class="sidebar-list__note" role="status">${filtering ? "No matching sessions." : "No sessions yet."}</p>
                      ${filtering ? nothing : renderImportNote(props)}
                    </div>
                  `
                : html`${visibleGroups.map((group) => groupSection(group, props, filtering))}`
        }
          </div>`}
          </div>
          </div>

          </div>
        </div>
    </aside>
    </div>
    <button type="button" class="shell-chrome-controls" aria-label="Expand sidebar" @click=${toggleDesktopSidebar}>${icons.panelLeftOpen}</button>
  </hui-session-hovercard-provider>`;
}

function openNewSession(props: ShellProps, group?: SessionGroup) {
  props.onNewSession(group);
}

function shellFromEvent(event: Event): HTMLElement | null {
  return event.currentTarget instanceof HTMLElement
    ? event.currentTarget.closest<HTMLElement>(".app-shell")
    : null;
}

function focusSessionSearch(event: Event) {
  const shell = shellFromEvent(event);
  const sidebar = shell?.querySelector<HTMLElement>(".sidebar");
  if (sidebar && matchMedia(APP_SHELL_DRAWER_MEDIA).matches && sidebar.dataset.open !== "true") {
    setNavigationDrawer(sidebar, true, false);
  }
  queueMicrotask(() => shell?.querySelector<HTMLInputElement>(".sidebar-search input")?.focus());
}

function toggleDesktopSidebar(event: Event) {
  const shell = shellFromEvent(event);
  if (!shell || matchMedia(APP_SHELL_DRAWER_MEDIA).matches) {
    return;
  }
  const collapsed = shell.dataset["navCollapsed"] !== "true";
  shell.dataset["navCollapsed"] = String(collapsed);
  shell.querySelector<HTMLElement>(".sidebar-brand__collapse")
    ?.setAttribute("aria-expanded", String(!collapsed));
  // The collapse toggle and the restore control share one spot, so focus moves to
  // whichever is now shown: a second click or Enter in place undoes the first.
  const next = collapsed ? ".shell-chrome-controls" : ".sidebar-brand__collapse";
  requestAnimationFrame(() => shell.querySelector<HTMLElement>(next)?.focus());
}

export function closeDrawerOnEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") {
    return;
  }
  const current = event.currentTarget;
  if (!(current instanceof HTMLElement)) {
    return;
  }
  const sidebar = current.matches(".sidebar")
    ? current
    : current.querySelector<HTMLElement>(".sidebar");
  if (!sidebar || sidebar.dataset.open !== "true") {
    return;
  }
  event.preventDefault();
  setNavigationDrawer(sidebar, false, true);
}

export function toggleNavigationDrawer(event: Event) {
  const sidebar = shellFromEvent(event)?.querySelector<HTMLElement>(".sidebar");
  if (sidebar) {
    setNavigationDrawer(sidebar, sidebar.dataset.open !== "true", false);
  }
}

function closeContainingDrawer(event: Event, returnFocus = false, focusMain = false) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement) || !matchMedia(APP_SHELL_DRAWER_MEDIA).matches) {
    return;
  }
  const sidebar = target.closest<HTMLElement>(".app-shell")?.querySelector<HTMLElement>(".sidebar");
  if (!sidebar) {
    return;
  }
  setNavigationDrawer(sidebar, false, returnFocus);
  if (focusMain) {
    queueMicrotask(() =>
      sidebar.closest<HTMLElement>(".app-shell")
        ?.querySelector<HTMLElement>(".main-header__title")
        ?.focus(),
    );
  }
}

/** Keep the drawer's visual and accessibility states in one transaction. The
 * main region must not remain keyboard- or screen-reader-reachable behind the
 * modal drawer on narrow screens. */
export function setNavigationDrawer(
  sidebar: HTMLElement,
  open: boolean,
  returnFocus: boolean,
  media?: DrawerMediaQuery,
) {
  const reconciledOpen = open && bindDrawerToNarrowMedia(
    sidebar,
    () => setNavigationDrawer(sidebar, false, false),
    media,
  );
  if (!reconciledOpen) {
    unbindDrawerMedia(sidebar);
  }
  sidebar.dataset.open = String(reconciledOpen);
  const shell = typeof sidebar.closest === "function"
    ? sidebar.closest<HTMLElement>(".app-shell")
    : null;
  const trigger = shell?.querySelector<HTMLButtonElement>(".chat-pane__nav-toggle")
    ?? shell?.querySelector<HTMLButtonElement>(".topbar-nav-toggle")
    ?? sidebar.querySelector<HTMLButtonElement>(".topbar");
  const main = shell?.querySelector<HTMLElement>(".main")
    ?? sidebar.parentElement?.querySelector<HTMLElement>(".main");
  trigger?.setAttribute("aria-expanded", String(reconciledOpen));
  trigger?.setAttribute("aria-label", reconciledOpen ? "Close navigation" : "Open navigation");
  main?.toggleAttribute("inert", reconciledOpen);
  sidebar.closest?.(".hui-application")?.querySelector(".hui-update-notice")?.toggleAttribute("inert", reconciledOpen);
  if (reconciledOpen && typeof sidebar.focus === "function") {
    queueMicrotask(() => sidebar.focus());
  }
  if (!reconciledOpen && returnFocus) {
    trigger?.focus();
  }
}

/** Every routed view renders its own header, so main only hosts the body. */
export function renderMain(props: ShellProps, body: TemplateResult) {
  const chatLike =
    props.view === "home" ||
    props.view === "bot" ||
    (props.view === "surface" && props.activePage?.id === "new-session");
  return html`
    <main id="control-ui-main" class="main content ${chatLike ? "content--chat" : ""}">
      ${body}
    </main>
  `;
}
