/**
 * The root application element, also reused as the embedded chat pane inside splits and bot views. As the shell it
 * owns the route and the layout, hands each feature's state to its controller in `controllers/` (the open
 * conversation, the composer, sessions, bots, the backlog, settings, automation, updates, launch and the work layout)
 * and passes props to the view render functions. Durable state lives behind the gateway's `/__hui/` routes; the shell
 * and its controllers mirror it and send requests through `api/`, never reading files or running processes.
 */
import { renderPicker } from "./views/settings-picker.ts";
import { renderDirectoryPicker } from "./views/directory-picker.ts";
import { renderSessionPane } from "./views/session-pane.ts";
import { sessionTreeIds } from "./lib/session/tree.ts";
import { html, nothing, type PropertyValues } from "lit";
import { icons } from "./lib/icons.ts";
import type { QuestionnaireCard } from "./components/questionnaire-card.ts";
import { keyed } from "lit/directives/keyed.js";
import { property, state } from "lit/decorators.js";
import { HuiElement } from "./lit/hui-element.ts";
import {
  createSession,
  createSessionGroup,
  reorderSessionGroups,
  deleteSession,
  deleteSessionGroup,
  loadGitCheckout,
  renameSession,
  resumeSession,
  subscribeSession,
  updateSessionGroup,
  type Attachment,
  type RuntimeEvent,
  type RuntimeCompaction,
  type RuntimeQuestion,
  type SessionGroup,
  type SessionStatus,
  type SessionStatusUpdate,
  type SessionView,
  type TranscriptItem,
  type GitCheckoutInfo,
  type WorktreeProgress,
} from "./api/sessions.ts";
import { sessionGroupLabel, transcriptAsMarkdown } from "./lib/session/sessions.ts";
import { resolveLaunchModel } from "./lib/model-selection.ts";
import { parseUpdateCommand, skillCommands } from "./lib/composer/slash-commands.ts";
import { isListFilterShortcut } from "./components/list-filter.ts";
import { withLiveChats, withoutBotSessions, type BotView } from "./lib/bots/bots.ts";
import { isBotSettingsShortcut, type BotPanelView, type SidebarTab } from "./lib/bots/roster.ts";
import { BacklogController } from "./controllers/backlog-controller.ts";
import { LaunchController } from "./controllers/launch-controller.ts";
import { SessionsController } from "./controllers/sessions-controller.ts";
import { ConversationController } from "./controllers/conversation-controller.ts";
import { ComposerController } from "./controllers/composer-controller.ts";
import { WorkLayoutController } from "./controllers/work-layout-controller.ts";
import { BotsController } from "./controllers/bots-controller.ts";
import { BotFactsController } from "./controllers/bot-facts-controller.ts";
import { BotToolsController } from "./controllers/bot-tools-controller.ts";
import { BotTriggersController } from "./controllers/bot-triggers-controller.ts";
import { renderBotArchiveDialog, renderBotDeleteDialog, renderBotPanel, renderBotPlaceholder } from "./views/bots.ts";
import { renderBotExportDialog, renderBotImportDialog } from "./views/bot-import.ts";
import { BotImportController } from "./controllers/bot-import-controller.ts";
import { renderUpdateDialog } from "./views/update-dialog.ts";
import { renderUpdateNotice } from "./views/update-notice.ts";
import { renderPowerNotice } from "./views/power-notice.ts";
import { customGroupOrder, moveGroupLabel, readSidebarSessionOptions, writeSidebarSessionOptions, type SidebarSessionOptions } from "./lib/session/sidebar-sessions.ts";
import { disconnectTextareaOverflowObserver, observeTextareaOverflow, scheduleTextareaHeightAdjustment } from "./lib/composer/textarea.ts";
import {
  deleteComposerDraft,
  mergeComposerDraft,
  NEW_SESSION_DRAFT_KEY,
  readComposerDraft,
  sessionDraftKey,
  writeComposerDraft,
} from "./lib/composer/drafts.ts";
import { CONTINUE_AFTER_ERROR_PROMPT, latestRunError } from "./lib/run-error.ts";
import {
  emptySessionPresentation,
  isSelectedSession,
  noteAfterEvent,
  type NoteLevel,
} from "./lib/session/ui-state.ts";
import { closeModal, ensureModal } from "./lib/modal-dialog.ts";
import { documentTitle } from "./lib/document-title.ts";
import { AutomationController } from "./controllers/automation-controller.ts";
import { SettingsController } from "./controllers/settings-controller.ts";
import { UpdateController } from "./controllers/update-controller.ts";
import { QUESTION_FOCUS_SELECTOR, renderHome, TRANSCRIPT_SCROLLER_SELECTOR, type BotHeaderAction, type HomeBot, type HomeProps } from "./views/home.ts";
import "./components/contributions.ts";
import { renderPanelSelector } from "./views/panel-selector.ts";
import { dedicatedPageRenderer, type DedicatedPageProps } from "./views/pages.ts";
import { renderKanbanPage } from "./views/kanban.ts";
import type { KanbanMove } from "./lib/kanban.ts";
import { DEFAULT_SESSION_STAGE, SESSION_STAGE_LABELS } from "./lib/kanban.ts";
import type { SessionStage } from "./api/schema/sessions.ts";
import type { SessionCardAction } from "./views/kanban.ts";
import { VoiceController } from "./controllers/voice-controller.ts";
import { renderCallBar, renderCallButton, renderCallView, type CallViewProps } from "./views/bot-voice.ts";
import { liveCallPlatform } from "./lib/voice/live-call-platform.ts";
import { deleteCall, postCallDelegation, postCallHeartbeat, postCallLines, postCallTask, startBotCall } from "./api/calls.ts";
import { localTimezone, type AutomationProps } from "./views/settings-automation.ts";
import { workerAction } from "./api/workers.ts";
import { hasOpenWebAwesomePopup } from "./lib/web-awesome.ts";
import { APP_SHELL_DRAWER_MEDIA, closeDrawerOnEscape, renderMain, renderSidebar, toggleNavigationDrawer, type GroupDropTarget, type GroupMenuAction, type NavId, type SessionCopyAction, type SessionOpenAction, type ShellBotsProps } from "./views/shell.ts";
import { writeClipboardText } from "./lib/clipboard.ts";
import { renderSettingsPage, SETTINGS_PAGES, type SettingsPage } from "./views/settings.ts";
import { clampSuggestionIndex, taskSuggestionPrompt } from "./lib/task-suggestions.ts";
import type { Watcher } from "./api/watchers.ts";
import {
  isCommandPaletteShortcut,
  renderCommandPalette,
  type CommandPaletteAction,
} from "./views/command-palette.ts";
import { isPiSurface, renderPiSurface } from "./views/pi-surfaces.ts";
import { renderPiResourceReader } from "./views/pi-resource-reader.ts";
import { isObservabilitySurface, renderObservabilitySurface } from "./views/observability.ts";
import { isOwnedSurface, renderOwnedSurface } from "./views/hui-owned-surfaces.ts";
import { HUI_PAGES, type HuiPage } from "./lib/pages.ts";
import { activeSessionPane, closeSessionPane, focusSessionPane, isChatPane, parseSessionLayout, replacePaneSession, resizeSessionLayout, SESSION_LAYOUT_KEY, sessionPanes, visibleSessionPanes, singleSessionLayout, splitSessionPane, type DropZone, type SessionPane, type SplitDirection } from "./lib/session/multiplexer.ts";
import {
  activateWorkView, launchableWorkViewKinds, migrateLayoutWorkViews, pruneWorkPaneStore, reorderWorkView,
  retainWorkSessions, sessionWorkPane, setWorkPaneMaximized, setWorkPaneOpen, workPaneMaximized, workViewKey, workViewKind,
  WORK_PANE_CHAT_MIN_WIDTH, type WorkViewRef,
} from "./lib/work-pane.ts";
import { PANE_COLUMN_MIN_WIDTH } from "./lib/session/pane-geometry.ts";
import { OPEN_FILE_EVENT, type OpenFileDetail } from "./lib/files/file-link-store.ts";
import { OPEN_SETTINGS_EVENT, requestOpenSettings, type OpenSettingsDetail } from "./lib/open-settings.ts";
import { scrollSettingsSection } from "./lib/settings-section-scroll.ts";
import "./components/work-pane.ts";
import "./components/terminal-pane.ts";
import "./components/browser-pane.ts";
import { SessionMultiplexer, type PanePresentation } from "./components/session-multiplexer.ts";
import {
  isRoutablePage,
  navigationPath,
  resolveNavigation,
  settingsCloseNavigation,
  settingsReturnTarget,
  type NavigationTarget,
} from "./lib/navigation.ts";

const HUI_UPDATE_SESSION_TITLE = "HUI update";

/** Pane callbacks are behavior, not render data: only their presence changes
 * the output. The split parent recreates equivalent closures on every render;
 * comparing identity re-rendered every pane's whole transcript on each unrelated
 * update or resize step. Lit still stores the newest value, but a rendered
 * button may keep an older one: capture only the pane/session id and the parent. */
const paneCallback = { attribute: false, hasChanged: (value: unknown, old: unknown) => !value !== !old };

/** A bot pane's Call button (HUI-18): offered while calls can run (GPT-Live, with a ChatGPT login). Compared by value. */
type PaneCall = { botId: string; inCall: boolean };
const paneCallProperty = { attribute: false, hasChanged: (value: unknown, old: unknown) => JSON.stringify(value) !== JSON.stringify(old) };

/** The bot pane's header data, without its callback (passed separately as a
 * pane callback). Compared by value: the parent rebuilds it on every render. */
type PaneBot = Omit<HomeBot, "onTogglePanel" | "onAction">;
const paneBotProperty = { attribute: false, hasChanged: (value: unknown, old: unknown) => JSON.stringify(value) !== JSON.stringify(old) };

/** The shell's bots in a pane: Lit stores each new list, but only a change of what its chat shows of them (name, face)
 * renders it again, not a bot's status or latest message. */
const botFaces = (bots: unknown) => JSON.stringify((bots as readonly BotView[] | undefined)?.map(({ id, handle, name, avatar }) => [id, handle, name, avatar]));
const paneBotsProperty = { attribute: false, hasChanged: (value: unknown, old: unknown) => botFaces(value) !== botFaces(old) };

/** Defined by `defineHuiApp`, not on import: main.ts loads this module while the
 * saved appearance is still being read, and the app must not paint before it. */
export class HuiApp extends HuiElement {
  @state() private view: NavId = "home";
  @state() private activePage: HuiPage | undefined;
  @state() private search = "";
  private readonly sessions = new SessionsController(this, {
    presented: (id) => this.isSessionPresented(id),
    listReceived: (ids) => this.followSessionList(ids),
    listSettled: () => this.openPendingSession(),
    statusesApplied: () => {
      // Bot chats are sessions too: their roster rows follow the same stream.
      if (this.bots.list.length) this.bots.adopt(this.withLiveBotState(this.bots.list));
    },
    statusApplied: (update) => this.followSessionStatus(update),
    reportError: (error, message) => this.reportOperationError(error, message),
    refreshSessions: () => this.refreshSessions(),
    sessionsDeleted: (ids) => { if (this.conversation.selected && ids.has(this.conversation.selected.id)) this.clearSessionState(); },
    worktreesShown: () => this.settingsOpen && this.settingsPage === "worktrees",
  });
  private readonly conversation = new ConversationController(this, {
    showError: (message) => {
      this.note = message;
      this.noteLevel = "error";
    },
    refreshSessions: () => this.refreshSessions(),
    paneCreating: () => Boolean(this.paneCreating),
    paneCreationFailed: () => Boolean(this.paneCreationError),
    resetSession: () => {
      this.backlog.clearSession();
      this.note = "";
      this.noteLevel = "info";
      this.composer.resetCommands();
    },
    connectionLost: () => this.composer.resetCommands(),
    adoptSnapshot: (snapshot) => {
      this.composer.adoptSnapshot(snapshot);
      this.backlog.adoptSnapshot(snapshot.suggestions, snapshot.watchers);
    },
    adoptEvent: (event) => this.adoptRunEvent(event),
    statusChanged: (id, status, interrupted) => this.followConversationStatus(id, status, interrupted),
    flushLaunchPrompt: () => this.composer.flushLaunchPrompt(),
  });
  private readonly composer = new ComposerController(this, {
    conversation: this.conversation,
    showNote: (message, level) => {
      this.note = message;
      if (level) this.noteLevel = level;
    },
    handleUpdateCommand: (text, attachments) => this.handleUpdateCommand(text, attachments),
    embeddedPane: () => this.embeddedPane,
    draftChanged: (sessionId, hasDraft) => { if (this.embeddedPane) this.onPaneDraftChange?.(sessionId, hasDraft); },
    composerSession: () => this.composerSession(),
    draftCommands: () => this.launcher.worker ? [] : skillCommands(this.control.pi?.skills ?? [], this.control.settings.disabledSkills),
    defaultCwd: () => this.launcher.defaults?.cwd,
    mentionable: () => this.mentionable(),
    textarea: () => this.composerTextarea,
    launching: () => this.launching,
  });
  @state() private sessionOptions: SidebarSessionOptions = readSidebarSessionOptions();
  @state() private kanbanMovePendingId = "";
  @state() private draggingSessionId = "";
  @state() private sessionDropTarget = "";
  @state() private sessionMovePendingId = "";
  private readonly backlog = new BacklogController(this, {
    notify: (message, failed) => this.sessions.notify(message, failed),
    showNote: (message, level) => { this.note = message; this.noteLevel = level; },
    refreshSessions: () => this.refreshSessions(true),
    paneRegistryChanged: () => void this.onPaneRegistryChange?.(),
    selected: () => this.conversation.selected,
    selectSession: (session) => this.selectSession(session),
    kanbanOpen: () => this.view === "kanban",
  });
  @state() private draggingGroup = "";
  @state() private groupDropTarget: GroupDropTarget | undefined;
  @state() private groupReorderPending = false;
  @state() private continuing = false;
  @state() private expandedActivityIds: ReadonlySet<string> = new Set();
  @state() private showScrollToBottom = false;
  @state() private launching = false;
  @state() private note = "";
  @state() private noteLevel: NoteLevel = "info";
  /** The runtime warning (provider retry, model fallback) the current run is narrating. */
  private recoveryNotice = "";
  @state() private importNote = "";
  @state() private importFailed = false;
  @state() private groupAction: { action: "new" } | { action: Exclude<GroupMenuAction, "new">; group: SessionGroup } | undefined;
  @state() private groupMutationPending = false;
  @state() private groupMutationError = "";
  @state() private groupDefaultCwd = "";
  @state() private groupDefaultMode: "branch" | "worktree" = "branch";
  @state() private groupDefaultRef = "";
  @state() private groupCheckout: GitCheckoutInfo | undefined;
  @state() private groupCheckoutLoading = false;
  @state() private groupCheckoutError = "";
  private groupCheckoutRequest = 0;
  private groupCheckoutDirectory = "";
  private readonly launcher = new LaunchController(this);
  private readonly automation = new AutomationController(this);
  private readonly control = new SettingsController(this, {
    piLoaded: (snapshot) => this.launcher.seedPreferences(snapshot, this.control.settings.models.primary),
    copyFailed: (message) => {
      this.note = message;
      this.noteLevel = "error";
    },
  });
  private updatingSelectedId: string | undefined;
  private renderedSelected: SessionView | undefined;
  private renderedBots: readonly BotView[] = [];
  private renderedQuestion: RuntimeQuestion | undefined;
  private renderedTranscript: readonly TranscriptItem[] = [];
  private renderedCompaction: RuntimeCompaction | undefined;
  private renderedQueueEditingId: string | undefined;
  private renderedDraftRevision = 0;
  private groupActionReturnFocus: HTMLElement | undefined;

