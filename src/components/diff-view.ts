/**
 * `<hui-diff-view>`: a Diff view, the Work view that shows what changed in the conversation's Git checkout. A header
 * chooses the comparison (uncommitted changes, the last commit, the previous branch with a branch picker, the default
 * branch, the last two with "Include uncommitted"), the layout (unified, or side by side when the pane is wide) and
 * refreshes; a filterable list of changed files (status, +/- counts, totals) sits beside the selected file's diff,
 * syntax-coloured by `lib/diff/highlight.ts`. Large or binary files open collapsed with a notice, renames show as
 * renames, and the file name opens the file in a Files view (the chat's file-link event, `OPEN_FILE_EVENT`). It
 * refreshes when the conversation's agent turn ends and when it becomes visible again. On narrow screens the list and
 * the diff take turns, with Back.
 *
 * It owns presentation and per-view state (`lib/diff/view-state.ts`); the gateway runs Git (`server/git/diff.ts`). No
 * decorators: the Work pane's view registry, which imports this lazily, also loads in Node tests.
 */
import { html, nothing, svg, type PropertyValues, type SVGTemplateResult, type TemplateResult } from "lit";
import { HuiElement } from "../lit/hui-element.ts";
import { icons } from "../lib/icons.ts";
import { loadViewAssets } from "../lib/view-assets.ts";
import { renderPicker } from "../views/settings-picker.ts";
import { DIFF_COLLAPSE_LINES } from "../lib/diff/view-state.ts";
import type { DiffBranch, DiffChanges, DiffComparison, DiffFile, DiffInfo } from "../api/schema/diff.ts";
import { mixedLineEndings, parseHunks, patchLineCount, splitRows, type DiffHunk, type DiffLine } from "../lib/diff/hunks.ts";
import { highlightHunks, type LineHighlights } from "../lib/diff/highlight.ts";
import { DiffRequestError, loadDiffChanges, loadDiffFile, loadDiffInfo, type DiffQuery } from "../api/diff.ts";
import { chosenParent, initialComparison, readDiffViewState, writeDiffViewState, type DiffLayout } from "../lib/diff/view-state.ts";
import { OPEN_FILE_EVENT, type OpenFileDetail } from "../lib/files/file-link-store.ts";
import { onTurnEnd } from "../lib/session/turn-end.ts";

loadViewAssets(() => import("../styles/diff-view.css"));

/** Side by side needs this much room for the view; below it the toggle says why it is off. */
export const SPLIT_MIN_WIDTH = 900;
/** Below this width the list and the diff take turns, as on narrow screens. */
export const STACKED_MAX_WIDTH = 640;

/* Lucide icons this view needs that OpenClaw's set lacks (src/lib/icons.ts holds only verbatim OpenClaw icons). */
const svg16 = (body: SVGTemplateResult) => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const arrowLeftIcon = svg16(svg`<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`);
const externalIcon = svg16(svg`<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`);

type Available = Extract<DiffInfo, { available: true }>;

const COMPARISON_LABELS: Record<DiffComparison, string> = {
  uncommitted: "Uncommitted changes",
  "last-commit": "Last commit",
  parent: "Against the previous branch",
  default: "Against the default branch",
};

const STATUS_LABELS: Record<DiffFile["status"], string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Unmerged" };

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first line a changed file should open at in Files: its first added line, else its first hunk's start. */
export function firstChangedLine(hunks: readonly DiffHunk[]): number | undefined {
  for (const hunk of hunks) {
    const added = hunk.lines.find((line) => line.kind === "add");
    if (added?.newNumber) return added.newNumber;
  }
  const start = hunks[0]?.newStart;
  return start && start > 0 ? start : undefined;
}

/** How a branch reads in the picker. */
function branchDescription(branch: DiffBranch, detected: string | undefined): string {
  const parts: string[] = [];
  if (branch.ref === detected) parts.push("detected");
  if (branch.distance !== undefined) parts.push(branch.distance === 0 ? "at HEAD" : `HEAD is ${plural(branch.distance, "commit")} ahead`);
  else parts.push("not an ancestor of HEAD");
  if (branch.remote) parts.push("remote");
  return parts.join(" · ");
}

