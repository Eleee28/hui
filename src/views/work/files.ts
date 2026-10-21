/**
 * The Files kind of Work view: what the Work pane needs to launch, name and render a Files view. Each launch is a new
 * view (a new id) with its own selection; the tab shows the selected file's name. The `<hui-files-view>` element
 * loads the first time a Files view renders, so neither it nor its editor weighs on the main bundle. Closing the tab
 * forgets the view's remembered selection; a file's unsaved text is kept by its File draft (`lib/files/draft.ts`).
 * A file reference clicked in the chat reveals its file in the conversation's active Files view, else its first one
 * (`filesViewToReveal`), else a new one.
 */
import { html } from "lit";
import { clearFilesViewState, filesViewTitle } from "../../lib/files/view-state.ts";
import { workViewKey, type SessionWorkPane, type WorkViewKind } from "../../lib/work-pane.ts";
import { WORK_SHORTCUTS } from "../../lib/work-shortcuts.ts";

export type FilesWorkViewRef = { kind: "files"; id: string };

/** Lucide folder-tree, sized for the launcher. */
const filesIcon = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/></svg>`;

let viewSequence = 0;
/** A new, page-unique view id. */
export function newFilesViewId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `files-${random}` : `files-${Date.now().toString(36)}-${(++viewSequence).toString(36)}`;
}

let loading: Promise<unknown> | undefined;
function loadFilesView(): void {
  if (typeof customElements === "undefined" || customElements.get("hui-files-view")) return;
  loading ??= import("../../components/files-view.ts").catch((error: unknown) => { loading = undefined; throw error; });
}

export const FILES_WORK_VIEW_SHORTCUT = WORK_SHORTCUTS.files;

/** The Files view a file reference opens in: the active tab when it is a Files view, else the first Files tab;
 * `undefined` means a new one. */
export function filesViewToReveal(pane: Pick<SessionWorkPane, "views" | "active">): FilesWorkViewRef | undefined {
  const files = pane.views.filter((view): view is FilesWorkViewRef => view.kind === "files");
  return files.find((view) => workViewKey(view) === pane.active) ?? files[0];
}

export const filesWorkViewKind: WorkViewKind<FilesWorkViewRef> = {
  kind: "files",
  label: "Files",
  icon: filesIcon,
  shortcut: FILES_WORK_VIEW_SHORTCUT,
  create: () => ({ kind: "files", id: newFilesViewId() }),
  key: (ref) => `files:${ref.id}`,
  title: (ref) => filesViewTitle(ref.id),
  render(ref, ctx) {
    loadFilesView();
    return html`<hui-files-view .sessionId=${ctx.sessionId} .viewId=${ref.id} .visible=${ctx.visible} .narrow=${ctx.narrow} .onTitleChange=${ctx.invalidate}></hui-files-view>`;
  },
  closed: (ref) => clearFilesViewState(ref.id),
};
