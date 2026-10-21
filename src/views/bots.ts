/**
 * The Bots tab: the sidebar roster, a bot's side panel (its overview, after
 * OpenAI's Dots, and the Routines, Triggers, Tools and Settings pages its rows
 * open, the last three in `bot-triggers.ts`, `bot-tools.ts` and
 * `bot-settings.ts`; its resizable edge and Expand) and the archive and delete
 * confirmations. Rendering only; every read and write is a prop callback owned
 * by `hui-app.ts`, and a drag only moves the panel's edge until it ends. The
 * bot's chat is the ordinary session pane (`renderHome`) with a bot header, not
 * a fork.
 */
import { renderBotFacts } from "./bot-facts.ts";
import type { BotFactsActions, BotFactsState } from "../lib/bots/facts.ts";
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../lib/icons.ts";
import { closeDropdownOnEscape, hasOpenWebAwesomePopup, labelDropdown } from "../lib/web-awesome.ts";
import { navigationPath } from "../lib/navigation.ts";
import { botLook, type BotView } from "../lib/bots/bots.ts";
import type { BotTrigger } from "../api/schema/bot-triggers.ts";
import type { WorkerState } from "../api/schema/workers.ts";
import { rosterFaceState, type BotFaceSize, type BotFaceState } from "../lib/bots/face.ts";
import "../components/bot-face.ts";
import type { AutomationRun, AutomationSnapshot, AutomationTask, AutomationTaskInput } from "../api/schema/automation.ts";
import { automationRunLabel, automationRunRecoveryDetail } from "../lib/automation-recovery.ts";
import {
  archivedBotCount,
  archivedRosterBots,
  botAccessibleName,
  botActivity,
  botActivityAt,
  botActivityLabel,
  botPreview,
  clampBotPanelWidth,
  compactRelativeTime,
  hiddenBotCount,
  rosterBots,
  botSettingsShortcutLabel,
  BOT_PANEL_MIN_WIDTH,
  type BotActivity,
  type BotPanelView,
} from "../lib/bots/roster.ts";
import { botRecentRuns, botRoutineRuns, botRoutines, routineFacts, routineSchedule, RoutineFormError, ROUTINE_WEEKDAYS } from "../lib/bots/routines.ts";
import { botToolsOffLabel } from "../lib/bots/tools.ts";
import { describeRoutineSchedule, formatTimestamp } from "./settings-automation.ts";
import { renderSettingsToggle } from "./settings-toggle.ts";
import { botCallsLabel, botModelLabel, botTaggingLabel, renderBotSettings, type BotSettingsProps } from "./bot-settings.ts";
import { renderBotToolsTab, type BotToolsProps } from "./bot-tools.ts";
import { agoLabel, renderBotTriggers, TRIGGER_RUN_LABELS, type BotTriggersProps } from "./bot-triggers.ts";
import { loadViewAssets } from "../lib/view-assets.ts";

loadViewAssets(() => import("../styles/bots.css"));

/* ── avatar ───────────────────────────────────────────────────────────────── */

export type BotAvatarOptions = {
  /** What the face shows; an emoji has no expressions. */
  state?: BotFaceState;
  badge?: TemplateResult | typeof nothing;
  /** The call's audio level (0–1) for a large face that speaks or listens. */
  level?: () => number | undefined;
};

/** A bot's face (or its emoji, while it has one), decorative: the name and status stay in text beside it. */
export function renderBotAvatar(bot: Pick<BotView, "id" | "avatar">, size: BotFaceSize = "md", options: BotAvatarOptions = {}) {
  const look = botLook(bot);
  const badge = options.badge ?? nothing;
  if (look.kind === "emoji") {
    return html`<span class="bot-avatar bot-avatar--${size} bot-avatar--emoji" style=${`--bot-avatar-color: ${look.color}`} aria-hidden="true"><span class="bot-avatar__glyph">${look.emoji}</span>${badge}</span>`;
  }
  return html`<span class="bot-avatar bot-avatar--${size} bot-avatar--face" aria-hidden="true"><hui-bot-face size=${size} shape=${look.shape} ears=${look.ears ?? ""} .color=${look.color}
    .seed=${look.seed} state=${options.state ?? "idle"} .level=${options.level}></hui-bot-face>${badge}</span>`;
}

function activityBadge(activity: BotActivity) {
  if (activity === "done") return html`<span class="bot-avatar__badge bot-avatar__badge--done" title="Done"></span>`;
  if (activity === "sleeping") return html`<span class="bot-avatar__badge bot-avatar__badge--sleeping" title="Sleeping">z</span>`;
  if (activity === "waiting") return html`<span class="bot-avatar__badge bot-avatar__badge--waiting" title="Waiting for your answer">${icons.hand}</span>`;
  if (activity === "error") return html`<span class="bot-avatar__badge bot-avatar__badge--error" title="Failed">${icons.alertTriangle}</span>`;
  if (activity === "away") return html`<span class="bot-avatar__badge bot-avatar__badge--away" title="Unreachable">${icons.plug}</span>`;
  return nothing;
}

/* ── roster ───────────────────────────────────────────────────────────────── */

export type BotRosterProps = {
  bots: readonly BotView[];
  /** The first read is still pending; a refresh keeps the current rows. */
  loading: boolean;
  error: string;
  query: string;
  showHidden: boolean;
  /** Archived bots listed below the roster, each with Restore. */
  showArchived: boolean;
  activeBotId: string;
  menuFor: string;
  /** Pending Hide/Unhide, archive, restore or delete, so the row cannot be acted on twice. */
  pendingId: string;
  now: number;
  onSelect: (bot: BotView) => void;
  /** Creates a bot at once on this machine (the gateway calls it "New Bot") and opens its chat. */
  onNew: () => void;
  /** A bot is being created: New bot waits for it. */
  creating: boolean;
  onEdit: (bot: BotView) => void;
  onSetHidden: (bot: BotView, hidden: boolean) => void;
  onArchive: (bot: BotView) => void;
  onToggleShowHidden: () => void;
  onToggleShowArchived: () => void;
  onRestore: (bot: BotView) => void;
  /** Asks before deleting a bot for good, active or archived. */
  onDelete: (bot: BotView) => void;
  /** Export…: the bot as a file HUI imports again. */
  onExport: (bot: BotView) => void;
  /** Import bot…, from the empty roster as from +. */
  onImport: () => void;
  onRetry: () => void;
  onToggleMenu: (id: string) => void;
  onCloseMenu: () => void;
};

