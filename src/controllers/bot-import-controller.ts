/**
 * The import and export dialogs' state (the roster's + → Import bot…, a bot's ⋯ → Export…), as a Lit controller so
 * `hui-app.ts` only opens them, renders them (`views/bot-import.ts`) and hears about an imported bot. Every request
 * goes through `api/bot-templates.ts`; a refusal stays in the dialog, never as an optimistic success. Export first asks the
 * gateway to review the bot, then keeps the operator's picks until Download sends them.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BotView } from "../lib/bots/bots.ts";
import { importSource, pickedFile, pickedFolder, type BotExportGroup, type BotExportReview, type BotImportPreview, type BotImportTab, type PickedSource } from "../lib/bots/templates.ts";
import { BotExportError, downloadBotExport, importBot, previewBotImport, reviewBotExport } from "../api/bot-templates.ts";
import { ensureModal } from "../lib/modal-dialog.ts";
import { additionChange, buildExport, picksWithoutAddition, withAdditions } from "../lib/bots/export-preview.ts";
import type { BotExportAddition } from "../api/schema/bot-templates.ts";
import type { BotExportDialogProps, BotExportDraft, BotImportDialogProps } from "../views/bot-import.ts";

/** The "Missed something?" form, empty. */
const EMPTY_DRAFT: BotExportDraft = { quote: "", group: "remove", becomes: "", error: "" };
import type { BotPlace } from "../views/bots.ts";

type ImportState = {
  step: "source" | "preview";
  tab: BotImportTab;
  picked?: PickedSource | undefined;
  url: string;
  text: string;
  worker: string;
  pending: boolean;
  error: string;
  preview?: BotImportPreview | undefined;
};

type ExportState = {
  bot: BotView;
  /** The gateway's review; absent while it reviews. */
  review?: BotExportReview | undefined;
  /** The operator's group for each change, script or need they moved. */
  picks: Record<string, BotExportGroup>;
  /** Passages the operator added, and the form for the next one. */
  added: BotExportAddition[];
  draft: BotExportDraft;
  /** Reviewing, or downloading. */
  pending: boolean;
  error: string;
  /** The download was refused because the review is gone or the bot changed since: another review fixes it. */
  stale: boolean;
};

export type BotImportOptions = {
  /** Remote workers an import may run a bot on (Settings → Workers). */
  workers(): readonly BotPlace[];
  /** A bot was imported: the roster shows it and its chat opens; `warnings` are steps after it that failed. */
  imported(bot: BotView, warnings: readonly string[]): void;
};

