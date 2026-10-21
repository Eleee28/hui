/**
 * The Work pane's contract and state: the registry of Work view kinds (terminal, browser, files, VS Code, diff…), the
 * browser-local per-conversation record (open, maximized, width, views, active view) and the pure transitions on it, plus the
 * one-time move of terminal and browser panes out of the chat multiplexer's saved layout. Rendering belongs to
 * `components/work-pane.ts`; each kind renders its own view; the conversations themselves stay PI/HUI-owned.
 */
import type { TemplateResult } from "lit";
import type { OpenSettingsDetail } from "./open-settings.ts";
import { closeSessionPane, isChatPane, locateSessionPane, replacePaneSession, sessionPanes, spotTabs, type SessionLayout } from "./session/multiplexer.ts";
import { PANE_DIVIDER_SIZE } from "./session/pane-geometry.ts";
import { WORK_SHORTCUTS } from "./work-shortcuts.ts";

export type WorkViewRef =
  | { kind: "terminal"; terminalId: string }
  | { kind: "browser" }
  | { kind: "files"; id: string }
  | { kind: "vscode" }
  | { kind: "diff"; id: string };

export type WorkViewContext = {
  /** The conversation owning the Work pane. */
  sessionId: string;
  /** This view is the active tab of a shown Work pane. */
  visible: boolean;
  /** < 1100px presentation. */
  narrow: boolean;
  /** Close this view (tab). */
  close(): void;
  /** The operator just launched this view: it may take keyboard focus once it is ready. */
  autofocus: boolean;
  /** Ask the Work pane to re-read this view's `title` (for example once a terminal reports its name). */
  invalidate(): void;
};

/** Where the operator can fix what `unavailable` reports: shown as a link beside the reason. */
export type WorkViewSettingsLink = OpenSettingsDetail & { label: string };

/** An existing resource a launcher can show again, such as a running terminal whose tab was closed. */
export type WorkViewResource<R extends WorkViewRef = WorkViewRef> = { ref: R; title: string };

export type WorkViewKind<R extends WorkViewRef = WorkViewRef> = {
  kind: R["kind"];
  /** Launcher caption, e.g. "Files". */
  label: string;
  /** 16px SVG, explicit size. */
  icon: TemplateResult;
  /** e.g. "Mod+Alt+Shift+KeyF" (display + binding); the entry in `WORK_SHORTCUTS`. */
  shortcut?: string;
  /** Visible reason when it cannot launch (for this conversation, when given). */
  unavailable?(sessionId?: string): string | undefined;
  /** When `unavailable` answers, the Settings page that changes it (e.g. "Open Settings → Tools → VS Code"). */
  settingsLink?(sessionId?: string): WorkViewSettingsLink | undefined;
  /** Calls `listener` whenever `unavailable` may answer differently; returns the unsubscribe. */
  onAvailabilityChange?(listener: () => void): () => void;
  /** Launcher action → new (or reused) ref. */
  create(sessionId: string): Promise<R> | R;
  /** Stable identity within a session. */
  key(ref: R): string;
  /** Tab caption. */
  title(ref: R): string;
  render(ref: R, ctx: WorkViewContext): TemplateResult;
  /** The view's tab closed (it was unmounted): forget per-view state kept outside the ref. Not called when the
   * conversation's views are merely hidden or the pane collapses. */
  closed?(ref: R, sessionId: string): void;
  /** Resources of this kind that exist without a tab and can be reopened from the launcher menu. */
  existing?(sessionId: string): Promise<WorkViewResource<R>[]>;
  /** At most one view of this kind per conversation (its key is constant): once open, the view itself is listed
   * instead of its launcher where both would appear side by side (the narrow destination chooser). */
  single?: boolean;
};

const kinds = new Map<string, WorkViewKind<any>>();

/** Registers (or replaces) a kind. Launchers list kinds in registration order. */
export function registerWorkViewKind(kind: WorkViewKind<any>): void {
  kinds.set(kind.kind, kind);
}

export function workViewKind(kind: string): WorkViewKind | undefined {
  return kinds.get(kind);
}

