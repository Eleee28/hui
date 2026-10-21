/**
 * `WorkLayoutController` owns the split layout and the Work pane outside `hui-app.ts`: the chat panes' layout
 * (`SESSION_LAYOUT_KEY`, mirrored in the history entry) and committing, focusing, splitting, closing, dropping,
 * moving and retargeting its panes; the browser-local record of each conversation's Work views (`WORK_PANE_KEY`),
 * the narrow breakpoint and the narrow Work destination, launching, revealing, hiding and maximizing views, files
 * opened from the chat, and the Alt shortcuts. The shell routes navigation through these and renders from them.
 */
import type { ReactiveControllerHost } from "lit";
import { createTerminal, listTerminals } from "../api/terminals.ts";
import type { PanePresentation, SessionMultiplexer } from "../components/session-multiplexer.ts";
import type { WorkPane } from "../components/work-pane.ts";
import { requestFilesViewReveal } from "../lib/files/view-state.ts";
import type { OpenFileDetail } from "../lib/files/file-link-store.ts";
import { navigationPath } from "../lib/navigation.ts";
import {
  activeSessionPane, addSessionTab, closeSessionPane, focusSessionPane, isChatPane, moveSessionPane, replacePaneSession, SESSION_LAYOUT_KEY,
  SESSION_SPLIT_MEDIA, sessionPanes, splitSessionPane, type DropZone, type SessionLayout, type SessionPane, type SplitDirection,
} from "../lib/session/multiplexer.ts";
import { matchesShortcut } from "../lib/shortcut-binding.ts";
import {
  activateWorkView, closeWorkView, closingLastWorkView, openWorkView, parseWorkPaneStore, registerWorkViewKind, serializeWorkPaneStore, sessionWorkPane,
  setWorkPaneMaximized, setWorkPaneOpen, setWorkPaneWidth, workPaneMaximized, workViewKey, workViewKind, workViewKinds,
  WORK_PANE_KEY, WORK_PANE_MAXIMIZE_SHORTCUT, WORK_PANE_TOGGLE_SHORTCUT, type WorkPaneStore, type WorkViewRef,
} from "../lib/work-pane.ts";
import { browserWorkViewKind } from "../views/work/browser.ts";
import { diffWorkViewKind } from "../views/work/diff.ts";
import { filesViewToReveal, filesWorkViewKind, type FilesWorkViewRef } from "../views/work/files.ts";
import { terminalWorkViewKind } from "../views/work/terminal.ts";
import { vscodeWorkViewKind } from "../views/work/vscode.ts";

type WorkLayoutHost = ReactiveControllerHost & { readonly renderRoot: HTMLElement | DocumentFragment };

type WorkLayoutDeps = {
  followedSession: () => string | undefined;
  showSession: (sessionId: string) => void;
  activePane: () => HTMLElement | undefined;
  focusComposer: () => void;
  paletteOpen: () => boolean;
  terminalFont: () => string;
  browserEnabled: () => boolean;
  remoteSession: (sessionId: string) => boolean;
};

export class WorkLayoutController {
  #layout: SessionLayout | undefined;
  /** Browser-local Work pane record per conversation (`lib/work-pane.ts`); top-level app only. */
  panes: WorkPaneStore = {};
  /** Below 1100px the Work pane is a full-screen destination instead of a side pane. */
  narrow = false;
  narrowShown = false;
  launching = "";
  error = "";
  /** The view the operator launched last; it may take focus once it opens. */
  launchedKey = "";
  /** Conversations whose Work views stay mounted, most recently focused first. */
  retained: string[] = [];
  readonly #host: WorkLayoutHost;
  readonly #deps: WorkLayoutDeps;
  #media: MediaQueryList | undefined;
  /** Unsubscribes the narrow chooser from the Work view kinds' availability changes. */
  #stopAvailability: (() => void)[] = [];

  constructor(host: WorkLayoutHost, deps: WorkLayoutDeps) {
    this.#host = host;
    this.#deps = deps;
  }

