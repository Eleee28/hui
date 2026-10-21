/** The explicit-memory page's confirmed server state, read and changed through src/api/bot-facts.ts; no extraction,
 * optimistic saves or cross-bot leakage. */
import type { ReactiveControllerHost } from "lit";
import type { BotFact, BotFactInput, BotFactPatch } from "../api/schema/bots.ts";
import { botFactsApi, type BotFactsApi } from "../api/bot-facts.ts";
import type { BotFactsState } from "../lib/bots/facts.ts";
export class BotFactsController {
  state: BotFactsState = { botId: "", facts: [], loading: false, loaded: false, pending: false, error: "" };
  #host: Pick<ReactiveControllerHost, "requestUpdate">;
  #api: BotFactsApi;
  #request = 0;
  constructor(host: Pick<ReactiveControllerHost, "requestUpdate">, client: BotFactsApi = botFactsApi) { this.#host = host; this.#api = client; }
  #set(change: Partial<BotFactsState>) { this.state = { ...this.state, ...change }; this.#host.requestUpdate(); }
  reset(botId: string) { this.#request++; this.state = { botId, facts: [], loading: false, loaded: false, pending: false, error: "" }; this.#host.requestUpdate(); }
  async load(botId: string, force = false): Promise<void> {
    if (this.state.botId !== botId) this.reset(botId);
    if (this.state.loading || this.state.pending || (this.state.loaded && !force)) return;
    const request = ++this.#request;
    this.#set({ loading: true, error: "" });
    try { const facts = await this.#api(botId, "GET"); if (request === this.#request) this.#set({ facts, loaded: true }); }
    catch (error) { if (request === this.#request) this.#set({ error: error instanceof Error ? error.message : "Could not load memories." }); }
    finally { if (request === this.#request) this.#set({ loading: false }); }
  }
  edit(fact?: BotFact) { this.#set({ editing: fact, error: "" }); }
  remove(fact?: BotFact) { this.#set({ removing: fact, error: "" }); }
  async save(input: BotFactInput): Promise<boolean> {
    const editing = this.state.editing;
    return this.#mutate(editing ? "PATCH" : "POST", editing?.id, editing ? { kind: input.kind, text: input.text, pinned: input.pinned ?? editing.pinned, revision: editing.revision } : input, true);
  }
  pin(fact: BotFact) { return this.#mutate("PATCH", fact.id, { pinned: !fact.pinned, revision: fact.revision }); }
  confirmDelete() { const fact = this.state.removing; return fact ? this.#mutate("DELETE", fact.id, fact.revision) : Promise.resolve(false); }
  async #mutate(method: string, id?: string, value?: BotFactInput | BotFactPatch | number, clearEditing = false): Promise<boolean> {
    if (this.state.pending || this.state.loading || !this.state.loaded) return false;
    const request = ++this.#request;
    const botId = this.state.botId;
    this.#set({ pending: true, error: "" });
    try {
      const facts = await this.#api(botId, method, id, value);
      if (request !== this.#request) return false;
      let editing = this.state.editing;
      if (clearEditing || (method === "DELETE" && editing?.id === id)) editing = undefined;
      else if (editing && editing.id === id) {
        const saved = facts.find((fact) => fact.id === id);
        if (saved) editing = { ...editing, revision: saved.revision, pinned: saved.pinned, updatedAt: saved.updatedAt };
      }
      this.#set({ facts, editing, ...(method === "DELETE" ? { removing: undefined } : {}) });
      return true;
    } catch (error) { if (request === this.#request) this.#set({ error: error instanceof Error ? error.message : "Could not save memory." }); return false; }
    finally { if (request === this.#request) this.#set({ pending: false }); }
  }
}