export function workViewKinds(): WorkViewKind[] {
  return [...kinds.values()];
}

/** Launchers worth listing beside a conversation's open views: every kind except a single-view kind already open. */
export function launchableWorkViewKinds(pane: Pick<SessionWorkPane, "views">): WorkViewKind[] {
  return workViewKinds().filter((kind) => !kind.single || !pane.views.some((view) => view.kind === kind.kind));
}

/** Used for kinds that are not registered (yet): the same keys the built-in kinds use. */
export function defaultWorkViewKey(ref: WorkViewRef): string {
  if (ref.kind === "terminal") return `terminal:${ref.terminalId}`;
  if (ref.kind === "files") return `files:${ref.id}`;
  if (ref.kind === "diff") return `diff:${ref.id}`;
  return ref.kind;
}

export function workViewKey(ref: WorkViewRef): string {
  return kinds.get(ref.kind)?.key(ref) ?? defaultWorkViewKey(ref);
}

/* ── state ────────────────────────────────────────────────────────────────── */

export const WORK_PANE_KEY = "hui.work-pane.v1";
export const WORK_PANE_DEFAULT_WIDTH = 560;
export const WORK_PANE_MIN_WIDTH = 320;
export const WORK_PANE_MAX_WIDTH = 1600;
/** Each chat column beside an expanded Work pane keeps at least this much room. */
export const WORK_PANE_CHAT_MIN_WIDTH = 420;
/** Conversations whose Work views stay mounted (hidden) after focus moves away, the focused one included. A view of a
 * conversation pushed out of this set reconnects (terminals replay their snapshot) when it is shown again. */
export const WORK_PANE_RETAINED_SESSIONS = 3;
/** Shows or hides the Work pane (on narrow screens: opens it as the destination, or returns to the chat). */
export const WORK_PANE_TOGGLE_SHORTCUT = WORK_SHORTCUTS.togglePane;
/** Maximizes the expanded Work pane over the chat columns, or restores them (desktop only). */
export const WORK_PANE_MAXIMIZE_SHORTCUT = WORK_SHORTCUTS.maximizePane;

export type SessionWorkPane = {
  /** Expanded on desktop. On narrow screens the pane is a destination instead (see the app's narrow state). */
  open: boolean;
  /** Desktop only: the expanded pane fills the content area and the chat columns are hidden (still mounted). Only
   * written when set; a record without it is not maximized. Narrow screens ignore it. */
  maximized?: boolean;
  /** CSS pixels; clamped again against the viewport when rendered. */
  width: number;
  /** Tab order. Keys (`workViewKey`) are unique. */
  views: WorkViewRef[];
  /** The active view's key, when there is one. */
  active?: string;
};

export type WorkPaneStore = Readonly<Record<string, SessionWorkPane>>;

export function emptyWorkPane(): SessionWorkPane {
  return { open: false, width: WORK_PANE_DEFAULT_WIDTH, views: [] };
}

export function sessionWorkPane(store: WorkPaneStore, sessionId: string): SessionWorkPane {
  return store[sessionId] ?? emptyWorkPane();
}

function update(store: WorkPaneStore, sessionId: string, change: (pane: SessionWorkPane) => SessionWorkPane): WorkPaneStore {
  const current = sessionWorkPane(store, sessionId);
  const next = change(current);
  return next === current ? store : { ...store, [sessionId]: next };
}

/** Adds `ref` as the last tab (or finds its existing tab) and makes it active; `expand` also opens the pane. */
export function openWorkView(store: WorkPaneStore, sessionId: string, ref: WorkViewRef, expand = true): WorkPaneStore {
  const key = workViewKey(ref);
  return update(store, sessionId, (pane) => ({
    ...pane,
    open: expand || pane.open,
    views: pane.views.some((view) => workViewKey(view) === key) ? pane.views : [...pane.views, ref],
    active: key,
  }));
}

/** Removes a tab. The previous tab (or else the next) becomes active. Closing the last one hides the pane as **Hide
 * Work pane** does (collapsed, no longer maximized); toggling it open again shows the empty launchers. */
