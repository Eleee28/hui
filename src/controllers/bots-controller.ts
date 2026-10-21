/**
 * `BotsController` keeps the bot roster outside `hui-app.ts`: the list, its loading and error state, and the gateway's
 * bot stream that pushes it, with reads by GET as the fallback for a gateway without
 * the stream. It also owns the sidebar's Agents | Bots choice, the bot panel's state with the browser-remembered open
 * state and width, the Settings page's saves, and the roster's actions: creating a bot, hiding, archiving (with its
 * confirmation and its Restore toast), restoring and deleting one, and whether GPT-Live calls can run. A top-level app
 * only: an embedded pane never reads bots.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { archiveBot, createBot, deleteBot, loadBots, restoreBot, subscribeBots, updateBot } from "../api/bots.ts";
import { loadCallsStatus } from "../api/calls.ts";
import type { WorkerView } from "../api/workers.ts";
import { callsReady } from "../lib/voice/calls.ts";
import type { CallsStatus } from "../api/schema/calls.ts";
import { closeModal, ensureModal } from "../lib/modal-dialog.ts";
import type { NavigationTarget } from "../lib/navigation.ts";
import { applyBotsUpdate, botChangePatch, botSettingChange, isNewBotsFrame, upsertBot, type BotView } from "../lib/bots/bots.ts";
import { archivedBotCount, hiddenBotCount, readBotPanel, readSidebarTab, writeBotPanel, writeSidebarTab, type BotPanelState, type BotPanelView, type SidebarTab } from "../lib/bots/roster.ts";
import { NO_BOT_SETTINGS_SAVES, type BotSettingKey, type BotSettingsProps, type BotSettingsSaves, type BotSettingValue } from "../views/bot-settings.ts";
import type { SettingsController } from "./settings-controller.ts";

type BotsHost = ReactiveControllerHost & { embeddedPane: boolean; renderRoot: ParentNode };

type BotsDeps = {
  control: Pick<SettingsController, "settings">;
  /** The list with each bot's chat status, unread mark and presence as the shell knows them. */
  live: (bots: readonly BotView[]) => BotView[];
  /** Every bots frame: a bot loaded after a panel page opened, or woken. */
  onFrame: () => void;
  notify: (message: string, failed?: boolean) => void;
  navigate: (target: NavigationTarget, replace?: boolean) => void;
  /** The bot whose chat the bot route shows; "" off that route. */
  shownBotId: () => string;
  refreshSessions: () => void;
  workers: () => readonly WorkerView[];
};

type BotArchiveToast = { bot: BotView; restoring: boolean; error?: string };

/** A bot's Settings page: a row's saves or refusals without that row's. */
function withoutSetting<Value>(record: Partial<Record<BotSettingKey, Value>>, key: BotSettingKey): Partial<Record<BotSettingKey, Value>> {
  const next = { ...record };
  delete next[key];
  return next;
}

export class BotsController implements ReactiveController {
  list: readonly BotView[] = [];
  loading = false;
  loaded = false;
  error = "";
  streamLive = false;
  /** The sidebar's Agents | Bots choice, remembered by the browser. */
  tab: SidebarTab = readSidebarTab();
  panel: BotPanelState = readBotPanel();
  /** The page the panel shows: the bot's overview, or one its rows opened. Each bot opens on its overview. */
  panelView: BotPanelView = "overview";
  /** The overview row that opened the page showing (its `data-panel-link`): going back puts the focus on it again. */
  panelOpenedFrom = "";
  /** Wide screens: the panel fills the bot's view, its chat hidden underneath. Never remembered. */
  panelExpanded = false;
  /** Narrow layouts open the panel as a sheet only on request; never remembered. */
  sheetOpen = false;
  /** The Settings page's saves, per bot: each change is one PATCH, sent in order, and a newer change to the same row
   * replaces a value still waiting. Kept per bot, so leaving a bot never drops a change on its way. */
  #saves: ReadonlyMap<string, BotSettingsSaves> = new Map();
  #savesQueue: Promise<void> = Promise.resolve();
  showHidden = false;
  showArchived = false;
  /** The roster row whose hide, restore or delete is on its way; another waits for it. */
  pendingId = "";
  /** + is creating a bot; another press waits for it. */
  creating = false;
  /** The bot whose Archive asks for confirmation. */
  archiving: BotView | undefined;
  archivePending = false;
  archiveError = "";
  /** The bot whose Delete asks for confirmation. */
  deleting: BotView | undefined;
  deletePending = false;
  deleteError = "";
  archiveToast: BotArchiveToast | undefined;
  #archiveToastTimer: ReturnType<typeof setTimeout> | undefined;
  /** The ChatGPT login GPT-Live calls use (`/__hui/calls`), read on a bot's page. */
  callsStatus: CallsStatus | undefined;
  #callsStatusLoading: Promise<void> | undefined;
  readonly #host: BotsHost;
  readonly #deps: BotsDeps;
  #inFlight: Promise<void> | undefined;
  #again = false;
  #streamStop: (() => void) | undefined;
  #streamUnsupported = false;
  #revision = 0;

