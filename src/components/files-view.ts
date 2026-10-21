/**
 * `<hui-files-view>`: a Files view, AgentsInTheCloud's Work view for one conversation's working directory. A
 * collapsible navigator (lazy file tree, filter, upload, new file or folder, delete behind a confirmation) beside the
 * selected file: text in CodeMirror with autosave, Markdown as Source or Rendered, images and PDFs as previews and
 * anything else as metadata with a download.
 *
 * It owns presentation and per-view state (`lib/files/view-state.ts`); the File draft (`lib/files/draft.ts`) owns
 * unsaved text and saves, shared with other views of the same file; the gateway owns the disk. The editor itself loads
 * on demand (`lib/files/editor.ts`). It refreshes when the conversation's agent turn ends and when it becomes visible
 * again. A reveal request (a file reference clicked in the chat, `lib/files/view-state.ts`) opens a file at a line or a
 * folder in the tree.
 *
 * Behaviour follows AgentsInTheCloud's Files view (packages/files, MIT, see THIRD_PARTY_NOTICES.md); the markup is HUI's.
 * No decorators: the Work pane's view registry, which imports this lazily, also loads in Node tests.
 */
import { html, nothing, svg, type PropertyValues, type SVGTemplateResult, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { HuiElement } from "../lit/hui-element.ts";
import { icons } from "../lib/icons.ts";
import { loadViewAssets } from "../lib/view-assets.ts";
import { closeModal, ensureModal } from "../lib/modal-dialog.ts";
import { renderMarkdown } from "../lib/markdown/markdown.ts";
import { writeClipboardText } from "../lib/clipboard.ts";
import { isMarkdownPath } from "../api/files.ts";
import type { FileEntry, FileRead, FilesInfo, FilesSearch } from "../api/schema/files.ts";
import { editFileText, editorText, type FileTextChange } from "../lib/editable-text.ts";
import { draftKey, draftStatus, existingDraft, forgetDraft, hasUnsavedDrafts, openDraft, releaseDraft, type DraftFile, type FileDraft } from "../lib/files/draft.ts";
import {
  createEntry,
  deleteEntry,
  fetchPreviewBlob,
  fetchRawFile,
  FilesRequestError,
  listDirectory,
  loadFilesInfo,
  readFile,
  saveFile,
  searchFiles,
  uploadFile,
} from "../api/files.ts";
import { onFilesViewReveal, readFilesViewState, takeFilesViewReveal, writeFilesViewState, type FilesViewReveal, type MarkdownDisplayMode } from "../lib/files/view-state.ts";
import { onTurnEnd } from "../lib/session/turn-end.ts";
import type { FileEditorHandle } from "../lib/files/editor.ts";

loadViewAssets(() => import("../styles/files-view.css"));

const SAVE_DELAY_MS = 600;
const FILTER_DELAY_MS = 150;

/* Lucide icons this view needs that OpenClaw's set lacks (src/lib/icons.ts holds only verbatim OpenClaw icons). */
const svg16 = (body: SVGTemplateResult) => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const filePlusIcon = svg16(svg`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>`);
const folderPlusIcon = svg16(svg`<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>`);
const uploadIcon = svg16(svg`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>`);
const fileIcon = svg16(svg`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`);
const linkIcon = svg16(svg`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`);
const chevronRightIcon = svg16(svg`<path d="m9 18 6-6-6-6"/>`);
const chevronDownIcon = svg16(svg`<path d="m6 9 6 6 6-6"/>`);

type DirectoryState = { entries?: FileEntry[]; loading: boolean; error?: string; truncated?: boolean };

type Dialog =
  | { kind: "create"; type: "file" | "directory"; folder: string; name: string; busy: boolean; error: string }
  | { kind: "delete"; entry: FileEntry; busy: boolean; error: string }
  | { kind: "overwrite"; folder: string; files: File[]; busy: boolean; error: string };

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let unloadGuard = false;
/** One page-wide guard: leaving the page with text that has not reached the disk asks first. */
function guardUnload(): void {
  if (unloadGuard || typeof window === "undefined") return;
  unloadGuard = true;
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsavedDrafts()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

let loadEditor: Promise<typeof import("../lib/files/editor.ts")> | undefined;
function editorModule() {
  loadEditor ??= import("../lib/files/editor.ts").catch((error: unknown) => { loadEditor = undefined; throw error; });
  return loadEditor;
}

export class HuiFilesView extends HuiElement {
  static override properties = {
    sessionId: {},
    viewId: {},
    visible: { type: Boolean },
    narrow: { type: Boolean },
    onTitleChange: { attribute: false },
    info: { state: true },
    dirs: { state: true },
    expanded: { state: true },
    filter: { state: true },
    search: { state: true },
    searchError: { state: true },
    selected: { state: true },
    file: { state: true },
    fileError: { state: true },
    fileLoading: { state: true },
    markdownMode: { state: true },
    previewUrl: { state: true },
    navigatorOpen: { state: true },
    drawerOpen: { state: true },
    dialog: { state: true },
    uploadStatus: { state: true },
    editorReady: { state: true },
    copied: { state: true },
  };

  declare sessionId: string;
  declare viewId: string;
  declare visible: boolean;
  declare narrow: boolean;
  /** The selected file (and so the tab caption) changed: the Work pane's `ctx.invalidate`. */
  declare onTitleChange: (() => void) | undefined;
  declare info: FilesInfo | undefined;
  declare dirs: Map<string, DirectoryState>;
  declare expanded: Set<string>;
  declare filter: string;
  declare search: FilesSearch | undefined;
  declare searchError: string;
  declare selected: string | undefined;
  declare file: FileRead | undefined;
  declare fileError: string;
  declare fileLoading: boolean;
  declare markdownMode: MarkdownDisplayMode;
  declare previewUrl: string | undefined;
  declare navigatorOpen: boolean;
  declare drawerOpen: boolean;
  declare dialog: Dialog | undefined;
  declare uploadStatus: string;
  declare editorReady: boolean;
  declare copied: boolean;

  private draft: FileDraft | undefined;
  /** The registry key of `draft`, kept so releasing it never depends on later property changes. */
  private draftKeyValue = "";
  private draftListener = () => this.renderDraft();
  private editor: FileEditorHandle | undefined;
  private editorHost = createRef<HTMLDivElement>();
  private uploadInput = createRef<HTMLInputElement>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private filterTimer: ReturnType<typeof setTimeout> | undefined;
  private searchAbort: AbortController | undefined;
  private openSequence = 0;
  private generation = 0;
  private editing = false;
  /** What the editor was last told, so a draft notification reconfigures it only on a real change. */
  private editorReadOnly = false;
  private stopTurnEnd: (() => void) | undefined;
  private stopReveal: (() => void) | undefined;
  /** `reset` has not finished loading the view yet; it takes any reveal request itself when it does. */
  private resetting = false;
  /** The line to show once the file being opened has its editor. */
  private pendingLine: { line: number; column?: number | undefined } | undefined;
  private wasVisible = false;

  constructor() {
    super();
    this.sessionId = "";
    this.viewId = "";
    this.visible = true;
    this.narrow = false;
    this.onTitleChange = undefined;
    this.info = undefined;
    this.dirs = new Map();
    this.expanded = new Set();
    this.filter = "";
    this.search = undefined;
    this.searchError = "";
    this.selected = undefined;
    this.file = undefined;
    this.fileError = "";
    this.fileLoading = false;
    this.markdownMode = "rendered";
    this.previewUrl = undefined;
    this.navigatorOpen = true;
    this.drawerOpen = false;
    this.dialog = undefined;
    this.uploadStatus = "";
    this.editorReady = false;
    this.copied = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    guardUnload();
    if (this.sessionId) this.subscribeTurnEnd();
    if (this.viewId) this.subscribeReveal();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopTurnEnd?.();
    this.stopTurnEnd = undefined;
    this.stopReveal?.();
    this.stopReveal = undefined;
    this.closeFile();
    clearTimeout(this.filterTimer);
    this.searchAbort?.abort();
  }

  protected override updated(changed: PropertyValues) {
    if ((changed.has("sessionId") || changed.has("viewId")) && this.sessionId && this.viewId) void this.reset();
    else if (changed.has("visible") && this.visible && !this.wasVisible) {
      this.editor?.refresh();
      void this.refresh();
    }
    if (changed.has("visible")) this.wasVisible = this.visible;
    if (changed.has("narrow") && this.narrow && !this.selected) this.drawerOpen = true;
    const dialog = this.querySelector<HTMLDialogElement>("dialog.hui-files-dialog");
    if (dialog) ensureModal(dialog);
  }

  private subscribeTurnEnd() {
    this.stopTurnEnd?.();
    this.stopTurnEnd = onTurnEnd(this.sessionId, () => void this.refresh());
  }

  private subscribeReveal() {
    this.stopReveal?.();
    this.stopReveal = onFilesViewReveal(this.viewId, () => {
      if (this.resetting || !this.info) return;
      const target = takeFilesViewReveal(this.viewId);
      if (target && this.info.available) void this.reveal(target);
    });
  }

  /* ── loading ── */

  private async reset() {
    const generation = ++this.generation;
    this.resetting = true;
    this.closeFile();
    this.subscribeTurnEnd();
    this.subscribeReveal();
    const state = readFilesViewState(this.viewId);
    this.expanded = new Set(state.expanded);
    this.navigatorOpen = state.navigatorOpen;
    this.markdownMode = state.markdown;
    this.selected = state.selected;
    this.drawerOpen = this.narrow && !state.selected;
    this.dirs = new Map();
    this.info = undefined;
    this.filter = "";
    this.search = undefined;
    let info: FilesInfo;
    try {
      info = await loadFilesInfo(this.sessionId);
    } catch (error) {
      info = { available: false, reason: errorText(error) };
    }
    if (generation !== this.generation) return;
    this.info = info;
    if (!info.available) {
      this.resetting = false;
      takeFilesViewReveal(this.viewId);
      return;
    }
    await Promise.all(["", ...this.expanded].map((path) => this.loadDirectory(path, generation)));
    if (generation !== this.generation) return;
    this.resetting = false;
    const target = takeFilesViewReveal(this.viewId);
    if (target) void this.reveal(target);
    else if (state.selected) void this.open(state.selected, { keepDrawer: true });
  }

  /** Shows what a reveal request names: a file (at its line, when given) or a folder, opened in the tree. */
  private async reveal(target: FilesViewReveal) {
    if (this.filter) {
      this.searchAbort?.abort();
      this.filter = "";
      this.search = undefined;
      this.searchError = "";
    }
    if (target.kind === "directory") {
      if (this.narrow) this.drawerOpen = true;
      else if (!this.navigatorOpen) {
        this.navigatorOpen = true;
        this.persist();
      }
      const folders: string[] = [];
      for (let folder = target.path; folder; folder = parentOf(folder)) folders.unshift(folder);
      const missing = folders.filter((folder) => !this.expanded.has(folder));
      if (missing.length) {
        this.expanded = new Set([...this.expanded, ...missing]);
        this.persist();
      }
      await Promise.all(folders.filter((folder) => !this.dirs.get(folder)?.entries).map((folder) => this.loadDirectory(folder)));
      this.scrollRowIntoView(target.path);
      return;
    }
    const line = target.line ? { line: target.line, column: target.column } : undefined;
    if (line && isMarkdownPath(target.path) && this.markdownMode === "rendered") this.setMarkdownMode("source");
    if (this.selected === target.path && this.file && !this.fileError && !this.fileLoading) {
      // Already open (and maybe edited): keep it, just show the line.
      if (this.narrow) this.drawerOpen = false;
      this.revealInTree(target.path);
      if (line && this.editor) this.editor.revealLine(line.line, line.column);
      else this.pendingLine = line;
    } else {
      await this.open(target.path, line ? { line } : {});
    }
    this.scrollRowIntoView(target.path);
  }

  private scrollRowIntoView(path: string) {
    void this.updateComplete.then(() => {
      const row = [...this.querySelectorAll<HTMLElement>("button.hui-files-row__main")].find((candidate) => candidate.dataset["path"] === path);
      row?.scrollIntoView({ block: "nearest" });
    });
  }

  private setDirectory(path: string, state: DirectoryState) {
    const next = new Map(this.dirs);
    next.set(path, state);
    this.dirs = next;
  }

  private async loadDirectory(path: string, generation = this.generation) {
    const previous = this.dirs.get(path);
    this.setDirectory(path, { ...previous, loading: true });
    try {
      const listing = await listDirectory(this.sessionId, path);
      if (generation !== this.generation) return;
      this.setDirectory(path, { entries: listing.entries, loading: false, truncated: listing.truncated });
    } catch (error) {
      if (generation !== this.generation) return;
      if (path && error instanceof FilesRequestError && error.status === 404) {
        // A folder that disappeared is no longer open.
        const expanded = new Set(this.expanded);
        expanded.delete(path);
        this.expanded = expanded;
        this.persist();
        const next = new Map(this.dirs);
        next.delete(path);
        this.dirs = next;
        return;
      }
      this.setDirectory(path, { ...previous, loading: false, error: errorText(error) });
    }
  }

  /** Re-reads open folders and the selected file: after an agent turn, on becoming visible, or on request. */
  async refresh() {
    if (!this.info?.available || !this.sessionId) return;
    const generation = this.generation;
    await Promise.all(["", ...this.expanded].filter((path) => path === "" || this.dirs.has(path)).map((path) => this.loadDirectory(path, generation)));
    if (this.filter.trim()) void this.runSearch(this.filter);
    await this.checkFile();
  }

  private async checkFile() {
    const path = this.selected;
    if (!path || this.fileLoading) return;
    const sequence = this.openSequence;
    let latest: FileRead;
    try {
      latest = await readFile(this.sessionId, path);
    } catch (error) {
      if (sequence !== this.openSequence) return;
      if (error instanceof FilesRequestError && error.status === 404) {
        if (this.draft?.dirty) {
          this.draft.error = "The file was deleted on disk; your unsaved text is still here.";
          this.draft.notify();
        } else {
          this.closeFile();
          this.fileError = "This file no longer exists.";
        }
      }
      return;
    }
    if (sequence !== this.openSequence) return;
    const current = this.file;
    if (!current || latest.kind !== current.kind) {
      void this.open(path, { keepDrawer: true });
      return;
    }
    if (latest.kind === "text" && this.draft && latest.content !== undefined) {
      this.file = latest;
      this.draft.changedOnDisk({ content: latest.content, etag: latest.etag, writable: latest.writable });
      return;
    }
    if (latest.etag !== current.etag) void this.open(path, { keepDrawer: true });
  }

  /* ── opening files ── */

  private persist() {
    writeFilesViewState(this.viewId, {
      selected: this.selected,
      expanded: [...this.expanded],
      navigatorOpen: this.navigatorOpen,
      markdown: this.markdownMode,
    });
  }

  private announceTitle() {
    this.onTitleChange?.();
  }

  private closeFile() {
    ++this.openSequence;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (this.draft) void releaseDraft(this.draftKeyValue, this.draft, this.draftListener);
    this.draft = undefined;
    this.editor?.destroy();
    this.editor = undefined;
    this.editorReady = false;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = undefined;
    this.file = undefined;
    this.fileError = "";
  }

  async open(path: string, options: { keepDrawer?: boolean; line?: { line: number; column?: number | undefined } } = {}) {
    if (this.selected !== path || this.file || this.fileError) this.closeFile();
    this.pendingLine = options.line;
    const sequence = ++this.openSequence;
    this.selected = path;
    this.persist();
    this.announceTitle();
    if (this.narrow && !options.keepDrawer) this.drawerOpen = false;
    this.revealInTree(path);
    this.fileLoading = true;
    this.fileError = "";
    let file: FileRead;
    try {
      file = await readFile(this.sessionId, path);
    } catch (error) {
      if (sequence !== this.openSequence) return;
      this.fileLoading = false;
      this.fileError = errorText(error);
      return;
    }
    if (sequence !== this.openSequence) return;
    this.file = file;
    this.fileLoading = false;
    if (file.kind === "text" && file.content !== undefined) await this.openText(path, file, sequence);
    else if (file.kind === "image" || file.kind === "pdf") await this.openPreview(path, sequence);
  }

  private revealInTree(path: string) {
    const folders: string[] = [];
    for (let folder = parentOf(path); folder; folder = parentOf(folder)) folders.unshift(folder);
    const missing = folders.filter((folder) => !this.expanded.has(folder));
    if (!missing.length) return;
    this.expanded = new Set([...this.expanded, ...missing]);
    this.persist();
    for (const folder of missing) if (!this.dirs.has(folder)) void this.loadDirectory(folder);
  }

  private async openText(path: string, file: FileRead, sequence: number) {
    const key = draftKey(this.sessionId, path);
    const sessionId = this.sessionId;
    const draft = openDraft(key, { content: file.content ?? "", etag: file.etag, writable: file.writable }, async ({ content, etag }) => {
      const result = await saveFile(sessionId, path, content, etag);
      if ("conflict" in result) {
        const current = result.conflict;
        return { conflict: { content: current.content ?? "", etag: current.etag, writable: current.writable } satisfies DraftFile };
      }
      return { etag: result.saved.etag };
    });
    this.draft = draft;
    this.draftKeyValue = key;
    draft.listeners.add(this.draftListener);
    let module: typeof import("../lib/files/editor.ts");
    try {
      module = await editorModule();
    } catch (error) {
      if (sequence === this.openSequence) this.fileError = `The editor could not load: ${errorText(error)}`;
      return;
    }
    await this.updateComplete;
    const host = this.editorHost.value;
    if (sequence !== this.openSequence || !host) return;
    host.replaceChildren();
    const editor = await module.createFileEditor({
      parent: host,
      text: editorText(draft.content),
      path,
      readOnly: !draft.writable,
      onChange: (changes) => this.edited(changes),
      onSave: () => this.saveNow(),
    });
    if (sequence !== this.openSequence) {
      editor.destroy();
      return;
    }
    this.editor = editor;
    this.editorReadOnly = !draft.writable;
    this.editorReady = true;
    this.renderDraft();
    if (draft.dirty && !draft.conflict) this.scheduleSave();
    const line = this.pendingLine;
    this.pendingLine = undefined;
    if (line) void this.updateComplete.then(() => { if (this.editor === editor) editor.revealLine(line.line, line.column); });
  }

  private async openPreview(path: string, sequence: number) {
    try {
      const blob = await fetchRawFile(this.sessionId, path);
      if (sequence !== this.openSequence) return;
      this.previewUrl = URL.createObjectURL(blob);
    } catch (error) {
      if (sequence === this.openSequence) this.fileError = errorText(error);
    }
  }

  /* ── editing and saving ── */

  private edited(changes: FileTextChange[]) {
    const draft = this.draft;
    if (!draft) return;
    this.editing = true;
    try {
      draft.edit(editFileText(draft.content, changes));
    } finally {
      this.editing = false;
    }
    if (this.markdownMode === "rendered" && this.isMarkdown) this.setMarkdownMode("source");
    this.scheduleSave();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY_MS);
  }

  private saveNow(overwrite = false) {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const draft = this.draft;
    if (!draft) return;
    void draft.flush(overwrite).then(() => {
      // Edits made while a save ran are saved by that same flush; a later edit schedules its own.
      if (draft === this.draft && draft.dirty && !draft.conflict && !draft.error && !this.saveTimer) this.scheduleSave();
    });
  }

  private renderDraft() {
    const draft = this.draft;
    if (!draft) return;
    if (!this.editing) this.editor?.setText(editorText(draft.content));
    if (this.editor && this.editorReadOnly !== !draft.writable) {
      this.editorReadOnly = !draft.writable;
      this.editor.setReadOnly(this.editorReadOnly);
    }
    if (draft.conflict) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.requestUpdate();
  }

  private reloadFromDisk() {
    const draft = this.draft;
    if (!draft?.conflict) return;
    draft.accept(draft.conflict);
  }

  private get isMarkdown(): boolean {
    return Boolean(this.selected && isMarkdownPath(this.selected) && this.file?.kind === "text");
  }

  private setMarkdownMode(mode: MarkdownDisplayMode) {
    this.markdownMode = mode;
    this.persist();
    if (mode === "source") {
      void this.updateComplete.then(() => this.editor?.refresh());
    }
  }

  /* ── navigator actions ── */

  private toggleNavigator() {
    if (this.narrow) {
      this.drawerOpen = !this.drawerOpen;
      return;
    }
    this.navigatorOpen = !this.navigatorOpen;
    this.persist();
    void this.updateComplete.then(() => this.editor?.refresh());
  }

  private toggleFolder(path: string) {
    const expanded = new Set(this.expanded);
    if (expanded.has(path)) expanded.delete(path);
    else {
      expanded.add(path);
      if (!this.dirs.get(path)?.entries) void this.loadDirectory(path);
    }
    this.expanded = expanded;
    this.persist();
  }

  /** Where new files and uploads go: the selected file's folder, or the root. */
  private get currentFolder(): string {
    return this.selected ? parentOf(this.selected) : "";
  }

  private onFilterInput(event: InputEvent) {
    this.filter = (event.currentTarget as HTMLInputElement).value;
    clearTimeout(this.filterTimer);
    if (!this.filter.trim()) {
      this.searchAbort?.abort();
      this.search = undefined;
      this.searchError = "";
      return;
    }
    this.filterTimer = setTimeout(() => void this.runSearch(this.filter), FILTER_DELAY_MS);
  }

  private async runSearch(query: string) {
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    try {
      const result = await searchFiles(this.sessionId, query, abort.signal);
      if (abort.signal.aborted || query !== this.filter) return;
      this.search = result;
      this.searchError = "";
    } catch (error) {
      if (abort.signal.aborted) return;
      this.searchError = errorText(error);
    }
  }

  private openCreate(type: "file" | "directory") {
    this.dialog = { kind: "create", type, folder: this.currentFolder, name: "", busy: false, error: "" };
  }

  private async submitCreate(event: Event) {
    event.preventDefault();
    const dialog = this.dialog;
    if (dialog?.kind !== "create" || dialog.busy) return;
    const name = dialog.name.trim();
    if (!name) {
      this.dialog = { ...dialog, error: "Type a name." };
      return;
    }
    this.dialog = { ...dialog, busy: true, error: "" };
    try {
      const entry = await createEntry(this.sessionId, joinPath(dialog.folder, name), dialog.type);
      this.closeDialog();
      if (dialog.folder && !this.expanded.has(dialog.folder)) this.toggleFolder(dialog.folder);
      await this.loadDirectory(parentOf(entry.path));
      if (entry.kind === "file") void this.open(entry.path);
      else this.toggleFolder(entry.path);
    } catch (error) {
      if (this.dialog?.kind === "create") this.dialog = { ...this.dialog, busy: false, error: errorText(error) };
    }
  }

  private askDelete(entry: FileEntry) {
    this.dialog = { kind: "delete", entry, busy: false, error: "" };
  }

  private async confirmDelete(event: Event) {
    event.preventDefault();
    const dialog = this.dialog;
    if (dialog?.kind !== "delete" || dialog.busy) return;
    this.dialog = { ...dialog, busy: true, error: "" };
    const { entry } = dialog;
    try {
      await deleteEntry(this.sessionId, entry.path, entry.kind === "directory" && !entry.symlink);
    } catch (error) {
      if (this.dialog?.kind === "delete") this.dialog = { ...this.dialog, busy: false, error: errorText(error) };
      return;
    }
    this.closeDialog();
    if (this.selected && within(this.selected, entry.path)) {
      const selected = this.selected;
      this.closeFile();
      forgetDraft(draftKey(this.sessionId, selected));
      this.selected = undefined;
      this.persist();
      this.announceTitle();
    } else if (entry.kind === "file") forgetDraft(draftKey(this.sessionId, entry.path));
    const expanded = new Set([...this.expanded].filter((path) => !within(path, entry.path)));
    if (expanded.size !== this.expanded.size) {
      this.expanded = expanded;
      this.persist();
    }
    await this.loadDirectory(parentOf(entry.path));
    if (this.filter.trim()) void this.runSearch(this.filter);
  }

  private chooseUpload() {
    this.uploadInput.value?.click();
  }

  private onUploadChosen(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (files.length) void this.upload(this.currentFolder, files);
  }

  private async upload(folder: string, files: File[], overwrite = false) {
    const count = files.length === 1 ? `“${files[0]!.name}”` : `${files.length} files`;
    this.uploadStatus = `Uploading ${count}…`;
    const conflicts: File[] = [];
    const failures: string[] = [];
    await Promise.all(files.map(async (file) => {
      try {
        await uploadFile(this.sessionId, folder, file, overwrite);
      } catch (error) {
        if (error instanceof FilesRequestError && error.status === 409) conflicts.push(file);
        else failures.push(`${file.name}: ${errorText(error)}`);
      }
    }));
    if (folder && !this.expanded.has(folder)) this.toggleFolder(folder);
    await this.loadDirectory(folder);
    const uploaded = files.length - conflicts.length - failures.length;
    this.uploadStatus = failures.length
      ? `${failures.length === 1 ? "Upload failed" : `${failures.length} uploads failed`}: ${failures[0]}`
      : uploaded ? `Uploaded ${uploaded === 1 && files.length === 1 ? count : `${uploaded} file${uploaded === 1 ? "" : "s"}`} to ${folder || this.rootName}` : "";
    if (conflicts.length) this.dialog = { kind: "overwrite", folder, files: conflicts, busy: false, error: "" };
    if (this.selected && files.some((file) => joinPath(folder, file.name) === this.selected)) void this.checkFile();
  }

  private async confirmOverwrite(event: Event) {
    event.preventDefault();
    const dialog = this.dialog;
    if (dialog?.kind !== "overwrite" || dialog.busy) return;
    this.closeDialog();
    await this.upload(dialog.folder, dialog.files, true);
  }

  private closeDialog() {
    closeModal(this.querySelector<HTMLDialogElement>("dialog.hui-files-dialog") ?? undefined);
    this.dialog = undefined;
  }

  private hasFiles(event: DragEvent): boolean {
    return Boolean(event.dataTransfer?.types.includes("Files"));
  }

  private dragOver(event: DragEvent) {
    if (!this.hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-drop-folder]");
    for (const element of this.querySelectorAll(".is-drop-target")) if (element !== row) element.classList.remove("is-drop-target");
    row?.classList.add("is-drop-target");
  }

  private dragLeave(event: DragEvent) {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-drop-folder]");
    if (row && !(event.relatedTarget instanceof Node && row.contains(event.relatedTarget))) row.classList.remove("is-drop-target");
  }

  private drop(event: DragEvent) {
    if (!this.hasFiles(event)) return;
    event.preventDefault();
    for (const element of this.querySelectorAll(".is-drop-target")) element.classList.remove("is-drop-target");
    const items = [...(event.dataTransfer?.items ?? [])];
    if (items.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      this.uploadStatus = "Folders cannot be uploaded yet; drop files instead.";
      return;
    }
    const files = [...(event.dataTransfer?.files ?? [])];
    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-drop-folder]")?.dataset["dropFolder"] ?? "";
    if (files.length) void this.upload(folder, files);
  }

  private treeKeydown(event: KeyboardEvent) {
    const rows = [...this.querySelectorAll<HTMLButtonElement>("button.hui-files-row__main")];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && current >= 0) {
      const row = rows[current]!;
      const folder = row.dataset["folder"];
      const open = row.getAttribute("aria-expanded") === "true";
      if (folder !== undefined && (event.key === "ArrowRight") !== open) this.toggleFolder(folder);
      else if (event.key === "ArrowLeft") {
        const parent = parentOf(row.dataset["path"] ?? "");
        next = rows.findIndex((candidate) => candidate.dataset["folder"] === parent);
        if (next < 0) next = undefined;
      }
    } else return;
    event.preventDefault();
    if (next !== undefined) rows[next]?.focus();
  }

  private async copyPath() {
    if (!this.selected || !this.info?.available) return;
    const root = this.info.root.replace(/\/$/u, "");
    if (await writeClipboardText(`${root}/${this.selected}`)) {
      this.copied = true;
      setTimeout(() => { this.copied = false; }, 1500);
    }
  }

  private async download() {
    const file = this.file;
    if (!file) return;
    try {
      const blob = this.previewUrl ? await fetchPreviewBlob(this.previewUrl) : await fetchRawFile(this.sessionId, file.path);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      this.fileError = errorText(error);
    }
  }

  private get rootName(): string {
    return this.info?.available ? this.info.name : "the working directory";
  }

  /* ── rendering ── */

  private renderRow(entry: FileEntry, depth: number): TemplateResult {
    const indent = `padding-inline-start: ${8 + depth * 14}px`;
    const remove = html`<button type="button" class="hui-files-row__delete btn btn--ghost btn--icon" aria-label=${`Delete ${entry.name}`}
      data-hui-tooltip="Delete" @click=${() => this.askDelete(entry)}>${icons.trash}</button>`;
    if (entry.kind === "directory") {
      const open = this.expanded.has(entry.path);
      const state = this.dirs.get(entry.path);
      return html`<li class="hui-files-node">
        <div class="hui-files-row" data-drop-folder=${entry.path}>
          <button type="button" class="hui-files-row__main" style=${indent} aria-expanded=${open ? "true" : "false"}
            data-folder=${entry.path} data-path=${entry.path} @click=${() => this.toggleFolder(entry.path)}>
            <span class="hui-files-row__chevron">${open ? chevronDownIcon : chevronRightIcon}</span>
            <span class="hui-files-row__icon">${icons.folder}</span>
            <span class="hui-files-row__name">${entry.name}</span>
            ${entry.symlink ? html`<span class="hui-files-row__badge">link</span>` : nothing}
          </button>
          ${remove}
        </div>
        ${open ? this.renderChildren(state, depth + 1) : nothing}
      </li>`;
    }
    if (entry.kind === "file") {
      const selected = this.selected === entry.path;
      return html`<li class="hui-files-node">
        <div class="hui-files-row ${selected ? "is-selected" : ""}">
          <button type="button" class="hui-files-row__main" style=${indent} data-path=${entry.path}
            aria-current=${selected ? "true" : "false"} @click=${() => void this.open(entry.path)}>
            <span class="hui-files-row__chevron"></span>
            <span class="hui-files-row__icon">${entry.symlink ? linkIcon : fileIcon}</span>
            <span class="hui-files-row__name">${entry.name}</span>
          </button>
          ${remove}
        </div>
      </li>`;
    }
    // A link that leaves the working directory, or a socket or device: listed, never opened.
    return html`<li class="hui-files-node">
      <div class="hui-files-row is-inert">
        <span class="hui-files-row__main hui-files-row__main--inert" style=${indent}>
          <span class="hui-files-row__chevron"></span>
          <span class="hui-files-row__icon">${entry.kind === "symlink" ? linkIcon : fileIcon}</span>
          <span class="hui-files-row__name">${entry.name}</span>
          <span class="hui-files-row__reason">${entry.kind === "symlink" ? "link outside this folder" : "not a regular file"}</span>
        </span>
        ${entry.kind === "symlink" ? remove : nothing}
      </div>
    </li>`;
  }

  private renderChildren(state: DirectoryState | undefined, depth: number): TemplateResult {
    const pad = `padding-inline-start: ${8 + depth * 14 + 20}px`;
    if (!state?.entries) {
      return html`<p class="hui-files-tree__note" style=${pad}>${state?.error ?? "Loading…"}</p>`;
    }
    return html`${state.error ? html`<p class="hui-files-tree__note is-error" style=${pad} role="alert">${state.error}</p>` : nothing}
      ${state.entries.length
        ? html`<ul class="hui-files-tree__list" role="group">${state.entries.map((entry) => this.renderRow(entry, depth))}</ul>`
        : html`<p class="hui-files-tree__note" style=${pad}>Empty folder</p>`}
      ${state.truncated ? html`<p class="hui-files-tree__note" style=${pad}>Only the first 2,000 entries are listed; use the filter to find the rest.</p>` : nothing}`;
  }

  private renderSearch(): TemplateResult {
    if (this.searchError) return html`<p class="hui-files-tree__note is-error" role="alert">${this.searchError}</p>`;
    const search = this.search;
    if (!search) return html`<p class="hui-files-tree__note">Searching…</p>`;
    if (!search.entries.length) return html`<p class="hui-files-tree__note">No file matches “${search.query}”.</p>`;
    return html`<ul class="hui-files-tree__list">
      ${search.entries.map((entry) => {
        const folder = parentOf(entry.path);
        const selected = this.selected === entry.path;
        return html`<li class="hui-files-node"><div class="hui-files-row ${selected ? "is-selected" : ""}">
          <button type="button" class="hui-files-row__main hui-files-row__main--result" data-path=${entry.path}
            aria-current=${selected ? "true" : "false"} @click=${() => void this.open(entry.path)}>
            <span class="hui-files-row__icon">${fileIcon}</span>
            <span class="hui-files-row__name">${entry.name}</span>
            ${folder ? html`<span class="hui-files-row__folder">${folder}</span>` : nothing}
          </button>
        </div></li>`;
      })}
    </ul>
    ${search.truncated ? html`<p class="hui-files-tree__note">More files match; keep typing to narrow it down.</p>` : nothing}`;
  }

  private renderNavigator(): TemplateResult {
    const info = this.info;
    const root = this.dirs.get("");
    return html`<aside class="hui-files-nav" aria-label="Files navigator"
      @dragover=${this.dragOver} @dragleave=${this.dragLeave} @drop=${this.drop}>
      <div class="hui-files-nav__header">
        <span class="hui-files-nav__root" data-hui-tooltip=${info?.available ? info.root : ""}>
          <span class="hui-files-row__icon">${icons.folder}</span>
          <span class="hui-files-nav__root-name">${info?.available ? info.name : "Files"}</span>
        </span>
        <span class="hui-files-nav__actions">
          <button type="button" class="btn btn--ghost btn--icon" aria-label="New file" data-hui-tooltip="New file" @click=${() => this.openCreate("file")}>${filePlusIcon}</button>
          <button type="button" class="btn btn--ghost btn--icon" aria-label="New folder" data-hui-tooltip="New folder" @click=${() => this.openCreate("directory")}>${folderPlusIcon}</button>
          <button type="button" class="btn btn--ghost btn--icon" aria-label="Upload files" data-hui-tooltip="Upload files" @click=${this.chooseUpload}>${uploadIcon}</button>
          <button type="button" class="btn btn--ghost btn--icon" aria-label="Refresh" data-hui-tooltip="Refresh" @click=${() => void this.refresh()}>${icons.refresh}</button>
          ${this.narrow ? html`<button type="button" class="btn btn--ghost btn--icon" aria-label="Close files navigator" data-hui-tooltip="Close" @click=${() => { this.drawerOpen = false; }}>${icons.close}</button>` : nothing}
        </span>
        <input type="file" multiple hidden ${ref(this.uploadInput)} @change=${this.onUploadChosen} />
      </div>
      <label class="hui-files-nav__filter">
        <span class="hui-files-row__icon">${icons.search}</span>
        <input class="hui-files-nav__filter-input" type="search" placeholder="Filter files" aria-label="Filter files" autocomplete="off" spellcheck="false"
          .value=${this.filter} @input=${this.onFilterInput}
          @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape" && this.filter) { event.preventDefault(); this.filter = ""; this.search = undefined; this.searchError = ""; } }} />
      </label>
      <div class="hui-files-tree" data-drop-folder="" @keydown=${this.treeKeydown}>
        ${this.filter.trim()
          ? this.renderSearch()
          : root?.entries
            ? root.entries.length
              ? html`${root.error ? html`<p class="hui-files-tree__note is-error" role="alert">${root.error}</p>` : nothing}
                <ul class="hui-files-tree__list" role="group">${root.entries.map((entry) => this.renderRow(entry, 0))}</ul>
                ${root.truncated ? html`<p class="hui-files-tree__note">Only the first 2,000 entries are listed; use the filter to find the rest.</p>` : nothing}`
              : html`<p class="hui-files-tree__note">This folder is empty. Create a file or drop files here.</p>`
            : html`<p class="hui-files-tree__note ${root?.error ? "is-error" : ""}">${root?.error ?? "Loading files…"}</p>`}
      </div>
      ${this.uploadStatus ? html`<p class="hui-files-nav__status" role="status">${this.uploadStatus}</p>` : nothing}
    </aside>`;
  }

  private renderStatus(): TemplateResult | typeof nothing {
    const draft = this.draft;
    if (!draft || this.file?.kind !== "text") return nothing;
    const status = draftStatus(draft);
    return html`<span class="hui-files-status" data-state=${status.state} role="status">
      <span class="hui-files-status__dot" aria-hidden="true"></span><span class="hui-files-status__text">${status.text}</span>
    </span>
    ${status.state === "error" && draft.error ? html`<button type="button" class="btn btn--sm" @click=${() => this.saveNow()}>Retry</button>` : nothing}`;
  }

  private renderHeader(): TemplateResult {
    const path = this.selected;
    const open = this.narrow ? this.drawerOpen : this.navigatorOpen;
    const label = open ? "Hide files" : "Show files";
    const entry: FileEntry | undefined = path && this.file ? { name: this.file.name, path, kind: "file", size: this.file.size } : undefined;
    return html`<header class="hui-files-main__header">
      <button type="button" class="btn btn--ghost btn--icon" aria-label=${label} data-hui-tooltip=${label} aria-expanded=${open ? "true" : "false"}
        @click=${this.toggleNavigator}>${open && !this.narrow ? icons.panelLeftClose : icons.panelLeftOpen}</button>
      ${path
        ? html`<span class="hui-files-path" data-hui-tooltip=${path}><bdi dir="ltr">${path}</bdi></span>
          <button type="button" class="btn btn--ghost btn--icon hui-files-copy" aria-label="Copy full path" data-hui-tooltip=${this.copied ? "Copied" : "Copy full path"}
            @click=${() => void this.copyPath()}>${this.copied ? icons.check : icons.copy}</button>`
        : html`<span class="hui-files-path hui-files-path--empty">No file selected</span>`}
      <span class="hui-files-main__spacer"></span>
      ${this.renderStatus()}
      ${this.isMarkdown ? html`<span class="hui-files-segmented" role="group" aria-label="Markdown display mode">
          <button type="button" class="hui-files-segmented__option" aria-pressed=${this.markdownMode === "source" ? "true" : "false"} @click=${() => this.setMarkdownMode("source")}>Source</button>
          <button type="button" class="hui-files-segmented__option" aria-pressed=${this.markdownMode === "rendered" ? "true" : "false"} @click=${() => this.setMarkdownMode("rendered")}>Rendered</button>
        </span>` : nothing}
      ${this.file && this.file.kind !== "text" ? html`<button type="button" class="btn btn--ghost btn--icon" aria-label="Download" data-hui-tooltip="Download" @click=${() => void this.download()}>${icons.download}</button>` : nothing}
      ${entry ? html`<button type="button" class="btn btn--ghost btn--icon" aria-label=${`Delete ${entry.name}`} data-hui-tooltip="Delete file" @click=${() => this.askDelete(entry)}>${icons.trash}</button>` : nothing}
    </header>`;
  }

  private renderConflict(): TemplateResult | typeof nothing {
    const conflict = this.draft?.conflict;
    if (!conflict) return nothing;
    return html`<div class="hui-files-conflict" role="alert">
      <div class="hui-files-conflict__text">
        <strong>This file changed on disk while you were editing it.</strong>
        <span>Your edits are kept here and nothing is saved until you choose.</span>
      </div>
      <div class="hui-files-conflict__actions">
        <button type="button" class="btn btn--sm" @click=${this.reloadFromDisk}>Reload from disk</button>
        <button type="button" class="btn btn--sm primary" @click=${() => this.saveNow(true)}>Overwrite with mine</button>
      </div>
      <details class="hui-files-conflict__details">
        <summary>Show the version on disk</summary>
        <pre>${conflict.content}</pre>
      </details>
    </div>`;
  }

  private renderBody(): TemplateResult {
    const file = this.file;
    const text = file?.kind === "text";
    const rendered = text && this.isMarkdown && this.markdownMode === "rendered";
    let other: TemplateResult | typeof nothing = nothing;
    if (this.fileError) other = html`<div class="hui-files-empty" role="alert"><p>${this.fileError}</p></div>`;
    else if (!this.selected) {
      other = html`<div class="hui-files-empty"><p>Select a file to view or edit it.</p>
        ${this.narrow ? html`<button type="button" class="btn btn--sm" @click=${() => { this.drawerOpen = true; }}>Browse files</button>` : nothing}</div>`;
    } else if (this.fileLoading || !file) other = html`<div class="hui-files-empty"><p>Opening ${nameOf(this.selected)}…</p></div>`;
    else if (file.kind === "image") {
      other = this.previewUrl
        ? html`<div class="hui-files-preview"><img src=${this.previewUrl} alt=${file.name} /></div>`
        : html`<div class="hui-files-empty"><p>Loading preview…</p></div>`;
    } else if (file.kind === "pdf") {
      other = this.previewUrl
        ? html`<iframe class="hui-files-pdf" src=${this.previewUrl} title=${file.name}></iframe>`
        : html`<div class="hui-files-empty"><p>Loading preview…</p></div>`;
    } else if (file.kind === "binary" || file.kind === "too-large") {
      other = html`<div class="hui-files-empty hui-files-meta">
        <p><strong>${file.name}</strong></p>
        <p>${file.kind === "binary" ? "Binary file: it has no text to show here." : `Too large to edit here (${formatBytes(file.size)}; the limit is 2 MB).`}</p>
        <dl>
          <dt>Size</dt><dd>${formatBytes(file.size)}</dd>
          <dt>Modified</dt><dd>${new Date(file.mtime).toLocaleString()}</dd>
        </dl>
        <button type="button" class="btn btn--sm" @click=${() => void this.download()}>${icons.download} Download</button>
      </div>`;
    } else if (text && !this.editorReady && !rendered) other = html`<div class="hui-files-empty"><p>Loading the editor…</p></div>`;
    return html`<div class="hui-files-body">
      <div class="hui-files-editor" ${ref(this.editorHost)} ?hidden=${!text || rendered || !this.editorReady}></div>
      ${rendered && this.draft ? html`<article class="hui-files-markdown sidebar-markdown">${renderMarkdown(this.draft.content)}</article>` : nothing}
      ${other}
    </div>`;
  }

  private renderDialog(): TemplateResult | typeof nothing {
    const dialog = this.dialog;
    if (!dialog) return nothing;
    const cancel = html`<button type="button" class="btn" ?disabled=${dialog.busy} @click=${this.closeDialog}>Cancel</button>`;
    const error = dialog.error ? html`<p class="group-action-dialog__error" role="alert">${dialog.error}</p>` : nothing;
    const shell = (title: string, body: TemplateResult, submit: (event: Event) => void) => html`<dialog class="hui-modal-dialog group-action-dialog hui-files-dialog" aria-labelledby="hui-files-dialog-title"
      @cancel=${(event: Event) => { event.preventDefault(); if (!dialog.busy) this.closeDialog(); }}>
      <form class="exec-approval-card" @submit=${submit}>
        <div class="exec-approval-title" id="hui-files-dialog-title">${title}</div>
        ${body}
        ${error}
      </form>
    </dialog>`;
    if (dialog.kind === "create") {
      const what = dialog.type === "file" ? "file" : "folder";
      return shell(`New ${what}`, html`
        <div class="exec-approval-sub">In ${dialog.folder || this.rootName}</div>
        <label class="field">
          <span>Name</span>
          <input class="input hui-files-dialog__input" name="name" autocomplete="off" spellcheck="false" autofocus
            placeholder=${dialog.type === "file" ? "notes.md" : "docs"} .value=${dialog.name} ?disabled=${dialog.busy}
            @input=${(event: InputEvent) => { if (this.dialog?.kind === "create") this.dialog = { ...this.dialog, name: (event.currentTarget as HTMLInputElement).value, error: "" }; }} />
        </label>
        <div class="exec-approval-actions">
          <button type="submit" class="btn primary" ?disabled=${dialog.busy}>${dialog.busy ? "Creating…" : `Create ${what}`}</button>
          ${cancel}
        </div>`, (event) => void this.submitCreate(event));
    }
    if (dialog.kind === "delete") {
      const { entry } = dialog;
      const folder = entry.kind === "directory" && !entry.symlink;
      const risks: TemplateResult[] = [];
      if (folder) risks.push(html`<li>The folder <code>${entry.path}</code> and everything inside it.</li>`);
      else if (entry.kind === "symlink" || entry.symlink) risks.push(html`<li>The link <code>${entry.path}</code>. What it points to is kept.</li>`);
      else risks.push(html`<li>The file <code>${entry.path}</code>${entry.size ? ` (${formatBytes(entry.size)})` : ""}.</li>`);
      const unsaved = existingDraft(draftKey(this.sessionId, entry.path))?.dirty || (this.selected && within(this.selected, entry.path) && this.draft?.dirty);
      if (unsaved) risks.push(html`<li>Unsaved edits to ${this.selected && within(this.selected, entry.path) ? nameOf(this.selected) : entry.name}.</li>`);
      if (this.selected && folder && within(this.selected, entry.path)) risks.push(html`<li>The open file <code>${this.selected}</code> closes.</li>`);
      return shell(`Delete ${entry.name}?`, html`
        <div class="exec-approval-sub">Deleting does not use the trash and cannot be undone. It removes:</div>
        <ul class="hui-files-dialog__risks">${risks}</ul>
        <div class="exec-approval-actions">
          <button type="submit" class="btn danger" ?disabled=${dialog.busy}>${dialog.busy ? "Deleting…" : "Delete"}</button>
          ${cancel}
        </div>`, (event) => void this.confirmDelete(event));
    }
    return shell(dialog.files.length === 1 ? "Replace the existing file?" : `Replace ${dialog.files.length} existing files?`, html`
      <div class="exec-approval-sub">${dialog.files.length === 1
        ? `Uploading replaces this file in ${dialog.folder || this.rootName}; its current content is lost:`
        : `Uploading replaces these files in ${dialog.folder || this.rootName}; their current content is lost:`}</div>
      <ul class="hui-files-dialog__risks">${dialog.files.map((file) => html`<li><code>${joinPath(dialog.folder, file.name)}</code></li>`)}</ul>
      <div class="exec-approval-actions">
        <button type="submit" class="btn danger" ?disabled=${dialog.busy}>Replace</button>
        ${cancel}
      </div>`, (event) => void this.confirmOverwrite(event));
  }

  override render() {
    const info = this.info;
    if (!info) return html`<div class="hui-files hui-files--message"><p class="hui-files-empty">Loading files…</p></div>`;
    if (!info.available) {
      return html`<div class="hui-files hui-files--message"><div class="hui-files-empty" role="status"><p><strong>Files are not available</strong></p><p>${info.reason}</p></div></div>`;
    }
    const showNavigator = this.narrow ? this.drawerOpen : this.navigatorOpen;
    return html`<div class="hui-files ${this.narrow ? "hui-files--narrow" : ""} ${showNavigator ? "hui-files--navigator" : ""}">
      ${showNavigator ? this.renderNavigator() : nothing}
      ${this.narrow && showNavigator ? html`<button type="button" class="hui-files-backdrop" aria-label="Close files navigator" @click=${() => { this.drawerOpen = false; }}></button>` : nothing}
      <section class="hui-files-main" aria-label=${this.selected ? `Editor for ${this.selected}` : "Editor"}>
        ${this.renderHeader()}
        ${this.renderConflict()}
        ${this.renderBody()}
      </section>
    </div>
    ${this.renderDialog()}`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-files-view")) {
  customElements.define("hui-files-view", HuiFilesView);
}

declare global {
  interface HTMLElementTagNameMap {
    "hui-files-view": HuiFilesView;
  }
}
