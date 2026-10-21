/**
 * The Diff kind of Work view: what the Work pane needs to launch, name and render a Diff view of the conversation's
 * Git changes. Like Files, each launch is a new view (a new id) with its own comparison and selection; closing the
 * tab forgets them. The `<hui-diff-view>` element loads the first time a Diff view renders, so neither it nor its
 * highlighter weighs on the main bundle.
 */
import { html } from "lit";
import { clearDiffViewState } from "../../lib/diff/view-state.ts";
import type { WorkViewKind } from "../../lib/work-pane.ts";
import { WORK_SHORTCUTS } from "../../lib/work-shortcuts.ts";

export type DiffWorkViewRef = { kind: "diff"; id: string };

/** Lucide file-diff, sized for the launcher. */
export const diffIcon = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M9 10h6"/><path d="M12 13V7"/><path d="M9 17h6"/></svg>`;

let viewSequence = 0;
/** A new, page-unique view id. */
export function newDiffViewId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `diff-${random}` : `diff-${Date.now().toString(36)}-${(++viewSequence).toString(36)}`;
}

let loading: Promise<unknown> | undefined;
function loadDiffView(): void {
  if (typeof customElements === "undefined" || customElements.get("hui-diff-view")) return;
  loading ??= import("../../components/diff-view.ts").catch((error: unknown) => { loading = undefined; throw error; });
}

export const DIFF_WORK_VIEW_SHORTCUT = WORK_SHORTCUTS.diff;

export const diffWorkViewKind: WorkViewKind<DiffWorkViewRef> = {
  kind: "diff",
  label: "Diff",
  icon: diffIcon,
  shortcut: DIFF_WORK_VIEW_SHORTCUT,
  create: () => ({ kind: "diff", id: newDiffViewId() }),
  key: (ref) => `diff:${ref.id}`,
  title: () => "Diff",
  render(ref, ctx) {
    loadDiffView();
    return html`<hui-diff-view .sessionId=${ctx.sessionId} .viewId=${ref.id} .visible=${ctx.visible} .narrow=${ctx.narrow}></hui-diff-view>`;
  },
  closed: (ref) => clearDiffViewState(ref.id),
};