export function closeWorkView(store: WorkPaneStore, sessionId: string, key: string): WorkPaneStore {
  return update(store, sessionId, (pane) => {
    const index = pane.views.findIndex((view) => workViewKey(view) === key);
    if (index < 0) return pane;
    const views = pane.views.filter((_, i) => i !== index);
    const neighbour = views[index - 1] ?? views[index];
    const active = pane.active === key ? neighbour && workViewKey(neighbour) : pane.active;
    const next: SessionWorkPane = { ...pane, views };
    if (active) next.active = active; else delete next.active;
    if (!views.length) {
      next.open = false;
      delete next.maximized;
    }
    return next;
  });
}

/** Whether closing `key` removes the conversation's last Work view, so the pane hides. */
export function closingLastWorkView(store: WorkPaneStore, sessionId: string, key: string): boolean {
  const { views } = sessionWorkPane(store, sessionId);
  return views.length === 1 && workViewKey(views[0]!) === key;
}

export function activateWorkView(store: WorkPaneStore, sessionId: string, key: string, expand = true): WorkPaneStore {
  return update(store, sessionId, (pane) => {
    if (!pane.views.some((view) => workViewKey(view) === key)) return pane;
    if (pane.active === key && (pane.open || !expand)) return pane;
    return { ...pane, active: key, open: expand || pane.open };
  });
}

/** Moves a tab to `index` (clamped) in tab order. */
export function reorderWorkView(store: WorkPaneStore, sessionId: string, key: string, index: number): WorkPaneStore {
  return update(store, sessionId, (pane) => {
    const from = pane.views.findIndex((view) => workViewKey(view) === key);
    if (from < 0 || !Number.isFinite(index)) return pane;
    const to = Math.max(0, Math.min(pane.views.length - 1, Math.trunc(index)));
    if (to === from) return pane;
    const views = [...pane.views];
    const [moved] = views.splice(from, 1);
    views.splice(to, 0, moved!);
    return { ...pane, views };
  });
}

/** The tab `step` places after (or before) the active one, wrapping around. */
export function adjacentWorkView(pane: SessionWorkPane, step: 1 | -1): string | undefined {
  if (!pane.views.length) return undefined;
  const index = pane.views.findIndex((view) => workViewKey(view) === pane.active);
  const next = index < 0 ? 0 : (index + step + pane.views.length) % pane.views.length;
  return workViewKey(pane.views[next]!);
}

/** Expands or collapses the pane. Collapsing also restores a maximized pane, so the chat comes back beside its rail. */
export function setWorkPaneOpen(store: WorkPaneStore, sessionId: string, open: boolean): WorkPaneStore {
  return update(store, sessionId, (pane) => {
    if (pane.open === open && (open || !pane.maximized)) return pane;
    const next: SessionWorkPane = { ...pane, open };
    if (!open) delete next.maximized;
    return next;
  });
}

/** Maximizes the pane over the chat columns (expanding it) or restores the chat beside it (the pane stays open). */
export function setWorkPaneMaximized(store: WorkPaneStore, sessionId: string, maximized: boolean): WorkPaneStore {
  return update(store, sessionId, (pane) => {
    if (Boolean(pane.maximized) === maximized && (!maximized || pane.open)) return pane;
    const next: SessionWorkPane = { ...pane, open: pane.open || maximized };
    if (maximized) next.maximized = true; else delete next.maximized;
    return next;
  });
}

/** Whether the conversation's pane is shown maximized: open, maximized and on a wide (non-narrow) screen. */
export function workPaneMaximized(pane: Pick<SessionWorkPane, "open" | "maximized">, narrow: boolean): boolean {
  return !narrow && pane.open && pane.maximized === true;
}

/** The room the chat keeps beside the pane: `WORK_PANE_CHAT_MIN_WIDTH` per side-by-side chat column, plus the
 * dividers between them. */
