/**
 * `BotTriggersController` keeps a bot's triggers section state outside `hui-app.ts`, as the Tools & skills page's
 * controller does: it reads the triggers while the section shows (again every few seconds, since triggers fire on
 * their own), adds, switches, tests and deletes them through `api/bot-triggers.ts`, and shows a trigger's URL, which
 * its listener reports to, once, right after it was made or replaced.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BotTrigger, BotTriggerCreated, BotTriggerInput, BotTriggerPatch, BotTriggerRun, BotTriggersList } from "../api/schema/bot-triggers.ts";
import type { BotView } from "../api/schema/bots.ts";
import { botTriggersApi } from "../api/bot-triggers.ts";
import { writeClipboardText } from "../lib/clipboard.ts";
import { TRIGGERS_POLL_MS, type BotTriggersActions, type BotTriggersState } from "../lib/bots/triggers.ts";

export type BotTriggersApi = {
  list(botId: string): Promise<BotTriggersList>;
  create(botId: string, input: BotTriggerInput): Promise<BotTriggerCreated>;
  update(botId: string, triggerId: string, patch: BotTriggerPatch): Promise<BotTrigger>;
  remove(botId: string, triggerId: string): Promise<void>;
  test(botId: string, triggerId: string): Promise<BotTriggerRun>;
  rotate(botId: string, triggerId: string): Promise<BotTriggerCreated>;
  copy(text: string): Promise<boolean>;
  /** The page's origin, which a trigger's URL starts with. */
  origin(): string;
};

const API: BotTriggersApi = {
  ...botTriggersApi,
  copy: (text) => writeClipboardText(text),
  origin: () => (typeof location === "undefined" ? "" : location.origin),
};

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

const EMPTY: Omit<BotTriggersState, "botId"> = { loading: false, error: "", pending: false, actionError: "", formError: "", notice: "" };

export class BotTriggersController implements ReactiveController {
  state: BotTriggersState = { botId: "", ...EMPTY };
  readonly #host: ReactiveControllerHost;
  readonly #api: BotTriggersApi;
  readonly #visible: () => boolean;
  #request = 0;
  #timer?: ReturnType<typeof setInterval>;
  #watched?: BotView;
  /** The bot and its chat's status when `follow` last looked. */
  #followed = "";

  /** `visible`: whether the section still shows; the timer stops by itself once it doesn't. */
  constructor(host: ReactiveControllerHost, options: { api?: BotTriggersApi; visible?: () => boolean } = {}) {
    this.#host = host;
    this.#api = options.api ?? API;
    this.#visible = options.visible ?? (() => true);
    host.addController(this);
  }

  hostConnected(): void {}

  hostDisconnected(): void {
    this.sync(undefined);
  }

  #set(next: Partial<BotTriggersState>): void {
    this.state = { ...this.state, ...next };
    this.#host.requestUpdate();
  }

  /** Another bot: nothing of the last one stays, its revealed URL least of all. */
  reset(botId: string): void {
    this.#request += 1;
    this.state = { botId, ...EMPTY };
    this.#host.requestUpdate();
  }

  /** The section shows for `bot` (read now, then every few seconds) or no longer shows (undefined). */
  sync(bot: BotView | undefined): void {
    if (!bot) {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = undefined;
      this.#watched = undefined;
      return;
    }
    const changed = this.#watched?.id !== bot.id;
    this.#watched = bot;
    if (changed || !this.#timer) {
      void this.refresh(bot);
      if (!this.#timer) {
        this.#timer = setInterval(() => {
          if (!this.#visible()) this.sync(undefined);
          else if (this.#watched && !this.state.pending) void this.refresh(this.#watched);
        }, TRIGGERS_POLL_MS);
      }
    }
  }

  /** From the bots stream while the section shows: starts reading once the bot is known, and reads again when its chat
   * changes state (a trigger may just have woken it). */
  follow(bot: BotView): void {
    const key = `${bot.id}|${bot.status}`;
    if (this.#watched?.id !== bot.id || !this.#timer) {
      this.#followed = key;
      this.sync(bot);
      return;
    }
    this.#watched = bot;
    if (key === this.#followed) return;
    this.#followed = key;
    if (!this.state.pending) void this.refresh(bot);
  }

  /** Reads the triggers; a failed read keeps what was shown. */
  async refresh(bot: BotView): Promise<void> {
    if (this.state.botId !== bot.id) this.reset(bot.id);
    const request = ++this.#request;
    this.#set({ loading: true });
    try {
      const list = await this.#api.list(bot.id);
      if (request !== this.#request) return;
      this.#set({ loading: false, error: "", list });
    } catch (error) {
      if (request !== this.#request) return;
      this.#set({ loading: false, error: errorText(error, "Could not read the bot's triggers.") });
    }
  }

  async #act(bot: BotView, work: () => Promise<Partial<BotTriggersState> | void>, surface: "form" | "action", fallback: string): Promise<boolean> {
    if (this.state.pending) return false;
    this.#set({ pending: true, actionError: "", formError: "", notice: "" });
    try {
      const next = await work();
      this.#set({ pending: false, ...(next ?? {}) });
      await this.refresh(bot);
      return true;
    } catch (error) {
      this.#set({ pending: false, ...(surface === "form" ? { formError: errorText(error, fallback) } : { actionError: errorText(error, fallback) }) });
      return false;
    }
  }

  #reveal(created: BotTriggerCreated): Partial<BotTriggersState> {
    return { revealed: { triggerId: created.trigger.id, name: created.trigger.name, url: `${this.#api.origin()}${created.hook.path}`, copied: false } };
  }

  props(bot: BotView): { state: BotTriggersState } & BotTriggersActions {
    const state = this.state.botId === bot.id ? this.state : { botId: bot.id, ...EMPTY, loading: true };
    return {
      state,
      onCreate: (input) => this.#act(bot, async () => this.#reveal(await this.#api.create(bot.id, input)), "form", "Could not add the trigger."),
      onFormError: (message) => { this.#set({ formError: message }); },
      onToggle: (trigger, enabled) => { void this.#act(bot, async () => { await this.#api.update(bot.id, trigger.id, { enabled }); }, "action", "Could not switch the trigger."); },
      onTest: (trigger) => {
        void this.#act(bot, async () => {
          const run = await this.#api.test(bot.id, trigger.id);
          return { notice: run.status === "fired" ? `Sent a test event to ${bot.name}'s chat.` : `The test did not reach ${bot.name}: ${run.reason ?? run.status}.` };
        }, "action", "Could not test the trigger.");
      },
      onDelete: (trigger) => {
        void this.#act(bot, async () => {
          await this.#api.remove(bot.id, trigger.id);
          return this.state.revealed?.triggerId === trigger.id ? { revealed: undefined } : {};
        }, "action", "Could not delete the trigger.");
      },
      onRotate: (trigger) => { void this.#act(bot, async () => this.#reveal(await this.#api.rotate(bot.id, trigger.id)), "action", "Could not replace the URL."); },
      onCopy: () => {
        const revealed = this.state.revealed;
        if (!revealed) return;
        void this.#api.copy(revealed.url).then((copied) => {
          if (this.state.revealed?.url === revealed.url) this.#set({ revealed: { ...revealed, copied } });
        });
      },
      onDismissUrl: () => { this.#set({ revealed: undefined }); },
      onRetry: () => { void this.refresh(bot); },
    };
  }
}
