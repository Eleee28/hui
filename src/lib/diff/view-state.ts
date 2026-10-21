/**
 * What one Diff view remembers in this browser: its comparison, the previous branch the operator picked instead of
 * the detected one, whether uncommitted changes join a branch comparison, unified or side-by-side, and the selected
 * file. Keyed by the view's id like the Files view's state; closing the tab forgets it. Also the rule for the
 * comparison a view opens on.
 */
import type { DiffComparison, DiffInfo } from "../../api/schema/diff.ts";

export const DIFF_COMPARISONS: readonly DiffComparison[] = ["uncommitted", "last-commit", "parent", "default"];

export function isDiffComparison(value: unknown): value is DiffComparison {
  return typeof value === "string" && (DIFF_COMPARISONS as readonly string[]).includes(value);
}

export const DIFF_COLLAPSE_LINES = 1_500;

export type DiffLayout = "unified" | "split";

export type DiffViewState = {
  /** Absent until the operator chooses one: the view then follows `initialComparison`. */
  comparison: DiffComparison | undefined;
  /** A full ref picked as the previous branch. */
  parent: string | undefined;
  uncommitted: boolean;
  layout: DiffLayout;
  selected: string | undefined;
};

type ViewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PREFIX = "hui.diff-view.v1:";
const memory = new Map<string, DiffViewState>();

export const DEFAULT_DIFF_VIEW_STATE: DiffViewState = { comparison: undefined, parent: undefined, uncommitted: true, layout: "unified", selected: undefined };

function storage(): ViewStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

const text = (value: unknown, max: number) => typeof value === "string" && value && value.length <= max ? value : undefined;

/** Accepts only well-formed stored state; anything else is the default. */
export function normalizeDiffViewState(value: unknown): DiffViewState {
  if (!value || typeof value !== "object") return { ...DEFAULT_DIFF_VIEW_STATE };
  const record = value as Record<string, unknown>;
  return {
    comparison: isDiffComparison(record["comparison"]) ? record["comparison"] : undefined,
    parent: text(record["parent"], 1024)?.match(/^refs\/(heads|remotes)\//u) ? record["parent"] as string : undefined,
    uncommitted: record["uncommitted"] !== false,
    layout: record["layout"] === "split" ? "split" : "unified",
    selected: text(record["selected"], 4096),
  };
}

export function readDiffViewState(viewId: string, store: ViewStorage | undefined = storage()): DiffViewState {
  const cached = memory.get(viewId);
  if (cached) return cached;
  let state = { ...DEFAULT_DIFF_VIEW_STATE };
  try {
    const raw = store?.getItem(PREFIX + viewId);
    if (raw) state = normalizeDiffViewState(JSON.parse(raw));
  } catch {
    // Unreadable state starts over.
  }
  memory.set(viewId, state);
  return state;
}

export function writeDiffViewState(viewId: string, patch: Partial<DiffViewState>, store: ViewStorage | undefined = storage()): DiffViewState {
  const next = normalizeDiffViewState({ ...readDiffViewState(viewId, store), ...patch });
  memory.set(viewId, next);
  try {
    store?.setItem(PREFIX + viewId, JSON.stringify(next));
  } catch {
    // The view keeps working from memory.
  }
  return next;
}

/** Forgets a closed view's state. */
export function clearDiffViewState(viewId: string, store: ViewStorage | undefined = storage()): void {
  memory.delete(viewId);
  try { store?.removeItem(PREFIX + viewId); } catch { /* nothing stored */ }
}

/** The comparison to show: the remembered one while it still applies; else uncommitted changes when there are any,
 * then the previous branch, the default branch, the last commit. */
export function initialComparison(info: Extract<DiffInfo, { available: true }>, remembered: DiffComparison | undefined): DiffComparison {
  if (remembered && info.comparisons.includes(remembered)) return remembered;
  if (info.uncommitted > 0) return "uncommitted";
  for (const comparison of ["parent", "default", "last-commit"] as const) if (info.comparisons.includes(comparison)) return comparison;
  return "uncommitted";
}

/** The previous branch to compare with: the remembered pick while it is still offered, else the detected one. */
export function chosenParent(info: Extract<DiffInfo, { available: true }>, remembered: string | undefined): string | undefined {
  if (remembered && (info.branches.some((branch) => branch.ref === remembered) || info.parent?.ref === remembered)) return remembered;
  return info.parent?.ref;
}