export class BotImportController implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #options: BotImportOptions;
  #import: ImportState | undefined;
  #export: ExportState | undefined;

  constructor(host: ReactiveControllerHost, options: BotImportOptions) {
    this.#host = host;
    this.#options = options;
    host.addController(this);
  }

  hostConnected(): void {}

  get importing(): boolean { return this.#import !== undefined; }
  get exporting(): boolean { return this.#export !== undefined; }

  #set(change: Partial<ImportState>): void {
    if (!this.#import) return;
    this.#import = { ...this.#import, ...change };
    this.#host.requestUpdate();
  }

  openImport = (): void => {
    this.#import = { step: "source", tab: "file", url: "", text: "", worker: "", pending: false, error: "" };
    this.#host.requestUpdate();
  };

  /** Both dialogs go (bots were turned off, say); a request in flight finds nothing to update. */
  close = (): void => {
    this.#import = undefined;
    this.#export = undefined;
    this.#host.requestUpdate();
  };

  #closeImport = (): void => {
    if (this.#import?.pending) return;
    this.#import = undefined;
    this.#host.requestUpdate();
  };

  /** Reads a picked file or folder into a source; a refusal (too large) says so in the dialog. */
  async #pick(read: () => Promise<PickedSource>): Promise<void> {
    this.#set({ pending: true, error: "" });
    try {
      const picked = await read();
      this.#set({ picked, pending: false });
    } catch (error) {
      this.#set({ pending: false, picked: undefined, error: error instanceof Error ? error.message : "That file could not be read." });
    }
  }

  async #preview(pick?: string): Promise<void> {
    const state = this.#import;
    if (!state || state.pending) return;
    const source = importSource(state.tab, state);
    if (typeof source === "string") {
      this.#set({ error: source });
      return;
    }
    this.#set({ pending: true, error: "" });
    try {
      const preview = await previewBotImport({ source, ...(pick !== undefined ? { pick } : {}), ...(state.worker ? { worker: state.worker } : {}) });
      if (this.#import === undefined) return;
      this.#set({ step: "preview", preview, pending: false });
    } catch (error) {
      this.#set({ pending: false, error: error instanceof Error ? error.message : "HUI could not read that template." });
    }
  }

  async #create(): Promise<void> {
    const state = this.#import;
    if (!state?.preview || state.pending) return;
    this.#set({ pending: true, error: "" });
    try {
      const result = await importBot(state.preview.template, state.worker || undefined);
      if (this.#import === undefined) return;
      this.#import = undefined;
      this.#host.requestUpdate();
      this.#options.imported(result.bot, result.warnings);
    } catch (error) {
      this.#set({ pending: false, error: error instanceof Error ? error.message : "The bot could not be imported." });
    }
  }

  importProps(): BotImportDialogProps | undefined {
    const state = this.#import;
    if (!state) return undefined;
    return {
      ...state,
      workers: this.#options.workers(),
      onTab: (tab) => this.#set({ tab, error: "" }),
      onPickFile: (file) => void this.#pick(() => pickedFile(file)),
      onPickFolder: (files) => void this.#pick(() => pickedFolder(files)),
      onUrl: (url) => this.#set({ url }),
      onText: (text) => this.#set({ text }),
      onWorker: (worker) => this.#set({ worker }),
      onPreview: () => void this.#preview(),
      onPick: (key) => void this.#preview(key),
      onBack: () => this.#set({ step: "source", error: "" }),
      onCreate: () => void this.#create(),
      onClose: this.#closeImport,
    };
  }

  openExport = (bot: BotView): void => {
    this.#export = { bot, picks: {}, added: [], draft: EMPTY_DRAFT, pending: true, error: "", stale: false };
    void this.#review();
  };

  #setExport(change: Partial<ExportState>): void {
    if (!this.#export) return;
    this.#export = { ...this.#export, ...change };
    this.#host.requestUpdate();
  }

  /** Asks for a review; a dialog closed or reviewing again by the time it answers ignores it. */
  async #review(): Promise<void> {
    if (!this.#export) return;
    const asked: ExportState = { ...this.#export, review: undefined, picks: {}, added: [], draft: EMPTY_DRAFT, pending: true, error: "", stale: false };
    this.#export = asked;
    this.#host.requestUpdate();
    try {
      const review = await reviewBotExport(asked.bot.id);
      if (this.#export === asked) this.#setExport({ review, pending: false });
    } catch (error) {
      if (this.#export === asked) this.#setExport({ pending: false, error: error instanceof Error ? error.message : "The bot could not be reviewed." });
    }
  }

  async #download(): Promise<void> {
    const state = this.#export;
    if (!state?.review || state.pending) return;
    this.#setExport({ pending: true, error: "" });
    try {
      await downloadBotExport(state.bot.id, { review: state.review.id, picks: state.picks, added: state.added }, { fallbackName: buildExport(withAdditions(state.review, state.added), state.picks).fileName });
      this.#export = undefined;
      this.#host.requestUpdate();
    } catch (error) {
      this.#setExport({ pending: false, error: error instanceof Error ? error.message : "The bot could not be exported.", stale: error instanceof BotExportError && error.status === 409 });
    }
  }

  exportProps(): BotExportDialogProps | undefined {
    const state = this.#export;
    if (!state) return undefined;
    return {
      ...state,
      onPick: (id, group) => {
        if (this.#export && !this.#export.pending) this.#setExport({ picks: { ...this.#export.picks, [id]: group } });
      },
      onDraft: (change) => {
        if (this.#export) this.#setExport({ draft: { ...this.#export.draft, ...change, error: "" } });
      },
      onAdd: () => {
        const current = this.#export;
        if (!current?.review || current.pending) return;
        const { quote, group, becomes } = current.draft;
        const addition: BotExportAddition = { quote, group, ...(becomes.trim() && group !== "confirm" ? { becomes } : {}) };
        const change = additionChange(withAdditions(current.review, current.added), addition, `a${current.added.length + 1}`);
        if (typeof change === "string") this.#setExport({ draft: { ...current.draft, error: change } });
        else this.#setExport({ added: [...current.added, addition], draft: EMPTY_DRAFT });
      },
      onUndo: (index) => {
        const current = this.#export;
        if (!current || current.pending) return;
        this.#setExport({ added: current.added.filter((_, at) => at !== index), picks: picksWithoutAddition(current.picks, index) });
      },
      onReview: () => void this.#review(),
      onDownload: () => void this.#download(),
      onClose: () => {
        // A review may be cancelled; a download in flight finishes first.
        if (this.#export?.pending && this.#export.review) return;
        this.#export = undefined;
        this.#host.requestUpdate();
      },
    };
  }

  /** After a render: an open dialog shows as a modal, its first control focused. */
  showDialogs(root: ParentNode): void {
    for (const [open, selector, focus] of [[this.importing, ".bot-import-dialog", ".bot-import-cancel, .bot-import-back"], [this.exporting, ".bot-export-dialog", ".bot-export-cancel"]] as const) {
      if (!open) continue;
      const dialog = root.querySelector?.(selector);
      if (dialog instanceof HTMLDialogElement && !dialog.open) {
        ensureModal(dialog);
        dialog.querySelector<HTMLElement>(focus)?.focus();
      }
    }
  }
}