const PARENT_SOURCES: Record<NonNullable<Available["parent"]>["source"], string> = {
  "gh-merge-base": "gh merge base",
  "git-town": "git-town parent",
  upstream: "tracked branch",
  nearest: "nearest ancestor",
};

type ParsedFile = { hunks: DiffHunk[]; lines: number; mixedEol: boolean };

export class HuiDiffView extends HuiElement {
  static override properties = {
    sessionId: {},
    viewId: {},
    visible: { type: Boolean },
    narrow: { type: Boolean },
    info: { state: true },
    changes: { state: true },
    changesError: { state: true },
    loading: { state: true },
    comparison: { state: true },
    parent: { state: true },
    uncommitted: { state: true },
    layout: { state: true },
    selected: { state: true },
    filter: { state: true },
    wide: { state: true },
    compact: { state: true },
    detailOpen: { state: true },
    loadedFiles: { state: true },
    fileErrors: { state: true },
    expanded: { state: true },
    highlights: { state: true },
  };

  declare sessionId: string;
  declare viewId: string;
  declare visible: boolean;
  declare narrow: boolean;
  declare info: DiffInfo | undefined;
  declare changes: DiffChanges | undefined;
  declare changesError: string;
  declare loading: boolean;
  declare comparison: DiffComparison;
  declare parent: string | undefined;
  declare uncommitted: boolean;
  declare layout: DiffLayout;
  declare selected: string | undefined;
  declare filter: string;
  declare wide: boolean;
  /** The view is too narrow for the list beside the diff (a narrow Work pane on a desktop). */
  declare compact: boolean;
  /** Narrow screens: the selected file's diff is shown instead of the list. */
  declare detailOpen: boolean;
  /** Files the full answer left out (`truncated: "total"`), loaded one by one. */
  declare loadedFiles: Map<string, DiffFile>;
  declare fileErrors: Map<string, string>;
  /** Large files the operator chose to show anyway. */
  declare expanded: Set<string>;
  declare highlights: Map<string, LineHighlights>;

  private generation = 0;
  private abort: AbortController | undefined;
  private stopTurnEnd: (() => void) | undefined;
  private resize: ResizeObserver | undefined;
  private wasVisible = false;
  /** A turn ended while hidden: refresh when shown. */
  private stale = false;
  private parsed = new Map<string, ParsedFile>();
  private highlighting = new Set<string>();

