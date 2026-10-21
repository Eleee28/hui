/**
 * `SessionsController` owns the session registry and the sidebar's reading state outside `hui-app.ts`: the gateway's
 * session list with its revision, loading and error, the one status stream that keeps every session's status and
 * unread mark current, the collapsed groups (`COLLAPSED_KEY`), the subagent trees toggled open and the open group
 * menu, and the shell's action toast and session archive toast with their timers. It also owns the Sessions page
 * (state, filters, selection, bulk delete and transcript search) and the Settings → Worktrees inventory with its
 * removal queue and the poll that runs while facts are pending. The shell decides when the stream starts and follows
 * each list into its layout and selection.
 */
import type { ReactiveControllerHost } from "lit";
import { applySessionListUpdate } from "../api/session-list.ts";
import type { SessionListUpdate } from "../api/schema/sessions.ts";
import { deleteSession, loadSessions, renameSession, searchSessionTranscripts, subscribeSessionStatuses, type SessionGroup, type SessionStatus, type SessionStatusUpdate, type SessionView } from "../api/sessions.ts";
import { loadWorktrees, removeWorktrees } from "../api/worktrees.ts";
import { closeModal } from "../lib/modal-dialog.ts";
import { mergeSessionStatuses } from "../lib/session/ui-state.ts";
import { sessionTreeIds } from "../lib/session/tree.ts";
import { worktreesOnlyUsedBy, type WorktreeInventory, type WorktreeRemovalResult, type WorktreeRisk } from "../lib/worktrees.ts";
import { DEFAULT_SESSIONS_PAGE_FILTERS, type SessionsPageFilters, type SessionsPageProps, type SessionsPageState, type TranscriptSearchState } from "../views/sessions.ts";
import type { WorktreeFilter, WorktreesPageProps } from "../views/worktrees.ts";

const COLLAPSED_KEY = "hui.collapsed-groups";

/** Collapsed groups are a reading preference, so they stay in the browser. */
function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

type SessionsHost = ReactiveControllerHost & Pick<HTMLElement, "querySelector">;

type SessionsDeps = {
  presented: (id: string) => boolean;
  listReceived: (ids: ReadonlySet<string>) => void;
  listSettled: () => void;
  statusesApplied: () => void;
  statusApplied: (update: SessionStatusUpdate) => void;
  reportError: (error: unknown, message: string) => void;
  refreshSessions: () => Promise<void>;
  sessionsDeleted: (ids: ReadonlySet<string>) => void;
  worktreesShown: () => boolean;
};

export class SessionsController {
  groups: readonly SessionGroup[] = [];
  loading = true;
  error = "";
  /** Revision of the gateway session list in `groups`; older lists lose. */
  revision = 0;
  statuses = new Map<string, SessionStatus>();
  unread = new Map<string, boolean>();
  collapsed: ReadonlySet<string> = readCollapsed();
  toggledSessionTrees: ReadonlySet<string> = new Set();
  groupMenuFor = "";
  /** Outcome of a sidebar, Kanban, Sessions or bot action, shown as the shell toast. */
  actionToast: { message: string; failed: boolean } | undefined;
  archiveToast: { session: SessionView; restoring: boolean; error?: string } | undefined;
  pageState: SessionsPageState = "all";
  pageFilters: SessionsPageFilters = { ...DEFAULT_SESSIONS_PAGE_FILTERS };
  pageSelected: ReadonlySet<string> = new Set();
  deleteConfirm = false;
  deleting = false;
  transcriptSearch: TranscriptSearchState = { query: "", searching: false, searched: "" };
  #transcriptSearchRun: AbortController | undefined;
  worktreeInventory: WorktreeInventory | undefined;
  worktreesLoading = false;
  worktreesError = "";
  worktreeQuery = "";
  worktreeFilter: WorktreeFilter = "all";
  worktreeConfirm = "";
  /** Paths sent for removal whose request has not answered yet. */
  worktreeRemovals: ReadonlySet<string> = new Set();
  /** Sizes of everything sent for removal since the queue was last empty,
   * so the total progress still counts rows that are already gone. */
  worktreeRemovalSizes: ReadonlyMap<string, number> = new Map();
  worktreeResults: readonly WorktreeRemovalResult[] = [];
  readonly #host: SessionsHost;
  readonly #deps: SessionsDeps;
  #hasStatusSnapshot = false;
  /** One lightweight connection keeps background session lifecycle visible. */
  #statusStreamStop: (() => void) | undefined;
  #archiveToastTimer: ReturnType<typeof setTimeout> | undefined;
  #actionToastTimer: ReturnType<typeof setTimeout> | undefined;
  #worktreePoll: ReturnType<typeof setTimeout> | undefined;
  #worktreeRemovalQueue: Promise<unknown> = Promise.resolve();

