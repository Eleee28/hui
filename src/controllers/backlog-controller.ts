/**
 * `BacklogController` owns the Kanban board and the work it files outside `hui-app.ts`: the Backlog column (the
 * server's merged view of local tasks and the Jira feed, the only source of the column; nothing moves
 * optimistically), moving, starting and removing a task, the board's view options, search text and drag state, the
 * Jira create and link dialogs, whether Jira is connected, and the open session's task suggestions and watchers.
 * The shell renders the board, the cards and the dialogs from these fields.
 */
import type { ReactiveControllerHost } from "lit";
import { addSuggestionToBacklog, backlogItemMarkdown, loadBacklog, removeBacklogItem, setBacklogItemGroup, type BacklogItem, type BacklogJiraState } from "../api/backlog.ts";
import { loadJiraConnection } from "../api/jira.ts";
import { dismissTaskSuggestion, startTaskSuggestion } from "../api/task-suggestions.ts";
import { dismissWatcher as dismissWatcherRequest, parseWatchers, readWatcherLog, restartWatcher as restartWatcherRequest, stopWatcher as stopWatcherRequest, type Watcher } from "../api/watchers.ts";
import type { BacklogStartTarget } from "../components/backlog-start-dialog.ts";
import type { JiraCreatedDetail } from "../components/jira-create-dialog.ts";
import type { SessionView } from "../api/sessions.ts";
import { writeClipboardText } from "../lib/clipboard.ts";
import { readKanbanOptions, writeKanbanOptions, type KanbanOptions } from "../lib/kanban.ts";
import { sessionGroupLabel } from "../lib/session/sessions.ts";
import type { NoteLevel } from "../lib/session/ui-state.ts";
import { clampSuggestionIndex, parseTaskSuggestions, type TaskSuggestion, type TaskSuggestionStartMode } from "../lib/task-suggestions.ts";
import type { BacklogCardAction } from "../views/kanban.ts";
import { DEFAULT_SESSION_STAGE, SESSION_STAGE_LABELS } from "../lib/kanban.ts";

type BacklogDeps = {
  notify: (message: string, failed?: boolean) => void;
  showNote: (message: string, level: NoteLevel) => void;
  refreshSessions: () => Promise<void>;
  paneRegistryChanged: () => void;
  selected: () => SessionView | undefined;
  selectSession: (session: SessionView) => void;
  kanbanOpen: () => boolean;
};

type WatcherLogView = { id: string; lines: readonly string[]; truncated: boolean; loading: boolean };

export class BacklogController {
  options: KanbanOptions = readKanbanOptions();
  query = "";
  draggingId = "";
  dropTarget = "";
  /** Session whose "Create Jira work item" dialog is open. */
  jiraCreateSession: SessionView | undefined;
  /** Session whose "Link Jira work item" dialog is open. */
  jiraLinkSession: SessionView | undefined;
  /** Local backlog task whose Jira create/link dialog is open. */
  jiraCreateBacklogItem: BacklogItem | undefined;
  jiraLinkBacklogItem: BacklogItem | undefined;
  jiraCreateSuggestion: TaskSuggestion | undefined;
  /** Whether Jira is connected, for the suggestion card's actions; unknown until loaded. */
  jiraConfigured: boolean | undefined;
  /** Pending `suggest_task` cards for the open session, from its snapshot. */
  taskSuggestions: readonly TaskSuggestion[] = [];
  taskSuggestionIndex = 0;
  taskSuggestionPendingId = "";
  /** HUI-run background watchers for the open session, from its snapshot. */
  watchers: readonly Watcher[] = [];
  watcherPendingId = "";
  /** The watcher log the operator opened; one at a time. */
  watcherLog: WatcherLogView | null = null;
  items: readonly BacklogItem[] = [];
  loading = false;
  error = "";
  jira: BacklogJiraState = { status: "unconfigured" };
  pendingId = "";
  /** Backlog item whose start dialog is open, with the drop target. */
  starting: { item: BacklogItem; target: BacklogStartTarget } | undefined;
  /** Local task awaiting removal confirmation. */
  removing: BacklogItem | undefined;
  readonly #host: ReactiveControllerHost;
  readonly #deps: BacklogDeps;
  #request = 0;

  constructor(host: ReactiveControllerHost, deps: BacklogDeps) {
    this.#host = host;
    this.#deps = deps;
  }