  constructor(host: BotsHost, deps: BotsDeps) {
    this.#host = host;
    this.#deps = deps;
    host.addController(this);
  }

  hostDisconnected(): void {
    if (this.#archiveToastTimer) clearTimeout(this.#archiveToastTimer);
    this.#streamStop?.();
    this.#streamStop = undefined;
    this.streamLive = false;
  }

  adopt(bots: readonly BotView[]): void {
    this.list = bots;
    this.#host.requestUpdate();
  }

  #set(next: Partial<Pick<BotsController, "list" | "loading" | "loaded" | "error" | "showHidden" | "showArchived" | "pendingId" | "creating"
    | "archiving" | "archivePending" | "archiveError" | "deleting" | "deletePending" | "deleteError" | "archiveToast">>): void {
    Object.assign(this, next);
    this.#host.requestUpdate();
  }

  /** The gateway's bot stream. It starts with the whole list, then sends what
   * changed; a gateway without it falls back to reading the list whenever a
   * bot's session changes status. */
  sync(): void {
    if (this.#host.embeddedPane || this.#streamUnsupported || this.#streamStop) return;
    this.#streamStop = subscribeBots({
      onUpdate: (update, first) => {
        if (!isNewBotsFrame(update.revision, first, this.#revision)) return;
        this.#revision = update.revision;
        this.#set({ list: this.#deps.live(applyBotsUpdate(this.list, update)), loaded: true, error: "" });
        this.#deps.onFrame();
      },
      onConnection: (state) => {
        this.streamLive = state === "live";
        if (state === "reconnecting" && !this.loaded) this.#set({ error: "Could not reach the gateway for the bot list. Retrying…" });
        if (state === "unsupported") {
          this.#streamUnsupported = true;
          this.#streamStop = undefined;
          void this.refresh();
        }
      },
    });
  }

  /** The list is current when the stream runs; otherwise it is read now. */
  ensure(): void {
    if (this.#streamUnsupported) void this.refresh();
    else this.sync();
  }

  /** Retry from an error state: restart a stopped stream or read the list. */
  retry = () => {
    this.#set({ error: "" });
    if (this.#streamUnsupported || this.streamLive) {
      void this.refresh();
      return;
    }
    this.#streamStop?.();
    this.#streamStop = undefined;
    this.sync();
  };

  /** One read at a time; a change that lands meanwhile reads once more after it.
   * Only used without a live stream, whose newer frames a read could overwrite. */
  refresh(): Promise<void> {
    if (this.#host.embeddedPane || this.streamLive) return Promise.resolve();
    if (this.#inFlight) {
      this.#again = true;
      return this.#inFlight;
    }
    this.#set({ loading: true });
    this.#inFlight = (async () => {
      try {
        do {
          this.#again = false;
          try {
            const bots = await loadBots();
            // A stream that went live meanwhile is newer than this read.
            if (!this.streamLive) this.#set({ list: this.#deps.live(bots) });
            this.#set({ loaded: true, error: "" });
          } catch (error) {
            this.#set({ error: error instanceof Error ? error.message : "Could not read bots." });
          }
        } while (this.#again);
      } finally {
        this.#set({ loading: false });
        this.#inFlight = undefined;
      }
    })();
    return this.#inFlight;
  }

  /** False when the tab was already showing. */
  selectTab(tab: SidebarTab): boolean {
    if (this.tab === tab) return false;
    this.tab = tab;
    writeSidebarTab(tab);
    this.#host.requestUpdate();
    return true;
  }

  #setPanel(next: Partial<BotPanelState>): void {
    this.panel = { ...this.panel, ...next };
    writeBotPanel(this.panel);
  }

  /** Another bot opens on its overview, docked. */
  resetPanel(): void {
    this.sheetOpen = false;
    this.panelView = "overview";
    this.panelOpenedFrom = "";
    this.panelExpanded = false;
    this.#host.requestUpdate();
  }

  /** The sheet on narrow layouts; docked, it opens at the width it had. */
  openPanel(sheet: boolean): void {
    if (sheet) this.sheetOpen = true;
    else if (!this.panel.open) this.#setPanel({ open: true });
    this.#host.requestUpdate();
  }

  togglePanel(sheet: boolean): void {
    if (sheet) {
      this.sheetOpen = !this.sheetOpen;
    } else {
      this.#setPanel({ open: !this.panel.open });
      if (!this.panel.open) this.panelExpanded = false;
    }
    this.#host.requestUpdate();
  }

  closePanel(sheet: boolean): void {
    if (sheet) this.sheetOpen = false;
    else this.#setPanel({ open: false });
    this.panelExpanded = false;
    this.#host.requestUpdate();
  }

  closeSheet(): void {
    this.sheetOpen = false;
    this.#host.requestUpdate();
  }

  /** Opens a page from a row of the overview (`from`, the row's `data-panel-link`), or goes back; returns the row the
   * focus goes back to. */
  showPanelView(view: BotPanelView, from = ""): string {
    const returnTo = view === "overview" ? this.panelOpenedFrom : from;
    this.panelOpenedFrom = view === "overview" ? "" : from;
    this.panelView = view;
    this.#host.requestUpdate();
    return returnTo;
  }

  resizePanel(width: number): void {
    this.#setPanel({ width });
    this.#host.requestUpdate();
  }

  expandPanel(expanded: boolean): void {
    this.panelExpanded = expanded;
    this.#host.requestUpdate();
  }

  savesOf(botId: string): BotSettingsSaves {
    return this.#saves.get(botId) ?? NO_BOT_SETTINGS_SAVES;
  }

  #updateSaves(botId: string, update: (saves: BotSettingsSaves) => BotSettingsSaves): void {
    this.#saves = new Map(this.#saves).set(botId, update(this.savesOf(botId)));
    this.#host.requestUpdate();
  }