  constructor(host: SessionsHost, deps: SessionsDeps) {
    this.#host = host;
    this.#deps = deps;
  }

  start(): void {
    this.#statusStreamStop ??= subscribeSessionStatuses({
      onSnapshot: this.#applyStatusSnapshot,
      onStatus: this.#applyStatusUpdate,
      onSessions: this.#applyListChange,
    });
  }

  stop(): void {
    clearTimeout(this.#worktreePoll);
    clearTimeout(this.#actionToastTimer);
    this.#statusStreamStop?.();
    this.#statusStreamStop = undefined;
  }

  listed(id: string): SessionView | undefined {
    return this.groups.flatMap((group) => group.sessions).find((session) => session.id === id);
  }

  async refresh(background = false): Promise<void> {
    if (!background) {
      this.loading = true;
      this.#host.requestUpdate();
    }
    try {
      const { revision, groups } = await loadSessions();
      // The status stream may have delivered newer changes while this loaded.
      this.receive(revision, this.#hasStatusSnapshot ? mergeSessionStatuses(groups, this.statuses) : groups);
      this.error = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read sessions.";
      if (this.groups.length === 0) {
        this.error = message;
      } else {
        // A refresh failure must not replace a usable registry with a full
        // sidebar error. Preserve the last confirmed list and report inline.
        this.#deps.reportError(error, message);
      }
    } finally {
      if (!background) this.loading = false;
      this.#host.requestUpdate();
      this.#deps.listSettled();
    }
  }

  /** Full lists and stream changes both land here, in revision order. */
  receive(revision: number, groups: readonly SessionGroup[]): void {
    if (revision < this.revision) return;
    this.revision = revision;
    this.groups = groups;
    this.#host.requestUpdate();
    this.#deps.listReceived(new Set(groups.flatMap((group) => group.sessions.map(({ id }) => id))));
  }

  showStatus(id: string, status: SessionStatus, interrupted: SessionView["interrupted"]): void {
    this.groups = this.groups.map((group) => ({
      ...group,
      sessions: group.sessions.map((session) =>
        session.id === id ? { ...session, status, interrupted } : session,
      ),
    }));
    this.#host.requestUpdate();
  }

  toggleSessionTree = (id: string) => {
    const next = new Set(this.toggledSessionTrees);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.toggledSessionTrees = next;
    this.#host.requestUpdate();
  };

  toggleGroup = (label: string) => {
    const next = new Set(this.collapsed);
    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }
    this.collapsed = next;
    this.#host.requestUpdate();
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  };

  expandGroup(label: string): void {
    const collapsed = new Set(this.collapsed);
    collapsed.delete(label);
    this.collapsed = collapsed;
    this.#host.requestUpdate();
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* Keep the group visible when storage is unavailable. */ }
  }

  toggleGroupMenu(group: string): void {
    this.groupMenuFor = this.groupMenuFor === group ? "" : group;
    this.#host.requestUpdate();
  }

  closeGroupMenu(): void {
    this.groupMenuFor = "";
    this.#host.requestUpdate();
  }

  /** Replaces the action toast; an empty message clears it. Successes clear
   * after 6 s, while failures and progress ("…") stay until replaced or dismissed. */
  notify(message: string, failed = false): void {
    clearTimeout(this.#actionToastTimer);
    this.actionToast = message ? { message, failed } : undefined;
    this.#host.requestUpdate();
    if (message && !failed && !message.endsWith("…")) this.#actionToastTimer = setTimeout(() => this.notify(""), 6_000);
  }

  showArchived(session: SessionView): void {
    this.archiveToast = { session, restoring: false };
    this.#host.requestUpdate();
    this.scheduleArchiveToast();
  }

  pauseArchiveToast = () => {
    if (this.#archiveToastTimer) clearTimeout(this.#archiveToastTimer);
    this.#archiveToastTimer = undefined;
  };

  dismissArchiveToast = () => {
    this.pauseArchiveToast();
    this.archiveToast = undefined;
    this.#host.requestUpdate();
  };

  scheduleArchiveToast = () => {
    this.pauseArchiveToast();
    if (!this.archiveToast || this.archiveToast.restoring || this.archiveToast.error) return;
    const element = this.#host.querySelector(".session-archive-toast");
    if (element?.matches(":hover") || element?.contains(document.activeElement)) return;
    this.#archiveToastTimer = setTimeout(this.dismissArchiveToast, 15_000);
  };

  restoreArchivedSession = async () => {
    const toast = this.archiveToast;
    if (!toast || toast.restoring) return;
    this.pauseArchiveToast();
    this.archiveToast = { session: toast.session, restoring: true };
    this.#host.requestUpdate();
    try {
      await renameSession(toast.session.id, { archived: false });
      if (this.archiveToast?.session.id === toast.session.id) this.dismissArchiveToast();
      this.notify("Session restored.");
      await this.#deps.refreshSessions();
    } catch (error) {
      if (this.archiveToast?.session.id === toast.session.id) {
        this.archiveToast = { session: toast.session, restoring: false,
          error: error instanceof Error ? error.message : "Could not restore that session." };
        this.#host.requestUpdate();
      }
    }
  };

  #set(next: Partial<Pick<SessionsController, "pageState" | "pageFilters" | "pageSelected" | "deleteConfirm" | "deleting"
    | "worktreeInventory" | "worktreesLoading" | "worktreesError" | "worktreeQuery" | "worktreeFilter" | "worktreeConfirm"
    | "worktreeRemovals" | "worktreeRemovalSizes" | "worktreeResults">>): void {
    Object.assign(this, next);
    this.#host.requestUpdate();
  }

  #searchTranscripts = () => {
    this.#transcriptSearchRun?.abort();
    const run = new AbortController();
    this.#transcriptSearchRun = run;
    const query = this.transcriptSearch.query.trim();
    const settle = (outcome: Pick<TranscriptSearchState, "result" | "error">) => {
      if (this.#transcriptSearchRun !== run) return;
      this.transcriptSearch = { query: this.transcriptSearch.query, searching: false, searched: query, ...outcome };
      this.#host.requestUpdate();
    };
    this.transcriptSearch = { ...this.transcriptSearch, searching: true };
    this.#host.requestUpdate();
    void searchSessionTranscripts(query, run.signal).then(
      (result) => settle({ result }),
      (error: unknown) => settle({ error: error instanceof Error ? error.message : "Could not search the transcripts." }),
    );
  };

  sessionsPageProps(): Pick<SessionsPageProps, "state" | "filters" | "onState" | "onFilters" | "selected" | "onSelect"
    | "confirmingDelete" | "deleting" | "onDeleteSelected" | "onCancelDelete" | "onConfirmDelete"
    | "transcriptSearch" | "onTranscriptQuery" | "onTranscriptSearch"> {
    return {
      transcriptSearch: this.transcriptSearch,
      onTranscriptQuery: (query) => {
        this.transcriptSearch = { ...this.transcriptSearch, query };
        this.#host.requestUpdate();
      },
      onTranscriptSearch: this.#searchTranscripts,
      state: this.pageState,
      filters: this.pageFilters,
      onState: (pageState) => this.#set({ pageState }),
      onFilters: (pageFilters) => this.#set({ pageFilters }),
      selected: this.pageSelected,
      onSelect: this.selectSessions,
      confirmingDelete: this.deleteConfirm,
      deleting: this.deleting,
      onDeleteSelected: () => this.#set({ deleteConfirm: true }),
      onCancelDelete: this.closeDeleteDialog,
      onConfirmDelete: (ids, withWorktrees) => void this.deleteSelected(ids, withWorktrees),
    };
  }

  worktreesProps(): Omit<WorktreesPageProps, "onOpenSession" | "onCopyPath"> {
    return {
      inventory: this.worktreeInventory,
      loading: this.worktreesLoading,
      error: this.worktreesError,
      query: this.worktreeQuery,
      filter: this.worktreeFilter,
      confirm: this.worktreeConfirm,
      removing: this.worktreeRemovals,
      removalSizes: this.worktreeRemovalSizes,
      results: this.worktreeResults,
      onQuery: (worktreeQuery) => this.#set({ worktreeQuery }),
      onFilter: (worktreeFilter) => this.#set({ worktreeFilter }),
      onRefresh: this.loadWorktreeInventory,
      onRequestRemove: (path) => this.#set({ worktreeConfirm: path, worktreeResults: [] }),
      onRequestCleanup: () => this.#set({ worktreeConfirm: "merged", worktreeResults: [] }),
      onCancel: () => { this.#closeWorktreeDialog(); this.#set({ worktreeConfirm: "" }); },
      onDismissResults: () => this.#set({ worktreeResults: [] }),
      onConfirmRemove: (path, acknowledged) => this.#removeWorktreePaths([path], "single", acknowledged),
      onConfirmCleanup: (paths) => this.#removeWorktreePaths(paths, "merged"),
    };
  }

  openWorktrees(): void {
    this.#set({ worktreeConfirm: "", worktreeResults: [] });
    this.loadWorktreeInventory();
  }

  /** Slow facts (size, local changes, GitHub) arrive in the background; poll
   * briefly while the server reports them pending and the page is open. */
  loadWorktreeInventory = () => {
    clearTimeout(this.#worktreePoll);
    this.#worktreePoll = undefined;
    if (this.worktreesLoading) return;
    this.#set({ worktreesLoading: true, worktreesError: "" });
    void loadWorktrees()
      .then((worktreeInventory) => this.#set({ worktreeInventory }))
      .catch((error: unknown) => this.#set({ worktreesError: error instanceof Error ? error.message : "Could not read worktrees." }))
      .finally(() => {
        this.#set({ worktreesLoading: false });
        if ((this.worktreeInventory?.pending || this.worktreeRemovals.size > 0) && this.#deps.worktreesShown()) {
          this.#worktreePoll = setTimeout(this.loadWorktreeInventory, 1500);
        }
      });
  };

  /** Git deletes a large worktree file by file, which can take minutes, so the
   * confirmation closes at once and the rows show progress while polling. */
  #removeWorktreePaths(paths: readonly string[], mode: "single" | "merged", acknowledged: readonly WorktreeRisk[] = []): void {
    if (paths.length === 0) return;
    this.#closeWorktreeDialog();
    this.#set({ worktreeConfirm: "" });
    void this.#requestWorktreeRemoval(paths, mode, acknowledged).then((results) => {
      this.#set({ worktreeResults: [...this.worktreeResults, ...results] });
    });
    this.loadWorktreeInventory();
  }

  /** Sends one removal request at a time: each can stay open for minutes and
   * browsers allow only a few connections per host. Never rejects. */
  #requestWorktreeRemoval(paths: readonly string[], mode: "single" | "merged", acknowledged: readonly WorktreeRisk[] = []) {
    const sizes = new Map(this.worktreeRemovals.size ? this.worktreeRemovalSizes : []);
    for (const path of paths) sizes.set(path, this.worktreeInventory?.worktrees.find((row) => row.path === path)?.bytes ?? 0);
    this.#set({ worktreeRemovalSizes: sizes, worktreeRemovals: new Set([...this.worktreeRemovals, ...paths]) });
    const next = this.#worktreeRemovalQueue
      .then(() => removeWorktrees(paths, mode, acknowledged))
      .then(({ results, inventory }) => {
        this.#set({ worktreeInventory: inventory });
        return results;
      }, (error: unknown) => paths.map((path): WorktreeRemovalResult => ({
        path,
        label: this.worktreeInventory?.worktrees.find((row) => row.path === path)?.branch || path.split("/").pop() || path,
        removed: false,
        branchDeleted: false,
        error: error instanceof Error ? error.message : "Could not remove it.",
      })))
      .finally(() => {
        this.#set({ worktreeRemovals: new Set([...this.worktreeRemovals].filter((path) => !paths.includes(path))) });
      });
    this.#worktreeRemovalQueue = next;
    return next;
  }

  #closeWorktreeDialog(): void {
    const dialog = this.#host.querySelector(".worktree-remove-dialog");
    if (dialog instanceof HTMLDialogElement) closeModal(dialog);
  }

  selectSessions = (ids: readonly string[], checked: boolean) => {
    const next = new Set(this.pageSelected);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    this.#set({ pageSelected: next });
  };

  closeDeleteDialog = () => {
    if (this.deleting) return;
    closeModal(this.#host.querySelector(".sessions-delete-dialog") as HTMLDialogElement | undefined);
    this.#set({ deleteConfirm: false });
  };

  /** Deletes each selected tree, then removes worktrees only those sessions used.
   * Worktree removal never forces: local changes or a non-HUI worktree keep it.
   * It can take minutes, so it runs after the dialog closes. */
  deleteSelected = async (ids: readonly string[], withWorktrees: boolean) => {
    if (this.deleting || ids.length === 0) return;
    this.#set({ deleting: true });
    const all = this.groups.flatMap((group) => group.sessions);
    const deleted = new Set<string>();
    const failures: string[] = [];
    let worktrees: string[] | undefined;
    try {
      // Read links before deleting: the inventory forgets a deleted session.
      if (withWorktrees) this.#set({ worktreeInventory: await loadWorktrees() });
      const rows = withWorktrees ? this.worktreeInventory?.worktrees : undefined;
      for (const id of ids) {
        if (deleted.has(id)) continue; // Already gone with its parent.
        try {
          await deleteSession(id);
          for (const member of sessionTreeIds(all, id)) deleted.add(member);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : `Could not delete ${id}.`);
        }
      }
      this.#deps.sessionsDeleted(deleted);
      if (rows) worktrees = worktreesOnlyUsedBy(rows, deleted);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Could not read worktrees.");
    }
    const count = ids.filter((id) => deleted.has(id)).length;
    const notice = `Deleted ${count} session${count === 1 ? "" : "s"}.${failures.length ? ` Failed: ${failures.join("; ")}` : ""}`;
    // A message ending in "…" stays until replaced.
    const shown = worktrees?.length ? `${notice} Removing ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"}…` : notice;
    this.notify(shown, failures.length > 0);
    this.#set({ pageSelected: new Set([...this.pageSelected].filter((id) => !deleted.has(id))), deleting: false });
    this.closeDeleteDialog();
    void this.#deps.refreshSessions();
    if (!worktrees) return;

    const results = await Promise.all(worktrees.map((path) => this.#requestWorktreeRemoval([path], "single").then(([result]) => result)));
    if (this.actionToast?.message !== shown) return; // Dismissed or replaced meanwhile.
    const removed = results.filter((result) => result?.removed).length;
    const kept = results.filter((result) => !result?.removed).map((result) => result?.label ?? "");
    this.notify(`${notice} Removed ${removed} worktree${removed === 1 ? "" : "s"}.${kept.length
      ? ` Kept ${kept.join(", ")} (local changes or not created by HUI); review ${kept.length === 1 ? "it" : "them"} in Settings → Worktrees.`
      : ""}`, failures.length > 0);
  };

  #applyStatusSnapshot = (updates: readonly SessionStatusUpdate[]) => {
    // The status stream has just (re)connected, so the gateway is reachable
    // again: a list that failed to load earlier is worth asking for once more.
    if (this.error && !this.loading) void this.refresh();
    this.statuses = new Map(updates.map(({ id, status }) => [id, status]));
    const unread = new Map(updates.flatMap((update) =>
      update.unread === undefined ? [] : [[update.id, update.unread] as const]));
    this.unread = new Map(updates.map((update) => [update.id, update.unread === true]));
    this.#hasStatusSnapshot = true;
    const merged = mergeSessionStatuses(this.groups, this.statuses);
    this.groups = merged.map((group) => ({
      ...group,
      sessions: group.sessions.map((session) => {
        const isUnread = unread.has(session.id) ? unread.get(session.id) === true : session.unread === true;
        return { ...session, unread: isUnread || undefined };
      }),
    }));
    this.#host.requestUpdate();
    this.#deps.statusesApplied();
  };

  #applyStatusUpdate = (update: SessionStatusUpdate) => {
    const { id, status, unread, creating, creationError, title } = update;
    const presented = this.#deps.presented(id);
    this.statuses.set(id, status);
    if (unread !== undefined) this.unread.set(id, unread);
    // A settled worktree session now has its real title and directory, or its error.
    const created = Boolean(this.listed(id)?.creating) && !creating;
    this.groups = this.groups.map((group) => ({
      ...group,
      sessions: group.sessions.map((session) => session.id === id
        ? {
            ...session,
            status,
            unread: presented
              ? undefined
              : unread === undefined ? session.unread : unread || undefined,
            creating,
            creationError,
            ...(title ? { title } : {}),
          }
        : session),
    }));
    this.#host.requestUpdate();
    if (created) void this.refresh(true);
    this.#deps.statusApplied(update);
  };

  #applyListChange = (update: SessionListUpdate) => {
    if (update.revision <= this.revision) return;
    // Status events can overtake a list built a moment earlier.
    this.receive(update.revision, mergeSessionStatuses(applySessionListUpdate(this.groups, update), this.statuses));
    this.loading = false;
    this.error = "";
    this.#deps.listSettled();
  };
}
