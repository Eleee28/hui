/** Port of OpenClaw 2026.9.5's chat split layout (MIT, ec9c1a13).
 * Columns contain vertical stacks, not a recursive binary docking tree. */
export type SplitDirection = "left" | "right" | "up" | "down";
/** A pane shows its session's chat. Layouts saved before the Work pane can also
 * hold a shared terminal (`terminalId`) or the managed-browser view
 * (`browser`); loading moves those into the Work pane (`migrateLayoutWorkViews`
 * in `work-pane.ts`), so the format stays readable. Each entry of a column is
 * one spot and holds its visible pane; the spot's hidden `tabs` ride along on
 * it, with `tabIndex` giving the visible pane's own tab position. */
export type SessionPane = { id: string; sessionId: string; terminalId?: string; browser?: true; tabs?: SessionPane[]; tabIndex?: number };
export type SessionColumn = { id: string; panes: SessionPane[]; paneWeights: number[] };
export type SessionLayout = { columns: SessionColumn[]; columnWeights: number[]; activePaneId: string };
export type DropZone = { kind: "center" } | { kind: "tab" } | { kind: "edge"; edge: SplitDirection };
export type PaneRect = { left: number; top: number; width: number; height: number };

export const SESSION_SPLIT_MEDIA = "(max-width: 1099px)";
export const SESSION_LAYOUT_KEY = "hui.chat-split-layout.v1";

export function singleSessionLayout(sessionId: string): SessionLayout {
  return { columns: [{ id: "c1", panes: [{ id: "p1", sessionId }], paneWeights: [1] }], columnWeights: [1], activePaneId: "p1" };
}

/** Every pane, hidden tabs included. */
export function sessionPanes(layout: SessionLayout): SessionPane[] {
  return layout.columns.flatMap((column) => column.panes.flatMap(spotTabs));
}

/** The panes currently shown, one per spot. */
export function visibleSessionPanes(layout: SessionLayout): SessionPane[] {
  return layout.columns.flatMap((column) => column.panes);
}

/** A spot's panes in tab order, without the tab bookkeeping. */
export function spotTabs(spot: SessionPane): SessionPane[] {
  const { tabs = [], tabIndex = 0, ...visible } = spot;
  return [...tabs.slice(0, tabIndex), visible, ...tabs.slice(tabIndex)];
}

function spotShowing(tabs: SessionPane[], visibleId: string): SessionPane {
  const index = tabs.findIndex(({ id }) => id === visibleId);
  const hidden = tabs.filter((_, i) => i !== index);
  return hidden.length ? { ...tabs[index]!, tabs: hidden, tabIndex: index } : { ...tabs[index]! };
}

/** Finds a pane, visible or a hidden tab, and the spot that holds it. */
function locateTab(layout: SessionLayout, id: string) {
  for (const [columnIndex, column] of layout.columns.entries()) {
    for (const [paneIndex, spot] of column.panes.entries()) {
      const tabs = spotTabs(spot);
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index >= 0) return { column, columnIndex, paneIndex, spot, tabs, index };
    }
  }
  return undefined;
}

export function isChatPane(pane: SessionPane): boolean {
  return !pane.terminalId && !pane.browser;
}

export function locateSessionPane(layout: SessionLayout, id: string) {
  for (const [columnIndex, column] of layout.columns.entries()) {
    const paneIndex = column.panes.findIndex((pane) => pane.id === id);
    const pane = column.panes[paneIndex];
    if (pane) return { column, columnIndex, pane, paneIndex };
  }
  return undefined;
}

export function activeSessionPane(layout: SessionLayout): SessionPane {
  return locateSessionPane(layout, layout.activePaneId)?.pane ?? layout.columns[0]!.panes[0]!;
}

function copyLayout(layout: SessionLayout): SessionLayout {
  return { ...layout, columnWeights: [...layout.columnWeights], columns: layout.columns.map((column) => ({ ...column, paneWeights: [...column.paneWeights], panes: column.panes.map((pane) => pane.tabs ? { ...pane, tabs: pane.tabs.map((tab) => ({ ...tab })) } : { ...pane }) })) };
}