function chatRoom(chatColumns: number): number {
  const columns = Math.max(1, Math.trunc(chatColumns) || 1);
  return WORK_PANE_CHAT_MIN_WIDTH * columns + PANE_DIVIDER_SIZE * (columns - 1);
}

/** Whether an expanded pane at its minimum still leaves every chat column its room. When it does not, the pane
 * shows as its collapsed rail unless the operator expands it anyway. Unknown room (`available` 0 or absent) fits. */
export function workPaneFits(available: number | undefined, chatColumns = 1): boolean {
  return !available || available - chatRoom(chatColumns) >= WORK_PANE_MIN_WIDTH;
}

/** The pane's width: `width` within its limits, leaving each of `chatColumns` chat columns its room in `available`
 * (never below the pane's own minimum; `workPaneFits` says when that minimum no longer fits). */
export function clampWorkPaneWidth(width: number, available = Number.POSITIVE_INFINITY, chatColumns = 1): number {
  const max = Math.max(WORK_PANE_MIN_WIDTH, Math.min(WORK_PANE_MAX_WIDTH, available - chatRoom(chatColumns)));
  if (Number.isNaN(width)) return Math.min(WORK_PANE_DEFAULT_WIDTH, max);
  return Math.round(Math.max(WORK_PANE_MIN_WIDTH, Math.min(max, width)));
}

export function setWorkPaneWidth(store: WorkPaneStore, sessionId: string, width: number, available?: number, chatColumns = 1): WorkPaneStore {
  const clamped = clampWorkPaneWidth(width, available, chatColumns);
  return update(store, sessionId, (pane) => pane.width === clamped ? pane : { ...pane, width: clamped });
}

/** Forgets conversations that no longer exist (deleted or archived out of the registry). */
export function pruneWorkPaneStore(store: WorkPaneStore, sessionIds: ReadonlySet<string>): WorkPaneStore {
  const entries = Object.entries(store);
  const kept = entries.filter(([id]) => sessionIds.has(id));
  return kept.length === entries.length ? store : Object.fromEntries(kept);
}

/** Most recently focused first, `focused` included, at most `bound` conversations that have Work views. */
export function retainWorkSessions(previous: readonly string[], focused: string | undefined, store: WorkPaneStore, bound = WORK_PANE_RETAINED_SESSIONS): string[] {
  const order = focused ? [focused, ...previous.filter((id) => id !== focused)] : [...previous];
  return order.filter((id) => sessionWorkPane(store, id).views.length > 0).slice(0, bound);
}

/* ── persistence ──────────────────────────────────────────────────────────── */

const TERMINAL_ID = /^[0-9a-f-]{36}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function validSessionId(id: string): boolean {
  return Boolean(id.trim()) && id.length <= 512 && !CONTROL.test(id);
}

/** A structurally valid ref of a kind `isKnown` accepts, or undefined. */
export function parseWorkViewRef(value: unknown, isKnown: (kind: string) => boolean = (kind) => kinds.has(kind)): WorkViewRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !isKnown(raw.kind)) return undefined;
  if (raw.kind === "terminal") return typeof raw.terminalId === "string" && TERMINAL_ID.test(raw.terminalId) ? { kind: "terminal", terminalId: raw.terminalId } : undefined;
  if (raw.kind === "files" || raw.kind === "diff") {
    return typeof raw.id === "string" && raw.id.trim() && raw.id.length <= 128 && !CONTROL.test(raw.id) ? { kind: raw.kind, id: raw.id } : undefined;
  }
  if (raw.kind === "browser" || raw.kind === "vscode") return { kind: raw.kind };
  return undefined;
}

