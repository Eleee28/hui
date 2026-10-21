/**
 * Pixel geometry for split session panes: track sizes with minimums, each pane's rectangle and the dividers
 * between them, with the ratio range each divider may be dragged across. Panes are positioned rather than
 * re-parented, so moving one never restarts its stream or terminal.
 */
import type { PaneRect, SessionLayout } from "./multiplexer.ts";

export const PANE_DIVIDER_SIZE = 6;
/** The narrowest chat column, and the shortest stacked pane. */
export const PANE_COLUMN_MIN_WIDTH = 320;
export const PANE_ROW_MIN_HEIGHT = 200;
/** `minRatio`/`maxRatio`: how far the divider may move so that neither side drops below its minimum; `ratio` is the
 * current split within that range. */
export type PaneDivider = PaneRect & { id: string; columnId?: string; index: number; ratio: number; extent: number; minRatio: number; maxRatio: number };

/** The narrowest each of `columns` chat columns may be in `width`: `preferred` (420px beside an open Work pane) when
 * every column can have it, otherwise an equal share of the room, never below the usual 320px (and never wider than
 * `width` itself). The columns then share the room by their weights above that minimum. */
export function paneColumnMinimum(width: number, columns: number, preferred = PANE_COLUMN_MIN_WIDTH): number {
  const base = Math.min(PANE_COLUMN_MIN_WIDTH, width);
  if (preferred <= base || columns < 1) return base;
  const share = Math.floor((width - PANE_DIVIDER_SIZE * (columns - 1)) / columns);
  return Math.max(base, Math.min(preferred, share));
}

/** A divider between two tracks spanning `extent` whose weights split `weightRatio`: the range it may be dragged across,
 * keeping each track at `minimum` (within the divider's usual 15–85% limits; a pair too narrow for both minimums stays
 * at the middle), and its ratio within that range, since a track held at its minimum is wider than its weight says. */
function dividerSplit(weightRatio: number, extent: number, minimum: number) {
  const edge = extent > 0 ? minimum / extent : 0.5;
  const minRatio = Math.min(0.5, Math.max(0.15, edge));
  const maxRatio = Math.max(0.5, Math.min(0.85, 1 - edge));
  return { ratio: Math.min(maxRatio, Math.max(minRatio, weightRatio)), extent, minRatio, maxRatio };
}

/** Flex-like allocation, honoring the original 320px columns / 200px rows.
 * Overflow scrolls when the viewport cannot contain the minimum sizes. */
export function paneTrackSizes(size: number, weights: readonly number[], minimum: number): number[] {
  let remaining = Math.max(minimum * weights.length, size - PANE_DIVIDER_SIZE * (weights.length - 1));
  const result = weights.map(() => 0);
  const pending = new Set(weights.map((_, index) => index));
  while (pending.size) {
    const total = [...pending].reduce((sum, i) => sum + weights[i]!, 0);
    const constrained = [...pending].filter((i) => remaining * weights[i]! / total < minimum);
    if (!constrained.length) {
      for (const i of pending) result[i] = remaining * weights[i]! / total;
      break;
    }
    for (const i of constrained) { result[i] = minimum; remaining -= minimum; pending.delete(i); }
  }
  return result;
}

/** Keep pane DOM in a stable, flat host. Only these rectangles change when a
 * pane moves, so no custom-element disconnect, stream restart or PTY teardown
 * is necessary, including between columns and with duplicate sessions. */
export function sessionPaneGeometry(layout: SessionLayout, width: number, height: number, columnMinimum = PANE_COLUMN_MIN_WIDTH) {
  const panes = new Map<string, PaneRect>();
  const dividers: PaneDivider[] = [];
  const minimumWidth = paneColumnMinimum(width, layout.columns.length, columnMinimum);
  const widths = paneTrackSizes(width, layout.columnWeights, minimumWidth);
  let left = 0;
  let canvasHeight = height;
  for (const [columnIndex, column] of layout.columns.entries()) {
    const columnWidth = widths[columnIndex]!;
    const heights = paneTrackSizes(height, column.paneWeights, PANE_ROW_MIN_HEIGHT);
    let top = 0;
    for (const [paneIndex, pane] of column.panes.entries()) {
      const paneHeight = heights[paneIndex]!;
      const rect = { left, top, width: columnWidth, height: paneHeight };
      panes.set(pane.id, rect);
      // Hidden tabs keep their spot's rectangle so they stay laid out, ready to show.
      for (const tab of pane.tabs ?? []) panes.set(tab.id, rect);
      top += paneHeight;
      if (paneIndex < column.panes.length - 1) {
        dividers.push({ id: `${column.id}:${paneIndex}`, columnId: column.id, index: paneIndex,
          ...dividerSplit(column.paneWeights[paneIndex]! / (column.paneWeights[paneIndex]! + column.paneWeights[paneIndex + 1]!),
            paneHeight + heights[paneIndex + 1]!, PANE_ROW_MIN_HEIGHT),
          left, top, width: columnWidth, height: PANE_DIVIDER_SIZE });
        top += PANE_DIVIDER_SIZE;
      }
    }
    canvasHeight = Math.max(canvasHeight, top);
    left += columnWidth;
    if (columnIndex < layout.columns.length - 1) {
      dividers.push({ id: `columns:${columnIndex}`, index: columnIndex,
        ...dividerSplit(layout.columnWeights[columnIndex]! / (layout.columnWeights[columnIndex]! + layout.columnWeights[columnIndex + 1]!),
          columnWidth + widths[columnIndex + 1]!, minimumWidth),
        left, top: 0, width: PANE_DIVIDER_SIZE, height });
      left += PANE_DIVIDER_SIZE;
    }
  }
  for (const divider of dividers) if (!divider.columnId) divider.height = canvasHeight;
  return { panes, dividers, width: left, height: canvasHeight };
}