  constructor() {
    super();
    this.sessionId = "";
    this.viewId = "";
    this.visible = true;
    this.narrow = false;
    this.info = undefined;
    this.changes = undefined;
    this.changesError = "";
    this.loading = false;
    this.comparison = "uncommitted";
    this.parent = undefined;
    this.uncommitted = true;
    this.layout = "unified";
    this.selected = undefined;
    this.filter = "";
    this.wide = true;
    this.compact = false;
    this.detailOpen = false;
    this.loadedFiles = new Map();
    this.fileErrors = new Map();
    this.expanded = new Set();
    this.highlights = new Map();
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.sessionId) this.subscribeTurnEnd();
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(([entry]) => {
        const width = entry?.contentRect.width ?? 0;
        if (width <= 0) return;
        this.wide = width >= SPLIT_MIN_WIDTH;
        this.compact = width < STACKED_MAX_WIDTH;
      });
      this.resize.observe(this);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopTurnEnd?.();
    this.stopTurnEnd = undefined;
    this.resize?.disconnect();
    this.resize = undefined;
    this.abort?.abort();
  }

  protected override updated(changed: PropertyValues) {
    if ((changed.has("sessionId") || changed.has("viewId")) && this.sessionId && this.viewId) void this.reset();
    else if (changed.has("visible") && this.visible && !this.wasVisible && this.info) {
      if (this.stale || this.info.available) void this.refresh();
    }
    if (changed.has("visible")) this.wasVisible = this.visible;
  }

  private subscribeTurnEnd() {
    this.stopTurnEnd?.();
    this.stopTurnEnd = onTurnEnd(this.sessionId, () => {
      if (this.visible) void this.refresh();
      else this.stale = true;
    });
  }

  private persist() {
    writeDiffViewState(this.viewId, {
      comparison: this.comparison,
      parent: this.parent,
      uncommitted: this.uncommitted,
      layout: this.layout,
      selected: this.selected,
    });
  }

  /** The list and the diff take turns instead of sitting side by side. */
  private get stacked(): boolean {
    return this.narrow || this.compact;
  }

  private get query(): DiffQuery {
    return { comparison: this.comparison, parent: this.parent, uncommitted: this.uncommitted };
  }

  /* ── loading ── */

  private async reset() {
    this.subscribeTurnEnd();
    const state = readDiffViewState(this.viewId);
    this.layout = state.layout;
    this.uncommitted = state.uncommitted;
    this.selected = state.selected;
    this.parent = state.parent;
    this.info = undefined;
    this.changes = undefined;
    this.detailOpen = false;
    await this.refresh(state.comparison);
  }

  /** Re-reads what can be compared, then the changes of the current comparison. */
  private async refresh(remembered: DiffComparison | undefined = this.comparison) {
    const generation = ++this.generation;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.stale = false;
    this.loading = true;
    let info: DiffInfo;
    try {
      info = await loadDiffInfo(this.sessionId, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) return;
      info = { available: false, reason: errorText(error), code: "git" };
    }
    if (generation !== this.generation) return;
    this.info = info;
    if (!info.available) {
      this.loading = false;
      this.changes = undefined;
      return;
    }
    this.comparison = initialComparison(info, remembered);
    this.parent = chosenParent(info, this.parent);
    await this.loadChanges(generation, abort);
  }

  private async loadChanges(generation = ++this.generation, abort = this.replaceAbort()) {
    this.loading = true;
    try {
      const changes = await loadDiffChanges(this.sessionId, this.query, abort.signal);
      if (generation !== this.generation) return;
      this.changes = changes;
      this.changesError = "";
      this.loadedFiles = new Map();
      this.fileErrors = new Map();
      this.parsed.clear();
      this.highlights = new Map();
      this.highlighting.clear();
      const paths = new Set(changes.files.map((file) => file.path));
      if (!this.selected || !paths.has(this.selected)) {
        this.selected = changes.files[0]?.path;
        if (!this.selected) this.detailOpen = false;
      }
      this.persist();
      this.ensureSelectedLoaded();
    } catch (error) {
      if (abort.signal.aborted || generation !== this.generation) return;
      this.changesError = error instanceof DiffRequestError && error.code === "remote" ? error.message : errorText(error);
      this.changes = undefined;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  private replaceAbort(): AbortController {
    this.abort?.abort();
    this.abort = new AbortController();
    return this.abort;
  }

  /** The selected file as far as it is known: loaded on its own when the full answer left it out. */
  private fileFor(path: string | undefined): DiffFile | undefined {
    if (!path) return undefined;
    return this.loadedFiles.get(path) ?? this.changes?.files.find((file) => file.path === path);
  }

  private ensureSelectedLoaded() {
    const file = this.fileFor(this.selected);
    if (!file || file.truncated !== "total" || this.fileErrors.has(file.path)) return;
    const generation = this.generation;
    const query = this.query;
    void loadDiffFile(this.sessionId, query, file).then((loaded) => {
      if (generation !== this.generation) return;
      this.loadedFiles = new Map(this.loadedFiles).set(file.path, loaded ?? { ...file, truncated: undefined, patch: "" });
    }, (error: unknown) => {
      if (generation !== this.generation) return;
      this.fileErrors = new Map(this.fileErrors).set(file.path, errorText(error));
    });
  }

  private parsedFor(file: DiffFile): ParsedFile {
    const key = `${file.path}\0${file.patch?.length ?? -1}`;
    let parsed = this.parsed.get(key);
    if (!parsed) {
      const hunks = parseHunks(file.patch ?? "");
      parsed = { hunks, lines: patchLineCount(file.patch ?? ""), mixedEol: mixedLineEndings(hunks) };
      this.parsed.set(key, parsed);
    }
    return parsed;
  }

  private requestHighlight(file: DiffFile, parsed: ParsedFile) {
    if (this.highlights.has(file.path) || this.highlighting.has(file.path) || !parsed.hunks.length) return;
    this.highlighting.add(file.path);
    const generation = this.generation;
    void highlightHunks(file.path, parsed.hunks).then((result) => {
      if (generation !== this.generation || !result) return;
      this.highlights = new Map(this.highlights).set(file.path, result);
    }, () => undefined);
  }

  /* ── actions ── */

  private choose(comparison: DiffComparison) {
    if (comparison === this.comparison) return;
    this.comparison = comparison;
    this.persist();
    void this.loadChanges();
  }

  private chooseParent(ref: string) {
    if (ref === this.parent) return;
    this.parent = ref;
    this.persist();
    void this.loadChanges();
  }

  private toggleUncommitted(event: Event) {
    this.uncommitted = (event.currentTarget as HTMLInputElement).checked;
    this.persist();
    void this.loadChanges();
  }

  private setLayout(layout: DiffLayout) {
    this.layout = layout;
    this.persist();
  }

  private select(path: string) {
    this.selected = path;
    this.detailOpen = true;
    this.persist();
    this.ensureSelectedLoaded();
    void this.updateComplete.then(() => this.querySelector(".hui-diff-main__scroll")?.scrollTo({ top: 0 }));
  }

  private openInFiles(file: DiffFile, line?: number) {
    const detail: OpenFileDetail = { sessionId: this.sessionId, path: file.path, kind: "file", ...(line ? { line } : {}) };
    this.dispatchEvent(new CustomEvent<OpenFileDetail>(OPEN_FILE_EVENT, { detail, bubbles: true, composed: true }));
  }

  private listKeydown(event: KeyboardEvent) {
    const rows = [...this.querySelectorAll<HTMLButtonElement>("button.hui-diff-file")];
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else return;
    event.preventDefault();
    const row = rows[next];
    if (!row) return;
    row.focus();
    if (!this.stacked && row.dataset["path"]) this.select(row.dataset["path"]);
  }

  /* ── rendering: header ── */

  private comparisonDescription(info: Available, comparison: DiffComparison): string {
    if (comparison === "uncommitted") return info.uncommitted ? "Working tree against HEAD" : "No uncommitted changes";
    if (comparison === "last-commit") return info.lastCommit ? `${info.lastCommit.sha} ${info.lastCommit.subject}` : "HEAD";
    if (comparison === "parent") {
      const picked = info.branches.find((branch) => branch.ref === this.parent) ?? info.parent;
      if (!picked) return "";
      return picked.ref === info.parent?.ref ? `${picked.name} (${PARENT_SOURCES[info.parent.source]})` : `${picked.name} (chosen)`;
    }
    return info.defaultBranch?.name ?? "";
  }

  private renderToolbar(info: Available): TemplateResult {
    const branchComparison = this.comparison === "parent" || this.comparison === "default";
    const splitDisabled = !this.wide || this.stacked;
    return html`<header class="hui-diff-toolbar">
      <div class="hui-diff-toolbar__picker hui-diff-toolbar__picker--comparison">
        ${renderPicker({
          label: "Compare",
          value: this.comparison,
          options: info.comparisons.map((comparison) => ({ value: comparison, label: COMPARISON_LABELS[comparison], description: this.comparisonDescription(info, comparison) })),
          showOptionTooltips: false,
          showSelectedDescription: false,
          className: "hui-diff-picker",
          onChange: (value) => this.choose(value as DiffComparison),
        })}
      </div>
      ${this.comparison === "parent" ? html`<div class="hui-diff-toolbar__picker hui-diff-toolbar__picker--branch">
          ${renderPicker({
            label: "Previous branch",
            value: this.parent ?? null,
            options: info.branches.map((branch) => ({ value: branch.ref, label: branch.name, description: branchDescription(branch, info.parent?.ref) })),
            searchable: true,
            searchPlaceholder: "Find a branch",
            showOptionTooltips: false,
            className: "hui-diff-picker",
            onChange: (value) => this.chooseParent(value),
          })}
        </div>` : nothing}
      ${branchComparison ? html`<label class="hui-diff-check">
          <input type="checkbox" .checked=${this.uncommitted} @change=${this.toggleUncommitted} />
          <span>Include uncommitted</span>
        </label>` : nothing}
      <span class="hui-diff-toolbar__spacer"></span>
      <span class="hui-diff-segmented" role="group" aria-label="Diff layout">
        <button type="button" class="hui-diff-segmented__option" aria-pressed=${this.layout === "unified" || splitDisabled ? "true" : "false"} @click=${() => this.setLayout("unified")}>Unified</button>
        <button type="button" class="hui-diff-segmented__option" aria-pressed=${this.layout === "split" && !splitDisabled ? "true" : "false"} ?disabled=${splitDisabled}
          aria-describedby=${splitDisabled ? `${this.viewId}-split-reason` : nothing}
          @click=${() => this.setLayout("split")}>Side by side</button>
      </span>
      ${splitDisabled && !this.stacked ? html`<span class="hui-diff-toolbar__reason" id=${`${this.viewId}-split-reason`}>Side by side needs a wider pane</span>` : nothing}
      <button type="button" class="btn btn--ghost btn--icon hui-diff-refresh" aria-label="Refresh" data-hui-tooltip="Refresh" ?disabled=${this.loading} @click=${() => void this.refresh()}>${icons.refresh}</button>
    </header>`;
  }

  private renderSummary(info: Available): TemplateResult {
    const changes = this.changes;
    const head = info.detached ? `detached HEAD at ${info.head ?? "?"}` : info.unborn ? `${info.branch ?? "HEAD"} (no commits yet)` : info.branch ?? "HEAD";
    const branchBase = changes && (changes.comparison === "parent" || changes.comparison === "default");
    const from = changes ? `${branchBase ? `merge base with ${changes.base.label}` : changes.base.label}${changes.base.sha ? ` ${changes.base.sha.slice(0, 7)}` : ""}` : "";
    const range = changes ? `${from} → ${changes.includesUncommitted ? (changes.comparison === "uncommitted" ? "working tree" : `${head} + working tree`) : head}` : head;
    return html`<div class="hui-diff-summary">
      <span class="hui-diff-summary__range" data-hui-tooltip=${info.root}><bdi dir="ltr">${range}</bdi></span>
      ${info.subdirectory ? html`<span class="hui-diff-summary__note">only ${info.subdirectory}/</span>` : nothing}
    </div>`;
  }

  /* ── rendering: file list ── */

  private visibleFiles(): DiffFile[] {
    const files = this.changes?.files ?? [];
    const words = this.filter.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    if (!words.length) return files;
    return files.filter((file) => {
      const haystack = `${file.path} ${file.oldPath ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }

  private renderStatus(file: DiffFile): TemplateResult {
    return html`<span class="hui-diff-status" data-status=${file.status} aria-label=${STATUS_LABELS[file.status]} data-hui-tooltip=${STATUS_LABELS[file.status]}>${file.status}</span>`;
  }

  private renderCounts(file: Pick<DiffFile, "additions" | "deletions" | "binary">): TemplateResult {
    if (file.binary) return html`<span class="hui-diff-counts"><span class="hui-diff-counts__binary">bin</span></span>`;
    return html`<span class="hui-diff-counts"><span class="hui-diff-counts__add">+${file.additions.toLocaleString()}</span><span class="hui-diff-counts__del">−${file.deletions.toLocaleString()}</span></span>`;
  }

  private renderList(): TemplateResult {
    const changes = this.changes;
    const files = this.visibleFiles();
    let body: TemplateResult;
    if (this.changesError) {
      body = html`<div class="hui-diff-note is-error" role="alert"><p>${this.changesError}</p><button type="button" class="btn btn--sm" @click=${() => void this.loadChanges()}>Retry</button></div>`;
    } else if (!changes) body = html`<p class="hui-diff-list__note">Comparing…</p>`;
    else if (!changes.files.length) body = html`<p class="hui-diff-list__note">No changed files.</p>`;
    else if (!files.length) body = html`<p class="hui-diff-list__note">No changed file matches “${this.filter.trim()}”.</p>`;
    else {
      body = html`<ul class="hui-diff-list__items" role="list">
        ${files.map((file) => {
          const selected = file.path === this.selected;
          const folder = folderOf(file.path);
          return html`<li>
            <button type="button" class="hui-diff-file ${selected ? "is-selected" : ""}" data-path=${file.path} aria-current=${selected ? "true" : "false"}
              @click=${() => this.select(file.path)}>
              ${this.renderStatus(file)}
              <span class="hui-diff-file__text">
                <span class="hui-diff-file__name">${nameOf(file.path)}</span>
                <span class="hui-diff-file__folder">${file.oldPath ? `from ${file.oldPath}` : folder}</span>
              </span>
              ${this.renderCounts(file)}
            </button>
          </li>`;
        })}
      </ul>`;
    }
    return html`<aside class="hui-diff-list" aria-label="Changed files">
      <div class="hui-diff-list__header">
        <span class="hui-diff-list__total">${changes ? plural(changes.files.length + changes.filesOmitted, "file") : "Files"}</span>
        ${changes ? this.renderCounts({ additions: changes.additions, deletions: changes.deletions, binary: false }) : nothing}
      </div>
      <label class="hui-diff-list__filter">
        <span class="hui-diff-list__filter-icon">${icons.search}</span>
        <input type="search" placeholder="Filter changed files" aria-label="Filter changed files" autocomplete="off" spellcheck="false"
          .value=${this.filter} @input=${(event: InputEvent) => { this.filter = (event.currentTarget as HTMLInputElement).value; }}
          @keydown=${(event: KeyboardEvent) => { if (event.key === "Escape" && this.filter) { event.preventDefault(); this.filter = ""; } }} />
      </label>
      ${changes?.truncated ? html`<p class="hui-diff-list__note">The changes are large: some files load when you open them.</p>` : nothing}
      ${changes?.filesOmitted ? html`<p class="hui-diff-list__note">${plural(changes.filesOmitted, "more changed file")} not listed.</p>` : nothing}
      ${changes?.untrackedOmitted ? html`<p class="hui-diff-list__note">${plural(changes.untrackedOmitted, "untracked file")} left out (too many).</p>` : nothing}
      <div class="hui-diff-list__scroll" @keydown=${this.listKeydown}>${body}</div>
    </aside>`;
  }

  /* ── rendering: the diff ── */

  private renderCode(file: DiffFile, line: DiffLine, mixedEol: boolean): TemplateResult {
    const segments = this.highlights.get(file.path)?.get(line);
    const text = segments
      ? segments.map((segment) => segment.className ? html`<span class=${segment.className}>${segment.text}</span>` : segment.text)
      : line.text;
    return html`${text}${line.cr && mixedEol ? html`<span class="hui-diff-eol" aria-label="CRLF">␍</span>` : nothing}`;
  }

  private renderNoNewline(columns: number): TemplateResult {
    return html`<tr class="hui-diff-row hui-diff-row--eof"><td colspan=${columns}>No newline at end of file</td></tr>`;
  }

  private renderUnified(file: DiffFile, parsed: ParsedFile): TemplateResult {
    return html`<table class="hui-diff-table hui-diff-table--unified">
      <colgroup><col class="hui-diff-col-num" /><col class="hui-diff-col-num" /><col /></colgroup>
      ${parsed.hunks.map((hunk) => html`<tbody>
        <tr class="hui-diff-row hui-diff-row--hunk"><td colspan="3">@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ <span class="hui-diff-hunk__section">${hunk.section}</span></td></tr>
        ${hunk.lines.map((line) => html`<tr class="hui-diff-row" data-kind=${line.kind}>
            <td class="hui-diff-num">${line.oldNumber ?? ""}</td>
            <td class="hui-diff-num">${line.newNumber ?? ""}</td>
            <td class="hui-diff-code"><span class="hui-diff-sign" aria-hidden="true">${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</span>${this.renderCode(file, line, parsed.mixedEol)}</td>
          </tr>${line.noNewline ? this.renderNoNewline(3) : nothing}`)}
      </tbody>`)}
    </table>`;
  }

  private renderSplit(file: DiffFile, parsed: ParsedFile): TemplateResult {
    const cell = (line: DiffLine | undefined, side: "left" | "right") => {
      if (!line) return html`<td class="hui-diff-num is-empty"></td><td class="hui-diff-code is-empty"></td>`;
      const number = side === "left" ? line.oldNumber : line.newNumber;
      return html`<td class="hui-diff-num" data-kind=${line.kind}>${number ?? ""}</td>
        <td class="hui-diff-code" data-kind=${line.kind}>${this.renderCode(file, line, parsed.mixedEol)}${line.noNewline ? html`<span class="hui-diff-eof-inline">No newline at end of file</span>` : nothing}</td>`;
    };
    return html`<table class="hui-diff-table hui-diff-table--split">
      <colgroup><col class="hui-diff-col-num" /><col /><col class="hui-diff-col-num" /><col /></colgroup>
      ${parsed.hunks.map((hunk) => html`<tbody>
        <tr class="hui-diff-row hui-diff-row--hunk"><td colspan="4">@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ <span class="hui-diff-hunk__section">${hunk.section}</span></td></tr>
        ${splitRows(hunk).map((row) => html`<tr class="hui-diff-row hui-diff-row--split">${cell(row.left, "left")}${cell(row.right, "right")}</tr>`)}
      </tbody>`)}
    </table>`;
  }

  private renderFileHeader(file: DiffFile, parsed: ParsedFile | undefined): TemplateResult {
    const openable = file.status !== "D";
    const line = parsed ? firstChangedLine(parsed.hunks) : undefined;
    return html`<header class="hui-diff-main__header">
      ${this.stacked ? html`<button type="button" class="btn btn--ghost btn--icon" aria-label="Back to changed files" data-hui-tooltip="Changed files" @click=${() => { this.detailOpen = false; }}>${arrowLeftIcon}</button>` : nothing}
      ${this.renderStatus(file)}
      <span class="hui-diff-main__path">
        ${file.oldPath ? html`<span class="hui-diff-main__old"><bdi dir="ltr">${file.oldPath}</bdi></span><span class="hui-diff-main__arrow" aria-label="renamed to">→</span>` : nothing}
        ${openable
          ? html`<button type="button" class="hui-diff-main__open" data-hui-tooltip="Open in Files" @click=${() => this.openInFiles(file, line)}><bdi dir="ltr">${file.path}</bdi></button>`
          : html`<span class="hui-diff-main__deleted"><bdi dir="ltr">${file.path}</bdi></span>`}
      </span>
      ${openable ? nothing : html`<span class="hui-diff-main__hint">deleted: nothing to open</span>`}
      <span class="hui-diff-toolbar__spacer"></span>
      ${this.renderCounts(file)}
      ${openable ? html`<button type="button" class="btn btn--ghost btn--icon" aria-label=${`Open ${nameOf(file.path)} in Files`} data-hui-tooltip="Open in Files" @click=${() => this.openInFiles(file, line)}>${externalIcon}</button>` : nothing}
    </header>`;
  }

  private renderFileBody(file: DiffFile): TemplateResult {
    if (file.truncated === "total") {
      const error = this.fileErrors.get(file.path);
      return error
        ? html`<div class="hui-diff-note is-error" role="alert"><p>${error}</p></div>`
        : html`<div class="hui-diff-note"><p>Loading this file's diff…</p></div>`;
    }
    if (file.binary) return html`<div class="hui-diff-note"><p><strong>Binary file</strong></p><p>${STATUS_LABELS[file.status]}; it has no text to compare.</p></div>`;
    const parsed = this.parsedFor(file);
    const notices: TemplateResult[] = [];
    if (file.oldMode && file.newMode && file.oldMode !== file.newMode) notices.push(html`<p class="hui-diff-notice">Mode changed from ${file.oldMode} to ${file.newMode}.</p>`);
    if (!parsed.hunks.length) {
      const what = file.status === "R" ? "Renamed without changes." : file.status === "C" ? "Copied without changes." : notices.length ? "" : "No text changes.";
      return html`${notices}${what ? html`<div class="hui-diff-note"><p>${what}</p></div>` : nothing}`;
    }
    const large = parsed.lines > DIFF_COLLAPSE_LINES && !this.expanded.has(file.path);
    if (large) {
      return html`${notices}<div class="hui-diff-note">
        <p><strong>Large diff</strong></p>
        <p>${plural(parsed.lines, "line")} (${file.additions.toLocaleString()} added, ${file.deletions.toLocaleString()} removed). It is collapsed to keep the view responsive.</p>
        <button type="button" class="btn btn--sm" @click=${() => { this.expanded = new Set(this.expanded).add(file.path); }}>Show diff</button>
      </div>`;
    }
    this.requestHighlight(file, parsed);
    const split = this.layout === "split" && this.wide && !this.stacked;
    return html`${notices}
      ${split ? this.renderSplit(file, parsed) : this.renderUnified(file, parsed)}
      ${file.truncated === "file" ? html`<p class="hui-diff-notice">The diff stops here: this file's changes are longer than the gateway sends at once. Open it in Files to see all of it.</p>` : nothing}`;
  }

  private renderMain(info: Available): TemplateResult {
    const changes = this.changes;
    const file = this.fileFor(this.selected);
    let content: TemplateResult;
    if (this.changesError) content = html`<div class="hui-diff-empty" role="alert"><p><strong>Could not compare</strong></p><p>${this.changesError}</p></div>`;
    else if (!changes) content = html`<div class="hui-diff-empty"><p>Comparing…</p></div>`;
    else if (!changes.files.length) content = this.renderNoChanges(info);
    else if (!file) content = html`<div class="hui-diff-empty"><p>Select a file to see its changes.</p></div>`;
    else {
      const parsed = file.truncated === "total" || file.binary ? undefined : this.parsedFor(file);
      content = html`${this.renderFileHeader(file, parsed)}<div class="hui-diff-main__scroll">${this.renderFileBody(file)}</div>`;
    }
    return html`<section class="hui-diff-main" aria-label=${file ? `Changes in ${file.path}` : "Changes"}>${content}</section>`;
  }

  private renderNoChanges(info: Available): TemplateResult {
    const head = info.branch ?? "HEAD";
    const base = this.comparison === "parent"
      ? (info.branches.find((branch) => branch.ref === this.parent) ?? info.parent)?.name ?? "the previous branch"
      : info.defaultBranch?.name ?? "the default branch";
    const withWorktree = this.uncommitted ? ", and there are no uncommitted changes" : "";
    const text = this.comparison === "uncommitted" ? "The working tree matches HEAD: nothing is uncommitted."
      : this.comparison === "last-commit" ? `The last commit changed nothing${info.subdirectory ? ` under ${info.subdirectory}/` : ""}.`
      : `${head} adds nothing on top of ${base}${withWorktree}.`;
    return html`<div class="hui-diff-empty"><p><strong>No changes</strong></p><p>${text}</p></div>`;
  }

  override render() {
    const info = this.info;
    if (!info) return html`<div class="hui-diff hui-diff--message"><div class="hui-diff-empty"><p>Loading changes…</p></div></div>`;
    if (!info.available) {
      const title = info.code === "not-repo" ? "Not a Git repository" : "Diffs are not available";
      return html`<div class="hui-diff hui-diff--message"><div class="hui-diff-empty" role="status"><p><strong>${title}</strong></p><p>${info.reason}</p>
        <button type="button" class="btn btn--sm" @click=${() => void this.refresh()}>Check again</button></div></div>`;
    }
    const showList = !this.stacked || !this.detailOpen || !this.selected;
    const showMain = !this.stacked || (this.detailOpen && Boolean(this.selected));
    return html`<div class="hui-diff ${this.narrow ? "hui-diff--narrow" : ""} ${this.stacked ? "hui-diff--stacked" : ""} ${this.loading ? "is-loading" : ""}">
      ${this.renderToolbar(info)}
      ${this.renderSummary(info)}
      <div class="hui-diff-body">
        ${showList ? this.renderList() : nothing}
        ${showMain ? this.renderMain(info) : nothing}
      </div>
    </div>`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("hui-diff-view")) {
  customElements.define("hui-diff-view", HuiDiffView);
}

declare global {
  interface HTMLElementTagNameMap {
    "hui-diff-view": HuiDiffView;
  }
}