function normalizeWeights(weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function nextId(ids: string[], prefix: string): string {
  return `${prefix}${Math.max(0, ...ids.map((id) => Number(id.slice(1)) || 0)) + 1}`;
}

export function splitSessionPane(layout: SessionLayout, paneId: string, sessionId: string, direction: SplitDirection): SessionLayout {
  // A hidden tab splits beside its spot (e.g. a terminal requested before a tab switch).
  const source = locateTab(layout, paneId);
  if (!source) return layout;
  const next = copyLayout(layout);
  const pane: SessionPane = { id: nextId(sessionPanes(layout).map(({ id }) => id), "p"), sessionId };
  if (direction === "left" || direction === "right") {
    const index = source.columnIndex + Number(direction === "right");
    const weight = next.columnWeights[source.columnIndex]!;
    next.columns.splice(index, 0, { id: nextId(layout.columns.map(({ id }) => id), "c"), panes: [pane], paneWeights: [1] });
    next.columnWeights.splice(source.columnIndex, 1, weight / 2, weight / 2);
  } else {
    const column = next.columns[source.columnIndex]!;
    const index = source.paneIndex + Number(direction === "down");
    const weight = column.paneWeights[source.paneIndex]!;
    column.panes.splice(index, 0, pane);
    column.paneWeights.splice(source.paneIndex, 1, weight / 2, weight / 2);
  }
  next.activePaneId = pane.id;
  return next;
}

/** Closing a view never deletes or aborts its session. Keep the surviving pane
 * identities even when a split collapses back to one pane. */
export function closeSessionPane(layout: SessionLayout, paneId: string): SessionLayout {
  const tab = locateTab(layout, paneId);
  if (tab && tab.tabs.length > 1) {
    // Closing a tab keeps its spot; the neighbouring tab takes its place.
    const next = copyLayout(layout);
    const visible = tab.spot.id === paneId ? tab.tabs[tab.index - 1]?.id ?? tab.tabs[tab.index + 1]!.id : tab.spot.id;
    next.columns[tab.columnIndex]!.panes[tab.paneIndex] = spotShowing(tab.tabs.filter(({ id }) => id !== paneId), visible);
    if (layout.activePaneId === paneId) next.activePaneId = visible;
    return next;
  }
  const source = locateSessionPane(layout, paneId);
  if (!source || sessionPanes(layout).length < 2) return layout;
  const next = copyLayout(layout);
  if (next.activePaneId === paneId) {
    next.activePaneId = source.column.panes[source.paneIndex - 1]?.id
      ?? layout.columns[source.columnIndex - 1]?.panes.at(-1)?.id
      ?? visibleSessionPanes(layout).find(({ id }) => id !== paneId)!.id;
  }
  const column = next.columns[source.columnIndex]!;
  column.panes.splice(source.paneIndex, 1);
  column.paneWeights.splice(source.paneIndex, 1);
  if (!column.panes.length) {
    next.columns.splice(source.columnIndex, 1);
    next.columnWeights.splice(source.columnIndex, 1);
  } else column.paneWeights = normalizeWeights(column.paneWeights);
  next.columnWeights = normalizeWeights(next.columnWeights);
  return next;
}

/** Focusing a hidden tab also shows it in its spot. */
export function focusSessionPane(layout: SessionLayout, paneId: string): SessionLayout {
  const tab = paneId === layout.activePaneId ? undefined : locateTab(layout, paneId);
  if (!tab) return layout;
  if (tab.spot.id === paneId) return { ...layout, activePaneId: paneId };
  const next = copyLayout(layout);
  next.columns[tab.columnIndex]!.panes[tab.paneIndex] = spotShowing(tab.tabs, paneId);
  next.activePaneId = paneId;
  return next;
}

/** Opens `sessionId`'s chat as the shown tab of `paneId`'s spot, reusing a tab
 * that already shows it. */
export function addSessionTab(layout: SessionLayout, paneId: string, sessionId: string): SessionLayout {
  const spot = locateTab(layout, paneId);
  if (!spot) return layout;
  const existing = spot.tabs.find((tab) => isChatPane(tab) && tab.sessionId === sessionId);
  if (existing) return focusSessionPane(layout, existing.id);
  const next = copyLayout(layout);
  const pane: SessionPane = { id: nextId(sessionPanes(layout).map(({ id }) => id), "p"), sessionId };
  next.columns[spot.columnIndex]!.panes[spot.paneIndex] = spotShowing([...spot.tabs, pane], pane.id);
  next.activePaneId = pane.id;
  return next;
}

/** Move the view, not its session. Center swaps both views; edges relocate the
 * source without duplicating it or losing terminal ownership; `tab` adds it to
 * the target's spot. Only the moved pane travels: other tabs stay put. */
export function moveSessionPane(layout: SessionLayout, sourceId: string, targetId: string, zone: DropZone): SessionLayout {
  const source = locateTab(layout, sourceId);
  const target = locateTab(layout, targetId);
  if (!source || !target) return layout;
  const pane = source.tabs[source.index]!;
  const sameSpot = source.columnIndex === target.columnIndex && source.paneIndex === target.paneIndex;
  if (zone.kind !== "edge") {
    if (sameSpot) return layout;
    const next = zone.kind === "tab" ? closeSessionPane(layout, sourceId) : copyLayout(layout);
    const place = (at: typeof source, replacement: SessionPane | undefined, visible: string) => {
      const tabs = replacement ? at.tabs.map((tab, i) => i === at.index ? replacement : tab) : [...at.tabs, pane];
      next.columns[at.columnIndex]!.panes[at.paneIndex] = spotShowing(tabs, visible);
    };
    if (zone.kind === "tab") place(locateTab(next, targetId)!, undefined, sourceId);
    else {
      const other = target.tabs[target.index]!;
      place(target, pane, sourceId);
      place(source, other, source.spot.id === sourceId ? other.id : source.spot.id);
    }
    next.activePaneId = sourceId;
    return next;
  }
  if (sameSpot) {
    // Within one spot, only splitting a tab out means anything.
    if (source.tabs.length < 2) return layout;
    targetId = source.tabs.find(({ id }) => id !== sourceId)!.id;
  }
  const next = closeSessionPane(layout, sourceId);
  const destination = locateTab(next, targetId)!;
  if (zone.edge === "left" || zone.edge === "right") {
    const index = destination.columnIndex + Number(zone.edge === "right");
    const weight = next.columnWeights[destination.columnIndex]!;
    next.columns.splice(index, 0, {
      id: nextId(layout.columns.map(({ id }) => id), "c"), panes: [pane], paneWeights: [1],
    });
    next.columnWeights.splice(destination.columnIndex, 1, weight / 2, weight / 2);
  } else {
    const column = destination.column;
    const index = destination.paneIndex + Number(zone.edge === "down");
    const weight = column.paneWeights[destination.paneIndex]!;
    column.panes.splice(index, 0, pane);
    column.paneWeights.splice(destination.paneIndex, 1, weight / 2, weight / 2);
  }
  next.activePaneId = sourceId;
  return next;
}

/** Arrow-key equivalent of moving a header to a neighboring pane's edge. */
export function sessionPaneMoveTarget(layout: SessionLayout, paneId: string, direction: SplitDirection): string | undefined {
  const source = locateSessionPane(layout, paneId);
  if (!source) return;
  const { column, columnIndex, paneIndex } = source;
  if (direction === "left") return layout.columns[columnIndex - 1]?.panes[0]?.id ?? column.panes[paneIndex - 1]?.id ?? column.panes[paneIndex + 1]?.id;
  if (direction === "right") return layout.columns[columnIndex + 1]?.panes[0]?.id ?? column.panes[paneIndex + 1]?.id ?? column.panes[paneIndex - 1]?.id;
  if (direction === "up") return column.panes[paneIndex - 1]?.id ?? layout.columns[columnIndex - 1]?.panes.at(-1)?.id;
  return column.panes[paneIndex + 1]?.id ?? layout.columns[columnIndex + 1]?.panes[0]?.id;
}

export function replacePaneSession(layout: SessionLayout, paneId: string, sessionId: string): SessionLayout {
  const next = copyLayout(layout);
  const pane = locateSessionPane(next, paneId)?.pane;
  if (pane) { pane.sessionId = sessionId; delete pane.terminalId; delete pane.browser; }
  return next;
}

export function resizeSessionWeights(weights: readonly number[], index: number, ratio: number): number[] {
  const next = [...weights];
  if (index < 0 || index + 1 >= next.length || !Number.isFinite(ratio)) return next;
  const total = next[index]! + next[index + 1]!;
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  next[index] = total * clamped;
  next[index + 1] = total * (1 - clamped);
  return next;
}

export function resizeSessionLayout(layout: SessionLayout, columnId: string | undefined, index: number, ratio: number): SessionLayout {
  const next = copyLayout(layout);
  if (columnId) {
    const column = next.columns.find(({ id }) => id === columnId);
    if (column) column.paneWeights = resizeSessionWeights(column.paneWeights, index, ratio);
  } else next.columnWeights = resizeSessionWeights(next.columnWeights, index, ratio);
  return next;
}

/** Upstream uses a 30% edge band and nearest-edge corner resolution. */
export function sessionDropZone(rect: PaneRect, clientX: number, clientY: number): DropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const horizontal = x <= 0.3 ? { edge: "left" as const, distance: x } : 1 - x <= 0.3 ? { edge: "right" as const, distance: 1 - x } : undefined;
  const vertical = y <= 0.3 ? { edge: "up" as const, distance: y } : 1 - y <= 0.3 ? { edge: "down" as const, distance: 1 - y } : undefined;
  const closest = horizontal && vertical ? horizontal.distance <= vertical.distance ? horizontal : vertical : horizontal ?? vertical;
  return closest ? { kind: "edge", edge: closest.edge } : { kind: "center" };
}