/** Drawer handling stays with the shell, which owns the mobile navigation. */
export type RosterDrawer = { navigate: (event: Event) => void; dialog: (event: Event) => void };

function rosterMenuId(id: string): string {
  return `bot-actions-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function botRow(bot: BotView, props: BotRosterProps, drawer: RosterDrawer) {
  const active = props.activeBotId === bot.id;
  const open = props.menuFor === bot.id;
  const at = botActivityAt(bot);
  const activity = botActivity(bot, active);
  const preview = activity === "summarizing" ? "Summarizing memory…" : activity === "waiting" ? "Waiting for your answer" : botPreview(bot);
  const unread = bot.unread && !active;
  return html`<div
    class="session-row-wrap session-row-host sidebar-recent-session bot-row ${active ? "sidebar-recent-session--active" : ""} ${unread ? "sidebar-recent-session--unread" : ""} ${bot.hidden ? "bot-row--hidden" : ""} ${props.pendingId === bot.id ? "sidebar-recent-session--moving" : ""}"
    data-bot-id=${bot.id} data-session-row-action-count="1">
    <a href=${navigationPath({ kind: "bot", id: bot.id })} class="session-row sidebar-recent-session__link bot-row__link" draggable="false"
      aria-current=${active ? "true" : "false"} aria-label=${botAccessibleName(bot, active)}
      @click=${(event: MouseEvent) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        drawer.navigate(event);
        props.onSelect(bot);
      }}>
      ${renderBotAvatar(bot, "sm", { state: rosterFaceState(bot, active), badge: activityBadge(activity) })}
      <span class="bot-row__text">
        <span class="bot-row__top">
          <span class="bot-row__name sidebar-recent-session__name">${bot.name}</span>
          ${bot.memory?.failing ? html`<span class="bot-row__warning" title=${`Memory summaries are failing: ${bot.memory.failing.error}`}>${icons.alertTriangle}</span>` : nothing}
          <time class="bot-row__time" datetime=${at ? new Date(at).toISOString() : nothing} title=${at ? new Date(at).toLocaleString() : nothing}>${compactRelativeTime(at, props.now)}</time>
        </span>
        <span class="bot-row__bottom">
          ${bot.worker ? html`<span class="bot-row__tag bot-row__machine" title=${`Runs on ${bot.worker.name}`}>${icons.globe}<span>${bot.worker.name}</span></span>` : nothing}
          ${bot.hidden ? html`<span class="bot-row__tag">Hidden</span>` : nothing}
          <span class="bot-row__preview">${preview}</span>
        </span>
      </span>
    </a>
    <span class="sidebar-recent-session__aside session-row-aside">
      <span class="session-row-actions">
        <wa-dropdown class="session-menu" placement="bottom-end" distance="4" .open=${open} id=${rosterMenuId(bot.id)}
          @keydown=${closeDropdownOnEscape}
          @wa-show=${(event: Event) => { labelDropdown(event); if (!open) props.onToggleMenu(bot.id); }}
          @wa-hide=${() => { if (open) props.onCloseMenu(); }}
          @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
            (event.currentTarget as HTMLElement).querySelector<HTMLElement>('[slot="trigger"]')?.focus();
            props.onCloseMenu();
            const action = event.detail.item.value;
            if (action === "edit") { drawer.dialog(event); props.onEdit(bot); }
            if (action === "hide") props.onSetHidden(bot, !bot.hidden);
            if (action === "export") { drawer.dialog(event); props.onExport(bot); }
            if (action === "archive") { drawer.dialog(event); props.onArchive(bot); }
            if (action === "delete") { drawer.dialog(event); props.onDelete(bot); }
          }}>
          <button slot="trigger" type="button" class="session-action session-row__menu-btn" aria-label=${`Actions for ${bot.name}`} ?disabled=${props.pendingId === bot.id}>
            <span class="session-row__more-icon" aria-hidden="true">${icons.moreHorizontal}</span>
          </button>
          <wa-dropdown-item value="edit" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span><span class="session-menu__text">Edit bot…</span></wa-dropdown-item>
          <wa-dropdown-item value="hide" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.eye}</span><span class="session-menu__text">${bot.hidden ? "Unhide" : "Hide"}</span></wa-dropdown-item>
          <wa-dropdown-item value="export" class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.download}</span><span class="session-menu__text">Export…</span></wa-dropdown-item>
          <div class="session-menu__separator" role="separator"></div>
          <wa-dropdown-item value="archive" variant="danger" class="session-menu__item session-menu__item--destructive"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.box}</span><span class="session-menu__text">Archive…</span></wa-dropdown-item>
          <wa-dropdown-item value="delete" variant="danger" class="session-menu__item session-menu__item--destructive"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span><span class="session-menu__text">Delete…</span></wa-dropdown-item>
        </wa-dropdown>
      </span>
    </span>
  </div>`;
}

/** An archived bot keeps its chat and memory but has no chat to open until
 * it is restored, so its row is not a link. Restore brings it back; Delete,
 * after a confirmation, removes it for good. */
function archivedRow(bot: BotView, props: BotRosterProps, drawer: RosterDrawer) {
  const pending = props.pendingId === bot.id;
  return html`<li class="bot-archived-row" data-bot-id=${bot.id}>
    ${renderBotAvatar(bot, "sm", { state: "offline" })}
    <span class="bot-archived-row__text">
      <span class="bot-archived-row__name">${bot.name}</span>
      <span class="bot-archived-row__meta">${bot.title || botPreview(bot)}</span>
    </span>
    <button type="button" class="btn btn--sm bot-archived-row__restore" ?disabled=${pending} aria-label=${`Restore ${bot.name}`}
      @click=${() => props.onRestore(bot)}>${pending ? "Restoring…" : "Restore"}</button>
    <button type="button" class="btn btn--sm bot-archived-row__delete" ?disabled=${pending} aria-label=${`Delete ${bot.name}`} title="Delete"
      @click=${(event: Event) => { drawer.dialog(event); props.onDelete(bot); }}>${icons.trash}</button>
  </li>`;
}

/** Show hidden (N) and Show archived (N), each only while some are; then,
 * while Show archived is on, the archived bots with Restore and Delete. */
function renderRosterToggles(props: BotRosterProps, drawer: RosterDrawer) {
  const hidden = hiddenBotCount(props.bots);
  const archived = archivedBotCount(props.bots);
  if (!hidden && !archived) return nothing;
  const rows = props.showArchived && archived ? archivedRosterBots(props.bots, props.query) : [];
  return html`<div class="bot-roster__toggles">
      ${hidden ? html`<button type="button" class="bot-roster__hidden-toggle" aria-pressed=${String(props.showHidden)} @click=${props.onToggleShowHidden}>
        ${icons.eye}<span>Show hidden (${hidden})</span></button>` : nothing}
      ${archived ? html`<button type="button" class="bot-roster__hidden-toggle" aria-pressed=${String(props.showArchived)} @click=${props.onToggleShowArchived}>
        ${icons.box}<span>Show archived (${archived})</span></button>` : nothing}
    </div>
    ${props.showArchived && archived ? html`<section class="bot-roster__archived" aria-label="Archived bots">
      ${rows.length
        ? html`<ul class="bot-roster__archived-list">${rows.map((bot) => archivedRow(bot, props, drawer))}</ul>`
        : html`<p class="sidebar-list__note" role="status">No matching archived bots.</p>`}
    </section>` : nothing}`;
}

export function renderBotRoster(props: BotRosterProps, drawer: RosterDrawer) {
  const known = props.bots.filter((bot) => !bot.archived);
  if (!known.length) {
    if (props.error) {
      return html`<div class="sidebar-empty bot-roster__state"><p class="sidebar-list__note is-error" role="alert">${props.error}</p>
        <button type="button" class="btn btn--sm" @click=${props.onRetry}>Retry</button></div>`;
    }
    if (props.loading) return html`<p class="sidebar-list__note" role="status">Loading bots…</p>`;
    const archived = archivedBotCount(props.bots);
    return html`<div class="sidebar-empty bot-roster__empty">
      <p class="bot-roster__empty-title">${archived ? "No active bots" : "No bots yet"}</p>
      <p class="sidebar-list__note">${archived
        ? `${archived === 1 ? "One archived bot keeps its chat and memory" : `${archived} archived bots keep their chats and memory`}; Show archived lists ${archived === 1 ? "it" : "them"} to restore or delete.`
        : "A bot is a named agent with one permanent chat, its own model and a memory that summarizes older messages by itself. Routines can message it on a schedule."}</p>
      <div class="bot-roster__empty-actions">
        <button type="button" class="btn btn--sm bot-roster__new" ?disabled=${props.creating} aria-busy=${props.creating ? "true" : "false"}
          @click=${(event: Event) => { drawer.navigate(event); props.onNew(); }}>${icons.plus}<span>${props.creating ? "Creating…" : "New bot"}</span></button>
        <button type="button" class="btn btn--sm bot-roster__import" @click=${(event: Event) => { drawer.dialog(event); props.onImport(); }}>${icons.fileText}<span>Import bot…</span></button>
      </div>
    </div>
    ${renderRosterToggles(props, drawer)}`;
  }
  const rows = rosterBots(props.bots, { query: props.query, showHidden: props.showHidden });
  return html`${props.error ? html`<p class="sidebar-list__note is-error" role="alert">${props.error} <button type="button" class="btn btn--sm" @click=${props.onRetry}>Retry</button></p>` : nothing}
    <div class="session-group__rows sidebar-recent-sessions__list bot-roster__rows">
      ${rows.length
        ? repeat(rows, (bot) => bot.id, (bot) => botRow(bot, props, drawer))
        : html`<p class="sidebar-list__note" role="status">${props.query.trim() ? "No matching bots." : "Every bot is hidden."}</p>`}
    </div>
    ${renderRosterToggles(props, drawer)}`;
}

/* ── new bot ──────────────────────────────────────────────────────────────── */

/** A remote worker a new bot can be created on (Settings → Workers). */
export type BotPlace = { id: string; name: string; state: WorkerState };

export type NewBotButtonProps = {
  /** None: the menu's New bot creates it on this machine. */
  workers: readonly BotPlace[];
  /** New bot, without workers. */
  onNew: () => void;
  /** A menu choice: creates the bot at once on the worker with this id, or on this machine (undefined). */
  onCreate: (worker: string | undefined) => void;
  /** Import bot…: one from another platform's template, or a HUI export. */
  onImport: () => void;
  /** The menu opens: a chance to read the workers' state again. */
  onOpen?: () => void;
  /** After a choice, as the roster's other actions close the mobile drawer. */
  closeDrawer: (event: Event) => void;
  /** A bot is being created: + waits for it. */
  creating?: boolean;
};

/**
 * The roster's +, a small menu: New bot, then Import bot…. While a remote worker exists New bot is New bot on Local or on
 * each worker, and a choice creates the bot there at once: a bot stays on the machine it is created on.
 */
export function renderNewBotButton(props: NewBotButtonProps) {
  const busy = Boolean(props.creating);
  return html`<wa-dropdown class="session-menu new-bot-menu" placement="bottom-end" distance="4" @keydown=${closeDropdownOnEscape}
    @wa-show=${(event: Event) => { labelDropdown(event); props.onOpen?.(); }}
    @wa-select=${(event: CustomEvent<{ item: { value: string } }>) => {
      const value = event.detail.item.value;
      if (value === IMPORT_BOT) props.onImport();
      else if (!props.workers.length) props.onNew();
      else props.onCreate(value === NEW_BOT_LOCAL ? undefined : value);
      props.closeDrawer(event);
    }}>
    <button slot="trigger" type="button" aria-label="New bot" title="New bot" data-new-bot-trigger ?disabled=${busy} aria-busy=${busy ? "true" : "false"}>${icons.plus}</button>
    ${props.workers.length ? html`<wa-dropdown-item value=${NEW_BOT_LOCAL} class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.terminal}</span><span class="session-menu__text">New bot on Local</span></wa-dropdown-item>
    ${props.workers.map((worker) => html`<wa-dropdown-item value=${worker.id} class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.globe}</span><span class="session-menu__text">New bot on ${worker.name}${worker.state === "connected"
      ? nothing
      : html` <span class="settings-row__muted">· ${worker.state === "error" ? "offline" : worker.state}</span>`}</span></wa-dropdown-item>`)}`
      : html`<wa-dropdown-item value=${NEW_BOT_LOCAL} class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.plus}</span><span class="session-menu__text">New bot</span></wa-dropdown-item>`}
    <div class="session-menu__separator" role="separator"></div>
    <wa-dropdown-item value=${IMPORT_BOT} class="session-menu__item"><span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.fileText}</span><span class="session-menu__text">Import bot…</span></wa-dropdown-item>
  </wa-dropdown>`;
}

/** The menu item for this machine, and Import bot…; worker ids are UUIDs, so they never collide with either. */
const NEW_BOT_LOCAL = "local";
const IMPORT_BOT = "import";

/* ── chat placeholder (no bot or no chat yet) ─────────────────────────────── */

export type BotPlaceholderProps = {
  title: string;
  message: string;
  tone: "status" | "alert";
  mobileNav: boolean;
  onRetry?: () => void;
  /** The action's label; "Retry" unless the placeholder offers something else. */
  actionLabel?: string;
  onToggleNavigation: (event: Event) => void;
};

export function renderBotPlaceholder(props: BotPlaceholderProps) {
  return html`<div class="bot-workspace bot-workspace--placeholder">
    <header class="transcript__head chat-pane__header bot-workspace__header">
      <div class="chat-pane__header-leading">
        ${props.mobileNav ? html`<button class="btn btn--ghost btn--icon chat-icon-btn chat-pane__nav-toggle" type="button" aria-label="Open navigation"
          aria-controls="primary-navigation-drawer" aria-expanded="false" @click=${props.onToggleNavigation}>${icons.menu}</button>` : nothing}
        <div class="transcript__identity chat-pane__crumbs"><h2 class="transcript__title chat-pane__session-title">${props.title}</h2></div>
      </div>
    </header>
    <div class="agent-chat__empty bot-workspace__message" role=${props.tone}>
      <span>${props.message}</span>
      ${props.onRetry ? html`<button type="button" class="btn btn--sm" @click=${props.onRetry}>${props.actionLabel ?? "Retry"}</button>` : nothing}
    </div>
  </div>`;
}

/* ── side panel ───────────────────────────────────────────────────────────── */

export type BotPanelProps = {
  bot: BotView;
  id: string;
  /** The bot's overview, or a page one of its rows opened. */
  view: BotPanelView;
  /** The row that opened the page showing (its `data-panel-link`): a section's + opens its page on the add form. */
  openedFrom?: string;
  /** Narrow layouts show the panel as a sheet over the chat; a sheet neither resizes nor expands. */
  sheet: boolean;
  /** Expand is offered: docked, and no call is under way (a call shows over the chat, which an expanded panel hides). */
  expandable: boolean;
  /** The panel fills the bot's view, its chat hidden underneath. */
  expanded: boolean;
  /** Its width beside the chat, as the operator left it. */
  width: number;
  timezone: string;
  /** The profile's Call (the chat header's own button), while the bot can be called: an expanded panel hides the
   * chat's header. */
  call?: TemplateResult;
  onView: (view: BotPanelView, from?: string) => void;
  onClose: () => void;
  onExpand: (expanded: boolean) => void;
  /** The width a drag or the keys settled on, already within the room the chat leaves. */
  onResize: (width: number) => void;
  routines: {
    automation: AutomationSnapshot | undefined;
    error: string;
    pending: boolean;
    formError: string;
    actionError: string;
    onCreate: (input: AutomationTaskInput) => Promise<boolean>;
    onFormError: (message: string) => void;
    onSetEnabled: (task: AutomationTask, enabled: boolean) => void;
    onRun: (task: AutomationTask) => void;
    onDelete: (task: AutomationTask) => void;
    onRetry: () => void;
  };
  /** The Tools page's state and actions (`BotToolsController.props`). */
  tools: Omit<BotToolsProps, "bot">;
  facts?: { state: BotFactsState } & BotFactsActions;
  /** The triggers, on the overview and their page (`BotTriggersController.props`). */
  triggers: Omit<BotTriggersProps, "bot" | "now">;
  /** The Settings page: everything but the bot, the ids and its face, which the panel supplies. */
  settings: Omit<BotSettingsProps, "bot" | "id" | "face">;
};

const VIEW_TITLES: Record<Exclude<BotPanelView, "overview">, string> = { routines: "Routines", triggers: "Triggers", tools: "Tools & skills", settings: "Settings", facts: "Memory" };

const playIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`;
/** Lucide maximize-2 and minimize-2, as the Work pane's. */
const expandIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /><path d="M9 21H3v-6" /></svg>`;
const restoreIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 10 7-7" /><path d="M20 10h-6V4" /><path d="m3 21 7-7" /><path d="M4 14h6v6" /></svg>`;