  /** A Settings page change: shown at once as saving, then sent as its own PATCH after the ones before it. */
  changeSetting(botId: string, key: BotSettingKey, value: BotSettingValue): void {
    if (this.savesOf(botId).pending[key] === value) return;
    this.#updateSaves(botId, (saves) => ({ pending: { ...saves.pending, [key]: value }, errors: withoutSetting(saves.errors, key) }));
    this.#savesQueue = this.#savesQueue.then(() => this.#sendSetting(botId, key));
  }

  /** Sends the newest value a row waits on. The gateway's answer replaces the bot; a refusal stays on the row. A value
   * already sent, or replaced by a newer change meanwhile, is not sent again. */
  async #sendSetting(botId: string, key: BotSettingKey): Promise<void> {
    const value = this.savesOf(botId).pending[key];
    if (value === undefined) return;
    const settle = (error?: string) => this.#updateSaves(botId, (saves) => saves.pending[key] !== value ? saves : {
      pending: withoutSetting(saves.pending, key),
      errors: error ? { ...saves.errors, [key]: error } : withoutSetting(saves.errors, key),
    });
    const bot = this.list.find((candidate) => candidate.id === botId);
    if (!bot) {
      settle("This bot is gone.");
      return;
    }
    const patch = botChangePatch(bot, botSettingChange(key, value));
    if (!patch) {
      settle();
      return;
    }
    try {
      this.adopt(upsertBot(this.list, await updateBot(botId, patch)));
      settle();
    } catch (error) {
      settle(error instanceof Error ? error.message : "Could not save that change.");
    }
  }

  dismissSetting(botId: string, key: BotSettingKey): void {
    if (!this.savesOf(botId).errors[key]) return;
    this.#updateSaves(botId, (saves) => ({ ...saves, errors: withoutSetting(saves.errors, key) }));
  }

  /** The ChatGPT login GPT-Live calls use; a read under way is shared. A failed read leaves Call hidden. */
  loadCallsStatus(): Promise<void> {
    this.#callsStatusLoading ??= loadCallsStatus().then(
      (status) => {
        this.callsStatus = status;
        this.#host.requestUpdate();
      },
      () => { this.callsStatus = undefined; },
    ).finally(() => { this.#callsStatusLoading = undefined; });
    return this.#callsStatusLoading;
  }

  /** Call shows whenever GPT-Live can run: with a ChatGPT login. */
  callsAvailable(): boolean {
    return callsReady(this.callsStatus);
  }

  /** The Calls section: GPT-Live's default voice, which a bot's "Default" follows, and whether a ChatGPT login lets
   * calls run. That is left out until the gateway has said, so a signed-in operator never sees the hint flash. */
  settingsCall(): BotSettingsProps["call"] {
    return { defaultVoice: this.#deps.control.settings.calls.voice, ...(this.callsStatus ? { ready: callsReady(this.callsStatus) } : {}) };
  }

  /** Opens the archive and delete confirmations once they render, focus on Cancel. */
  showDialogs(): void {
    for (const [open, selector, focus] of [[this.archiving, ".bot-archive-dialog", ".bot-archive-cancel"], [this.deleting, ".bot-delete-dialog", ".bot-delete-cancel"]] as const) {
      if (!open) continue;
      const dialog = this.#host.renderRoot.querySelector?.(selector);
      if (dialog instanceof HTMLDialogElement && !dialog.open) {
        ensureModal(dialog);
        dialog.querySelector<HTMLButtonElement>(focus)?.focus();
      }
    }
  }

  /** A bot made here or imported: in the list at once, its chat (a new session) open. */
  #opened(bot: BotView): void {
    this.adopt(upsertBot(this.list, bot));
    void this.refresh();
    // The new chat is a new session; open the bot once the list has it.
    this.#deps.refreshSessions();
    this.#deps.navigate({ kind: "bot", id: bot.id });
  }

  /**
   * + (and the empty roster's New bot), as in Grok Bot: no form. The bot is created at once, on this machine or, from
   * +'s menu while a remote worker exists, on the worker chosen, where it stays. It has no name, so the gateway calls it
   * "New Bot", and everything else starts on the defaults with the face its id picks; its chat opens, where its first
   * turn has already started asking what to call it, and its Settings page changes the rest. A refusal (a worker HUI is
   * not connected to, say) shows in the roster's notice.
   */
  create = (worker?: string) => {
    if (this.creating) return;
    this.#set({ creating: true });
    // A worker can take a moment: the roster says where the bot is being made.
    if (worker) {
      this.#deps.notify(`Creating a bot on ${this.#deps.workers().find((candidate) => candidate.id === worker)?.name ?? "the worker"}…`);
    }
    void createBot(worker ? { worker } : {})
      .then((bot) => {
        this.#deps.notify("");
        this.#opened(bot);
      })
      .catch((error: unknown) => {
        this.#deps.notify(error instanceof Error ? error.message : "Could not create a bot.", true);
      })
      .finally(() => {
        this.#set({ creating: false });
      });
  };

  /** An imported bot opens like a new one. */
  imported(bot: BotView, warnings: readonly string[]): void {
    if (warnings.length) this.#deps.notify(`Imported ${bot.name}. ${warnings.join(" ")}`, true);
    this.#opened(bot);
  }

  toggleShowHidden = () => this.#set({ showHidden: !this.showHidden });

  toggleShowArchived = () => this.#set({ showArchived: !this.showArchived });

  setHidden = (bot: BotView, hidden: boolean) => {
    if (this.pendingId) return;
    this.#set({ pendingId: bot.id });
    void updateBot(bot.id, { hidden })
      .then((updated) => {
        this.adopt(upsertBot(this.list, updated));
        // With nothing hidden any more, the next hidden bot starts out of sight again.
        if (!hiddenBotCount(this.list)) this.#set({ showHidden: false });
        this.#deps.notify(hidden ? `${updated.name} is hidden. Show hidden lists it again.` : `${updated.name} is back in the roster.`);
      })
      .catch((error: unknown) => {
        this.#deps.notify(error instanceof Error ? error.message : "Could not change that bot.", true);
      })
      .finally(() => {
        this.#set({ pendingId: "" });
      });
  };

  requestArchive = (bot: BotView) => {
    this.#set({ archiving: bot, archiveError: "" });
  };

  closeArchive = () => {
    const dialog = this.#host.renderRoot.querySelector?.(".bot-archive-dialog");
    if (dialog instanceof HTMLDialogElement) closeModal(dialog);
    this.#set({ archiving: undefined, archiveError: "" });
  };

  confirmArchive = () => {
    const bot = this.archiving;
    if (!bot || this.archivePending) return;
    this.#set({ archivePending: true, archiveError: "" });
    void archiveBot(bot.id)
      .then((archived) => {
        this.closeArchive();
        this.adopt(upsertBot(this.list, archived));
        this.#deps.notify("");
        this.#set({ archiveToast: { bot: archived, restoring: false } });
        this.scheduleToast();
        if (this.#deps.shownBotId() === bot.id) this.#deps.navigate({ kind: "home" }, true);
        void this.refresh();
        this.#deps.refreshSessions();
      })
      .catch((error: unknown) => {
        this.#set({ archiveError: error instanceof Error ? error.message : "Could not archive that bot." });
      })
      .finally(() => {
        this.#set({ archivePending: false });
      });
  };

  /** Delete (the ⋯ menus, or Show archived's trash icon) asks first: deleting cannot be undone. */
  requestDelete = (bot: BotView) => {
    if (this.pendingId) return;
    this.#set({ deleting: bot, deleteError: "" });
  };

  closeDelete = () => {
    const dialog = this.#host.renderRoot.querySelector?.(".bot-delete-dialog");
    if (dialog instanceof HTMLDialogElement) closeModal(dialog);
    this.#set({ deleting: undefined, deleteError: "" });
  };

  /** The row stays until the gateway confirms; a failure stays in the dialog. */
  confirmDelete = () => {
    const bot = this.deleting;
    if (!bot || this.deletePending) return;
    this.#set({ deletePending: true, deleteError: "", pendingId: bot.id });
    void deleteBot(bot.id)
      .then(() => {
        this.closeDelete();
        this.adopt(this.list.filter((each) => each.id !== bot.id));
        if (!archivedBotCount(this.list)) this.#set({ showArchived: false });
        if (this.archiveToast?.bot.id === bot.id) this.dismissToast();
        this.#deps.notify(`Deleted ${bot.name}.`);
        // Its chat is gone: the open bot view goes with it, as after archiving.
        if (this.#deps.shownBotId() === bot.id) this.#deps.navigate({ kind: "home" }, true);
        void this.refresh();
        this.#deps.refreshSessions();
      })
      .catch((error: unknown) => {
        this.#set({ deleteError: error instanceof Error ? error.message : "Could not delete that bot." });
      })
      .finally(() => {
        this.#set({ deletePending: false, pendingId: "" });
      });
  };

  /** Restore from Show archived: the row stays until the gateway confirms. */
  restore = (bot: BotView) => {
    if (this.pendingId) return;
    this.#set({ pendingId: bot.id });
    void restoreBot(bot.id)
      .then((restored) => {
        this.adopt(upsertBot(this.list, restored));
        // With nothing archived any more, the next archived bot starts out of sight again.
        if (!archivedBotCount(this.list)) this.#set({ showArchived: false });
        if (this.archiveToast?.bot.id === restored.id) this.dismissToast();
        this.#deps.notify(`Restored ${restored.name}. Its routines stay paused until you turn them on.`);
        void this.refresh();
      })
      .catch((error: unknown) => {
        this.#deps.notify(error instanceof Error ? error.message : "Could not restore that bot.", true);
      })
      .finally(() => {
        this.#set({ pendingId: "" });
      });
  };

  pauseToast = () => {
    if (this.#archiveToastTimer) clearTimeout(this.#archiveToastTimer);
    this.#archiveToastTimer = undefined;
  };

  dismissToast = () => {
    this.pauseToast();
    this.#set({ archiveToast: undefined });
  };

  /** Same lifetime as the session archive toast: 15 s without hover or focus. */
  scheduleToast = () => {
    this.pauseToast();
    if (!this.archiveToast || this.archiveToast.restoring || this.archiveToast.error) return;
    const element = this.#host.renderRoot.querySelector(".bot-archive-toast");
    if (element?.matches(":hover") || element?.contains(document.activeElement)) return;
    this.#archiveToastTimer = setTimeout(this.dismissToast, 15_000);
  };

  restoreFromToast = async () => {
    const toast = this.archiveToast;
    if (!toast || toast.restoring || this.pendingId) return;
    this.pauseToast();
    this.#set({ archiveToast: { bot: toast.bot, restoring: true }, pendingId: toast.bot.id });
    try {
      const restored = await restoreBot(toast.bot.id);
      this.adopt(upsertBot(this.list, restored));
      if (this.archiveToast?.bot.id === toast.bot.id) this.dismissToast();
      this.#deps.notify(`Restored ${restored.name}. Its routines stay paused until you turn them on.`);
      void this.refresh();
      this.#deps.refreshSessions();
    } catch (error) {
      if (this.archiveToast?.bot.id === toast.bot.id) {
        this.#set({ archiveToast: { bot: toast.bot, restoring: false, error: error instanceof Error ? error.message : "Could not restore that bot." } });
      }
    } finally {
      this.#set({ pendingId: "" });
    }
  };
}
