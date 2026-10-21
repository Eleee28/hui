/**
 * `BotToolsController` keeps a bot's Tools & skills page state outside `hui-app.ts`, so the page
 * is self-contained: the app makes one, refreshes it when the page shows, lets
 * it follow the stream, and passes `props(bot)` to the view.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { BotCatalog, BotSkillRef, BotView } from "../api/schema/bots.ts";
import { loadBotCatalog } from "../api/bot-tools.ts";
import { updateBot } from "../api/bots.ts";
import { answerQuestion } from "../api/sessions.ts";
import { botToolsKey, skillsAfter, toolsAfter, type BotAccessAnswer, type BotToolsActions, type BotToolsState } from "../lib/bots/tools.ts";

export type BotToolsApi = {
  load: (id: string) => Promise<BotCatalog>;
  save: (id: string, change: { disabledTools?: string[]; disabledSkills?: BotSkillRef[] }) => Promise<unknown>;
  answer: (sessionId: string, questionId: string, value: BotAccessAnswer) => Promise<void>;
};

const API: BotToolsApi = {
  load: loadBotCatalog,
  save: (id, change) => updateBot(id, change),
  answer: (sessionId, questionId, value) => answerQuestion(sessionId, questionId, { value }),
};

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/** The Tools & skills page's state and actions, for one bot at a time. */
export class BotToolsController implements ReactiveController {
  state: BotToolsState = { botId: "", loading: false, error: "", saving: false, saveError: "", answering: false, query: "" };
  readonly #host: ReactiveControllerHost;
  readonly #api: BotToolsApi;
  #request = 0;
  /** `botToolsKey` of the bot when the catalog was last read. */
  #seen = "";

  constructor(host: ReactiveControllerHost, api: BotToolsApi = API) {
    this.#host = host;
    this.#api = api;
    host.addController(this);
  }

  hostConnected(): void {}

  #set(next: Partial<BotToolsState>): void {
    this.state = { ...this.state, ...next };
    this.#host.requestUpdate();
  }

  /** Another bot: nothing of the last one stays. */
  reset(botId: string): void {
    this.#request += 1;
    this.#seen = "";
    this.state = { botId, loading: false, error: "", saving: false, saveError: "", answering: false, query: "" };
    this.#host.requestUpdate();
  }

  /** Reads the catalog; a failed read keeps what was shown. */
  async refresh(bot: BotView): Promise<void> {
    if (this.state.botId !== bot.id) this.reset(bot.id);
    const request = ++this.#request;
    this.#seen = botToolsKey(bot);
    this.#set({ loading: true });
    try {
      const catalog = await this.#api.load(bot.id);
      if (request !== this.#request) return;
      this.#set({ loading: false, error: "", catalog });
    } catch (error) {
      if (request !== this.#request) return;
      this.#set({ loading: false, error: errorText(error, "Could not read the bot's tools.") });
    }
  }

  /** From the bots stream: read again once the bot changed in a way the catalog shows. */
  follow(bot: BotView): void {
    if (this.state.botId !== bot.id || this.state.saving) return;
    if (botToolsKey(bot) !== this.#seen) void this.refresh(bot);
  }

  async #save(bot: BotView, change: { disabledTools?: string[]; disabledSkills?: BotSkillRef[] }): Promise<void> {
    if (this.state.saving || !this.state.catalog) return;
    this.#set({ saving: true, saveError: "" });
    try {
      await this.#api.save(bot.id, change);
      this.#set({ saving: false });
      await this.refresh(bot);
    } catch (error) {
      this.#set({ saving: false, saveError: errorText(error, "Could not change the bot's tools.") });
    }
  }

  async #answer(bot: BotView, value: BotAccessAnswer): Promise<void> {
    const request = this.state.catalog?.request;
    if (!request || this.state.answering) return;
    this.#set({ answering: true, saveError: "" });
    try {
      await this.#api.answer(request.sessionId, request.id, value);
      this.#set({ answering: false });
      await this.refresh(bot);
    } catch (error) {
      this.#set({ answering: false, saveError: errorText(error, "Could not answer the request.") });
    }
  }

  /** The tab's view state and callbacks for `bot`. */
  props(bot: BotView): { state: BotToolsState } & BotToolsActions {
    const state = this.state.botId === bot.id ? this.state : { ...this.state, botId: bot.id, loading: true, catalog: undefined, error: "" };
    return {
      state,
      onToggleTool: (name, enabled) => {
        const catalog = this.state.catalog;
        if (catalog) void this.#save(bot, { disabledTools: toolsAfter(catalog, name, enabled) });
      },
      onToggleSkill: (skill, enabled) => {
        const catalog = this.state.catalog;
        if (catalog) void this.#save(bot, { disabledSkills: skillsAfter(catalog, skill, enabled) });
      },
      onSearch: (query) => { this.#set({ query }); },
      onAnswer: (value) => { void this.#answer(bot, value); },
      onRetry: () => { void this.refresh(bot); },
    };
  }
}