/* ── the routines page ── */

function renderRoutine(task: AutomationTask, props: BotPanelProps) {
  const { routines } = props;
  return html`<li class="bot-routine ${task.enabled ? "" : "bot-routine--paused"}" data-routine=${task.id}>
    <div class="bot-routine__head">
      <span class="bot-routine__name">${task.name}</span>
      ${renderSettingsToggle(`Enable ${task.name}`, task.enabled, (checked) => routines.onSetEnabled(task, checked), routines.pending)}
    </div>
    <p class="bot-routine__meta">${routineWhen(task)}</p>
    ${renderRoutineFacts(task, props)}
    <p class="bot-routine__prompt" title=${task.prompt}>${task.prompt}</p>
    <div class="bot-routine__actions">
      <button type="button" class="btn btn--sm bot-routine__run" ?disabled=${routines.pending} aria-label=${`Run now: ${task.name}`} @click=${() => routines.onRun(task)}>${playIcon}<span>Run now</span></button>
      <button type="button" class="btn btn--sm btn--ghost bot-routine__delete" ?disabled=${routines.pending} aria-label=${`Delete ${task.name}`} @click=${() => routines.onDelete(task)}>${icons.trash}<span>Delete</span></button>
    </div>
  </li>`;
}

/** "Daily at 08:00 · next Tomorrow 08:00", or "… · paused". */
function routineWhen(task: AutomationTask): string {
  return `${describeRoutineSchedule(task.schedule)} · ${task.enabled ? `next ${formatTimestamp(task.nextRunAt)}` : "paused"}`;
}