export function sessionDropRect(rect: PaneRect, zone: DropZone): PaneRect {
  // DOMRect dimensions are prototype getters, not enumerable own properties.
  const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  if (zone.kind !== "edge") return bounds;
  if (zone.edge === "left") return { ...bounds, width: rect.width / 2 };
  if (zone.edge === "right") return { ...bounds, left: rect.left + rect.width / 2, width: rect.width / 2 };
  if (zone.edge === "up") return { ...bounds, height: rect.height / 2 };
  return { ...bounds, top: rect.top + rect.height / 2, height: rect.height / 2 };
}

/** Browser-local state only; reject malformed records without touching registry
 * or PI data. Session existence is checked once the registry finishes loading. */
export function parseSessionLayout(value: unknown): SessionLayout | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SessionLayout>;
  if (!Array.isArray(raw.columns) || !raw.columns.length || !Array.isArray(raw.columnWeights)) return undefined;
  const ids = new Set<string>();
  const validId = (value: unknown, pattern: RegExp) => {
    if (typeof value !== "string" || !pattern.test(value) || ids.has(value)) return false;
    ids.add(value);
    return true;
  };
  const validWeights = (value: unknown, count: number): value is number[] => Array.isArray(value) && value.length === count && value.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  if (!validWeights(raw.columnWeights, raw.columns.length)) return undefined;
  const validPane = (pane: SessionPane | undefined) => {
    if (!pane || !validId(pane.id, /^p\d+$/) || typeof pane.sessionId !== "string" || !pane.sessionId.trim() || pane.sessionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(pane.sessionId)) return false;
    if (pane.terminalId !== undefined && (typeof pane.terminalId !== "string" || !/^[0-9a-f-]{36}$/u.test(pane.terminalId))) return false;
    return pane.browser === undefined || (pane.browser === true && pane.terminalId === undefined);
  };
  for (const column of raw.columns) {
    if (!column || !validId(column.id, /^c\d+$/) || !Array.isArray(column.panes) || !column.panes.length || !validWeights(column.paneWeights, column.panes.length)) return undefined;
    for (const pane of column.panes) {
      if (!validPane(pane)) return undefined;
      if (pane.tabs === undefined && pane.tabIndex === undefined) continue;
      if (!Array.isArray(pane.tabs) || !pane.tabs.length || !Number.isInteger(pane.tabIndex) || pane.tabIndex! < 0 || pane.tabIndex! > pane.tabs.length) return undefined;
      if (!pane.tabs.every((tab) => validPane(tab) && tab.tabs === undefined && tab.tabIndex === undefined)) return undefined;
    }
  }
  if (typeof raw.activePaneId !== "string" || !raw.columns.some((column) => column.panes.some(({ id }) => id === raw.activePaneId))) return undefined;
  return copyLayout(raw as SessionLayout);
}