  /** Browser-owned presentation state; each pane still owns its own runtime state. */
  get layout(): SessionLayout | undefined { return this.#layout; }
  set layout(layout: SessionLayout | undefined) {
    this.#layout = layout;
    this.#host.requestUpdate();
  }

  persistLayout(): void {
    try {
      if (this.layout && (sessionPanes(this.layout).length > 1 || sessionPanes(this.layout).some((pane) => !isChatPane(pane)))) {
        localStorage.setItem(SESSION_LAYOUT_KEY, JSON.stringify(this.layout));
      } else localStorage.removeItem(SESSION_LAYOUT_KEY);
    } catch { /* The current view still works if browser storage is unavailable. */ }
  }

  commitLayout(layout: SessionLayout, replace = true): void {
    this.layout = layout;
    const id = activeSessionPane(layout).sessionId;
    this.#deps.showSession(id);
    this.persistLayout();
    window.history[replace ? "replaceState" : "pushState"](
      { ...window.history.state, huiSessionLayout: layout }, "", navigationPath({ kind: "session", id }),
    );
  }

  focusPane = (id: string) => {
    if (!this.layout || this.layout.activePaneId === id) return;
    this.commitLayout(focusSessionPane(this.layout, id));
  };

  splitPane = (pane: SessionPane, direction: SplitDirection) => {
    if (this.layout) this.commitLayout(splitSessionPane(this.layout, pane.id, pane.sessionId, direction));
  };

  paneControls(pane: SessionPane, state: PanePresentation): { close?: () => void; split?: (direction: SplitDirection) => void } {
    return {
      ...(state.split ? { close: () => this.closePane(pane.id) } : {}),
      ...(!state.narrow ? { split: (direction: SplitDirection) => this.splitPane(pane, direction) } : {}),
    };
  }

  closePane = (paneId: string) => {
    if (!this.layout) return;
    const next = closeSessionPane(this.layout, paneId);
    if (next === this.layout) return;
    this.commitLayout(next);
    void this.#host.updateComplete.then(() => this.#host.renderRoot.querySelector<SessionMultiplexer>("hui-session-multiplexer")?.updateComplete).then(() => {
      this.#deps.activePane()?.querySelector<HTMLElement>(".chat-pane__header")?.focus({ preventScroll: true });
    });
  };

  dropSession(id: string, paneId: string, zone: DropZone): void {
    if (!this.layout) return;
    this.commitLayout(zone.kind === "center"
      ? replacePaneSession(focusSessionPane(this.layout, paneId), paneId, id)
      : zone.kind === "tab" ? addSessionTab(this.layout, paneId, id)
        : splitSessionPane(this.layout, paneId, id, zone.edge));
  }

  movePane = (sourceId: string, targetId: string, zone: DropZone) => {
    if (this.layout) this.commitLayout(moveSessionPane(this.layout, sourceId, targetId, zone));
  };

  changePaneSession(paneId: string, id: string): void {
    if (this.layout) this.commitLayout(replacePaneSession(focusSessionPane(this.layout, paneId), paneId, id), false);
  }

  /** Registers the built-in Work view kinds, reads the browser-local record, follows the narrow breakpoint and the
   * shortcuts. */
  start(): void {
    registerWorkViewKind(terminalWorkViewKind({
      fontFamily: () => this.#deps.terminalFont(),
      unavailable: (sessionId) => sessionId && this.#deps.remoteSession(sessionId)
        ? "Terminals run on this gateway's machine; this conversation runs on a remote worker."
        : undefined,
    }));
    registerWorkViewKind(browserWorkViewKind({ enabled: () => this.#deps.browserEnabled() }));
    registerWorkViewKind(filesWorkViewKind);
    registerWorkViewKind(vscodeWorkViewKind);
    registerWorkViewKind(diffWorkViewKind);
    // A launcher's reason can change outside this app's state (VS Code's gateway status): redraw the narrow chooser.
    for (const stop of this.#stopAvailability) stop();
    this.#stopAvailability = workViewKinds().flatMap((kind) => kind.onAvailabilityChange ? [kind.onAvailabilityChange(() => this.#host.requestUpdate())] : []);
    try { this.panes = parseWorkPaneStore(JSON.parse(localStorage.getItem(WORK_PANE_KEY) ?? "null")); } catch { this.panes = {}; }
    this.#media = window.matchMedia(SESSION_SPLIT_MEDIA);
    this.narrow = this.#media.matches;
    this.#media.addEventListener("change", this.#onMediaChange);
    // Capture: a focused terminal swallows keys, and Work pane shortcuts must still work from inside one.
    document.addEventListener("keydown", this.onShortcut, true);
    this.#host.requestUpdate();
  }

  stop(): void {
    document.removeEventListener("keydown", this.onShortcut, true);
    this.#media?.removeEventListener("change", this.#onMediaChange);
    this.#media = undefined;
    for (const stop of this.#stopAvailability) stop();
    this.#stopAvailability = [];
  }

  readonly #onMediaChange = (event: MediaQueryListEvent) => {
    this.narrow = event.matches;
    this.#host.requestUpdate();
  };

  persist(): void {
    try { localStorage.setItem(WORK_PANE_KEY, JSON.stringify(serializeWorkPaneStore(this.panes))); }
    catch { /* The pane still works for this page if browser storage is unavailable. */ }
  }

  commit(store: WorkPaneStore): void {
    if (store === this.panes) return;
    this.panes = store;
    this.persist();
    this.#host.requestUpdate();
  }

  maximized(): boolean {
    const sessionId = this.#deps.followedSession();
    return Boolean(sessionId) && workPaneMaximized(sessionWorkPane(this.panes, sessionId!), this.narrow);
  }

  hideNarrow(): void {
    this.narrowShown = false;
    this.#host.requestUpdate();
  }

  showNarrow(): void {
    if (!this.narrow) return;
    this.narrowShown = true;
    this.#host.requestUpdate();
  }

  dismissError = () => {
    this.error = "";
    this.#host.requestUpdate();
  };

  resize(sessionId: string, width: number, available: number, done: boolean): void {
    this.panes = setWorkPaneWidth(this.panes, sessionId, width, available, this.layout?.columns.length ?? 1);
    if (done) this.persist();
    this.#host.requestUpdate();
  }

  activate(sessionId: string, key: string): void {
    // Only a view just launched may take focus; switching tabs never refocuses an older one.
    if (key !== this.launchedKey) this.launchedKey = "";
    this.commit(activateWorkView(this.panes, sessionId, key));
  }

  close(sessionId: string, key: string, followed: string): void {
    if (this.launchedKey === key) this.launchedKey = "";
    const before = sessionWorkPane(this.panes, sessionId);
    const ref = before.views.find((view) => workViewKey(view) === key);
    const last = closingLastWorkView(this.panes, sessionId, key);
    this.commit(closeWorkView(this.panes, sessionId, key));
    if (ref) workViewKind(ref.kind)?.closed?.(ref, sessionId);
    if (last && sessionId === followed) this.#emptied(before.open);
  }

  /** Shows `ref` in its conversation's Work pane, focusing that conversation's chat pane and expanding the pane (or,
   * on narrow screens, opening the Work destination). */
  showView(sessionId: string, ref: WorkViewRef, launched = false): void {
    const layout = this.layout;
    if (layout && activeSessionPane(layout).sessionId !== sessionId) {
      const chat = sessionPanes(layout).find((pane) => isChatPane(pane) && pane.sessionId === sessionId);
      if (chat) this.commitLayout(focusSessionPane(layout, chat.id));
    }
    const key = workViewKey(ref);
    if (launched) this.launchedKey = key;
    this.error = "";
    this.commit(openWorkView(this.panes, sessionId, ref));
    this.#host.requestUpdate();
    if (this.narrow) this.showNarrow();
    else this.#element()?.reveal(sessionId);
    // Views that do not take focus themselves leave it on their tab.
    if (!launched || ref.kind !== "terminal") void this.#host.updateComplete.then(() => this.#element()?.focusPane("active"));
  }

  /** The chat header's **Open terminal**: the conversation's open terminal tab, else its first running terminal,
   * else a new one. */
  openTerminal = async (pane: SessionPane) => {
    const open = sessionWorkPane(this.panes, pane.sessionId).views.find((view) => view.kind === "terminal");
    if (open) { this.showView(pane.sessionId, open); return; }
    const running = (await listTerminals(pane.sessionId)).find(({ status }) => status === "running");
    const terminal = running ?? await createTerminal(pane.sessionId);
    this.showView(pane.sessionId, { kind: "terminal", terminalId: terminal.id }, !running);
  };

  /** The chat's inline browser preview and header globe open (or focus) the conversation's one browser view. */
  openBrowser = (pane: SessionPane) => {
    this.showView(pane.sessionId, { kind: "browser" });
  };

  /**
   * A file reference clicked in a conversation's chat (`components/file-link.ts`): show it in that conversation's
   * Files view — the active one, else its first, else a new one — opening the Work pane (or, on narrow screens, the
   * Work destination) the way any Work view does.
   */
  async openFile(detail: OpenFileDetail): Promise<void> {
    const kind = workViewKind("files");
    if (!kind) return;
    const { sessionId } = detail;
    let ref = filesViewToReveal(sessionWorkPane(this.panes, sessionId));
    if (!ref) {
      try {
        ref = await kind.create(sessionId) as FilesWorkViewRef;
      } catch (error) {
        this.error = error instanceof Error ? error.message : "Could not open Files.";
        this.#reveal(sessionId);
        return;
      }
    }
    requestFilesViewReveal(ref.id, {
      path: detail.path,
      kind: detail.kind,
      ...(detail.line ? { line: detail.line } : {}),
      ...(detail.column ? { column: detail.column } : {}),
    });
    this.showView(sessionId, ref);
  }

  /** A launcher in the Work pane ("+" menu, empty state, shortcut) for the focused conversation. */
  launch = async (kindName: string) => {
    const sessionId = this.#deps.followedSession();
    const kind = workViewKind(kindName);
    if (!sessionId || !kind || this.launching) return;
    const reason = kind.unavailable?.(sessionId);
    if (reason) { this.error = reason; this.#reveal(sessionId); return; }
    this.launching = kindName;
    this.error = "";
    this.#host.requestUpdate();
    try {
      const ref = await kind.create(sessionId);
      this.showView(sessionId, ref, true);
    } catch (error) {
      this.error = error instanceof Error ? error.message : `Could not open ${kind.label}.`;
      this.#reveal(sessionId);
    } finally {
      this.launching = "";
      this.#host.requestUpdate();
    }
  };

  toggle(): void {
    const sessionId = this.#deps.followedSession();
    if (!sessionId) return;
    if (this.narrow) {
      this.narrowShown = !this.narrowShown;
      this.#host.requestUpdate();
      if (this.narrowShown) void this.#host.updateComplete.then(() => this.#element()?.focusPane("active"));
      else this.#deps.focusComposer();
      return;
    }
    // Collapsed to its rail for lack of room counts as hidden: the shortcut shows it anyway.
    const element = this.#element();
    const open = !(element?.expanded ?? sessionWorkPane(this.panes, sessionId).open);
    if (open && element) { element.expand(); return; }
    this.commit(setWorkPaneOpen(this.panes, sessionId, open));
    if (open) void this.#host.updateComplete.then(() => this.#element()?.focusPane("active"));
    else this.#deps.focusComposer();
  }

  /** Maximizes the focused conversation's Work pane over its chat columns, or restores them (desktop only; narrow
   * screens already show one panel at a time). The chat stays mounted underneath. */
  toggleMaximized(maximized?: boolean): void {
    const sessionId = this.#deps.followedSession();
    if (!sessionId || this.narrow) return;
    const next = maximized ?? !workPaneMaximized(sessionWorkPane(this.panes, sessionId), false);
    this.commit(setWorkPaneMaximized(this.panes, sessionId, next));
    // Focus left in the now hidden chat moves into the pane; focus already in the pane (a terminal) stays put.
    if (next) void this.#host.updateComplete.then(() => {
      const element = this.#element();
      if (element && !element.contains(document.activeElement)) element.focusPane("active");
    });
  }

  /** Escape inside the pane, or **Back to chat**: return to the conversation without touching its turn. A maximized
   * pane hides the chat, so Escape goes to the panel selector, the way back to it; it never restores by itself. */
  leave = () => {
    if (this.narrow) this.hideNarrow();
    if (this.maximized()) {
      this.#host.renderRoot.querySelector<HTMLElement>(".hui-panel-selector .picker-select__trigger")?.focus({ preventScroll: true });
      return;
    }
    this.#deps.focusComposer();
  };

  /** Launcher shortcuts and the pane toggle, while a conversation is shown and nothing modal is open. */
  readonly onShortcut = (event: KeyboardEvent) => {
    if (!event.altKey || !this.#deps.followedSession() || this.#deps.paletteOpen() || document.querySelector("dialog[open]")) return;
    if (matchesShortcut(event, WORK_PANE_TOGGLE_SHORTCUT)) {
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
      return;
    }
    if (matchesShortcut(event, WORK_PANE_MAXIMIZE_SHORTCUT)) {
      event.preventDefault();
      event.stopPropagation();
      this.toggleMaximized();
      return;
    }
    const kind = workViewKinds().find((candidate) => candidate.shortcut && matchesShortcut(event, candidate.shortcut));
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    void this.launch(kind.kind);
  };

  /** The focused conversation's last Work view closed, which hid its pane (`closeWorkView`): as **Hide Work pane**
   * does, narrow screens go back to the chat and focus moves to the composer — unless it is elsewhere already (a view
   * that removes itself never takes focus from, say, the sidebar). */
  #emptied(wasOpen: boolean): void {
    const shown = this.narrow ? this.narrowShown : wasOpen;
    this.hideNarrow();
    const focused = document.activeElement;
    const inPane = !focused || focused === document.body || Boolean(this.#element()?.contains(focused));
    if (shown && inPane) this.#deps.focusComposer();
  }

  #reveal(sessionId: string): void {
    this.commit(setWorkPaneOpen(this.panes, sessionId, true));
    this.#host.requestUpdate();
    if (this.narrow) this.showNarrow();
    else this.#element()?.reveal(sessionId);
  }

  #element(): WorkPane | null {
    return this.#host.renderRoot.querySelector<WorkPane>("hui-work-pane");
  }
}