/** Who made a routine when the bot did, and a temporary routine's limits: "made by @ada", "until 18:00", "3 runs left". */
function renderRoutineFacts(task: AutomationTask, props: BotPanelProps) {
  const facts = routineFacts(task, { handle: (botId) => (botId === props.bot.id ? props.bot.handle : undefined), timeZone: props.timezone });
  return facts.length
    ? html`<ul class="bot-routine__facts" aria-label=${`About ${task.name}`}>${facts.map((fact) => html`<li class="bot-routine__fact">${fact}</li>`)}</ul>`
    : nothing;
}

function renderRun(run: AutomationRun) {
  const recovery = automationRunRecoveryDetail(run, formatTimestamp);
  return html`<li class="bot-run" data-run=${run.id} data-status=${run.status}>
    <div class="bot-run__head"><span class="bot-run__name">${run.taskName}</span><span class="bot-run__status">${automationRunLabel(run)}</span></div>
    <p class="bot-run__facts">${run.source === "manual" ? "Run now" : "Scheduled"} · ${formatTimestamp(run.startedAt ?? run.createdAt)}</p>
    ${recovery ? html`<p class="bot-run__body">${recovery}</p>` : nothing}
    ${run.summary ? html`<p class="bot-run__body">${run.summary}</p>` : nothing}
    ${run.error ? html`<p class="bot-run__body bot-run__body--error" role="alert">${run.error}</p>` : nothing}
  </li>`;
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function submitRoutine(event: SubmitEvent, props: BotPanelProps) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const { routines } = props;
  try {
    const name = formText(data, "name");
    if (!name) throw new RoutineFormError("Name the routine.");
    const prompt = formText(data, "prompt");
    if (!prompt) throw new RoutineFormError("Write what the routine sends to the bot.");
    const cadence = formText(data, "cadence");
    const schedule = routineSchedule({
      cadence,
      every: formText(data, "every"),
      unit: formText(data, "unit"),
      time: formText(data, cadence === "weekly" ? "weeklyTime" : "dailyTime"),
      weekday: formText(data, "weekday"),
      at: formText(data, "at"),
    }, props.timezone);
    // Only an accepted routine clears the form; a refusal keeps the input.
    void routines.onCreate({ name, description: "", sessionId: props.bot.sessionId, prompt, schedule, enabled: true }).then((created) => {
      if (created) form.reset();
    });
  } catch (error) {
    routines.onFormError(error instanceof RoutineFormError ? error.message : "Could not read the routine form.");
  }
}

