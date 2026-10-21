/**
 * The one place bots touch OptChat (docs/optchat.md), the memory engine of Pi
 * Durable conversations.
 *
 * Bots never reach the engine, its files or its Durable document directly:
 * everything goes through `BotMemory`, so the bot lifecycle is tested with a
 * fake and the real adapter, `optChatBotMemory`, stays a thin mapping onto
 * OptChat's helpers and its manager (`DurableHost.optchat`). Conversations are
 * named by their HUI resume reference (`durable:<id>`).
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { BotMemoryStatus } from "../bots-format.ts";
import { durableContext, type DurableHost } from "../runtimes/durable-host.ts";
import { configureOptChat, enableOptChat } from "../runtimes/durable-optchat.ts";
import { durableConversationId } from "../runtimes/durable.ts";

/** OptChat settings of one bot's chat: the agent name its prompts use, and the compactor's model. */
export type BotMemorySettings = {
  name: string;
  /** `provider/id`; absent: the conversation's own model. */
  model?: string;
  thinking?: string;
};

export interface BotMemory {
  /** Turns OptChat on inside the commit that creates the bot's conversation, so no prompt reaches it first. */
  enable(tx: Tx, conversationId: ConversationId, settings: BotMemorySettings): Promise<void>;
  /** Changes the agent name or compactor model of an existing bot's memory. */
  configure(reference: string, settings: BotMemorySettings): Promise<void>;
  /** Turns OptChat off inside the caller's commit (a deleted bot's chat), so nothing reads its memory back. */
  disable(tx: Tx, conversationId: ConversationId): Promise<void>;
  /** Deletes the memory files of a chat whose OptChat is off; nothing to delete is fine. */
  purge(reference: string): Promise<void>;
  /** Undefined when the gateway cannot read the chat's memory. */
  status(reference: string): Promise<BotMemoryStatus | undefined>;
  /** The rendered current view, `<chat>…</chat>`, once the memory has caught up with its chat. */
  view(reference: string): Promise<string>;
  /** OptChat's `zoom(id, n)` output, its own errors included as text. */
  zoom(reference: string, id: number, n: number): Promise<string>;
  /** The self-contained browse page. */
  html(reference: string): Promise<string>;
  /** Status changes of one memory, for live views. */
  subscribe(reference: string, listener: (status: BotMemoryStatus) => void): () => void;
}

/** The memory routes answer 503 with this message. */
export class BotMemoryUnavailableError extends Error {
  override name = "BotMemoryUnavailableError";
  constructor(message = "This bot's chat has no OptChat memory in this gateway.") {
    super(message);
  }
}

/**
 * OptChat in this gateway's Durable store. Its manager answers `undefined` for a conversation without OptChat, or
 * while this process does not own the store: views then carry no `memory` and the memory routes answer 503.
 */
export function optChatBotMemory(host: DurableHost): BotMemory {
  /** The conversation a reference names, once the store is open: the manager reads nothing before. */
  const conversation = async (reference: string): Promise<ConversationId> => {
    const id = durableConversationId(reference);
    if (id === undefined) throw new BotMemoryUnavailableError("This bot's chat is not a Durable conversation.");
    await host.open();
    return id;
  };
  const read = async (reference: string, query: (id: ConversationId) => Promise<string | undefined>): Promise<string> => {
    const text = await query(await conversation(reference));
    if (text === undefined) throw new BotMemoryUnavailableError();
    return text;
  };
  return {
    // The bots' boundary validated the settings; OptChat checks them again in the same commit.
    enable: (tx, conversationId, settings) => enableOptChat(tx, conversationId, {
      name: settings.name,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.thinking ? { thinking: settings.thinking as ModelThinkingLevel } : {}),
    }),
    disable: (tx, conversationId) => configureOptChat(tx, conversationId, { enabled: false }),
    async purge(reference) {
      await host.optchat.purge(await conversation(reference));
    },
    async configure(reference, settings) {
      const id = await conversation(reference);
      const found = await (await host.open()).conversation(id, durableContext);
      if (!found) throw new BotMemoryUnavailableError("This bot's conversation is not in this gateway's Durable store.");
      // The whole setting: an absent model or thinking level goes back to OptChat's default.
      await configureOptChat(found, {
        name: settings.name,
        model: settings.model ?? null,
        thinking: (settings.thinking as ModelThinkingLevel | undefined) ?? null,
      }, durableContext);
    },
    async status(reference) {
      const id = durableConversationId(reference);
      if (id === undefined) return undefined;
      await host.open();
      return host.optchat.status(id);
    },
    view: (reference) => read(reference, (id) => host.optchat.view(id)),
    zoom: (reference, at, n) => read(reference, (id) => host.optchat.zoom(id, at, n)),
    html: (reference) => read(reference, (id) => host.optchat.html(id)),
    subscribe(reference, listener) {
      const id = durableConversationId(reference);
      if (id === undefined) return () => {};
      let stop: (() => void) | undefined;
      let stopped = false;
      // The manager reports a memory only once the store is open.
      void host.open().then(() => { if (!stopped) stop = host.optchat.subscribe(id, listener); }, () => {});
      return () => {
        stopped = true;
        stop?.();
      };
    },
  };
}