  @state() private settingsOpen = false;
  @state() private settingsPage: SettingsPage = "appearance";
  /** Session-scoped editor state: a late selection can never retarget an action. */
  @state() private renamingFor = "";
  @state() private deletingFor = "";
  @state() private updateSessionCreating = false;
  private readonly updates = new UpdateController(this, () => this.composerTextarea?.focus());
  /** Which sidebar row menu is open. Only one at a time. */
  @state() private menuFor = "";
  @state() private commandPaletteOpen = false;
  @state() private commandPaletteQuery = "";
  @state() private commandPaletteActiveIndex = 0;
  @state() private mobileNavLayout = false;
  /* ── bots (top-level app only; panes never read bots) ── */
  private readonly bots = new BotsController(this, {
    control: this.control,
    live: (bots) => this.withLiveBotState(bots),
    onFrame: () => {
      this.followBotTools();
      this.followBotTriggers();
    },
    notify: (message, failed) => this.sessions.notify(message, failed),
    navigate: (target, replace) => this.navigate(target, replace),
    shownBotId: () => this.view === "bot" ? this.activeBotId : "",
    refreshSessions: () => void this.refreshSessions(true),
    workers: () => this.launcher.workers,
  });
  @state() private botSearch = "";
  @state() private botMenuFor = "";
  /** The bot whose chat the bot route shows. */
  @state() private activeBotId = "";
  /** Import bot… (+) and Export… (a bot's ⋯): their dialogs' state. An imported bot opens like a new one. */
  private botImports = new BotImportController(this, {
    workers: () => this.launcher.workers,
    imported: (bot, warnings) => this.bots.imported(bot, warnings),
  });
  /** The panel's Tools page: what the operator can turn off in the bot's chat, kept in its own controller. */
  private botTools = new BotToolsController(this);
  private botFacts = new BotFactsController(this);
  /** The bot's triggers, read while its overview or Triggers page shows. */
  private botTriggers = new BotTriggersController(this, { visible: () => this.botTriggersVisible() });
  private botRosterTick = 0;
  /** Set on the bot route's embedded pane: header identity and panel state. */
  @property(paneBotProperty) paneBot: PaneBot | undefined;
  @property(paneCallback) onPaneBotPanel: (() => void) | undefined;
  /** The bot header's ⋯ menu, handled by the app that owns the bot dialogs. */
  @property(paneCallback) onPaneBotAction: ((action: BotHeaderAction) => void) | undefined;
  private readonly work = new WorkLayoutController(this, {
    followedSession: () => this.workSessionId(),
    showSession: (id) => this.showSession(id),
    activePane: () => this.activePaneApp(),
    focusComposer: () => this.focusActiveComposer(),
    paletteOpen: () => this.commandPaletteOpen,
    terminalFont: () => this.control.settings.fontTerminal,
    browserEnabled: () => this.control.settings.browser.enabled,
    remoteSession: (sessionId) => Boolean(this.listedSession(sessionId)?.worker),
  });
  @property({ type: Boolean, attribute: "embedded-pane" }) embeddedPane = false;
  @property({ attribute: "pane-session-id" }) paneSessionId = "";
  /** The shell's registry entry, so a pane opens without waiting for (or
   * depending on) its own registry request, which can time out or be stale. */
  @property({ attribute: false }) paneSession?: SessionView;
  @property() paneId = "";
  @property({ type: Boolean }) paneActive = true;
  @property({ type: Boolean }) paneVisible = true;
  @property({ type: Boolean }) paneNarrow = false;
  @property({ type: Boolean }) paneMobileNav = false;
  @property(paneCallback) onPaneClose: (() => void) | undefined;
  @property(paneCallback) onPaneSplit: ((direction: SplitDirection) => void) | undefined;
  @property(paneCallback) onPaneTerminal: (() => Promise<void>) | undefined;
  /** Opens this session's browser view in the Work pane: the larger live view beside the chat. */
  @property(paneCallback) onPaneBrowser: (() => void) | undefined;
  @state() private terminalOpening = false;
  @state() private terminalError = "";
  @property(paneCallback) onPaneNavigate: ((id: string) => void) | undefined;
  @property(paneCallback) onPaneRegistryChange: (() => Promise<void>) | undefined;
  /** Worktree progress while the gateway still creates this pane's session;
   * the pane opens it once this clears. */
  @property({ attribute: false }) paneCreating: WorktreeProgress | undefined;
  @property({ attribute: false }) paneCreationError: string | undefined;
  /** The failed launch's prompt, returned to New Session when this pane deletes it. */
  @property({ attribute: false }) paneUnsentPrompt: string | undefined;
  /** The shell's session list; panes never fetch their own copy. */
  @property({ attribute: false }) paneGroups: readonly SessionGroup[] | undefined;
  @property(paneCallback) onPaneUpdate: ((text: string, attachments: readonly Attachment[]) => boolean) | undefined;
  /** Embedded panes own the composer but not the sidebar; report draft
   * presence so the shell can project the pencil onto the session row. */
  @property(paneCallback) onPaneDraftChange: ((sessionId: string, hasDraft: boolean) => void) | undefined;
  /** The shell's bots: an `@` in this pane's composer suggests them, and its chat shows their faces. */
  @property(paneBotsProperty) paneBots: readonly BotView[] | undefined;
  /** Opens a bot's chat in the shell, from its name on a message. */
  @property(paneCallback) onPaneOpenBot: ((botId: string) => void) | undefined;
  /** Set on the bot route's pane while the bot can be called. */
  @property(paneCallProperty) paneCall: PaneCall | undefined;
  @property(paneCallback) onPaneCall: (() => void) | undefined;
  /** The app's calls (top-level only): the one call with a bot, on GPT-Live. */
  private readonly voice = new VoiceController(this, {
    platform: (bot) => liveCallPlatform(bot, { startBotCall, postCallDelegation, postCallTask, postCallLines, postCallHeartbeat, deleteCall, subscribeSession }),
    now: () => Date.now(),
    setInterval: (callback, ms) => { const timer = window.setInterval(callback, ms); return () => window.clearInterval(timer); },
  });
  private mobileNavMedia: MediaQueryList | undefined;
  private composerTextarea: HTMLTextAreaElement | null = null;
  private readonly onMobileNavChange = (event: MediaQueryListEvent) => {
    this.mobileNavLayout = event.matches;
    // The bot panel moves between the side and a sheet; what it reads follows.
    this.syncBotPanelData();
  };

  /** Direct session route waiting for the registry to finish loading. */
  private pendingSessionId = "";
  /** Route that opened Settings. Direct Settings URLs deliberately fall home. */
  private settingsReturnTarget: NavigationTarget = { kind: "home" };
  private deleteReturnFocus: HTMLElement | undefined;
  private deleteNeedsFocus = false;
  private autoFollow = true;
  /** Rows grow after they render (link previews, images, diagrams): a followed thread stays at its end. */
  private readonly followResize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(([entry]) => {
    const thread = entry?.target.parentElement;
    if (this.autoFollow && this.paneVisible && thread) thread.scrollTop = thread.scrollHeight;
  });
  private followed: Element | undefined;
  private commandPaletteReturnFocus: HTMLElement | undefined;

  get hasQueuedMessageEdit(): boolean { return Boolean(this.composer.queueEditingId); }

  private readonly onPopState = () => {
    this.syncFromLocation();
  };