  async refresh(refresh = false): Promise<void> {
    const request = ++this.#request;
    this.loading = true;
    this.#host.requestUpdate();
    try {
      const view = await loadBacklog(refresh);
      if (request !== this.#request) return;
      this.items = view.items;
      this.jira = view.jira;
      this.error = "";
    } catch (error) {
      if (request === this.#request) this.error = error instanceof Error ? error.message : "The backlog could not be loaded.";
    } finally {
      if (request === this.#request) this.loading = false;
      this.#host.requestUpdate();
    }
  }

  setGroup = (item: BacklogItem, group: string) => {
    const current = !item.group || item.group === "ungrouped" ? "" : item.group;
    if (this.pendingId || current === group) return;
    this.#setPending(item.id);
    this.#deps.notify(`Moving ${item.title} to ${sessionGroupLabel(group)}…`);
    void setBacklogItemGroup(item.id, group)
      .then((view) => {
        this.#adopt(view);
        this.#deps.notify(`Moved ${item.title} to ${sessionGroupLabel(group)}.`);
      })
      .catch((error: unknown) => {
        this.#deps.notify(error instanceof Error ? error.message : "Could not move that backlog item.", true);
      })
      .finally(() => this.#setPending(""));
  };

  openStart = (item: BacklogItem, target: BacklogStartTarget) => {
    if (this.pendingId) return;
    void import("../components/backlog-start-dialog.ts").then(() => {
      this.starting = { item, target };
      this.#host.requestUpdate();
    });
  };

  closeStart = () => {
    this.starting = undefined;
    this.#host.requestUpdate();
  };

  started = (session: SessionView, item: BacklogItem) => {
    this.starting = undefined;
    this.#deps.notify(`Started “${session.title}” from the backlog in ${SESSION_STAGE_LABELS[session.stage ?? DEFAULT_SESSION_STAGE]}.`);
    this.items = this.items.filter(({ id }) => id !== item.id);
    this.#host.requestUpdate();
    void this.#deps.refreshSessions();
    void this.refresh();
  };

  askRemove(item: BacklogItem): void {
    this.removing = item;
    this.#host.requestUpdate();
  }

  cancelRemove = () => {
    if (this.pendingId) return;
    this.removing = undefined;
    this.#host.requestUpdate();
  };

  confirmRemove = (event: Event) => {
    event.preventDefault();
    const item = this.removing;
    if (!item || this.pendingId) return;
    this.#setPending(item.id);
    void removeBacklogItem(item.id)
      .then((view) => {
        this.#adopt(view);
        this.#deps.notify(`Removed “${item.title}” from the backlog.`);
        this.removing = undefined;
      })
      .catch((error: unknown) => {
        this.#deps.notify(error instanceof Error ? error.message : "Could not remove that task.", true);
        this.removing = undefined;
      })
      .finally(() => this.#setPending(""));
  };

  setQuery = (value: string) => {
    this.query = value;
    this.#host.requestUpdate();
  };

  setOptions = (options: KanbanOptions) => {
    this.options = options;
    writeKanbanOptions(options);
    this.#host.requestUpdate();
  };

  dragStart = (id: string) => {
    this.draggingId = id;
    this.dropTarget = "";
    this.#host.requestUpdate();
  };

  dragEnd = () => {
    this.draggingId = "";
    this.dropTarget = "";
    this.#host.requestUpdate();
  };

  dragOver = (cell: string) => {
    this.dropTarget = cell;
    this.#host.requestUpdate();
  };

  cardAction = (item: BacklogItem, action: BacklogCardAction) => {
    if (action === "open:jira") {
      if (item.jira) window.open(item.jira.url, "_blank", "noopener,noreferrer");
    } else if (action === "copy") {
      void writeClipboardText(backlogItemMarkdown(item)).then((copied) => {
        this.#deps.notify(copied ? `Copied “${item.title}”.` : "Could not copy to the clipboard.", !copied);
      });
    } else if (action === "remove") {
      this.askRemove(item);
    } else if (action === "jira:create") {
      void import("../components/jira-create-dialog.ts").then(() => { this.jiraCreateBacklogItem = item; this.#host.requestUpdate(); });
    } else if (action === "jira:link") {
      void import("../components/jira-link-dialog.ts").then(() => { this.jiraLinkBacklogItem = item; this.#host.requestUpdate(); });
    }
  };

  openJiraCreate(session: SessionView): void {
    void import("../components/jira-create-dialog.ts").then(() => { this.jiraCreateSession = session; this.#host.requestUpdate(); });
  }

  closeJiraCreate = () => {
    this.jiraCreateSession = undefined;
    this.jiraCreateSuggestion = undefined;
    this.jiraCreateBacklogItem = undefined;
    this.#host.requestUpdate();
  };

  jiraCreated = (detail: JiraCreatedDetail) => {
    this.jiraCreateSession = undefined;
    this.jiraCreateSuggestion = undefined;
    this.#host.requestUpdate();
    if (detail.backlogItemId) {
      this.jiraCreateBacklogItem = undefined;
      this.#deps.notify(detail.warning ?? `Created Jira work item ${detail.key} for the backlog task.`, Boolean(detail.warning));
      void this.refresh();
      return;
    }
    if (detail.suggestionId) {
      // Filing resolves the card now; the server snapshot confirms it.
      this.#setSuggestions(this.taskSuggestions.filter(({ id }) => id !== detail.suggestionId));
      this.#deps.paneRegistryChanged();
    }
    this.#deps.notify(detail.warning ?? `Created Jira work item ${detail.key}.`, Boolean(detail.warning));
    void this.#deps.refreshSessions();
  };

  openJiraLink(session: SessionView): void {
    void import("../components/jira-link-dialog.ts").then(() => { this.jiraLinkSession = session; this.#host.requestUpdate(); });
  }

  closeJiraLink = () => {
    this.jiraLinkSession = undefined;
    this.jiraLinkBacklogItem = undefined;
    this.#host.requestUpdate();
  };

  jiraLinked = (detail: JiraCreatedDetail) => {
    this.jiraLinkSession = undefined;
    this.#host.requestUpdate();
    if (detail.backlogItemId) {
      this.jiraLinkBacklogItem = undefined;
      this.#deps.notify(`Linked Jira work item ${detail.key} to the backlog task.`);
      void this.refresh();
      return;
    }
    if (this.#deps.kanbanOpen()) {
      this.#deps.notify(`Linked Jira work item ${detail.key}.`);
      void this.refresh();
    }
    this.#deps.notify(`Linked Jira work item ${detail.key}.`);
    void this.#deps.refreshSessions();
  };

  /** The suggestion card needs to know whether Jira is connected; checked
   * once per page load, and again after the Integrations page changes it. */
  ensureJiraConnectionKnown(): void {
    if (this.jiraConfigured !== undefined) return;
    this.jiraConfigured = false;
    this.#host.requestUpdate();
    void loadJiraConnection().then(
      (connection) => { this.jiraConfigured = connection.configured; this.#host.requestUpdate(); },
      () => { this.jiraConfigured = false; this.#host.requestUpdate(); },
    );
  }

  clearSession(): void {
    this.taskSuggestions = [];
    this.taskSuggestionIndex = 0;
    this.watchers = [];
    this.watcherPendingId = "";
    this.watcherLog = null;
    this.#host.requestUpdate();
  }

  adoptSnapshot(suggestions: unknown, watchers: unknown): void {
    const previousFirst = this.taskSuggestions[0]?.id;
    this.taskSuggestions = parseTaskSuggestions(suggestions);
    if (this.taskSuggestions.length) this.ensureJiraConnectionKnown();
    this.watchers = parseWatchers(watchers);
    const logged = this.watchers.find(({ id }) => id === this.watcherLog?.id);
    if (this.watcherLog && !logged) this.watcherLog = null;
    // An opened row follows new output without a refresh button.
    else if (logged && !this.watcherLog?.loading && logged.lastLine !== (this.watcherLog?.lines.findLast((line) => line.trim()) ?? "").trim()) {
      this.viewWatcherLog(logged);
    }
    // A newly flagged follow-up is shown first; otherwise keep the operator's place.
    this.taskSuggestionIndex = this.taskSuggestions[0]?.id !== previousFirst
      ? 0
      : clampSuggestionIndex(this.taskSuggestionIndex, this.taskSuggestions.length);
    this.#host.requestUpdate();
  }

  setSuggestionIndex = (index: number) => {
    this.taskSuggestionIndex = clampSuggestionIndex(index, this.taskSuggestions.length);
    this.#host.requestUpdate();
  };

  startSuggestion = (suggestion: TaskSuggestion, mode: TaskSuggestionStartMode = "session") => {
    const source = this.#deps.selected();
    if (!source || this.taskSuggestionPendingId) return;
    this.#setSuggestionPending(suggestion.id);
    void startTaskSuggestion(source.id, suggestion.id, mode)
      .then(async (session) => {
        this.#setSuggestions(this.taskSuggestions.filter(({ id }) => id !== suggestion.id));
        await this.#deps.refreshSessions();
        this.#deps.paneRegistryChanged();
        // "This session" stays put; the transcript shows the new turn.
        if (session.id !== source.id) this.#deps.selectSession(session);
      })
      .catch((error: unknown) => {
        this.#deps.showNote(error instanceof Error ? error.message : "Could not start that suggestion.", "error");
      })
      .finally(() => this.#setSuggestionPending(""));
  };

  dismissSuggestion = (suggestion: TaskSuggestion) => {
    const source = this.#deps.selected();
    if (!source || this.taskSuggestionPendingId) return;
    this.#setSuggestionPending(suggestion.id);
    void dismissTaskSuggestion(source.id, suggestion.id)
      .then((suggestions) => {
        if (this.#deps.selected()?.id !== source.id) return;
        this.#setSuggestions(parseTaskSuggestions(suggestions));
      })
      .catch((error: unknown) => {
        this.#deps.showNote(error instanceof Error ? error.message : "Could not dismiss that suggestion.", "error");
      })
      .finally(() => this.#setSuggestionPending(""));
  };

  saveSuggestionToBacklog = (suggestion: TaskSuggestion) => {
    const source = this.#deps.selected();
    if (!source || this.taskSuggestionPendingId) return;
    this.#setSuggestionPending(suggestion.id);
    void addSuggestionToBacklog(source.id, suggestion.id)
      .then((suggestions) => {
        if (this.#deps.selected()?.id === source.id) this.#setSuggestions(parseTaskSuggestions(suggestions));
        this.#deps.showNote(`Added “${suggestion.title}” to the Kanban backlog.`, "info");
      })
      .catch((error: unknown) => {
        this.#deps.showNote(error instanceof Error ? error.message : "Could not add that suggestion to the backlog.", "error");
      })
      .finally(() => this.#setSuggestionPending(""));
  };

  fileSuggestionInJira = (suggestion: TaskSuggestion) => {
    const session = this.#deps.selected();
    if (!session) return;
    void import("../components/jira-create-dialog.ts").then(() => {
      this.jiraCreateSuggestion = suggestion;
      this.jiraCreateSession = session;
      this.#host.requestUpdate();
    });
  };

  stopWatcher = (watcher: Watcher) => {
    this.#watcherAction(watcher, stopWatcherRequest, "Could not stop that watcher.");
  };

  restartWatcher = (watcher: Watcher) => {
    this.#watcherAction(watcher, restartWatcherRequest, "Could not restart that watcher.");
  };

  dismissWatcher = (watcher: Watcher) => {
    this.#watcherAction(watcher, dismissWatcherRequest, "Could not dismiss that watcher.");
  };

  viewWatcherLog(watcher: Watcher): void {
    const session = this.#deps.selected();
    if (!session) return;
    const previous = this.watcherLog?.id === watcher.id ? this.watcherLog : undefined;
    this.#setWatcherLog({ id: watcher.id, lines: previous?.lines ?? [], truncated: previous?.truncated ?? false, loading: true });
    void readWatcherLog(session.id, watcher.id)
      .then((log) => {
        if (this.#deps.selected()?.id !== session.id || this.watcherLog?.id !== watcher.id) return;
        this.#setWatcherLog({ id: log.id, lines: log.lines, truncated: log.truncated, loading: false });
      })
      .catch((error: unknown) => {
        if (this.watcherLog?.id !== watcher.id) return;
        this.#setWatcherLog(null);
        this.#deps.showNote(error instanceof Error ? error.message : "Could not read that watcher log.", "error");
      });
  }

  /** Opening a watcher's row fetches its log tail; closing it drops the tail. */
  toggleWatcherLog(watcher: Watcher, open: boolean): void {
    if (open) this.viewWatcherLog(watcher);
    else if (this.watcherLog?.id === watcher.id) this.#setWatcherLog(null);
  }

  /** One watcher mutation at a time; the card disables its buttons while a
   * request is in flight, and a response for another session is dropped. */
  #watcherAction(watcher: Watcher, request: (sessionId: string, watcherId: string) => Promise<Watcher[]>, failure: string): void {
    const session = this.#deps.selected();
    if (!session || this.watcherPendingId) return;
    this.watcherPendingId = watcher.id;
    this.#host.requestUpdate();
    void request(session.id, watcher.id)
      .then((watchers) => {
        if (this.#deps.selected()?.id !== session.id) return;
        this.watchers = watchers;
        if (this.watcherLog && !watchers.some(({ id }) => id === this.watcherLog!.id)) this.watcherLog = null;
      })
      .catch((error: unknown) => {
        this.#deps.showNote(error instanceof Error ? error.message : failure, "error");
      })
      .finally(() => {
        this.watcherPendingId = "";
        this.#host.requestUpdate();
      });
  }

  #setWatcherLog(log: WatcherLogView | null): void {
    this.watcherLog = log;
    this.#host.requestUpdate();
  }

  #setSuggestions(suggestions: readonly TaskSuggestion[]): void {
    this.taskSuggestions = suggestions;
    this.taskSuggestionIndex = clampSuggestionIndex(this.taskSuggestionIndex, suggestions.length);
    this.#host.requestUpdate();
  }

  #setSuggestionPending(id: string): void {
    this.taskSuggestionPendingId = id;
    this.#host.requestUpdate();
  }

  #adopt(view: { items: readonly BacklogItem[]; jira: BacklogJiraState }): void {
    this.items = view.items;
    this.jira = view.jira;
    this.#host.requestUpdate();
  }

  #setPending(id: string): void {
    this.pendingId = id;
    this.#host.requestUpdate();
  }
}