function renderRoutineForm(props: BotPanelProps, open: boolean) {
  const { routines } = props;
  const cadences = [["every", "Every"], ["daily", "Daily"], ["weekly", "Weekly"], ["once", "Once"]] as const;
  return html`<details class="bot-routine-form" ?open=${open}>
    <summary class="bot-routine-form__summary">${icons.plus}<span>Add routine</span></summary>
    <form class="bot-routine-form__body" novalidate @submit=${(event: SubmitEvent) => submitRoutine(event, props)}>
      <label class="bot-field"><span class="bot-field__label">Name</span>
        <input class="settings-input" name="name" type="text" maxlength="200" placeholder="Inbox digest" autocomplete="off" /></label>
      <label class="bot-field"><span class="bot-field__label">Prompt</span>
        <textarea class="settings-input" name="prompt" rows="3" maxlength="20000" placeholder="What should the bot do each time?"></textarea></label>
      <fieldset class="bot-field bot-routine-form__schedule">
        <legend class="bot-field__label">Schedule</legend>
        <div class="settings-segmented bot-routine-form__cadence">
          ${cadences.map(([value, label]) => html`<label class="settings-segmented__btn"><input type="radio" name="cadence" value=${value} ?checked=${value === "daily"} /><span>${label}</span></label>`)}
        </div>
        <div class="bot-routine-form__when bot-routine-form__when--every">
          <label class="bot-routine-form__inline"><span>Every</span><input class="settings-input" name="every" type="number" min="1" step="1" value="1" aria-label="Repeat every" /></label>
          <select class="settings-input" name="unit" aria-label="Interval unit">
            <option value="minutes">minutes</option><option value="hours" selected>hours</option><option value="days">days</option>
          </select>
        </div>
        <div class="bot-routine-form__when bot-routine-form__when--daily">
          <label class="bot-routine-form__inline"><span>At</span><input class="settings-input" name="dailyTime" type="time" value="08:00" aria-label="Daily time" /></label>
        </div>
        <div class="bot-routine-form__when bot-routine-form__when--weekly">
          <select class="settings-input" name="weekday" aria-label="Day of the week">
            ${ROUTINE_WEEKDAYS.map((day, index) => html`<option value=${String(index)} ?selected=${index === 1}>${day}</option>`)}
          </select>
          <label class="bot-routine-form__inline"><span>at</span><input class="settings-input" name="weeklyTime" type="time" value="09:00" aria-label="Weekly time" /></label>
        </div>
        <div class="bot-routine-form__when bot-routine-form__when--once">
          <label class="bot-routine-form__inline"><span>On</span><input class="settings-input" name="at" type="datetime-local" aria-label="Run once at" /></label>
        </div>
        <p class="bot-field__hint">Times are in ${props.timezone}.</p>
      </fieldset>
      ${routines.formError ? html`<p class="bot-field__error" role="alert">${routines.formError}</p>` : nothing}
      <div class="bot-routine-form__actions"><button type="submit" class="btn primary btn--sm" ?disabled=${routines.pending}>Add routine</button></div>
    </form>
  </details>`;
}

/** Reading the routines, or why they could not be read. */
function renderRoutinesState(props: BotPanelProps) {
  const { routines } = props;
  return routines.error
    ? html`<div class="bot-panel__state" role="alert">${routines.error} <button type="button" class="btn btn--sm" @click=${routines.onRetry}>Retry</button></div>`
    : html`<p class="bot-panel__state" role="status">Reading routines…</p>`;
}