  private readonly onGlobalKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.composer.sideChat) {
      this.composer.closeSideChat();
      return;
    }
    if (this.embeddedPane) return;
    if (event.key === "Escape") {
      this.handleGlobalEscape(event);
      return;
    }
    // The desktop app has no find bar: on a filterable settings list, Cmd/Ctrl+F searches it. An open dialog or
    // palette keeps the browser's own find.
    const listFilter = isListFilterShortcut(event) && !this.commandPaletteOpen && !document.querySelector("dialog[open]")
      ? this.renderRoot.querySelector<HTMLInputElement>(".settings-list-filter__input") : null;
    if (listFilter) {
      event.preventDefault();
      listFilter.focus();
      listFilter.select();
      return;
    }
    if (isBotSettingsShortcut(event)) {
      if (this.view !== "bot" || this.settingsOpen || this.commandPaletteOpen || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      this.toggleBotSettings();
      return;
    }
    if (!isCommandPaletteShortcut(event)) return;
    event.preventDefault();
    this.commandPaletteOpen ? this.closeCommandPalette() : this.openCommandPalette();
  };

  /**
   * Document-level fallback so Escape works regardless of focus (e.g. body
   * after navigation). Scoped handlers that consume Escape call preventDefault.
   */
  private handleGlobalEscape(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || this.commandPaletteOpen) return;
    if (hasOpenWebAwesomePopup(event) || document.querySelector("dialog[open]")) return;
    if (this.composer.sideChat) {
      event.preventDefault();
      this.composer.closeSideChat();
      return;
    }
    if (this.settingsOpen) {
      event.preventDefault();
      this.closeSettings();
      return;
    }
    if (!this.embeddedPane && this.view === "bot") {
      if (this.mobileNavLayout && this.bots.sheetOpen) {
        event.preventDefault();
        this.closeBotPanel();
        return;
      }
      // An expanded panel hides the chat: Escape brings the chat back and never stops a turn the operator cannot see.
      if (this.botPanelShownExpanded()) {
        event.preventDefault();
        this.expandBotPanel(false);
        return;
      }
      this.botPaneApp()?.handleGlobalEscape(event);
      return;
    }
    if (!this.embeddedPane && this.view === "home" && this.conversation.selected) {
      // A maximized Work pane hides the chat: Escape never stops a turn the operator cannot see.
      if (this.work.maximized()) return;
      this.activePaneApp()?.handleGlobalEscape(event);
      return;
    }
    if (this.view === "home" && this.conversation.selected && this.conversation.streaming && !this.conversation.stopping) {
      event.preventDefault();
      this.composer.abort();
    }
  }

  private readonly onPageHide = () => {
    void this.composer.persistDraft();
  };

  override connectedCallback() {
    super.connectedCallback();
    if (this.embeddedPane) {
      if (this.paneSessionId) this.applyNavigation({ kind: "session", id: this.paneSessionId });
    } else {
      this.work.start();
      this.syncFromLocation();
      this.mobileNavMedia = window.matchMedia(APP_SHELL_DRAWER_MEDIA);
      this.mobileNavLayout = this.mobileNavMedia.matches;
      this.mobileNavMedia.addEventListener("change", this.onMobileNavChange);
      window.addEventListener("popstate", this.onPopState);
      document.addEventListener("keydown", this.onGlobalKeyDown);
      this.addEventListener(OPEN_SETTINGS_EVENT, this.onOpenSettingsRequest);
      this.addEventListener(OPEN_FILE_EVENT, this.onOpenFileRequest);
    }
    window.addEventListener("pagehide", this.onPageHide);
    if (!this.embeddedPane) {
      this.sessions.start();
      this.bots.sync();
      this.updates.watch();
    }
  }

  override disconnectedCallback() {
    this.sessions.pauseArchiveToast();
    void this.composer.persistDraft();
    super.disconnectedCallback();
    window.clearInterval(this.sessionProgressPoll);
    this.mobileNavMedia?.removeEventListener("change", this.onMobileNavChange);
    this.mobileNavMedia = undefined;
    if (this.composerTextarea) disconnectTextareaOverflowObserver(this.composerTextarea);
    this.composerTextarea = null;
    window.removeEventListener("popstate", this.onPopState);
    this.removeEventListener(OPEN_SETTINGS_EVENT, this.onOpenSettingsRequest);
    this.removeEventListener(OPEN_FILE_EVENT, this.onOpenFileRequest);
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("keydown", this.onGlobalKeyDown);
    this.work.stop();
    if (!this.embeddedPane) this.voice.dispose();
    this.followResize?.disconnect();
    this.followed = undefined;
    this.sessions.stop();
  }

  private sessionProgressPoll?: number;
  override firstUpdated() {
    if (!this.embeddedPane) void this.control.refreshPower();
    this.sessionProgressPoll = window.setInterval(() => {
      // Not on macOS stays not on macOS; otherwise the banner follows the gateway.
      if (!this.embeddedPane && !document.hidden && this.control.power !== null) void this.control.refreshPower();
      if (!document.hidden && this.conversation.transcript.length) this.requestUpdate();
      if (!this.embeddedPane && !document.hidden && this.settingsOpen && this.settingsPage === "connection") {
        void this.control.refreshGatewayHealth();
      }
      // Roster times ("2m") age while nothing else re-renders the sidebar.
      if (!this.embeddedPane && !document.hidden && this.bots.tab === "bots" && ++this.botRosterTick % 10 === 0) {
        this.requestUpdate();
      }
    }, 3000);
    this.composer.switchDraft(NEW_SESSION_DRAFT_KEY);
    this.composer.refreshDraftIndicators();
    if (!this.embeddedPane) {
      void this.refreshSessions();
      this.loadLaunchPreferences();
      // The home page shows the launch form too, without a page navigation.
      this.launcher.loadWorkers();
      this.control.loadPreviews();
    }
  }

  private followSessionStatus({ id, status, title }: SessionStatusUpdate) {
    const bot = this.bots.list.find((candidate) => candidate.sessionId === id);
    if (bot) {
      this.bots.adopt(this.withLiveBotState(this.bots.list));
      // A turn started or settled: its latest message moved. The bot stream
      // pushes that itself; without it (an older gateway) read the list again.
      if (bot.status !== status && !this.bots.streamLive) void this.bots.refresh();
    }
    if (!this.embeddedPane && this.conversation.selected?.id === id) {
      this.reopenIfRestarted(id, status);
      this.conversation.select({ ...this.conversation.selected, status, ...(title ? { title } : {}) });
    }
  };

  /** The gateway restarted a runtime whose stream had ended: a remote session
   * reattached after a lost connection, or a retry from another screen. */
  private reopenIfRestarted(id: string, status: SessionStatus) {
    if (this.conversation.selected?.id !== id || this.conversation.opening || this.conversation.connection !== "stopped") return;
    if (this.conversation.selected.status === "error" && status !== "error") void this.conversation.open(id);
  }

  private async refreshSessions(background = false) {
    if (this.embeddedPane) {
      // The shell owns the list; resolve once its refresh has reached this pane.
      await this.onPaneRegistryChange?.();
      await this.updateComplete;
      return;
    }
    await this.sessions.refresh(background);
  }

  private followSessionList(ids: ReadonlySet<string>) {
    // Removed conversations take their Work pane record with them (their terminals end with them).
    if (!this.embeddedPane) this.work.commit(pruneWorkPaneStore(this.work.panes, ids));
    if (!this.work.layout) return;
    for (const pane of sessionPanes(this.work.layout)) {
      if (!ids.has(pane.sessionId)) this.work.layout = closeSessionPane(this.work.layout, pane.id);
    }
    const active = activeSessionPane(this.work.layout);
    if (!ids.has(active.sessionId)) {
      this.work.layout = undefined;
      this.work.persistLayout();
      if (this.view === "home" && this.conversation.selected) this.navigate({ kind: "home" }, true);
    } else if (this.view === "home" && this.conversation.selected && !this.settingsOpen) this.work.commitLayout(this.work.layout);
  }

  override willUpdate(changed: PropertyValues) {
    // Subagent trees follow the selection: moving elsewhere folds the old tree.
    if (this.updatingSelectedId !== this.conversation.selected?.id) {
      this.updatingSelectedId = this.conversation.selected?.id;
      this.sessions.toggledSessionTrees = new Set();
    }
    if (changed.has("paneCreating") && !this.paneCreating && changed.get("paneCreating") && this.conversation.selected?.id === this.paneSessionId) {
      void this.conversation.open(this.conversation.selected.id);
    }
    if (this.embeddedPane && changed.has("paneGroups") && this.paneGroups) {
      // The shell's list can trail this pane's own detailed stream; keep the
      // presented session's live status rather than regressing it.
      const selected = this.conversation.selected && this.isSessionPresented(this.conversation.selected.id) ? this.conversation.selected : undefined;
      this.sessions.groups = selected
        ? this.paneGroups.map((group) => ({
            ...group,
            sessions: group.sessions.map((session) => session.id === selected.id ? { ...session, status: selected.status } : session),
          }))
        : this.paneGroups;
      // Renames (by another screen or the gateway's generated name) reach the header.
      const listed = selected && this.listedSession(selected.id);
      // The stream clears an interruption when a run starts; the gateway clears
      // it when a reattached remote run turns out to have finished.
      if (listed) this.conversation.select({ ...selected, ...listed, status: selected.status, interrupted: selected.interrupted && listed.interrupted });
      const shellStatus = selected && this.paneGroups.flatMap((group) => group.sessions).find((session) => session.id === selected.id)?.status;
      if (selected && shellStatus) this.reopenIfRestarted(selected.id, shellStatus);
      this.sessions.loading = false;
      this.openPendingSession();
    }
    const queueEditChanged = this.renderedQueueEditingId !== this.composer.queueEditingId;
    this.renderedQueueEditingId = this.composer.queueEditingId;
    if (queueEditChanged && this.embeddedPane) {
      this.dispatchEvent(new CustomEvent("hui-queue-edit-retention", { bubbles: true }));
    }
    if (
      this.embeddedPane &&
      changed.has("paneSessionId") &&
      this.paneSessionId &&
      this.paneSessionId !== this.conversation.selected?.id &&
      this.paneSessionId !== this.pendingSessionId
    ) {
      this.applyNavigation({ kind: "session", id: this.paneSessionId });
    }
  }

  /** Lit cannot autofocus a field that appears on a later render, and typing
   * straight into a rename is the whole point of an inline field. */
  override updated(changed: PropertyValues) {
    // Session and bot panes measure their own composers.
    const textarea = !this.embeddedPane && ((this.view === "home" && this.conversation.selected) || this.view === "bot")
      ? null : this.renderRoot.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea");
    const draftReplaced = this.renderedDraftRevision !== this.composer.draftRevision;
    this.renderedDraftRevision = this.composer.draftRevision;
    if (textarea !== this.composerTextarea) {
      if (this.composerTextarea) disconnectTextareaOverflowObserver(this.composerTextarea);
      this.composerTextarea = textarea;
      if (textarea) {
        observeTextareaOverflow(textarea);
        scheduleTextareaHeightAdjustment(textarea);
      }
    } else if (textarea && draftReplaced) {
      // Typing measures its own textarea in the input handler; only a draft that
      // code replaced under it needs a measuring pass after the render.
      scheduleTextareaHeightAdjustment(textarea);
    }
    if (this.composer.pendingCommandBrowse && this.conversation.selected?.status === "idle" && !this.conversation.opening && textarea) {
      this.composer.browseCommands(textarea);
    }
    // A bot's chat offers GPT-Live calls once the gateway says a ChatGPT login is there.
    if (!this.embeddedPane && this.view === "bot" && !this.bots.callsStatus) void this.bots.loadCallsStatus();
    const selectedChanged = this.renderedSelected !== this.conversation.selected;
    this.renderedSelected = this.conversation.selected;
    const botsChanged = this.renderedBots !== this.bots.list;
    this.renderedBots = this.bots.list;
    if (selectedChanged || changed.has("view") || changed.has("settingsOpen") || changed.has("activeBotId") || botsChanged) {
      const activeSessionTitle = this.settingsOpen ? undefined
        : this.view === "home" ? this.conversation.selected?.title
          : this.view === "bot" ? this.activeBot()?.name
            : undefined;
      if (!this.embeddedPane) document.title = documentTitle(activeSessionTitle);
    }
    this.bots.showDialogs();
    this.botImports.showDialogs(this.renderRoot);
    // A selector that matches nothing walks the whole open transcript, and
    // this runs on every keystroke: query a dialog only while its state shows it.
    const worktreeDialog = this.sessions.worktreeConfirm && this.sessions.worktreeConfirm !== "merged" ? this.renderRoot.querySelector?.(".worktree-remove-dialog") : null;
    if (worktreeDialog instanceof HTMLDialogElement && !worktreeDialog.open) {
      ensureModal(worktreeDialog);
      worktreeDialog.querySelector<HTMLButtonElement>(".worktree-remove-cancel")?.focus();
    }
    const sessionsDeleteDialog = this.sessions.deleteConfirm ? this.renderRoot.querySelector?.(".sessions-delete-dialog") : null;
    if (sessionsDeleteDialog instanceof HTMLDialogElement) ensureModal(sessionsDeleteDialog);
    const backlogRemoveDialog = this.backlog.removing ? this.renderRoot.querySelector?.(".backlog-remove-dialog") : null;
    if (backlogRemoveDialog instanceof HTMLDialogElement) ensureModal(backlogRemoveDialog);
    const deleteDialog = this.deletingFor ? this.renderRoot.querySelector?.(".delete-session-dialog") : null;
    if (deleteDialog instanceof HTMLDialogElement) {
      ensureModal(deleteDialog);
    }
    if (this.deleteNeedsFocus && this.deletingFor) {
      this.deleteNeedsFocus = false;
      const cancel = this.renderRoot.querySelector?.(".delete-session-cancel");
      if (cancel instanceof HTMLButtonElement) cancel.focus();
    }
    const questionChanged = this.renderedQuestion !== this.conversation.question;
    this.renderedQuestion = this.conversation.question;
    if (questionChanged && this.conversation.question && (!this.embeddedPane || this.paneVisible)) {
      const focus = () => {
        const questionControl = this.renderRoot.querySelector?.(QUESTION_FOCUS_SELECTOR);
        if (questionControl instanceof HTMLElement) questionControl.focus();
      };
      // The questionnaire card renders its controls in its own update, after this one.
      const card = this.renderRoot.querySelector?.<QuestionnaireCard>("hui-questionnaire-card");
      if (card) void card.updateComplete.then(focus);
      else focus();
    }
    const groupDialog = this.groupAction ? this.renderRoot.querySelector?.(".group-action-dialog") : null;
    const updateDialog = this.updates.open ? this.renderRoot.querySelector?.(".hui-update-dialog") : null;
    if (updateDialog instanceof HTMLDialogElement) ensureModal(updateDialog);
    if (groupDialog instanceof HTMLDialogElement) ensureModal(groupDialog);
    const resourceReader = this.control.piResourceReader ? this.renderRoot.querySelector?.(".pi-resource-reader-modal") : null;
    if (resourceReader instanceof HTMLDialogElement) ensureModal(resourceReader);
    const commandPalette = this.commandPaletteOpen ? this.renderRoot.querySelector?.(".command-palette-dialog") : null;
    if (commandPalette instanceof HTMLDialogElement) {
      ensureModal(commandPalette);
      if (changed.has("commandPaletteOpen")) {
        const input = this.renderRoot.querySelector?.("#command-palette-input");
        if (input instanceof HTMLInputElement) input.focus();
      }
    }
    // The live compaction divider sits below the transcript rows, so its changes follow too.
    const compactionChanged = this.renderedCompaction !== this.conversation.compaction;
    this.renderedCompaction = this.conversation.compaction;
    const transcriptChanged = this.renderedTranscript !== this.conversation.transcript;
    this.renderedTranscript = this.conversation.transcript;
    if ((transcriptChanged || compactionChanged || changed.has("paneVisible")) && this.autoFollow) this.scrollToBottom();
    if (!this.renamingFor) {
      return;
    }
    const field = this.renderRoot.querySelector?.(".chat-pane__session-title-input");
    if (field instanceof HTMLInputElement && document.activeElement !== field) {
      field.focus();
      field.select();
    }
  }

  private syncFromLocation() {
    const resolved = resolveNavigation(window.location.pathname);
    if (resolved.target.kind === "session") {
      let saved = parseSessionLayout(window.history.state?.huiSessionLayout);
      if (!saved) try { saved = parseSessionLayout(JSON.parse(localStorage.getItem(SESSION_LAYOUT_KEY) ?? "null")); } catch { /* Use a single view. */ }
      if (saved) {
        // Terminal and browser panes saved before the Work pane move into it, without losing any.
        const migrated = migrateLayoutWorkViews(saved, this.work.panes);
        if (migrated.moved) {
          saved = migrated.layout;
          this.work.commit(migrated.store);
          this.work.layout = saved;
          this.work.persistLayout();
          window.history.replaceState({ ...window.history.state, huiSessionLayout: saved }, "");
        }
      }
      this.work.layout = saved ?? singleSessionLayout(resolved.target.id);
      if (activeSessionPane(this.work.layout).sessionId !== resolved.target.id) this.work.layout = replacePaneSession(this.work.layout, this.work.layout.activePaneId, resolved.target.id);
    }
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const canonical = resolved.path;
    if (current !== canonical) {
      window.history.replaceState({ ...window.history.state, huiSessionLayout: this.work.layout }, "", canonical);
    }
    this.applyNavigation(resolved.target);
  }

  private navigate(target: NavigationTarget, replace = false) {
    if (this.embeddedPane) {
      if (target.kind === "session") this.onPaneNavigate?.(target.id);
      else if (target.kind === "home") void this.onPaneRegistryChange?.();
      return;
    }
    if (target.kind === "session") {
      const layout = this.work.layout ?? singleSessionLayout(target.id);
      this.work.layout = replacePaneSession(layout, layout.activePaneId, target.id);
      this.work.persistLayout();
    }
    const path = navigationPath(target);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== path) {
      window.history[replace ? "replaceState" : "pushState"]({ huiSessionLayout: this.work.layout }, "", path);
    }
    this.applyNavigation(target);
  }

  /** Selection is retained while another surface is open, but only the active
   * session route may replace global lifecycle and unread state with its
   * detailed stream. */
  private isSessionPresented(id: string): boolean {
    if (this.embeddedPane) return this.paneVisible && this.paneSessionId === id;
    if (this.view === "bot") return !this.settingsOpen && this.activeBot()?.sessionId === id;
    if (this.view === "home" && !this.settingsOpen && this.work.layout) {
      const narrow = this.renderRoot.querySelector<SessionMultiplexer>("hui-session-multiplexer")?.narrow;
      return visibleSessionPanes(this.work.layout).some((pane) => isChatPane(pane) && pane.sessionId === id && (!narrow || pane.id === this.work.layout?.activePaneId));
    }
    const target = resolveNavigation(window.location.pathname).target;
    return target.kind === "session" && target.id === id;
  }

  private applyNavigation(target: NavigationTarget) {
    if (target.kind === "settings") {
      this.settingsPage = target.page;
      this.settingsOpen = true;
      this.loadSettingsData();
      if (target.page === "diagnostics") this.loadOperationalData();
      if (target.page === "worktrees") this.sessions.openWorktrees();
      if (target.page === "automation") this.automation.startPolling();
      else this.automation.stopPolling();
      return;
    }

    this.settingsOpen = false;
    this.automation.stopPolling();
    if (target.kind === "bot") {
      // An embedded pane has no bots: a bot's address lands on the normal home there.
      if (this.embeddedPane) {
        this.navigate({ kind: "home" }, true);
        return;
      }
      this.conversation.suspend();
      this.resetSessionEphemeral();
      this.pendingSessionId = "";
      this.activePage = undefined;
      if (this.view !== "bot" || this.activeBotId !== target.id) {
        this.bots.resetPanel();
        this.botTools.reset(target.id);
        this.botTriggers.reset(target.id);
        this.botFacts.reset(target.id);
      }
      this.activeBotId = target.id;
      this.view = "bot";
      this.setSidebarTab("bots");
      this.ensureBots();
      this.syncBotPanelData();
      return;
    }
    if (target.kind === "kanban") {
      this.conversation.suspend();
      this.resetSessionEphemeral();
      this.pendingSessionId = "";
      this.activePage = undefined;
      this.view = "kanban";
      void this.refreshSessions(true);
      void this.backlog.refresh();
      return;
    }
    if (target.kind === "page") {
      this.conversation.suspend();
      this.resetSessionEphemeral();
      if (target.page.id === "new-session") {
        this.composer.switchDraft(NEW_SESSION_DRAFT_KEY);
        this.loadLaunchPreferences();
        this.launcher.requestCheckout(this.launcher.defaults?.cwd ?? "~/");
        this.launcher.loadWorkers();
      }
      this.pendingSessionId = "";
      this.activePage = target.page;
      this.view = "surface";
      if (isPiSurface(target.page)) this.control.loadControlSurfaceData();
      if (isObservabilitySurface(target.page) || isOwnedSurface(target.page)) this.loadOperationalData();
      if (target.page.id === "cron" || target.page.id === "tasks") {
        this.automation.load();
        this.automation.startPolling();
      }
      return;
    }
    if (target.kind === "session") {
      this.activePage = undefined;
      this.view = "home";
      this.pendingSessionId = target.id;
      if (this.conversation.selected?.id === target.id) {
        this.pendingSessionId = "";
        // New session keeps the selection but owns the composer; returning to
        // the same session must restore that session's draft key.
        this.composer.switchDraft(sessionDraftKey(target.id));
        if (this.embeddedPane && !this.conversation.streamOpen) void this.conversation.open(target.id);
        return;
      }
      this.openPendingSession();
      return;
    }

    this.pendingSessionId = "";
    this.activePage = undefined;
    this.view = "home";
    this.clearSessionState();
  }

  private openPendingSession() {
    const id = this.pendingSessionId;
    if (!id) {
      return;
    }
    const session = this.sessions.groups.flatMap((group) => group.sessions).find((item) => item.id === id)
      ?? (this.paneSession?.id === id ? this.paneSession : undefined);
    if (session) {
      this.pendingSessionId = "";
      // A bot's chat opens as the bot (with its panel) wherever it is linked from.
      if (!this.embeddedPane && session.bot) {
        this.navigate({ kind: "bot", id: session.bot.id }, true);
        return;
      }
      this.activateSession(session);
      return;
    }
    if (!this.sessions.loading && !this.sessions.error) {
      this.navigate({ kind: "home" }, true);
    }
  }

  private selectView = (_view: NavId) => {
    this.navigate({ kind: "home" });
  };

  private openCommandPalette() {
    if (this.renderRoot.querySelector("dialog[open]")) return;
    this.commandPaletteReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    this.commandPaletteQuery = "";
    this.commandPaletteActiveIndex = 0;
    this.commandPaletteOpen = true;
  }

  private closeCommandPalette = () => {
    const dialog = this.renderRoot.querySelector?.(".command-palette-dialog");
    if (dialog instanceof HTMLDialogElement) closeModal(dialog);
    this.commandPaletteOpen = false;
    this.commandPaletteQuery = "";
    const trigger = this.commandPaletteReturnFocus;
    this.commandPaletteReturnFocus = undefined;
    queueMicrotask(() => {
      if (trigger?.isConnected) trigger.focus();
    });
  };

  private selectCommandPaletteAction = (action: CommandPaletteAction) => {
    const dialog = this.renderRoot.querySelector?.(".command-palette-dialog");
    if (dialog instanceof HTMLDialogElement) closeModal(dialog);
    this.commandPaletteOpen = false;
    this.commandPaletteQuery = "";
    this.commandPaletteReturnFocus = undefined;
    switch (action.kind) {
      case "page":
        this.openPage(action.page);
        break;
      case "settings":
        this.openSurfaceSettings(action.page);
        break;
      case "session":
        this.selectSession(action.session);
        break;
    }
  };

  private commandPalette() {
    return renderCommandPalette({
      open: this.commandPaletteOpen,
      query: this.commandPaletteQuery,
      activeIndex: this.commandPaletteActiveIndex,
      pages: HUI_PAGES,
      groups: this.listedGroups,
      onQuery: (query) => {
        this.commandPaletteQuery = query;
        this.commandPaletteActiveIndex = 0;
      },
      onActiveIndex: (index) => {
        this.commandPaletteActiveIndex = index;
      },
      onSelect: this.selectCommandPaletteAction,
      onClose: this.closeCommandPalette,
    });
  }

  private openPage = (page: HuiPage) => {
    if (isRoutablePage(page)) {
      this.navigate({ kind: "page", page });
    }
  };

  private updateSearch = (search: string) => {
    this.search = search;
  };

  private toggleMenu = (sessionId: string) => {
    this.menuFor = this.menuFor === sessionId ? "" : sessionId;
  };

  /** Session mutations are initiated from the sidebar menu; the chat header
   * only renders the temporary editor while a rename is in progress. */
  private renameFromMenu = (session: SessionView) => {
    this.menuFor = "";
    if (!this.embeddedPane) {
      void this.withSessionPane(session, (app) => app.renameFromMenu(session));
      return;
    }
    this.activateSession(session);
    this.renamingFor = session.id;
  };

  private togglePin = (session: SessionView) => {
    this.menuFor = "";
    void renameSession(session.id, { pinned: !session.pinned })
      .then(() => this.refreshSessions())
      .catch((error: unknown) => {
        this.reportOperationError(error, "Could not pin that session.");
      });
  };

  private setSessionMetadata = (
    session: SessionView,
    patch: { unread?: boolean; archived?: boolean; icon?: string },
    success: string,
  ) => {
    this.menuFor = "";
    void renameSession(session.id, patch)
      .then((updated) => {
        if (this.conversation.selected?.id === updated.id) this.conversation.select(updated);
        this.sessions.notify(patch.archived === true ? "" : success);
        if (patch.archived === true) {
          this.sessions.showArchived(updated);
        }
        const tree = sessionTreeIds(this.sessions.groups.flatMap((group) => group.sessions), updated.id);
        if (patch.archived === true && this.work.layout) {
          for (const pane of sessionPanes(this.work.layout)) {
            if (tree.has(pane.sessionId)) this.work.layout = closeSessionPane(this.work.layout, pane.id);
          }
          this.work.persistLayout();
        }
        if (patch.archived === true && this.conversation.selected && tree.has(this.conversation.selected.id)) {
          this.clearSessionState();
          this.navigate({ kind: "home" }, true);
        }
        return this.refreshSessions();
      })
      .catch((error: unknown) => {
        this.sessions.notify(error instanceof Error ? error.message : "Could not update that session.", true);
      });
  };

  private copySession = (session: SessionView, action: SessionCopyAction) => {
    if (!this.embeddedPane && action === "markdown") {
      void this.withSessionPane(session, (app) => app.copySession(session, action));
      return;
    }
    this.menuFor = "";
    const text = action === "id"
      ? session.id
      : action === "jira"
        ? session.jiraIssues?.at(-1)?.url ?? ""
      : action === "link"
        ? new URL(navigationPath({ kind: "session", id: session.id }), window.location.href).href
        : this.conversation.selected?.id === session.id
          ? transcriptAsMarkdown(this.conversation.transcript)
          : "";
    if (!text) {
      this.sessions.notify("Open the conversation before copying it as Markdown.", true);
      return;
    }
    void writeClipboardText(text).then((copied) => {
      if (!copied) throw new Error("Clipboard write failed");
      this.sessions.notify(action === "id" ? "Session ID copied." : action === "jira" ? "Jira link copied." : action === "link" ? "Session link copied." : "Conversation copied as Markdown.");
    }).catch(() => {
      this.sessions.notify("Could not copy to the clipboard.", true);
    });
  };

  private openSessionElsewhere = (session: SessionView, action: SessionOpenAction) => {
    this.menuFor = "";
    if (action === "jira") {
      const issue = session.jiraIssues?.at(-1);
      if (issue) window.open(issue.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (action === "editor") {
      window.location.href = `vscode://file${encodeURI(session.cwd)}`;
      return;
    }
    const path = navigationPath({ kind: "session", id: session.id });
    window.open(path, "_blank", action === "window" ? "popup,noopener,noreferrer" : "noopener,noreferrer");
  };

  private openJiraCreate = (session: SessionView) => {
    this.menuFor = "";
    this.backlog.openJiraCreate(session);
  };

  private openJiraLink = (session: SessionView) => {
    this.menuFor = "";
    this.backlog.openJiraLink(session);
  };

  private renderJiraLinkDialog() {
    if (!this.backlog.jiraLinkSession && !this.backlog.jiraLinkBacklogItem) return null;
    return html`<hui-jira-link-dialog
      .session=${this.backlog.jiraLinkSession}
      .backlogItem=${this.backlog.jiraLinkBacklogItem}
      .onClose=${this.backlog.closeJiraLink}
      .onLinked=${this.backlog.jiraLinked}
      .onOpenSettings=${() => this.openSurfaceSettings("integrations")}
    ></hui-jira-link-dialog>`;
  }

  private renderJiraCreateDialog() {
    if (!this.backlog.jiraCreateSession && !this.backlog.jiraCreateBacklogItem) return null;
    return html`<hui-jira-create-dialog
      .session=${this.backlog.jiraCreateSession}
      .backlogItem=${this.backlog.jiraCreateBacklogItem}
      .suggestion=${this.backlog.jiraCreateSuggestion}
      .onClose=${this.backlog.closeJiraCreate}
      .onCreated=${this.backlog.jiraCreated}
      .onOpenSettings=${() => this.openSurfaceSettings("integrations")}
    ></hui-jira-create-dialog>`;
  }

  private moveSession = (session: SessionView, group: string) => {
    if (this.sessionMovePendingId || session.group === group) return;
    this.menuFor = "";
    this.draggingSessionId = "";
    this.sessionDropTarget = "";
    this.sessionMovePendingId = session.id;
    this.sessions.notify(`Moving ${session.title}…`);
    void renameSession(session.id, { group })
      .then((updated) => {
        if (this.conversation.selected?.id === updated.id) this.conversation.select({ ...this.conversation.selected, group: updated.group });
        this.sessions.notify(`Moved ${updated.title} to ${sessionGroupLabel(updated.group)}.`);
        return this.refreshSessions();
      })
      .catch((error: unknown) => {
        this.sessions.notify(error instanceof Error ? error.message : "Could not move that session.", true);
      })
      .finally(() => {
        this.sessionMovePendingId = "";
      });
  };

  /** Operator stage placement from the Kanban board. Nothing moves until the
   * server confirms; the refreshed registry is the only source of the column. */
  private moveKanbanSession = (session: SessionView, move: KanbanMove) => {
    if (this.kanbanMovePendingId || (move.stage === undefined && move.group === undefined)) return;
    const target = (stage: SessionStage | null | undefined, group: string | undefined) => [
      ...(group !== undefined ? [sessionGroupLabel(group)] : []),
      ...(stage ? [SESSION_STAGE_LABELS[stage]] : []),
    ].join(" · ");
    this.kanbanMovePendingId = session.id;
    this.sessions.notify(move.stage === null ? `Handing ${session.title} back to the agent…` : `Moving ${session.title} to ${target(move.stage, move.group)}…`);
    // One PATCH, so a stage and group change land together or not at all.
    void renameSession(session.id, move)
      .then((updated) => {
        const label = SESSION_STAGE_LABELS[updated.stage ?? DEFAULT_SESSION_STAGE];
        this.sessions.notify(move.stage === null
          ? `${updated.title} follows its agent again (${label}).`
          : `Moved ${updated.title} to ${target(move.stage ? updated.stage : undefined, move.group !== undefined ? updated.group : undefined)}.`);
        if (this.conversation.selected?.id === updated.id) this.conversation.select({ ...this.conversation.selected, group: updated.group, stage: updated.stage, stageOrigin: updated.stageOrigin });
        return this.refreshSessions(true);
      })
      .catch((error: unknown) => {
        this.sessions.notify(error instanceof Error ? error.message : "Could not move that session.", true);
      })
      .finally(() => {
        this.kanbanMovePendingId = "";
        // Keep focus on the moved card so keyboard moves can continue.
        void this.updateComplete.then(() => {
          this.renderRoot.querySelector<HTMLElement>(`.kanban-card[data-session-id="${CSS.escape(session.id)}"] .kanban-card__title`)?.focus();
        });
      });
  };

  private renderBacklogStartDialog() {
    if (!this.backlog.starting) return null;
    return html`<hui-backlog-start-dialog
      .item=${this.backlog.starting.item}
      .target=${this.backlog.starting.target}
      .branchPrefix=${this.control.settings.branchPrefix}
      .onClose=${this.backlog.closeStart}
      .onStarted=${this.backlog.started}
    ></hui-backlog-start-dialog>`;
  }

  private renderBacklogRemoveDialog() {
    const item = this.backlog.removing;
    if (!item) return null;
    const close = this.backlog.cancelRemove;
    return html`<dialog class="hui-modal-dialog group-action-dialog backlog-remove-dialog" aria-labelledby="backlog-remove-title"
      @cancel=${(event: Event) => { event.preventDefault(); close(); }}>
      <form class="exec-approval-card" method="dialog" @submit=${this.backlog.confirmRemove}>
        <div class="exec-approval-title" id="backlog-remove-title">Remove “${item.title}” from the backlog?</div>
        <div class="exec-approval-sub">The local task and its problem and fix notes are deleted. ${item.jira ? `The linked Jira work item ${item.jira.key} is not changed.` : ""}</div>
        <div class="exec-approval-actions">
          <button type="submit" class="btn danger" ?disabled=${Boolean(this.backlog.pendingId)}>${this.backlog.pendingId ? "Removing…" : "Remove"}</button>
          <button type="button" class="btn" @click=${close}>Cancel</button>
        </div>
      </form>
    </dialog>`;
  }

  private kanbanSessionAction = (session: SessionView, action: SessionCardAction) => {
    if (action === "open:jira") this.openSessionElsewhere(session, "jira");
    else if (action === "copy:jira") {
      const url = session.jiraIssues?.at(-1)?.url;
      void (url ? writeClipboardText(url) : Promise.resolve(false)).then((copied) => {
        this.sessions.notify(copied ? "Jira link copied." : "Could not copy to the clipboard.", !copied);
      });
    } else if (action === "jira:create") this.openJiraCreate(session);
    else this.openJiraLink(session);
  };

  /** Reorders custom groups. OTHER as the target means "move to the end",
   * because it always renders last. The confirmed server order replaces the
   * local one; nothing is shown optimistically. */
  private reorderGroup = (group: string, target: GroupDropTarget) => {
    if (this.groupReorderPending) return;
    const order = customGroupOrder(this.sessions.groups);
    const next = target.group === "ungrouped"
      ? order.at(-1) === group || !order.includes(group) ? undefined : [...order.filter((label) => label !== group), group]
      : moveGroupLabel(order, group, target.group, target.position);
    this.draggingGroup = "";
    this.groupDropTarget = undefined;
    if (!next) return;
    this.sessions.closeGroupMenu();
    this.groupReorderPending = true;
    this.sessions.notify(`Moving ${sessionGroupLabel(group)}…`);
    void reorderSessionGroups(next)
      .then(({ revision, groups }) => {
        this.sessions.receive(revision, groups);
        this.sessions.notify(`Moved ${sessionGroupLabel(group)}.`);
      })
      .catch((error: unknown) => {
        this.sessions.notify(error instanceof Error ? error.message : "Could not reorder the groups.", true);
        return this.refreshSessions(true);
      })
      .finally(() => {
        this.groupReorderPending = false;
      });
  };

  /** Deleting is destructive, so the sidebar action opens a confirmation
   * dialog in the active chat rather than deleting straight from a row. */
  private deleteFromMenu = (session: SessionView) => {
    this.menuFor = "";
    if (!this.embeddedPane) {
      void this.withSessionPane(session, (app) => app.deleteFromMenu(session));
      return;
    }
    this.deleteReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.activateSession(session);
    this.deletingFor = session.id;
    this.deleteNeedsFocus = true;
  };

  /* ── sessions ─────────────────────────────────────────────────────────── */

  private selectSession = (session: SessionView) => {
    if (this.embeddedPane && this.onPaneNavigate) {
      this.onPaneNavigate(session.id);
      return;
    }
    // Choosing a conversation shows its chat; its Work pane stays one selector choice away on narrow screens.
    this.work.hideNarrow();
    const existing = this.work.layout && sessionPanes(this.work.layout).find((pane) => isChatPane(pane) && pane.sessionId === session.id);
    if (existing && this.work.layout) this.work.layout = focusSessionPane(this.work.layout, existing.id);
    this.navigate({ kind: "session", id: session.id });
  };

  private openSplitSession = (session: SessionView) => {
    if (this.embeddedPane || !this.conversation.selected) return;
    const layout = this.work.layout ?? singleSessionLayout(this.conversation.selected.id);
    this.work.commitLayout(splitSessionPane(layout, layout.activePaneId, session.id, "right"));
  };

  private showSession(id: string) {
    this.conversation.select(this.sessions.groups.flatMap((group) => group.sessions).find((session) => session.id === id));
    this.pendingSessionId = this.conversation.selected ? "" : id;
    this.view = "home";
    this.activePage = undefined;
    this.settingsOpen = false;
  }

  /* ── Work pane ────────────────────────────────────────────────────────── */

  /** The conversation the Work pane follows: the focused chat pane's. */
  private workSessionId(): string | undefined {
    if (this.embeddedPane || this.view !== "home" || this.settingsOpen || !this.conversation.selected || !this.work.layout) return undefined;
    return activeSessionPane(this.work.layout).sessionId;
  }

  /**
   * A file reference clicked in a conversation's chat (`components/file-link.ts`): show it in that conversation's
   * Files view — the active one, else its first, else a new one — opening the Work pane (or, on narrow screens, the
   * Work destination) the way any Work view does.
   */
  private readonly onOpenFileRequest = (event: Event) => {
    const detail = (event as CustomEvent<OpenFileDetail>).detail;
    if (this.embeddedPane || !detail?.sessionId || !this.work.layout) return;
    if (!sessionPanes(this.work.layout).some((pane) => isChatPane(pane) && pane.sessionId === detail.sessionId)) return;
    event.stopPropagation();
    void this.work.openFile(detail);
  };

  private focusActiveComposer() {
    void this.updateComplete.then(() => {
      const app = this.activePaneApp();
      const target = app?.querySelector<HTMLElement>("textarea") ?? app?.querySelector<HTMLElement>(".chat-pane__header");
      target?.focus({ preventScroll: true });
    });
  }

  private openTerminal = async () => {
    this.terminalOpening = true;
    this.terminalError = "";
    try { await this.onPaneTerminal?.(); }
    catch (error) { this.terminalError = error instanceof Error ? error.message : "Could not open terminal."; }
    finally { this.terminalOpening = false; }
  };

  private dropSession = (id: string, paneId: string, zone: DropZone) => {
    if (!this.work.layout || !this.sessions.groups.some((group) => group.sessions.some((session) => session.id === id))) return;
    this.draggingSessionId = "";
    this.work.dropSession(id, paneId, zone);
  };

  private activePaneApp(): HuiApp | undefined {
    const id = this.work.layout?.activePaneId;
    return id ? this.renderRoot.querySelector<HuiApp>(
      `[data-session-pane="${CSS.escape(id)}"] .chat-pane-cache__pane--visible > hui-app`,
    ) ?? undefined : undefined;
  }

  private async withSessionPane(session: SessionView, action: (app: HuiApp) => void) {
    this.selectSession(session);
    await this.updateComplete;
    await this.renderRoot.querySelector<SessionMultiplexer>("hui-session-multiplexer")?.updateComplete;
    const app = this.activePaneApp();
    if (app) {
      await app.updateComplete;
      action(app);
    }
  }

  private activateSession(session: SessionView) {
    if (!this.embeddedPane) {
      this.conversation.select(session);
      this.view = "home";
      this.work.layout ??= singleSessionLayout(session.id);
      return;
    }
    if (session.id === this.conversation.selected?.id) {
      // Already selected, including while its open request is pending. Starting
      // a duplicate would race two responses and two event subscriptions.
      this.view = "home";
      return;
    }
    this.resetSessionEphemeral();
    this.composer.switchDraft(sessionDraftKey(session.id));
    this.view = "home";
    this.conversation.select(session);
    void this.conversation.open(session.id);
  }

  private adoptRunEvent(event: RuntimeEvent) {
    if (event.type === "queue_update") this.composer.adoptQueue(event.queue);
    if (event.type === "notice" || event.type === "settled" || event.type === "error") {
      ({ note: this.note, noteLevel: this.noteLevel, recoveryNotice: this.recoveryNotice } = noteAfterEvent({ note: this.note, noteLevel: this.noteLevel, recoveryNotice: this.recoveryNotice }, event));
    }
  }

  private followConversationStatus(id: string, status: SessionStatus, interrupted: SessionView["interrupted"]) {
    this.composer.followStatus(status);
    // Keep the sidebar dot honest without a full re-fetch.
    this.sessions.showStatus(id, status, interrupted);
  }

  private isUpdateSession(session: SessionView | undefined): boolean {
    return session?.title === HUI_UPDATE_SESSION_TITLE && session.group === "";
  }

  /** Update is an HUI operation, but it still gets a durable, retryable home
   * in the session list. The session is opened without an initial prompt: the
   * visible `/update` stays in its composer and is never sent to PI. */
  private async openUpdateSession(command: "update" | "check"): Promise<boolean> {
    const draft = command === "check" ? "/update --check" : "/update";
    const activeSessionView = this.view === "home" && this.activePage === undefined && !this.settingsOpen;
    const sourceOwner = !this.embeddedPane && activeSessionView ? this.activePaneApp() ?? this : this;
    if (activeSessionView && this.isUpdateSession(this.conversation.selected)) {
      sourceOwner.composer.updateDraft(draft);
      return true;
    }
    if (this.updateSessionCreating) return false;
    const sourceDraftKey = sourceOwner.composer.draftKey;
    const sourceDraft = sourceOwner.composer.draft;
    const activeSession = activeSessionView ? this.conversation.selected : undefined;
    this.updateSessionCreating = true;
    try {
      const session = await createSession({
        cwd: activeSession?.cwd || this.launcher.defaults?.cwd || "~/",
        title: HUI_UPDATE_SESSION_TITLE,
        group: "",
      });
      await this.refreshSessions();
      const refreshed = this.sessions.groups.flatMap((group) => group.sessions).find((candidate) => candidate.id === session.id) ?? session;
      // The command was consumed by HUI, not by the source session. Remove
      // only that exact command draft; an unrelated draft from Review update
      // must survive the session switch.
      if (sourceOwner.composer.draftKey === sourceDraftKey && sourceOwner.composer.draft === sourceDraft && sourceDraft.trim() === draft) {
        sourceOwner.composer.draftEdit += 1;
        sourceOwner.composer.setDraft("");
        void sourceOwner.composer.persistDraft(sourceDraftKey, "", []);
      }
      this.resetSessionEphemeral();
      if (this.embeddedPane) this.composer.switchDraft(sessionDraftKey(refreshed.id));
      this.view = "home";
      this.conversation.select(refreshed);
      this.navigate({ kind: "session", id: refreshed.id });
      if (this.embeddedPane) {
        await this.composer.persistDraft(sessionDraftKey(refreshed.id), draft, []);
      } else await this.withSessionPane(refreshed, (app) => app.composer.updateDraft(draft));
      return true;
    } catch (error) {
      this.note = error instanceof Error ? error.message : "Could not create the HUI update session.";
      this.noteLevel = "error";
      return false;
    } finally {
      this.updateSessionCreating = false;
    }
  }

  private handleUpdateCommand(text: string, attachments: readonly Attachment[] = []): boolean {
    const command = parseUpdateCommand(text);
    if (!command) return false;
    if (command === "invalid" || attachments.length) {
      this.note = "Use /update or /update --check, without attachments. This command is handled by HUI, not the model.";
      this.noteLevel = "error";
      return true;
    }
    if (this.embeddedPane && this.onPaneUpdate) return this.onPaneUpdate(text, attachments);
    this.note = "";
    this.noteLevel = "info";
    this.composer.closeCommands();
    this.updates.review(this.composerTextarea, command === "check", () => this.openUpdateSession(command));
    return true;
  }

  private reviewUpdate = () => {
    this.updates.review(document.activeElement instanceof HTMLElement ? document.activeElement : null, false, () => this.openUpdateSession("update"));
  };

  /** The New Session page keeps the last chat selected, but its composer drafts a session that does not exist yet. */
  private composerSession(): SessionView | undefined {
    return this.view === "surface" && this.activePage?.id === "new-session" ? undefined : this.conversation.selected;
  }

  /** The shell's roster: what an `@` in this composer suggests and whose faces its chat shows. */
  private readonly mentionable = (): readonly BotView[] => this.embeddedPane ? this.paneBots ?? [] : this.bots.list;

  private currentRunError() {
    const session = this.conversation.selected;
    const error = session ? latestRunError(this.conversation.transcript, this.conversation.streaming) : undefined;
    if (!session || !error || this.conversation.dismissedRunErrors.has(`${session.id}\0${error.key}`)) return undefined;
    return error;
  }

  private dismissRunError = () => {
    const session = this.conversation.selected;
    const error = this.currentRunError();
    if (!session || !error) return;
    this.conversation.dismissedRunErrors = new Set([...this.conversation.dismissedRunErrors, `${session.id}\0${error.key}`]);
    this.requestUpdate();
  };

  private continueAfterError = () => {
    if (!this.currentRunError()) return;
    this.composer.send(CONTINUE_AFTER_ERROR_PROMPT);
  };

  private forked = async (forked: SessionView) => {
    this.composer.closeFork();
    await this.refreshSessions();
    this.selectSession(this.sessions.groups.flatMap((group) => group.sessions).find((candidate) => candidate.id === forked.id) ?? forked);
  };

  private renderForkDialog() {
    if (!this.composer.forkTarget) return null;
    return html`<hui-fork-dialog
      .target=${this.composer.forkTarget}
      .branchPrefix=${this.control.settings.branchPrefix}
      .onClose=${() => this.composer.closeFork()}
      .onForked=${this.forked}
    ></hui-fork-dialog>`;
  }

  private continueRun = () => {
    const session = this.conversation.selected;
    if (!session || this.conversation.streaming || this.conversation.opening || this.continuing) return;
    this.continuing = true;
    this.note = "";
    this.noteLevel = "info";
    void resumeSession(session.id)
      .catch((error: unknown) => {
        if (!isSelectedSession(session.id, this.conversation.selected?.id)) return;
        this.note = error instanceof Error ? error.message : "Could not continue that session.";
        this.noteLevel = "error";
      })
      .finally(() => {
        if (isSelectedSession(session.id, this.conversation.selected?.id)) this.continuing = false;
      });
  };

  private toggleWatcher = (watcher: Watcher, open: boolean) => {
    this.setActivityExpanded(`watcher:${watcher.id}`, open);
    this.backlog.toggleWatcherLog(watcher, open);
  };

  private setActivityExpanded = (id: string, expanded: boolean) => {
    const next = new Set(this.expandedActivityIds);
    if (expanded) next.add(id);
    else next.delete(id);
    this.expandedActivityIds = next;
  };

  private transcriptScrolled = (element: HTMLElement) => {
    this.autoFollow = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    this.showScrollToBottom = !this.autoFollow;
  };

  private navigateTranscript = (element: HTMLElement, top: number) => {
    // Pause before the programmatic scroll: a streaming update must not win
    // the race and pull the reader back to the live edge.
    this.autoFollow = false;
    element.scrollTo({ top, behavior: "instant" });
    // A jump clamped to the current position may not emit a native scroll.
    this.transcriptScrolled(element);
  };

  private scrollToBottom = () => {
    this.autoFollow = true;
    void this.updateComplete.then(() => {
      // Measuring a pane out of sight would lay out its whole transcript on
      // every streamed token; it follows once it is shown again.
      if (!this.autoFollow || !this.paneVisible) return;
      const scroller = this.renderRoot.querySelector?.(TRANSCRIPT_SCROLLER_SELECTOR);
      if (scroller instanceof HTMLElement) {
        const inner = scroller.querySelector(":scope > .chat-thread-inner");
        // Only the app that renders this thread follows it (the shell's selector also finds its panes').
        if (inner && inner !== this.followed && scroller.closest("hui-app") === this) {
          this.followResize?.disconnect();
          this.followResize?.observe(inner);
          this.followed = inner;
        }
        scroller.scrollTop = scroller.scrollHeight;
        this.autoFollow = true;
        this.showScrollToBottom = false;
      }
    });
  };

  private cancelRename = () => {
    this.renamingFor = "";
  };

  /** Enter and blur can both commit the same edit; clearing renamingFor first
   * makes the second call (and a blur after Escape) a no-op. */
  private rename = (title: string) => {
    const session = this.conversation.selected;
    const targetId = this.renamingFor;
    this.renamingFor = "";
    if (!session || targetId !== session.id || title === session.title) {
      return;
    }
    void renameSession(targetId, { title })
      .then((renamed: SessionView) => {
        if (!isSelectedSession(targetId, this.conversation.selected?.id)) {
          return;
        }
        this.conversation.select(renamed);
        void this.onPaneRegistryChange?.();
        return this.refreshSessions();
      })
      .catch((error: unknown) => {
        if (!isSelectedSession(targetId, this.conversation.selected?.id)) {
          return;
        }
        this.reportOperationError(error, "Could not update that session.");
      });
  };

  private cancelDelete = () => {
    this.closeDeleteDialog();
    this.deletingFor = "";
    this.deleteNeedsFocus = false;
    const target = this.deleteReturnFocus;
    this.deleteReturnFocus = undefined;
    void this.updateComplete.then(() => {
      if (target?.isConnected) {
        target.focus();
        return;
      }
      const fallback = this.renderRoot.querySelector?.(".delete-session-trigger");
      if (fallback instanceof HTMLButtonElement) fallback.focus();
    });
  };

  private confirmDelete = () => {
    const session = this.conversation.selected;
    const targetId = this.deletingFor;
    this.closeDeleteDialog();
    this.deletingFor = "";
    this.deleteReturnFocus = undefined;
    this.deleteNeedsFocus = false;
    if (!session || targetId !== session.id) {
      return;
    }
    // A failed worktree launch hands its prompt back to New Session.
    const unsent = this.paneUnsentPrompt;
    void deleteSession(targetId)
      .then(async () => {
        if (unsent) {
          const stored = await readComposerDraft(NEW_SESSION_DRAFT_KEY);
          await writeComposerDraft(NEW_SESSION_DRAFT_KEY, mergeComposerDraft(stored, { text: unsent, attachments: [] }));
        }
        if (isSelectedSession(targetId, this.conversation.selected?.id)) {
          this.clearSessionState();
          this.navigate({ kind: "home" }, true);
        }
        return this.refreshSessions();
      })
      .catch((error: unknown) => {
        this.reportOperationError(error, "Could not delete that session.");
      });
  };

  private retrySelected = () => {
    const id = this.conversation.selected?.id;
    if (id && !this.conversation.opening) void this.conversation.open(id);
  };

  /** The worker's own connect: once it is up, the gateway reattaches its sessions. */
  private reconnectSelected = () => {
    const worker = this.conversation.selected?.worker;
    if (!worker) return;
    void workerAction(worker.id, "connect").catch((error: unknown) => {
      this.note = error instanceof Error ? error.message : `Could not reconnect to ${worker.name}.`;
      this.noteLevel = "error";
    });
  };

  private launch = (input: { cwd: string; title?: string; group?: string; prompt?: string; commandDraft?: string; model?: string; thinking?: string; fast?: boolean; worktree?: boolean; branchName?: string; baseRef?: string; worker?: string }) => {
    if (input.prompt && this.handleUpdateCommand(input.prompt)) return;
    if (this.launching) return;
    this.launching = true;
    this.note = "";
    this.noteLevel = "info";
    const { prompt, commandDraft, ...sessionInput } = input;
    this.composer.pendingLaunchPrompt = prompt?.trim() ?? "";
    const launchAttachments = this.composer.attachments;
    void createSession({
      ...sessionInput,
      ...(prompt?.trim() ? { initialPrompt: prompt.trim() } : {}),
      // The gateway sends a worktree session's first prompt, so it needs these too.
      ...(input.worktree && prompt?.trim() && launchAttachments.length ? { initialAttachments: launchAttachments } : {}),
    })
      .then(async (session) => {
        await deleteComposerDraft(NEW_SESSION_DRAFT_KEY);
        this.composer.draftKey = sessionDraftKey(session.id);
        this.composer.draftHydrated = true;
        this.composer.draftLoad += 1;
        this.composer.draftEdit += 1;
        this.composer.setDraft(commandDraft ?? "");
        this.composer.pendingCommandBrowse = commandDraft !== undefined;
        this.composer.attachments = [];
        if (commandDraft !== undefined) void this.composer.persistDraft();
        this.launcher.resetWorkspace();
        this.conversation.select(session);
        await this.refreshSessions();
        this.navigate({ kind: "session", id: session.id });
        // The gateway sends a worktree session's prompt once its checkout exists.
        const pendingPrompt = session.creating ? "" : this.composer.pendingLaunchPrompt;
        this.composer.pendingLaunchPrompt = "";
        await this.withSessionPane(session, (app) => {
          app.composer.pendingLaunchPrompt = pendingPrompt;
          app.composer.pendingLaunchAttachments = pendingPrompt ? launchAttachments : [];
          app.composer.pendingCommandBrowse = commandDraft !== undefined;
          if (commandDraft !== undefined) app.composer.updateDraft(commandDraft);
          app.composer.flushLaunchPrompt();
        });
        this.composer.draftKey = NEW_SESSION_DRAFT_KEY;
        this.composer.setDraft("");
      })
      .catch((error: unknown) => {
        if (this.composer.pendingLaunchPrompt) {
          this.composer.draftEdit += 1;
          this.composer.setDraft(this.composer.pendingLaunchPrompt);
          this.composer.pendingLaunchPrompt = "";
          void this.composer.persistDraft();
        }
        this.note = error instanceof Error ? error.message : "Could not start that session.";
        this.noteLevel = "error";
      })
      .finally(() => {
        this.launching = false;
      });
  };

  private requestDirectorySuggestions = (input: string) => {
    this.launcher.loadDirectorySuggestions(input);
    if (this.groupAction?.action === "defaults") this.requestGroupCheckout(input);
    else this.launcher.requestCheckout(input);
  };

  private clearSessionState() {
    this.conversation.clear();
    this.composer.clearSession();
    this.backlog.clearSession();
    const empty = emptySessionPresentation();
    this.note = empty.note;
    this.noteLevel = empty.noteLevel;
    this.continuing = false;
    this.showScrollToBottom = false;
    this.autoFollow = true;
    this.resetSessionEphemeral();
  }

  private resetSessionEphemeral() {
    this.composer.resetSession();
    this.closeDeleteDialog();
    this.renamingFor = "";
    this.deletingFor = "";
    this.deleteReturnFocus = undefined;
    this.deleteNeedsFocus = false;
    this.conversation.stopping = false;
    this.conversation.dropQuestion();
    this.note = "";
    this.noteLevel = "info";
    this.conversation.connectionNote = "";
  }

  private closeDeleteDialog() {
    const dialog = this.renderRoot.querySelector?.(".delete-session-dialog");
    if (dialog instanceof HTMLDialogElement) closeModal(dialog);
  }

  private reportOperationError(error: unknown, fallback: string) {
    this.importNote = error instanceof Error ? error.message : fallback;
    this.importFailed = true;
  }

  /* ── bots ─────────────────────────────────────────────────────────────── */

  /** Session lists never show bot chats; the Bots tab lists their bots. The
   * unfiltered registry stays in `groups` so a bot pane can open its chat. */
  private listedGroupsSource: readonly SessionGroup[] | undefined;
  private listedGroupsCache: readonly SessionGroup[] = [];
  private get listedGroups(): readonly SessionGroup[] {
    if (this.listedGroupsSource !== this.sessions.groups) {
      this.listedGroupsSource = this.sessions.groups;
      this.listedGroupsCache = withoutBotSessions(this.sessions.groups);
    }
    return this.listedGroupsCache;
  }

  private activeBot(): BotView | undefined {
    return this.bots.list.find((bot) => bot.id === this.activeBotId);
  }

  private botPaneApp(): HuiApp | undefined {
    return this.renderRoot.querySelector<HuiApp>(".bot-workspace__pane") ?? undefined;
  }

  private withLiveBotState(bots: readonly BotView[]): BotView[] {
    return withLiveChats(bots, { statuses: this.sessions.statuses, unread: this.sessions.unread, presented: (id) => this.isSessionPresented(id) });
  }

  private ensureBots() {
    this.bots.ensure();
    // The roster's + offers the workers a new bot can run on.
    this.launcher.loadWorkers();
  }

  private setSidebarTab = (tab: SidebarTab) => {
    this.botMenuFor = "";
    if (this.bots.selectTab(tab) && tab === "bots") this.ensureBots();
  };

  private selectBot = (bot: BotView) => {
    this.botMenuFor = "";
    this.navigate({ kind: "bot", id: bot.id });
  };

  private openBot = (botId: string) => this.navigate({ kind: "bot", id: botId });

  private shellBotsProps(): ShellBotsProps {
    return {
      tab: this.bots.tab,
      onTab: this.setSidebarTab,
      search: this.botSearch,
      onSearch: (value) => { this.botSearch = value; },
      onNew: () => this.createNewBot(),
      workers: this.launcher.workers,
      onCreate: (worker) => this.createNewBot(worker),
      onImport: this.botImports.openImport,
      onWorkersMenu: () => this.launcher.loadWorkers(),
      creating: this.bots.creating,
      unread: this.bots.list.some((bot) => bot.unread && !bot.archived && !bot.hidden),
      roster: {
        bots: this.bots.list,
        loading: this.bots.loading || !this.bots.loaded,
        error: this.bots.error,
        query: this.botSearch,
        showHidden: this.bots.showHidden,
        showArchived: this.bots.showArchived,
        activeBotId: this.view === "bot" ? this.activeBotId : "",
        menuFor: this.botMenuFor,
        pendingId: this.bots.pendingId,
        now: Date.now(),
        onSelect: this.selectBot,
        onNew: () => this.createNewBot(),
        creating: this.bots.creating,
        onEdit: this.openEditBot,
        onSetHidden: this.setBotHidden,
        onArchive: this.requestArchiveBot,
        onToggleShowHidden: this.bots.toggleShowHidden,
        onToggleShowArchived: this.bots.toggleShowArchived,
        onRestore: this.bots.restore,
        onDelete: this.bots.requestDelete,
        onExport: (bot) => { this.botMenuFor = ""; this.botImports.openExport(bot); },
        onImport: this.botImports.openImport,
        onRetry: this.bots.retry,
        onToggleMenu: (id) => { this.botMenuFor = this.botMenuFor === id ? "" : id; },
        onCloseMenu: () => { this.botMenuFor = ""; },
      },
    };
  }

  private createNewBot = (worker?: string) => {
    this.botMenuFor = "";
    this.bots.create(worker);
  };

  /** The roster's Edit: the bot's chat with its panel on the Settings page, docked beside it on wide screens, as the
   * sheet on narrow ones. */
  private openEditBot = (bot: BotView) => {
    this.botMenuFor = "";
    this.showBotSettings(bot.id);
  };

  /** Opens a bot's Settings page, on its chat (navigating there first). */
  private showBotSettings(botId: string) {
    if (this.view !== "bot" || this.activeBotId !== botId || this.settingsOpen) this.navigate({ kind: "bot", id: botId });
    // Without the Bots tab the bot route goes home instead.
    if (this.view !== "bot" || this.activeBotId !== botId) return;
    this.bots.openPanel(this.mobileNavLayout);
    this.automation.clearErrors();
    this.selectBotPanelView("settings");
  }

  /** Ctrl+Shift+, (⇧⌘,) on a bot's chat, as in Grok Bot: its Settings page when that is not showing, closed when it is. */
  private toggleBotSettings() {
    const bot = this.activeBot();
    if (!bot || bot.archived || !this.listedSession(bot.sessionId)) return;
    if (this.botPanelVisible() && this.bots.panelView === "settings") this.closeBotPanel();
    else this.showBotSettings(bot.id);
  }

  /** Settings' utility model by its catalog name, the default of a bot's utility model. */
  private utilityModelName(): string | undefined {
    const ref = this.control.settings.models.utility;
    if (!ref) return undefined;
    return this.control.pi?.model.catalog.find((entry) => `${entry.provider}/${entry.id}` === ref)?.name ?? ref;
  }

  private setBotHidden = (bot: BotView, hidden: boolean) => {
    this.botMenuFor = "";
    this.bots.setHidden(bot, hidden);
  };

  private requestArchiveBot = (bot: BotView) => {
    this.botMenuFor = "";
    this.bots.requestArchive(bot);
  };

  private botPanelVisible(): boolean {
    // An archived bot's page is a placeholder without the panel.
    return this.view === "bot" && !this.settingsOpen && !this.activeBot()?.archived && (this.mobileNavLayout ? this.bots.sheetOpen : this.bots.panel.open);
  }

  /** The panel fills the bot's view: open, expanded and docked (a sheet never expands). */
  private botPanelShownExpanded(): boolean {
    return this.bots.panelExpanded && !this.mobileNavLayout && this.botPanelVisible();
  }

  private botPanelShows(...views: BotPanelView[]): boolean {
    return this.botPanelVisible() && views.includes(this.bots.panelView);
  }

  /** The overview lists the bot's triggers and its Triggers page manages them. */
  private botTriggersVisible(): boolean {
    return this.botPanelShows("overview", "triggers");
  }

  /** The open Tools page follows the bots stream: a request that waits, or lists a grant changed, reads it again. */
  private followBotTools() {
    const bot = this.botPanelShows("tools") ? this.activeBot() : undefined;
    if (bot) this.botTools.follow(bot);
  }

  /** The bot's triggers start reading once the bot is known (a `/bots/<id>` load), and read again when the bot's chat
   * changes state: a trigger may just have woken it. */
  private followBotTriggers() {
    const bot = this.botTriggersVisible() ? this.activeBot() : undefined;
    if (bot) this.botTriggers.follow(bot);
  }

  /** The panel's page decides what is read: the overview and Routines poll Automation like its page, the overview and
   * Triggers read the triggers, Tools its catalog, and the overview and Settings PI's model catalog. */
  private syncBotPanelData() {
    if (this.embeddedPane) return;
    if (this.botPanelShows("overview", "routines")) {
      this.automation.load();
      this.automation.startPolling();
    } else if (this.view === "bot") {
      this.automation.stopPolling();
    }
    this.botTriggers.sync(this.botTriggersVisible() ? this.activeBot() : undefined);
    const factsBot = this.botPanelShows("facts") ? this.activeBot() : undefined;
    if (factsBot) void this.botFacts.load(factsBot.id);
    const toolsBot = this.botPanelShows("tools") ? this.activeBot() : undefined;
    if (toolsBot) void this.botTools.refresh(toolsBot);
    // The overview names the bot's model and Settings picks it from PI's catalog, as New Session does.
    if (this.botPanelShows("overview", "settings")) this.loadLaunchPreferences();
  }

  /** Puts the focus in the panel. A page opened from a row starts where the row pointed: a section's + on its add
   * form, a routine, trigger or run (`routine-<id>`, `[data-routine]`) or a Settings section (`settings-model`, its
   * heading's id) on that, else on the way back. The overview, gone back to, puts it on the row that opened the page
   * (`returnTo`); otherwise it lands on the panel's body. */
  private focusBotPanel(returnTo = "") {
    void this.updateComplete.then(() => {
      const panel = this.renderRoot.querySelector<HTMLElement>(".bot-panel");
      if (!panel) return;
      const back = panel.querySelector<HTMLElement>(".bot-panel__back");
      const row = returnTo ? panel.querySelector<HTMLElement>(`[data-panel-link="${CSS.escape(returnTo)}"]`) : null;
      if (back && returnTo) {
        const form = returnTo.endsWith("-add") ? panel.querySelector<HTMLElement>('details[open] [name="name"]') : null;
        const dash = returnTo.indexOf("-");
        const item = dash > 0 ? panel.querySelector<HTMLElement>(`[data-${returnTo.slice(0, dash)}="${CSS.escape(returnTo.slice(dash + 1))}"]`) : null;
        const target = form ?? item ?? panel.querySelector<HTMLElement>(`#${CSS.escape(`${panel.id}-${returnTo}`)}`);
        if (target) {
          if (target !== form) target.tabIndex = -1;
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: "start" });
          return;
        }
      }
      (back ?? row ?? panel.querySelector<HTMLElement>(".bot-panel__body"))?.focus();
    });
  }

  private toggleBotPanel = () => {
    this.bots.togglePanel(this.mobileNavLayout);
    this.automation.clearErrors();
    this.syncBotPanelData();
    if (this.botPanelVisible()) this.focusBotPanel();
  };

  private closeBotPanel = () => {
    this.bots.closePanel(this.mobileNavLayout);
    this.syncBotPanelData();
    void this.updateComplete.then(() => this.botPaneApp()?.updateComplete).then(() => {
      this.renderRoot.querySelector<HTMLElement>(".bot-panel-toggle")?.focus();
    });
  };

  /** Opens one of the panel's pages from a row of its overview (`from`, the row's `data-panel-link`), or goes back. */
  private selectBotPanelView = (view: BotPanelView, from = "") => {
    const returnTo = this.bots.showPanelView(view, from);
    this.syncBotPanelData();
    this.focusBotPanel(returnTo);
  };

  private resizeBotPanel = (width: number) => this.bots.resizePanel(width);

  /** Expanded, the panel fills the bot's view and its chat stays mounted underneath, hidden, so a reply streaming in,
   * a draft and the scroll position are all there when it comes back. */
  private expandBotPanel = (expanded: boolean) => {
    this.bots.expandPanel(expanded);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".bot-panel__expand")?.focus());
  };

  private renderBotWorkspace() {
    const bot = this.activeBot();
    const placeholder = (title: string, message: string, tone: "status" | "alert", onRetry?: () => void, actionLabel?: string) => renderBotPlaceholder({
      title, message, tone, mobileNav: this.mobileNavLayout, onToggleNavigation: toggleNavigationDrawer, ...(onRetry ? { onRetry } : {}), ...(actionLabel ? { actionLabel } : {}),
    });
    if (!bot) {
      if (!this.bots.loaded) {
        return this.bots.error
          ? placeholder("Bot", this.bots.error, "alert", this.bots.retry)
          : placeholder("Bot", "Loading bot…", "status");
      }
      return placeholder("Bot not found", "This bot does not exist or has been archived.", "alert");
    }
    // Its chat opens again once it is restored; until then it takes no messages from here.
    if (bot.archived) {
      return placeholder(bot.name, `${bot.name} is archived. Its chat and memory are kept; restore it to open the chat again.`, "status",
        () => this.bots.restore(bot), this.bots.pendingId === bot.id ? "Restoring…" : "Restore");
    }
    const session = this.listedSession(bot.sessionId);
    if (!session) {
      return this.sessions.error
        ? placeholder(bot.name, this.sessions.error, "alert", () => void this.refreshSessions())
        : placeholder(bot.name, `Opening ${bot.name}'s chat…`, "status");
    }
    const sheet = this.mobileNavLayout;
    const panelOpen = sheet ? this.bots.sheetOpen : this.bots.panel.open;
    const panelId = `bot-panel-${bot.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const paneBot: PaneBot = {
      bot: {
        id: bot.id, name: bot.name, ...(bot.title ? { title: bot.title } : {}), ...(bot.avatar ? { avatar: bot.avatar } : {}),
        ...(bot.memory ? { memory: bot.memory } : {}), ...(bot.worker ? { worker: bot.worker } : {}),
      },
      panelOpen,
      panelId,
    };
    const call = this.voice.call?.bot.id === bot.id ? this.voice.call : undefined;
    const settingsCall = this.bots.settingsCall();
    const utilityDefault = this.utilityModelName();
    // A call under way stays reachable even if the ChatGPT login went meanwhile.
    const paneCall: PaneCall | undefined = call || this.bots.callsAvailable() ? { botId: bot.id, inCall: Boolean(call) } : undefined;
    const expanded = !call && this.botPanelShownExpanded();
    return html`<div class="bot-workspace ${panelOpen && !sheet ? "bot-workspace--panel" : ""} ${expanded ? "bot-workspace--expanded" : ""}" data-bot-id=${bot.id}>
      <div class="bot-workspace__chat">
        ${call?.minimized ? renderCallBar({ ...this.callViewProps(bot, call), floating: false }) : nothing}
        ${keyed(bot.id, html`<hui-app
          class="hui-session-pane-app bot-workspace__pane"
          embedded-pane
          pane-session-id=${bot.sessionId}
          .paneSession=${session}
          .paneId=${`bot-${bot.id}`}
          .paneActive=${true}
          .paneVisible=${true}
          .paneNarrow=${sheet}
          .paneMobileNav=${this.mobileNavLayout}
          .paneBot=${paneBot}
          .onPaneBotPanel=${this.toggleBotPanel}
          .onPaneBotAction=${(action: BotHeaderAction) => {
            if (action === "edit") this.openEditBot(bot);
            else if (action === "archive") this.requestArchiveBot(bot);
            else this.bots.requestDelete(bot);
          }}
          .onPaneNavigate=${(id: string) => {
            const target = this.listedSession(id);
            if (target && id !== bot.sessionId) this.selectSession(target);
          }}
          .onPaneRegistryChange=${() => this.refreshSessions(true).then(() => this.updateComplete).then(() => {})}
          .paneGroups=${this.sessions.revision ? this.sessions.groups : undefined}
          .onPaneUpdate=${(text: string, attachments: readonly Attachment[]) => this.handleUpdateCommand(text, attachments)}
          .onPaneDraftChange=${(sessionId: string, hasDraft: boolean) => this.composer.markSessionDraft(sessionId, hasDraft)}
          .paneCall=${paneCall}
          .onPaneCall=${paneCall ? this.paneCallAction(bot) : undefined}
          .paneBots=${this.mentionable()}
          .onPaneOpenBot=${this.openBot}
        ></hui-app>`)}
        ${call && !call.minimized ? renderCallView(this.callViewProps(bot, call)) : nothing}
      </div>
      ${panelOpen ? renderBotPanel({
        bot,
        id: panelId,
        view: this.bots.panelView,
        ...(this.bots.panelOpenedFrom ? { openedFrom: this.bots.panelOpenedFrom } : {}),
        sheet,
        expandable: !sheet && !call,
        expanded,
        width: this.bots.panel.width,
        timezone: localTimezone(),
        ...(paneCall ? { call: renderCallButton({ botName: bot.name, inCall: paneCall.inCall, onCall: this.paneCallAction(bot) }) } : {}),
        onView: this.selectBotPanelView,
        onClose: this.closeBotPanel,
        onExpand: this.expandBotPanel,
        onResize: this.resizeBotPanel,
        routines: {
          automation: this.automation.snapshot,
          error: this.automation.error,
          pending: this.automation.pending,
          formError: this.automation.formError,
          actionError: this.automation.actionError,
          onCreate: this.automation.create,
          onFormError: this.automation.reportFormError,
          onSetEnabled: this.automation.setEnabled,
          onRun: this.automation.run,
          onDelete: this.automation.delete,
          onRetry: this.automation.load,
        },
        tools: this.botTools.props(bot),
        facts: this.botFacts,
        triggers: this.botTriggers.props(bot),
        settings: {
          models: this.control.pi?.model.catalog ?? [],
          ...(utilityDefault ? { utilityDefault } : {}),
          saves: this.bots.savesOf(bot.id),
          onChange: (key, value) => this.bots.changeSetting(bot.id, key, value),
          onDismiss: (key) => this.bots.dismissSetting(bot.id, key),
          call: settingsCall,
          workersExist: this.launcher.workers.length > 0,
          // A bot on a worker works in a folder there: its folders come from that worker, never from this machine.
          directory: {
            suggestions: this.launcher.directorySuggestionsFrom === (bot.worker?.id ?? "") ? this.launcher.directorySuggestions : [],
            onInput: (value) => this.launcher.loadDirectorySuggestions(value, bot.worker?.id),
          },
        },
      }) : nothing}
    </div>`;
  }

  private renderBotDialogs() {
    if (this.embeddedPane) return nothing;
    const { archiving, deleting } = this.bots;
    return html`${archiving ? renderBotArchiveDialog(archiving, this.bots.archivePending, this.bots.archiveError, this.bots.confirmArchive, this.bots.closeArchive) : nothing}
    ${deleting ? renderBotDeleteDialog(deleting, this.bots.deletePending, this.bots.deleteError, this.bots.confirmDelete, this.bots.closeDelete) : nothing}
    ${this.renderBotTemplateDialogs()}`;
  }

  private renderBotTemplateDialogs() {
    const importing = this.botImports.importProps();
    const exporting = this.botImports.exportProps();
    return html`${importing ? renderBotImportDialog(importing) : nothing}${exporting ? renderBotExportDialog(exporting) : nothing}`;
  }

  /* ── calls with bots (HUI-18) ─────────────────────────────────────────── */

  /** Captures only the bot's id: a rendered button may keep an older closure, and the bot is read again when used. */
  private paneCallAction(bot: BotView): () => void {
    const botId = bot.id;
    return () => {
      const current = this.bots.list.find((candidate) => candidate.id === botId);
      if (current) this.openCall(current);
    };
  }

  /** Calls a bot (or returns to its call) and shows its view. One call at a time, on GPT-Live. */
  private openCall = (bot: BotView) => {
    if (!this.voice.startCall({ id: bot.id, sessionId: bot.sessionId, name: bot.name })) {
      this.sessions.notify(`Hang up the call with ${this.voice.call?.bot.name ?? "the other bot"} first.`, true);
      return;
    }
    // The call shows over the chat, which an expanded panel hides.
    this.bots.expandPanel(false);
    if (this.view !== "bot" || this.activeBotId !== bot.id || this.settingsOpen) this.navigate({ kind: "bot", id: bot.id });
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".bot-call__control--hangup, .bot-call__close")?.focus());
  };

  /** After the call view closes, focus returns to the chat it covered. */
  private focusBotChat() {
    void this.updateComplete.then(() => this.botPaneApp()?.updateComplete).then(() => {
      this.botPaneApp()?.renderRoot.querySelector<HTMLElement>(".bot-call-toggle, .agent-chat__composer-combobox > textarea")?.focus();
    });
  }

  private callViewProps(bot: Pick<BotView, "id" | "name" | "title" | "avatar" | "sessionId" | "memory">, call: NonNullable<VoiceController["call"]>): CallViewProps {
    return {
      bot: { id: bot.id, name: bot.name, ...(bot.title ? { title: bot.title } : {}), ...(bot.avatar ? { avatar: bot.avatar } : {}) },
      state: call.state,
      now: this.voice.now,
      summarizing: Boolean(bot.memory?.waiting),
      // Read every animation frame by the face, never rendered: the bot's voice while it speaks, else the microphone.
      level: this.callLevel,
      onToggleMic: () => this.voice.toggleMic(),
      onToggleSpeaker: () => this.voice.toggleSpeaker(),
      onMinimize: () => {
        this.voice.minimize();
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".bot-call-bar__open")?.focus());
      },
      onExpand: () => {
        if (this.view !== "bot" || this.activeBotId !== bot.id || this.settingsOpen) this.navigate({ kind: "bot", id: bot.id });
        this.voice.expand();
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".bot-call__control--hangup")?.focus());
      },
      onHangUp: () => {
        this.voice.hangUp();
        this.focusBotChat();
      },
      onClose: () => {
        this.voice.closeCall();
        this.focusBotChat();
      },
    };
  }

  private readonly callLevel = (): number | undefined =>
    this.voice.call?.state.phase === "speaking" ? this.voice.voiceLevel() : this.voice.micLevel();

  /** The call, while the operator is elsewhere in HUI (another page, another bot, Settings). */
  private floatingCall() {
    const call = this.voice.call;
    if (this.embeddedPane || !call) return undefined;
    if (this.view === "bot" && this.activeBotId === call.bot.id && !this.settingsOpen) return undefined;
    return call;
  }

  /** That call stays in sight in a band above the page's content (`shell--call-bar` makes room), never over it. */
  private renderFloatingCallBar() {
    const call = this.floatingCall();
    if (!call) return nothing;
    const bot = this.bots.list.find((candidate) => candidate.id === call.bot.id) ?? { id: call.bot.id, name: call.bot.name, sessionId: call.bot.sessionId };
    return renderCallBar({ ...this.callViewProps(bot, call), floating: true });
  }

  /* ── settings ─────────────────────────────────────────────────────────── */

  private closeSettings = () => {
    const exit = settingsCloseNavigation(this.settingsReturnTarget);
    this.navigate(exit.target, exit.replace);
  };

  /**
   * pi's configuration is read on demand rather than at boot: it costs a
   * filesystem walk, and most sessions never open Settings.
   */
  private openSettings = () => {
    const current = resolveNavigation(window.location.pathname).target;
    this.settingsReturnTarget = settingsReturnTarget(current);
    this.navigate({ kind: "settings", page: this.settingsPage });
  };

  private loadSettingsData = () => {
    this.control.loadStale();
    this.automation.load();
  };

  private loadLaunchPreferences() {
    if (this.control.pi) {
      this.launcher.seedPreferences(this.control.pi, this.control.settings.models.primary);
      return;
    }
    this.control.loadPi();
  }

  private loadOperationalData = (force = false) => {
    if (this.control.observabilityLoading) return;
    this.control.loadControlSurfaceData(force);
    this.automation.load();
    this.control.loadObservability(force);
  };

  /** A component inside the app (a Work pane launcher's or the VS Code view's Settings link) asks for a Settings page,
   * and optionally the section to scroll to. Cancelling the event tells it the app navigated, so its link does not
   * load the page. The section is scrolled to once it renders and kept there while sections above it load. */
  private stopSettingsScroll: (() => void) | undefined;
  private onOpenSettingsRequest = (event: Event) => {
    const detail = (event as CustomEvent<Partial<Record<keyof OpenSettingsDetail, unknown>> | undefined>).detail;
    const page = SETTINGS_PAGES.find((entry) => entry.id === detail?.page)?.id;
    if (!page) return;
    event.preventDefault();
    this.stopSettingsScroll?.();
    this.stopSettingsScroll = undefined;
    if (this.work.narrow) this.work.hideNarrow();
    this.openSurfaceSettings(page);
    const section = typeof detail?.section === "string" ? detail.section : "";
    if (section) this.stopSettingsScroll = scrollSettingsSection(this, section);
  };

  private openSurfaceSettings = (page: SettingsPage) => {
    const current = resolveNavigation(window.location.pathname).target;
    this.settingsReturnTarget = settingsReturnTarget(current);
    this.navigate({ kind: "settings", page });
  };

  private selectSettingsPage = (page: SettingsPage) => {
    // Removed settings regions still exist in the measured inventory, but are
    // intentionally unreachable in HUI's direct route state.
    const resolved = resolveNavigation(`/settings/${page}`);
    if (resolved.target.kind === "settings") {
      this.navigate(resolved.target);
    }
  };

  /** Copy a full path from a table row and confirm on the trigger itself. */
  private copyPath = (path: string, trigger: HTMLElement) => {
    void writeClipboardText(path).then((copied) => {
      if (!copied) return;
      trigger.dataset["copied"] = "true";
      trigger.dataset["huiTooltip"] = "Copied";
      window.setTimeout(() => { delete trigger.dataset["copied"]; trigger.dataset["huiTooltip"] = "Copy full path"; }, 1500);
    });
  };

  private openPageById(id: "new-session" | "sessions") {
    const page = HUI_PAGES.find((candidate) => candidate.id === id);
    if (page) this.openPage(page);
  }

  private openNewSession = (group?: SessionGroup) => {
    this.launcher.open(group);
    this.openPageById("new-session");
  };

  private updateSessionOptions = (options: SidebarSessionOptions) => {
    this.menuFor = "";
    this.sessions.closeGroupMenu();
    this.sessionOptions = options;
    writeSidebarSessionOptions(options);
  };

  private openGroupAction = (action: GroupMenuAction, group?: SessionGroup) => {
    const next: typeof this.groupAction = action === "new" ? { action } : group ? { action, group } : undefined;
    if (!next) return;
    this.groupMutationError = "";
    this.groupActionReturnFocus = this.renderRoot.querySelector<HTMLElement>(
      group ? `[data-group-menu-trigger="${CSS.escape(group.label)}"]` : "[data-new-group-trigger]",
    ) ?? undefined;
    this.groupAction = next;
    if (next.action === "defaults") {
      this.groupDefaultCwd = next.group.cwd ?? next.group.sessions[0]?.cwd ?? "~/";
      this.groupDefaultMode = next.group.workspaceMode ?? "branch";
      this.groupDefaultRef = next.group.baseRef ?? "";
      this.groupCheckoutDirectory = "";
      this.requestGroupCheckout(this.groupDefaultCwd, true);
    }
  };

  private requestGroupCheckout(input: string, initial = false) {
    this.groupDefaultCwd = input;
    const directory = input.trim();
    if (directory === this.groupCheckoutDirectory && !initial) return;
    this.groupCheckoutDirectory = directory;
    const marker = ++this.groupCheckoutRequest;
    this.groupCheckout = undefined;
    this.groupCheckoutError = "";
    if (!initial) {
      this.groupDefaultMode = "branch";
      this.groupDefaultRef = "";
    }
    this.groupCheckoutLoading = Boolean(directory);
    if (!directory) return;
    void loadGitCheckout(directory).then((checkout) => {
      if (marker !== this.groupCheckoutRequest) return;
      this.groupCheckout = checkout;
      if (!checkout.available) {
        this.groupDefaultMode = "branch";
        this.groupDefaultRef = "";
      } else if (!this.groupDefaultRef) {
        this.groupDefaultRef = checkout.defaultBranch || checkout.headBranch || "HEAD";
      }
    }).catch((error: unknown) => {
      if (marker === this.groupCheckoutRequest) this.groupCheckoutError = error instanceof Error ? error.message : "Could not inspect this directory.";
    }).finally(() => {
      if (marker === this.groupCheckoutRequest) this.groupCheckoutLoading = false;
    });
  }

  private closeGroupAction = () => {
    this.groupCheckoutRequest += 1;
    const returnFocus = this.groupActionReturnFocus;
    this.groupActionReturnFocus = undefined;
    const dialog = this.renderRoot.querySelector?.(".group-action-dialog");
    if (dialog instanceof HTMLDialogElement) closeModal(dialog);
    this.groupAction = undefined;
    this.groupMutationError = "";
    void this.updateComplete.then(() => {
      const narrow = window.matchMedia(APP_SHELL_DRAWER_MEDIA).matches;
      const target = narrow
        ? this.renderRoot.querySelector<HTMLElement>(".chat-pane__nav-toggle, .topbar-nav-toggle")
        : returnFocus;
      if (target?.isConnected) target.focus();
    });
  };

  private submitGroupAction = (event: SubmitEvent) => {
    event.preventDefault();
    if (!this.groupAction || this.groupMutationPending) return;
    if (this.groupAction.action === "defaults" && (this.groupCheckoutLoading || this.groupCheckoutError)) return;
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) return;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? "").trim();
    const state = this.groupAction;
    this.groupMutationPending = true;
    this.groupMutationError = "";
    const operation = state.action === "new"
      ? createSessionGroup(value("name"))
      : state.action === "rename"
        ? updateSessionGroup(state.group.label, { name: value("name") })
        : state.action === "defaults"
          ? updateSessionGroup(state.group.label, { cwd: value("cwd"),
              workspaceMode: this.groupCheckout?.available ? this.groupDefaultMode : "",
              baseRef: this.groupCheckout?.available ? this.groupDefaultRef : "" })
          : deleteSessionGroup(state.group.label);
    void operation
      .then(({ revision, groups }) => {
        this.sessions.receive(revision, groups);
        if (state.action === "new") {
          // A successful creation must be visible even when filters hid every row.
          this.search = "";
          this.updateSessionOptions({ ...this.sessionOptions, groupBy: "custom", status: "all", hideEmpty: "filtering" });
          this.sessions.expandGroup(value("name"));
        }
        if (this.conversation.selected) {
          const refreshed = groups.flatMap((entry) => entry.sessions).find((session) => session.id === this.conversation.selected?.id);
          if (refreshed) this.conversation.select(refreshed);
        }
        this.closeGroupAction();
      })
      .catch((error: unknown) => {
        this.groupMutationError = error instanceof Error ? error.message : "Could not update that group.";
      })
      .finally(() => {
        this.groupMutationPending = false;
      });
  };

  private renderGroupActionDialog() {
    const state = this.groupAction;
    if (!state) return null;
    const { action } = state;
    const title = state.action === "defaults"
      ? `New session defaults for “${sessionGroupLabel(state.group.label)}”`
      : state.action === "rename"
        ? `Rename group “${sessionGroupLabel(state.group.label)}”`
        : state.action === "new"
          ? "New group"
          : `Delete group “${sessionGroupLabel(state.group.label)}”`;
    return html`<dialog
      class="hui-modal-dialog group-action-dialog"
      aria-labelledby="group-action-title"
      @cancel=${(event: Event) => { event.preventDefault(); this.closeGroupAction(); }}
    >
      <form class="exec-approval-card" method="dialog" @submit=${this.submitGroupAction}>
        <div class="exec-approval-title" id="group-action-title">${title}</div>
        ${state.action === "defaults" ? html`
          <div class="exec-approval-sub">Choose where sessions created from this group start.</div>
          <div class="field input-dialog__field"><label for="group-default-cwd">Working directory</label>
            ${renderDirectoryPicker({ id: "group-default-cwd", label: "Working directory", value: this.groupDefaultCwd, suggestions: this.launcher.directorySuggestions, onInput: this.requestDirectorySuggestions, inputClass: "settings-input", externalLabel: true })}
          </div>
          ${this.groupCheckoutLoading ? html`<p role="status">Checking repository…</p>` : null}
          ${this.groupCheckoutError ? html`<p role="alert">${this.groupCheckoutError}</p>` : null}
          ${this.groupCheckout?.available ? html`
            <div class="field input-dialog__field"><span>Environment</span>
              ${renderPicker({ label: "Environment", value: this.groupDefaultMode, disabled: this.groupMutationPending,
                options: [{ value: "branch", label: "Branch", description: "Work in the current checkout." },
                  { value: "worktree", label: "New worktree", description: "Start each session in an isolated Git worktree." }],
                showSelectedDescription: true,
                onChange: (value) => { this.groupDefaultMode = value === "worktree" ? "worktree" : "branch"; } })}
            </div>
            <div class="field input-dialog__field"><span>Base branch</span>
              ${renderPicker({ label: "Base branch", value: this.groupDefaultRef, disabled: this.groupMutationPending,
                options: [...new Set([this.groupDefaultRef, this.groupCheckout.defaultBranch, ...this.groupCheckout.branches].filter(Boolean))].map((value) => ({ value, label: value })),
                searchable: true, searchPlaceholder: "Search branches or enter a commit",
                customOption: (query) => query.trim() ? { value: query.trim(), label: query.trim() } : null,
                onChange: (value) => { this.groupDefaultRef = value; } })}
            </div>
            ${this.groupDefaultMode === "worktree" ? html`<p class="exec-approval-sub">Choose a branch suffix when starting each session.</p>` : null}
          ` : null}
        ` : action === "delete" ? html`
          <div class="exec-approval-sub">The group is removed. Its sessions move back to OTHER.</div>
        ` : html`
          <label class="field input-dialog__field"><span>Group name</span><input class="settings-input" name="name" type="text" required maxlength="200" .value=${state.action === "rename" ? state.group.label : ""} /></label>
        `}
        ${this.groupMutationError ? html`<p class="group-action-dialog__error" role="alert">${this.groupMutationError}</p>` : null}
        <div class="exec-approval-actions">
          <button type="submit" class="btn ${action === "delete" ? "danger" : "primary"}" ?disabled=${this.groupMutationPending || (action === "defaults" && (this.groupCheckoutLoading || Boolean(this.groupCheckoutError)))}>${this.groupMutationPending ? "Saving…" : action === "delete" ? "Delete" : action === "new" ? "Create group" : "Save"}</button>
          <button type="button" class="btn" @click=${this.closeGroupAction}>Cancel</button>
        </div>
      </form>
    </dialog>`;
  }

  private homeProps(): HomeProps {
    const launchModels = this.control.pi?.model.catalog ?? [];
    const launchModel = resolveLaunchModel(
      launchModels,
      this.launcher.model,
      `${this.control.pi?.model.defaultProvider}/${this.control.pi?.model.defaultModel}`,
    );
    return {
      session: this.conversation.selected,
      // File references open in the Work pane, which only multiplexed chat panes have (not a bot's chat).
      fileLinks: this.embeddedPane && !this.paneBot,
      mobileNavLayout: this.embeddedPane ? this.paneMobileNav && this.paneActive : this.mobileNavLayout,
      controlScope: this.embeddedPane ? this.paneId : undefined,
      groups: this.listedGroups,
      findSession: (id) => this.listedSession(id),
      ...(this.paneBot && this.onPaneBotPanel ? { bot: {
        ...this.paneBot,
        onTogglePanel: () => this.onPaneBotPanel?.(),
        ...(this.onPaneBotAction ? { onAction: (action: BotHeaderAction) => this.onPaneBotAction?.(action) } : {}),
      } } : {}),
      transcript: this.conversation.transcript,
      bots: this.mentionable(),
      onOpenBot: this.embeddedPane ? this.onPaneOpenBot : this.openBot,
      subagents: this.conversation.subagents,
      opening: this.conversation.opening,
      openError: this.conversation.openError,
      streaming: this.conversation.streaming,
      stopping: this.conversation.stopping,
      continuing: this.continuing,
      chatPreferences: this.control.settings.chat,
      question: this.conversation.question,
      connection: this.conversation.connection,
      copiedId: this.conversation.copiedId,
      ...(this.paneCall && this.onPaneCall ? { call: { inCall: this.paneCall.inCall, onCall: this.onPaneCall } } : {}),
      expandedActivityIds: this.expandedActivityIds,
      showScrollToBottom: this.showScrollToBottom,
      ...this.conversation.props(),
      compaction: this.conversation.compaction,
      launching: this.launching,
      note: this.note,
      noteLevel: this.noteLevel,
      onDismissNote: () => { this.note = ""; this.noteLevel = "info"; },
      connectionNote: this.conversation.connectionNote,
      onLaunch: this.launch,
      onSelectSession: this.selectSession,
      onClosePane: this.onPaneClose,
      paneMovable: Boolean(this.onPaneClose) && !this.paneNarrow,
      onSplitPane: this.paneNarrow ? undefined : this.onPaneSplit,
      onOpenTerminal: this.onPaneTerminal ? this.openTerminal : undefined,
      onOpenBrowser: this.onPaneBrowser && this.control.settings.browser.enabled && this.conversation.transcript.some((item) => item.kind === "tool" && item.name === "browser")
        ? () => this.onPaneBrowser?.()
        : undefined,
      browserPreview: this.control.settings.browser.enabled
        ? { visible: this.paneVisible, ...(this.onPaneBrowser ? { onExpand: () => this.onPaneBrowser?.() } : {}) }
        : undefined,
      terminalOpening: this.terminalOpening,
      terminalError: this.terminalError,
      onSelectSubagent: (sessionId) => {
        const openBot = this.embeddedPane ? this.onPaneOpenBot : this.openBot;
        const open = (session: SessionView) => session.bot && openBot ? openBot(session.bot.id) : this.selectSession(session);
        const session = this.sessions.groups.flatMap((group) => group.sessions)
          .find((candidate) => candidate.id === sessionId);
        if (session) open(session);
        else void this.refreshSessions().then(() => {
          const refreshed = this.sessions.groups.flatMap((group) => group.sessions)
            .find((candidate) => candidate.id === sessionId);
          if (refreshed) open(refreshed);
        });
      },
      taskSuggestions: {
        suggestions: this.backlog.taskSuggestions,
        index: this.backlog.taskSuggestionIndex,
        pendingId: this.backlog.taskSuggestionPendingId,
        copied: this.conversation.copiedId === `suggestion:${this.backlog.taskSuggestions[clampSuggestionIndex(this.backlog.taskSuggestionIndex, this.backlog.taskSuggestions.length)]?.id ?? ""}`,
        onIndex: this.backlog.setSuggestionIndex,
        onStart: this.backlog.startSuggestion,
        jiraConfigured: this.backlog.jiraConfigured === true,
        onCreateJira: this.backlog.fileSuggestionInJira,
        onAddToBacklog: this.backlog.saveSuggestionToBacklog,
        onCopy: (suggestion) => { void this.conversation.copy(taskSuggestionPrompt(suggestion), `suggestion:${suggestion.id}`); },
        onDismiss: this.backlog.dismissSuggestion,
      },
      watchers: this.backlog.watchers.length ? {
        watchers: this.backlog.watchers,
        pendingId: this.backlog.watcherPendingId,
        log: this.backlog.watcherLog,
        expanded: this.expandedActivityIds,
        onGroupToggle: (open) => this.setActivityExpanded("watchers", open),
        onToggle: this.toggleWatcher,
        onStop: this.backlog.stopWatcher,
        onRestart: this.backlog.restartWatcher,
        onDismiss: this.backlog.dismissWatcher,
      } : undefined,
      runError: this.currentRunError(),
      onContinueAfterError: this.continueAfterError,
      onDismissRunError: this.dismissRunError,
      ...this.composer.props(),
      onContinue: this.continueRun,
      onCopy: this.conversation.copy,
      onActivityExpanded: this.setActivityExpanded,
      onTranscriptScroll: this.transcriptScrolled,
      onTranscriptNavigate: this.navigateTranscript,
      onScrollToBottom: this.scrollToBottom,
      renaming: this.renamingFor === this.conversation.selected?.id,
      confirmingDelete: this.deletingFor === this.conversation.selected?.id,
      onCancelRename: this.cancelRename,
      onRename: this.rename,
      onCancelDelete: this.cancelDelete,
      onConfirmDelete: this.confirmDelete,
      onRetry: this.retrySelected,
      onReconnect: this.reconnectSelected,
      ...this.launcher.props(),
      launchModels,
      launchModel,
      // Git inspection reads this machine's disk; folder suggestions come from the worker.
      onDirectoryInput: this.launcher.worker ? (input) => this.launcher.loadDirectorySuggestions(input, this.launcher.worker) : this.requestDirectorySuggestions,
      branchPrefix: this.control.settings.branchPrefix,
      worktreeProgress: this.paneCreating,
      worktreeError: this.paneCreationError,
      onOpenBranchPrefixSettings: () => requestOpenSettings(this, { page: "worktrees", section: "branch-prefix" }),
    };
  }

  private automationProps(): AutomationProps {
    return {
      ...this.automation.props(),
      sessions: this.sessions.groups.flatMap((group) => group.sessions),
    };
  }

  override render() {
    const noticesInert = this.mobileNavLayout && Boolean(this.renderRoot.querySelector('.sidebar[data-open="true"], .settings-sidebar[data-open="true"]'));
    return html`<div class="hui-application">
      ${this.embeddedPane ? null : renderUpdateNotice({
        release: this.updates.release(),
        inert: noticesInert,
        onReview: this.reviewUpdate,
        onDismiss: () => {
          this.updates.dismiss();
          this.composerTextarea?.focus();
        },
      })}
      ${this.embeddedPane ? null : renderPowerNotice({
        power: this.control.power,
        dismissed: this.control.powerNoticeDismissed,
        inert: noticesInert,
        onTurnOff: () => { this.control.setLidAwake(false); this.composerTextarea?.focus(); },
        onDismiss: () => { this.control.dismissPowerNotice(); this.composerTextarea?.focus(); },
      })}
      <div class="hui-workspace">${this.renderWorkspace()}</div>
      ${this.sessions.actionToast ? html`<div class="app-toast action-toast" data-level=${this.sessions.actionToast.failed ? "error" : "info"}>
        ${this.sessions.actionToast.failed ? html`<span class="app-toast__icon" aria-hidden="true">${icons.alertTriangle}</span>` : nothing}
        <span class="app-toast__message" role=${this.sessions.actionToast.failed ? "alert" : "status"}>${this.sessions.actionToast.message}</span>
        <button type="button" class="app-toast__dismiss" aria-label="Dismiss notification" @click=${() => this.sessions.notify("")}>${icons.close}</button>
      </div>` : null}
      ${this.sessions.archiveToast ? html`<div class="app-toast session-archive-toast"
        @pointerenter=${this.sessions.pauseArchiveToast} @pointerleave=${this.sessions.scheduleArchiveToast}
        @focusin=${this.sessions.pauseArchiveToast} @focusout=${this.sessions.scheduleArchiveToast}>
        <span class="app-toast__message" role=${this.sessions.archiveToast.error ? "alert" : "status"}>
          ${this.sessions.archiveToast.error ?? `Archived “${this.sessions.archiveToast.session.title}”.`}
        </span>
        <button type="button" class="app-toast__action" ?disabled=${this.sessions.archiveToast.restoring}
          @click=${this.sessions.restoreArchivedSession}>${this.sessions.archiveToast.restoring ? "Restoring…" : "Restore"}</button>
        <button type="button" class="app-toast__dismiss" aria-label="Dismiss archive notification"
          @click=${this.sessions.dismissArchiveToast}><span aria-hidden="true">×</span></button>
      </div>` : null}
      ${this.bots.archiveToast ? html`<div class="app-toast session-archive-toast bot-archive-toast"
        @pointerenter=${this.bots.pauseToast} @pointerleave=${this.bots.scheduleToast}
        @focusin=${this.bots.pauseToast} @focusout=${this.bots.scheduleToast}>
        <span class="app-toast__message" role=${this.bots.archiveToast.error ? "alert" : "status"}>
          ${this.bots.archiveToast.error ?? `Archived “${this.bots.archiveToast.bot.name}”. Its chat and memory are kept.`}
        </span>
        <button type="button" class="app-toast__action" ?disabled=${this.bots.archiveToast.restoring}
          @click=${this.bots.restoreFromToast}>${this.bots.archiveToast.restoring ? "Restoring…" : "Restore"}</button>
        <button type="button" class="app-toast__dismiss" aria-label="Dismiss archive notification"
          @click=${this.bots.dismissToast}><span aria-hidden="true">×</span></button>
      </div>` : null}
    </div>`;
  }

  private renderSessionPane = (pane: SessionPane, state: PanePresentation) => {
    const controls = this.work.paneControls(pane, state);
    return renderSessionPane({
      pane,
      state,
      session: this.sessions.groups.flatMap((group) => group.sessions).find(({ id }) => id === pane.sessionId),
      listed: this.listedSession(pane.sessionId),
      groups: this.sessions.revision ? this.sessions.groups : undefined,
      mobileNav: this.mobileNavLayout,
      bots: this.mentionable(),
      onClose: controls.close,
      onSplit: controls.split,
      onTerminal: () => this.work.openTerminal(pane),
      onBrowser: () => this.work.openBrowser(pane),
      onNavigate: (id) => this.work.changePaneSession(pane.id, id),
      onRegistryChange: () => this.refreshSessions(true).then(() => this.updateComplete).then(() => {}),
      onUpdate: (text, attachments) => this.handleUpdateCommand(text, attachments),
      onDraftChange: (sessionId, hasDraft) => this.composer.markSessionDraft(sessionId, hasDraft),
      onOpenBot: this.openBot,
    });
  };

  private paneLabel = (pane: SessionPane) => this.listedSession(pane.sessionId)?.title ?? "Session";

  private listedSession(id: string): SessionView | undefined {
    return this.sessions.listed(id);
  }

  private renderSessionMultiplex() {
    if (!this.conversation.selected || !this.work.layout) return renderHome(this.homeProps());
    const panes = sessionPanes(this.work.layout);
    const workSessionId = activeSessionPane(this.work.layout).sessionId;
    const work = sessionWorkPane(this.work.panes, workSessionId);
    this.work.retained = retainWorkSessions(this.work.retained, workSessionId, this.work.panes);
    const workShown = this.work.narrow && this.work.narrowShown;
    // Maximized on desktop: the Work pane fills the row and the panel selector (the narrow chooser) leads back to
    // the chat; the chat columns stay mounted, hidden and inert, underneath.
    const maximized = workPaneMaximized(work, this.work.narrow);
    return html`<div class="hui-workspace-panels ${workShown ? "hui-workspace-panels--work" : ""} ${maximized ? "hui-workspace-panels--maximized" : ""}">
    ${renderPanelSelector({
      panes,
      activePaneId: this.work.layout.activePaneId,
      sessionTitle: (sessionId) => this.sessions.groups.flatMap((group) => group.sessions).find(({ id }) => id === sessionId)?.title,
      workViews: work.views.flatMap((ref) => {
        const kind = workViewKind(ref.kind);
        return kind ? [{ key: workViewKey(ref), title: kind.title(ref), icon: kind.icon }] : [];
      }),
      launchers: launchableWorkViewKinds(work).map((kind) => ({ kind: kind.kind, label: kind.label, icon: kind.icon, unavailable: kind.unavailable?.(workSessionId) })),
      activeWorkKey: workShown || maximized ? work.active ?? "" : undefined,
      workShown: workShown || maximized,
      onSelectPane: (id) => {
        this.work.hideNarrow();
        // Choosing a chat while maximized restores it beside the pane.
        if (maximized) this.work.commit(setWorkPaneMaximized(this.work.panes, workSessionId, false));
        this.work.focusPane(id);
        if (maximized) this.focusActiveComposer();
      },
      onSelectWork: (key) => { this.work.commit(activateWorkView(this.work.panes, workSessionId, key, false)); this.work.showNarrow(); },
      onShowWork: () => this.work.showNarrow(),
      onLaunch: (kind) => void this.work.launch(kind),
    })}
    <div class="hui-workspace-row">
    <hui-session-multiplexer
      ?inert=${maximized}
      .layout=${this.work.layout}
      .sessionIds=${new Set(this.sessions.groups.flatMap((group) => group.sessions.map(({ id }) => id)))}
      .draggingSessionId=${this.draggingSessionId}
      .renderPane=${this.renderSessionPane}
      .onFocusPane=${this.work.focusPane}
      .onDropSession=${this.dropSession}
      .onMovePane=${this.work.movePane}
      .onClosePane=${this.work.closePane}
      .paneLabel=${this.paneLabel}
      .columnMinimum=${!this.work.narrow && work.open ? WORK_PANE_CHAT_MIN_WIDTH : PANE_COLUMN_MIN_WIDTH}
      .onResize=${(columnId: string | undefined, index: number, ratio: number) => {
        if (this.work.layout) this.work.layout = resizeSessionLayout(this.work.layout, columnId, index, ratio);
      }}
      .onResizeEnd=${() => {
        this.work.persistLayout();
        window.history.replaceState({ ...window.history.state, huiSessionLayout: this.work.layout }, "");
      }}
    ></hui-session-multiplexer>
    <hui-work-pane
      .store=${this.work.panes}
      .sessionId=${workSessionId}
      .retained=${this.work.retained}
      .narrow=${this.work.narrow}
      .chatColumns=${this.work.layout.columns.length}
      .narrowShown=${this.work.narrowShown}
      .launchedKey=${this.work.launchedKey}
      .launching=${this.work.launching}
      .error=${this.work.error}
      .onLaunch=${(kind: string) => void this.work.launch(kind)}
      .onReopen=${(ref: WorkViewRef) => this.work.showView(workSessionId, ref)}
      .onActivate=${(key: string) => this.work.activate(workSessionId, key)}
      .onClose=${(sessionId: string, key: string) => this.work.close(sessionId, key, workSessionId)}
      .onReorder=${(key: string, index: number) => this.work.commit(reorderWorkView(this.work.panes, workSessionId, key, index))}
      .onToggle=${(open: boolean) => this.work.commit(setWorkPaneOpen(this.work.panes, workSessionId, open))}
      .onMaximize=${(next: boolean) => this.work.toggleMaximized(next)}
      .onResize=${(width: number, available: number, done: boolean) => this.work.resize(workSessionId, width, available, done)}
      .onBack=${this.work.leave}
      .onEscape=${this.work.leave}
      .onDismissError=${this.work.dismissError}
    ></hui-work-pane>
    </div></div>`;
  }

  private dedicatedPageProps(): DedicatedPageProps {
    return {
      home: () => this.homeProps(),
      automation: () => this.automationProps(),
      sessions: () => ({
        groups: this.listedGroups,
        loading: this.sessions.loading,
        error: this.sessions.error,
        query: this.search,
        onQuery: this.updateSearch,
        onOpen: this.selectSession,
        onRestore: (session) => this.setSessionMetadata(session, { archived: false }, "Session restored."),
        onCopyPath: this.copyPath,
        onNew: () => this.openPageById("new-session"),
        onRefresh: () => void this.refreshSessions(),
        ...this.sessions.sessionsPageProps(),
      }),
      onOpenSettings: () => this.navigate({ kind: "settings", page: "integrations" }),
      onOpenSession: (id) => this.navigate({ kind: "session", id }),
    };
  }

  private renderWorkspace() {
    if (this.embeddedPane) {
      return html`<div class="hui-embedded-session">${this.conversation.selected ? renderHome(this.homeProps()) : html`<p role="status">Opening session…</p>`}${this.renderJiraCreateDialog()}${this.renderForkDialog()}</div>`;
    }

    if (this.settingsOpen) {
      return html`<div class="shell shell--settings settings-shell ${this.mobileNavLayout ? "shell--mobile-nav" : ""} ${this.floatingCall() ? "shell--call-bar" : ""}">
        ${renderSettingsPage({
          page: this.settingsPage,
          worktrees: {
            ...this.sessions.worktreesProps(),
            onOpenSession: (id) => this.navigate({ kind: "session", id }),
            onCopyPath: this.copyPath,
          },
          ...this.control.props(),
          onRefreshObservability: () => this.loadOperationalData(true),
          onSelectPage: this.selectSettingsPage,
          onChangeModels: (models) => {
            this.launcher.selectModel(models.primary);
            void this.control.save({ models });
          },
          onClose: this.closeSettings,
          ...this.automationProps(),
        })}
        ${this.renderFloatingCallBar()}
        ${this.commandPalette()}
        ${renderUpdateDialog(this.updates.dialogProps())}
        ${renderPiResourceReader(this.control.piResourceReader, this.control.closePiResourceReader, this.control.copyPiResource)}
      </div>`;
    }

    const props = {
      view: this.view,
      activePage: this.activePage,
      selectedSessionId: this.view === "bot" ? "" : this.conversation.selected?.id ?? "",
      splitSessionId: "",
      openSessionIds: new Set(this.work.layout && sessionPanes(this.work.layout).length > 1 ? sessionPanes(this.work.layout).map(({ sessionId }) => sessionId) : []),
      groups: this.listedGroups,
      bots: this.shellBotsProps(),
      draftSessionIds: this.composer.draftSessionIds,
      collapsed: this.sessions.collapsed,
      loading: this.sessions.loading,
      error: this.sessions.error,
      importNote: this.importNote,
      importFailed: this.importFailed,
      search: this.search,
      menuFor: this.menuFor,
      groupMenuFor: this.sessions.groupMenuFor,
      sessionOptions: this.sessionOptions,
      draggingSessionId: this.draggingSessionId,
      sessionDropTarget: this.sessionDropTarget,
      sessionMovePendingId: this.sessionMovePendingId,
      draggingGroup: this.draggingGroup,
      groupDropTarget: this.groupDropTarget,
      groupReorderPending: this.groupReorderPending,
      onGroupDragStart: (group: string) => {
        this.sessions.closeGroupMenu();
        this.draggingGroup = group;
        this.groupDropTarget = undefined;
      },
      onGroupDragEnd: () => {
        this.draggingGroup = "";
        this.groupDropTarget = undefined;
      },
      onGroupDragOver: (target: GroupDropTarget) => { this.groupDropTarget = target; },
      onGroupDragLeave: (group: string) => {
        if (this.groupDropTarget?.group === group) this.groupDropTarget = undefined;
      },
      onReorderGroup: this.reorderGroup,
      onSessionOptions: this.updateSessionOptions,
      onNewGroup: () => this.openGroupAction("new"),
      onSelectView: this.selectView,
      onOpenKanban: () => this.navigate({ kind: "kanban" }),
      onOpenPage: this.openPage,
      onSelectSession: this.selectSession,
      onSplitSession: this.openSplitSession,
      onToggleGroup: this.sessions.toggleGroup,
      toggledSessionTrees: this.sessions.toggledSessionTrees,
      onToggleSessionTree: this.sessions.toggleSessionTree,
      onToggleMenu: this.toggleMenu,
      onCloseMenu: () => {
        this.menuFor = "";
      },
      onToggleGroupMenu: (group: string) => {
        this.menuFor = "";
        this.sessions.toggleGroupMenu(group);
      },
      onCloseGroupMenu: () => this.sessions.closeGroupMenu(),
      onGroupAction: this.openGroupAction,
      onNewSession: this.openNewSession,
      onRenameSession: this.renameFromMenu,
      onTogglePin: this.togglePin,
      onUpdateSession: this.setSessionMetadata,
      onCopySession: this.copySession,
      onOpenSession: this.openSessionElsewhere,
      onCreateJiraIssue: this.openJiraCreate,
      onLinkJiraIssue: this.openJiraLink,
      onSessionDragStart: (session: SessionView) => {
        this.draggingSessionId = session.id;
        this.sessionDropTarget = "";
      },
      onSessionDragEnd: () => {
        this.draggingSessionId = "";
        this.sessionDropTarget = "";
      },
      onSessionDragOver: (group: string) => { this.sessionDropTarget = group; },
      onSessionDragLeave: (group: string) => {
        if (this.sessionDropTarget === group) this.sessionDropTarget = "";
      },
      onMoveSession: this.moveSession,
      onDeleteSession: this.deleteFromMenu,
      onOpenSettings: () => {
        this.openSettings();
      },
      onSearch: this.updateSearch,
    };

    const chatLikeRoute =
      (this.view === "home" && Boolean(this.conversation.selected)) ||
      this.view === "bot" ||
      (this.view === "surface" && this.activePage?.id === "new-session");

    return html`<div
      class="shell app-shell ${this.mobileNavLayout ? "shell--mobile-nav" : ""} ${chatLikeRoute ? "shell--chat" : ""} ${chatLikeRoute && this.mobileNavLayout ? "shell--merged-chat-chrome" : ""} ${this.floatingCall() ? "shell--call-bar" : ""}"
      @keydown=${closeDrawerOnEscape}
    >
      ${renderSidebar(props)}
      ${this.renderGroupActionDialog()}
      ${this.renderJiraCreateDialog()}
      ${this.renderJiraLinkDialog()}
      ${this.renderBacklogStartDialog()}
      ${this.renderBacklogRemoveDialog()}
      ${this.renderForkDialog()}
      ${this.renderBotDialogs()}
      ${this.renderFloatingCallBar()}
      ${this.commandPalette()}
      ${renderUpdateDialog(this.updates.dialogProps())}
      ${renderPiResourceReader(this.control.piResourceReader, this.control.closePiResourceReader, this.control.copyPiResource)}
      ${renderMain(
        props,
        this.view === "home"
          ? this.renderSessionMultiplex()
          : this.view === "bot"
            ? this.renderBotWorkspace()
          : this.view === "kanban"
            ? renderKanbanPage({
                groups: this.listedGroups,
                loading: this.sessions.loading,
                error: this.sessions.error,
                query: this.backlog.query,
                options: this.backlog.options,
                movePendingId: this.kanbanMovePendingId,
                draggingId: this.backlog.draggingId,
                dropTarget: this.backlog.dropTarget,
                onQuery: this.backlog.setQuery,
                onOptions: this.backlog.setOptions,
                onOpen: this.selectSession,
                onMove: this.moveKanbanSession,
                onDragStart: this.backlog.dragStart,
                onDragEnd: this.backlog.dragEnd,
                onDragOver: this.backlog.dragOver,
                onRefresh: () => { void this.refreshSessions(); void this.backlog.refresh(true); },
                backlog: this.backlog.items,
                backlogLoading: this.backlog.loading,
                backlogError: this.backlog.error,
                backlogJira: this.backlog.jira,
                backlogPendingId: this.backlog.pendingId,
                onBacklogGroup: this.backlog.setGroup,
                onBacklogStart: this.backlog.openStart,
                onBacklogAction: this.backlog.cardAction,
                onSessionAction: this.kanbanSessionAction,
              })
            : this.view === "surface" && this.activePage
              ? dedicatedPageRenderer(this.activePage.id)?.(this.dedicatedPageProps()) ?? (
                  isPiSurface(this.activePage)
                    ? renderPiSurface({
                        page: this.activePage,
                        pi: this.control.pi,
                        health: this.control.health,
                        workspaces: this.control.workspaceInspection,
                        loading: this.control.controlLoading,
                        error: this.control.controlSurfaceError(this.activePage),
                        onRefresh: () => this.control.loadControlSurfaceData(true),
                        onOpenSettings: this.openSurfaceSettings,
                        onSessions: () => this.openPageById("sessions"),
                        operation: this.control.piOperation,
                        removeCandidate: this.control.piRemoveCandidate,
                        onInstallPackage: this.control.installPiPackage,
                        onRequestRemovePackage: this.control.requestPiPackageRemoval,
                        onCancelRemovePackage: this.control.cancelPiPackageRemoval,
                        onConfirmRemovePackage: this.control.removePiPackage,
                        onInstallSkill: this.control.installPiSkill,
                        disabledSkills: this.control.settings.disabledSkills,
                        onSetSkillEnabled: this.control.setPiSkillEnabled,
                        disabledPlugins: this.control.settings.disabledPlugins,
                        onSetPluginEnabled: this.control.setPiPluginEnabled,
                        onReadSkill: (skill) => this.control.readPiResource("skill", skill),
                        onReadPlugin: (resource) => this.control.readPiResource("plugin", resource),
                      })
                    : isObservabilitySurface(this.activePage)
                      ? renderObservabilitySurface({
                          page: this.activePage,
                          snapshot: this.control.observability,
                          health: this.control.health,
                          loading: this.control.observabilityLoading,
                          error: this.control.observabilityError,
                          dense: this.control.settings.labs.denseObservability,
                          detailedDebug: this.control.settings.labs.detailedDebug,
                          onRefresh: () => this.loadOperationalData(true),
                          onExport: this.control.exportDiagnostics,
                        })
                      : isOwnedSurface(this.activePage)
                        ? renderOwnedSurface({
                            page: this.activePage,
                            settings: this.control.settings,
                            health: this.control.health,
                            onSettings: this.control.patchOwnedSettings,
                          })
                    : html``)
            : html``,
      )}
    </div>`;
  }
}

/** Upgrades the page's `<hui-app>`, which renders at once. */
export function defineHuiApp(): void {
  if (!customElements.get("hui-app")) customElements.define("hui-app", HuiApp);
}