/** Reads the stored record, dropping garbage, unknown kinds and duplicate tabs instead of failing the whole store. */
export function parseWorkPaneStore(value: unknown, isKnown?: (kind: string) => boolean): Record<string, SessionWorkPane> {
  const store: Record<string, SessionWorkPane> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return store;
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return store;
  for (const [sessionId, raw] of Object.entries(sessions as Record<string, unknown>)) {
    if (!validSessionId(sessionId) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const views: WorkViewRef[] = [];
    const keys = new Set<string>();
    for (const candidate of Array.isArray(entry.views) ? entry.views.slice(0, 64) : []) {
      const ref = parseWorkViewRef(candidate, isKnown);
      if (!ref || keys.has(workViewKey(ref))) continue;
      keys.add(workViewKey(ref));
      views.push(ref);
    }
    const pane: SessionWorkPane = {
      open: entry.open === true,
      width: clampWorkPaneWidth(typeof entry.width === "number" ? entry.width : Number.NaN),
      views,
    };
    // Additive field: records written before it load as not maximized; a collapsed pane is never maximized.
    if (entry.maximized === true && pane.open) pane.maximized = true;
    const active = typeof entry.active === "string" && keys.has(entry.active) ? entry.active : views[0] && workViewKey(views[0]);
    if (active) pane.active = active;
    store[sessionId] = pane;
  }
  return store;
}

/** The stored shape; conversations still at the default (closed, no views, default width) are left out. */
export function serializeWorkPaneStore(store: WorkPaneStore): { version: 1; sessions: Record<string, SessionWorkPane> } {
  const sessions: Record<string, SessionWorkPane> = {};
  for (const [id, pane] of Object.entries(store)) {
    if (!pane.open && !pane.views.length && pane.width === WORK_PANE_DEFAULT_WIDTH) continue;
    sessions[id] = pane;
  }
  return { version: 1, sessions };
}

/* ── migration from the chat multiplexer ──────────────────────────────────── */

/** Before the Work pane, terminals and the browser view were multiplexer panes (`terminalId` / `browser: true` in
 * the saved split layout). Moves each one into its conversation's Work pane, in layout order, and removes it from the
 * layout; chat panes, splits and tabs are untouched. A conversation whose pane was the visible one gets that view
 * active and its Work pane expanded. */
export function migrateLayoutWorkViews(layout: SessionLayout, store: WorkPaneStore): { layout: SessionLayout; store: WorkPaneStore; moved: number } {
  const work = sessionPanes(layout).filter((pane) => !isChatPane(pane));
  if (!work.length) return { layout, store, moved: 0 };
  const shown = new Set(layout.columns.flatMap((column) => column.panes.map(({ id }) => id)));
  const activeOwner = locateSessionPane(layout, layout.activePaneId)?.pane;
  let next = store;
  for (const pane of work) {
    const ref: WorkViewRef = pane.terminalId ? { kind: "terminal", terminalId: pane.terminalId } : { kind: "browser" };
    const current = sessionWorkPane(next, pane.sessionId);
    // A pane shown in its spot becomes the conversation's active view; a hidden tab joins behind it.
    next = openWorkView(next, pane.sessionId, ref, shown.has(pane.id) || current.open);
    if (!shown.has(pane.id) && current.active) next = activateWorkView(next, pane.sessionId, current.active, false);
  }
  // The focused pane was one of them: it is its conversation's active view.
  if (activeOwner && !isChatPane(activeOwner)) {
    next = activateWorkView(next, activeOwner.sessionId, workViewKey(activeOwner.terminalId ? { kind: "terminal", terminalId: activeOwner.terminalId } : { kind: "browser" }));
  }
  let migrated = layout;
  for (const pane of work) {
    const after = closeSessionPane(migrated, pane.id);
    // The last pane cannot close: it becomes its conversation's chat instead.
    migrated = after === migrated ? replacePaneSession(migrated, pane.id, pane.sessionId) : after;
  }
  // The focused pane was a terminal/browser: focus moves to a chat of the same conversation when one is open.
  if (activeOwner && !isChatPane(activeOwner)) {
    const chat = sessionPanes(migrated).find((pane) => isChatPane(pane) && pane.sessionId === activeOwner.sessionId);
    const spot = chat && migrated.columns.flatMap((column) => column.panes).find((visible) => spotTabs(visible).some(({ id }) => id === chat.id));
    if (chat && spot?.id === chat.id) migrated = { ...migrated, activePaneId: chat.id };
  }
  return { layout: migrated, store: next, moved: work.length };
}