function renderRoutinesView(props: BotPanelProps) {
  const { routines } = props;
  if (!routines.automation) return renderRoutinesState(props);
  const tasks = botRoutines(routines.automation, props.bot.sessionId);
  const runs = botRoutineRuns(routines.automation, props.bot.sessionId);
  return html`
    ${routines.actionError ? html`<p class="bot-field__error" role="alert">${routines.actionError}</p>` : nothing}
    ${tasks.length
      ? html`<ul class="bot-routines" aria-label="Routines">${tasks.map((task) => renderRoutine(task, props))}</ul>`
      : html`<p class="bot-panel__hint">No routines yet. A routine sends its prompt to ${props.bot.name}'s chat on a schedule, marked with its name.</p>`}
    ${renderRoutineForm(props, tasks.length === 0 || props.openedFrom === "routines-add")}
    <section class="bot-panel__section" aria-labelledby=${`${props.id}-runs`}>
      <h3 class="bot-panel__heading" id=${`${props.id}-runs`}>Latest runs</h3>
      ${runs.length
        ? html`<ul class="bot-runs">${runs.map(renderRun)}</ul>`
        : html`<p class="bot-panel__hint">Runs appear here with their outcome.</p>`}
      ${runs.some((run) => run.status === "running") ? html`<p class="bot-panel__hint" role="status">A run is in progress.</p>` : nothing}
    </section>
    ${routines.automation && routines.error ? html`<p class="bot-field__error" role="alert">Refresh failed: ${routines.error}</p>` : nothing}`;
}

/* ── the overview ── */

/** A section of the overview: its heading, and a + that opens its page on the add form. */
function overviewHead(props: BotPanelProps, section: string, title: string, add?: { label: string; view: BotPanelView }) {
  return html`<div class="bot-overview__head">
    <h3 class="bot-panel__heading" id=${`${props.id}-overview-${section}`}>${title}</h3>
    ${add ? html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-overview__add" data-panel-link=${`${section}-add`}
      aria-label=${add.label} title=${add.label} @click=${() => props.onView(add.view, `${section}-add`)}>${icons.plus}</button>` : nothing}
  </div>`;
}

/** A row that opens a page: what it is, and a line about it. Its switch, when it has one, sits beside it. */
function overviewLink(props: BotPanelProps, view: BotPanelView, link: string, name: string, meta: unknown, tone = "") {
  return html`<button type="button" class="bot-overview__link" data-panel-link=${link} @click=${() => props.onView(view, link)}>
    <span class="bot-overview__name">${name}</span>
    <span class="bot-overview__meta ${tone}">${meta}</span>
  </button>`;
}

/** Face, name, role and what it is doing, then Call and Edit, as a Dots profile opens. */
function renderProfile(props: BotPanelProps) {
  const { bot } = props;
  const activity = botActivityLabel(bot, true);
  const meta = [bot.title, `${activity.charAt(0).toUpperCase()}${activity.slice(1)}`, bot.worker ? `on ${bot.worker.name}` : ""].filter(Boolean).join(" · ");
  return html`<section class="bot-profile" aria-labelledby=${`${props.id}-name`}>
    ${renderBotAvatar(bot, "lg", { state: rosterFaceState(bot, true) })}
    <h2 class="bot-profile__name" id=${`${props.id}-name`}>${bot.name}</h2>
    <p class="bot-profile__meta">${meta}</p>
    <div class="bot-profile__actions">
      ${props.call ?? nothing}
      <button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-profile__edit" data-panel-link="settings-profile"
        aria-label=${`Edit ${bot.name}`} title=${`Edit (${botSettingsShortcutLabel()})`} @click=${() => props.onView("settings", "settings-profile")}>${icons.edit}</button>
    </div>
  </section>`;
}

function renderRoutinesSummary(props: BotPanelProps) {
  const { routines, bot } = props;
  const tasks = routines.automation ? botRoutines(routines.automation, bot.sessionId) : [];
  return html`<section class="bot-overview__section" aria-labelledby=${`${props.id}-overview-routines`}>
    ${overviewHead(props, "routines", "Routines", { label: "Add routine", view: "routines" })}
    ${!routines.automation ? renderRoutinesState(props) : tasks.length
      ? html`<ul class="bot-overview__list">${tasks.map((task) => html`<li class="bot-overview__row ${task.enabled ? "" : "bot-overview__row--off"}">
          ${overviewLink(props, "routines", `routine-${task.id}`, task.name, routineWhen(task))}
          ${renderSettingsToggle(`Enable ${task.name}`, task.enabled, (checked) => routines.onSetEnabled(task, checked), routines.pending)}
        </li>`)}</ul>`
      : html`<p class="bot-panel__hint">No routines yet. Ask ${bot.name} to do something on a schedule, or add one.</p>`}
    ${routines.automation && routines.actionError ? html`<p class="bot-field__error" role="alert">${routines.actionError}</p>` : nothing}
  </section>`;
}

/** When a trigger last fired, or the problem its listener reported. */
function triggerLine(trigger: BotTrigger, now: number) {
  if (trigger.watch?.error) return trigger.watch.error;
  return trigger.lastFiredAt ? `Last fired ${agoLabel(trigger.lastFiredAt, now)}` : "Never fired";
}

function renderTriggersSummary(props: BotPanelProps, now: number) {
  const { state } = props.triggers;
  const list = state.list;
  return html`<section class="bot-overview__section" aria-labelledby=${`${props.id}-overview-triggers`}>
    ${overviewHead(props, "triggers", "Triggers", { label: "Add trigger", view: "triggers" })}
    ${!list
      ? state.error
        ? html`<div class="bot-panel__state" role="alert">${state.error} <button type="button" class="btn btn--sm" @click=${props.triggers.onRetry}>Retry</button></div>`
        : html`<p class="bot-panel__state" role="status">Reading triggers…</p>`
      : list.triggers.length
        ? html`<ul class="bot-overview__list">${list.triggers.map((trigger) => html`<li class="bot-overview__row ${trigger.enabled ? "" : "bot-overview__row--off"}">
            ${overviewLink(props, "triggers", `trigger-${trigger.id}`, trigger.name, triggerLine(trigger, now), trigger.watch?.error ? "bot-overview__meta--error" : "")}
            ${renderSettingsToggle(`Enable ${trigger.name}`, trigger.enabled, (checked) => props.triggers.onToggle(trigger, checked), state.pending)}
          </li>`)}</ul>`
        : html`<p class="bot-panel__hint">No triggers yet. A trigger wakes ${props.bot.name} when a listener you run reports an event.</p>`}
    ${list && state.actionError ? html`<p class="bot-field__error" role="alert">${state.actionError}</p>` : nothing}
  </section>`;
}

/** What the bot did on its own lately: its routines' and triggers' runs, newest first. */
function renderActivity(props: BotPanelProps, now: number) {
  const routineRuns = botRoutineRuns(props.routines.automation, props.bot.sessionId);
  const runs = botRecentRuns(routineRuns, props.triggers.state.list?.runs ?? []);
  return html`<section class="bot-overview__section" aria-labelledby=${`${props.id}-overview-activity`}>
    ${overviewHead(props, "activity", "Activity")}
    ${runs.length
      ? html`<ul class="bot-overview__list">${runs.map((entry) => {
          const routine = entry.kind === "routine";
          const label = routine ? automationRunLabel(entry.run) : TRIGGER_RUN_LABELS[entry.run.status];
          const recovery = routine ? automationRunRecoveryDetail(entry.run, formatTimestamp) : "";
          const detail = routine ? entry.run.error ?? entry.run.summary : entry.run.reason ?? entry.run.summary;
          const when = agoLabel(entry.at, now);
          return html`<li class="bot-overview__row" data-status=${entry.run.status}>
            ${overviewLink(props, routine ? "routines" : "triggers", `run-${entry.run.id}`, routine ? entry.run.taskName : entry.run.triggerName,
              html`<span class="bot-overview__status">${label}</span>${recovery ? html` · ${recovery}` : nothing} · ${when}${detail ? html` · ${detail}` : nothing}`)}
          </li>`;
        })}</ul>`
      : html`<p class="bot-panel__hint">Runs of ${props.bot.name}'s routines and triggers show here.</p>`}
  </section>`;
}

/** Where the bot works, short: its own folder (the one HUI made, named by its id), or a chosen folder's last two
 * names; the whole path is the row's title. */
function workspaceLabel(bot: Pick<BotView, "id" | "cwd">): string {
  const parts = bot.cwd.split("/").filter(Boolean);
  if (parts.at(-1) === bot.id) return "Its own folder";
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : bot.cwd;
}

/** How the bot is set up, one row each, every row opening the page that changes it. */
function renderSetup(props: BotPanelProps) {
  const { bot } = props;
  const row = (link: string, view: BotPanelView, title: string, value: string, full = value) => html`<button type="button"
    class="bot-overview__setup" data-panel-link=${link} @click=${() => props.onView(view, link)}>
    <span class="bot-overview__name">${title}</span><span class="bot-overview__value" title=${full}>${value}</span>${icons.chevron}
  </button>`;
  const where = bot.worker ? ` on ${bot.worker.name}` : "";
  return html`<section class="bot-overview__section" aria-labelledby=${`${props.id}-overview-setup`}>
    ${overviewHead(props, "setup", "Setup")}
    <div class="bot-overview__list">
      ${row("settings-tagging", "settings", "Tagging", botTaggingLabel(bot), bot.description ?? botTaggingLabel(bot))}
      ${row("settings-model", "settings", "Model", botModelLabel(bot, props.settings.models))}
      ${row("tools", "tools", "Tools & skills", botToolsOffLabel(bot))}
      ${row("facts", "facts", "Memory", "Facts, preferences & decisions")}
      ${row("settings-calls", "settings", "Calls", botCallsLabel(bot, props.settings.call))}
      ${row("settings-workspace", "settings", "Workspace", `${workspaceLabel(bot)}${where}`, `${bot.cwd}${where}`)}
    </div>
  </section>`;
}

/** The panel's first page, after OpenAI's Dots: who the bot is, what it does on its own and how it is set up. Wide,
 * it splits in two columns: the profile and setup on the left, what it does on the right. */
function renderOverview(props: BotPanelProps) {
  const now = Date.now();
  return html`<div class="bot-overview">
    ${renderProfile(props)}
    <div class="bot-overview__does">
      ${renderRoutinesSummary(props)}
      ${renderTriggersSummary(props, now)}
      ${renderActivity(props, now)}
    </div>
    ${renderSetup(props)}
  </div>`;
}

function renderPanelView(props: BotPanelProps) {
  switch (props.view) {
    case "overview": return renderOverview(props);
    case "facts": return props.facts ? renderBotFacts(props.facts) : nothing;
    case "routines": return renderRoutinesView(props);
    case "triggers": return renderBotTriggers({ bot: props.bot, now: Date.now(), ...props.triggers, adding: props.openedFrom === "triggers-add" });
    // Keyed, as Settings: another bot's switches and skill search start afresh.
    case "tools": return keyed(props.bot.id, renderBotToolsTab({ bot: props.bot, ...props.tools }));
    // Keyed: another bot's page starts afresh (its look closed, nothing typed carried over).
    case "settings": return keyed(props.bot.id, renderBotSettings({ ...props.settings, bot: props.bot, id: props.id, face: (avatar) => renderBotAvatar({ id: props.bot.id, avatar }, "md") }));
  }
}

/* ── size: drag, keys, expand ── */

/** The drag in progress (one pointer at a time): where the pointer and the width started, the room beside the chat,
 * and whether it moved, since a click on the edge must not save the width the window squeezed it to. */
let drag: { x: number; width: number; available: number; panel: HTMLElement; moved: boolean } | undefined;

/** The panel a handle resizes, its width now and the width of the bot's view it shares with the chat. */
function measure(handle: HTMLElement) {
  const panel = handle.closest<HTMLElement>(".bot-panel")!;
  return { panel, width: panel.getBoundingClientRect().width, available: panel.parentElement?.clientWidth ?? Number.POSITIVE_INFINITY };
}

/** The panel's left edge, as the Work pane's: drag it, or use ← → (Shift for bigger steps), Home and End on it. The
 * width follows the pointer without a render; the app keeps it once the drag ends. */
function renderResizer(props: BotPanelProps) {
  if (props.sheet || props.expanded) return nothing;
  const end = () => {
    if (!drag) return;
    const { panel, available, moved } = drag;
    drag = undefined;
    panel.classList.remove("bot-panel--resizing");
    if (moved) props.onResize(clampBotPanelWidth(panel.getBoundingClientRect().width, available));
  };
  return html`<div class="bot-panel__resizer" role="separator" aria-orientation="vertical" aria-label="Resize the bot panel" tabindex="0"
    aria-valuenow=${props.width} aria-valuemin=${BOT_PANEL_MIN_WIDTH}
    @focus=${(event: FocusEvent) => {
      // The room the chat leaves changes with the window: what a screen reader announces is measured when it lands here.
      const handle = event.currentTarget as HTMLElement;
      const { width, available } = measure(handle);
      handle.setAttribute("aria-valuenow", String(Math.round(width)));
      handle.setAttribute("aria-valuemax", String(clampBotPanelWidth(Number.POSITIVE_INFINITY, available)));
    }}
    @pointerdown=${(event: PointerEvent) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget as HTMLElement;
      drag = { x: event.clientX, ...measure(handle), moved: false };
      handle.setPointerCapture(event.pointerId);
      drag.panel.classList.add("bot-panel--resizing");
      // No text selection while dragging; the keys stay on the handle, as clicking it would leave them.
      event.preventDefault();
      handle.focus({ preventScroll: true });
    }}
    @pointermove=${(event: PointerEvent) => {
      if (!drag) return;
      drag.moved = true;
      drag.panel.style.setProperty("--bot-panel-width", `${clampBotPanelWidth(drag.width + drag.x - event.clientX, drag.available)}px`);
    }}
    @pointerup=${end} @pointercancel=${end} @lostpointercapture=${end}
    @keydown=${(event: KeyboardEvent) => {
      const { width, available } = measure(event.currentTarget as HTMLElement);
      const step = event.shiftKey ? 80 : 24;
      const next = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step
        : event.key === "Home" ? BOT_PANEL_MIN_WIDTH : event.key === "End" ? Number.POSITIVE_INFINITY : undefined;
      if (next === undefined) return;
      event.preventDefault();
      props.onResize(clampBotPanelWidth(next, available));
    }}></div>`;
}

/** The overview's header holds only Expand and Close: its profile names the bot. A page's adds the way back and its
 * title. */
function renderPanelHeader(props: BotPanelProps) {
  const view = props.view;
  const expanded = props.expanded;
  return html`<header class="bot-panel__header">
    ${view === "overview" ? html`<span class="bot-panel__spacer"></span>` : html`
      <button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-panel__back" aria-label=${`Back to ${props.bot.name}`} title="Back"
        @click=${() => props.onView("overview")}>${icons.arrowLeft}</button>
      <h2 class="bot-panel__title">${VIEW_TITLES[view]}</h2>`}
    ${props.expandable ? html`<button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-panel__expand"
      aria-label=${expanded ? "Show the chat beside the panel" : "Expand the panel"} title=${expanded ? "Show the chat (Esc)" : "Expand"}
      @click=${() => props.onExpand(!expanded)}>${expanded ? restoreIcon : expandIcon}</button>` : nothing}
    <button type="button" class="btn btn--ghost btn--icon chat-icon-btn bot-panel__close" aria-label="Close the bot panel" title="Close" @click=${props.onClose}>${icons.close}</button>
  </header>`;
}

/** The panel beside the bot's chat: its overview, or a page one of the overview's rows opened. Docked, its left edge
 * resizes it and Expand makes it fill the bot's view; on narrow screens it is a sheet over the chat. */
export function renderBotPanel(props: BotPanelProps) {
  return html`${props.sheet ? html`<button type="button" class="bot-panel__backdrop" tabindex="-1" aria-label="Close the bot panel" @click=${props.onClose}></button>` : nothing}
    <aside class="bot-panel ${props.sheet ? "bot-panel--sheet" : ""}" id=${props.id}
      aria-label=${`${props.bot.name}: bot panel`} data-view=${props.view} style=${`--bot-panel-width: ${props.width}px`}
      @keydown=${(event: KeyboardEvent) => {
        // A popup inside (a menu, a picker) or a field taking back its text has its own Escape first.
        if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || hasOpenWebAwesomePopup(event)) return;
        // Escape never reaches the chat from here, where it would stop the bot's turn: it closes the sheet, brings the
        // chat back beside an expanded panel, and docked does nothing.
        event.preventDefault();
        event.stopPropagation();
        if (props.sheet) props.onClose();
        else if (props.expanded) props.onExpand(false);
      }}>
      ${renderResizer(props)}
      ${renderPanelHeader(props)}
      <div class="bot-panel__body" role="region" tabindex="0" aria-label=${props.view === "overview" ? `About ${props.bot.name}` : VIEW_TITLES[props.view]}>
        <div class="bot-panel__content">${renderPanelView(props)}</div>
      </div>
    </aside>`;
}

/* ── archive confirmation ─────────────────────────────────────────────────── */

export function renderBotArchiveDialog(bot: BotView, pending: boolean, error: string, onConfirm: () => void, onCancel: () => void) {
  return html`<dialog class="hui-modal-dialog group-action-dialog bot-archive-dialog" aria-labelledby="bot-archive-title"
    @cancel=${(event: Event) => { event.preventDefault(); if (!pending) onCancel(); }}>
    <form class="exec-approval-card" method="dialog" @submit=${(event: SubmitEvent) => { event.preventDefault(); onConfirm(); }}>
      <div class="exec-approval-title" id="bot-archive-title">Archive ${bot.name}?</div>
      <div class="exec-approval-sub">${bot.name} leaves the roster and its routines are disabled. Its chat, memory and workspace stay on ${bot.worker?.name ?? "this machine"}, and it can be restored.</div>
      ${error ? html`<p class="group-action-dialog__error" role="alert">${error}</p>` : nothing}
      <div class="exec-approval-actions">
        <button type="submit" class="btn danger" ?disabled=${pending}>${pending ? "Archiving…" : "Archive"}</button>
        <button type="button" class="btn bot-archive-cancel" ?disabled=${pending} @click=${onCancel}>Cancel</button>
      </div>
    </form>
  </dialog>`;
}

/* ── delete confirmation ──────────────────────────────────────────────────── */

/** Deleting cannot be undone, so the dialog says what goes and what stays, and Cancel has the focus. */
export function renderBotDeleteDialog(bot: BotView, pending: boolean, error: string, onConfirm: () => void, onCancel: () => void) {
  return html`<dialog class="hui-modal-dialog group-action-dialog bot-delete-dialog" aria-labelledby="bot-delete-title"
    @cancel=${(event: Event) => { event.preventDefault(); if (!pending) onCancel(); }}>
    <form class="exec-approval-card" method="dialog" @submit=${(event: SubmitEvent) => { event.preventDefault(); onConfirm(); }}>
      <div class="exec-approval-title" id="bot-delete-title">Delete ${bot.name}?</div>
      <div class="exec-approval-sub">${bot.name} is deleted for good: its chat leaves HUI, and its routines, its memory and its folder${bot.worker ? ` on ${bot.worker.name}` : ""} (SOUL.md and every file in it) go${bot.worker && bot.status === "disconnected" ? `; HUI is not connected to ${bot.worker.name} now, so those go there when it reconnects` : ""}. A workspace you chose for it stays. This cannot be undone.</div>
      ${error ? html`<p class="group-action-dialog__error" role="alert">${error}</p>` : nothing}
      <div class="exec-approval-actions">
        <button type="submit" class="btn danger" ?disabled=${pending}>${pending ? "Deleting…" : "Delete"}</button>
        <button type="button" class="btn bot-delete-cancel" ?disabled=${pending} @click=${onCancel}>Cancel</button>
      </div>
    </form>
  </dialog>`;
}
