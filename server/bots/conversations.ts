/**
 * The Durable side of bots' chats (HUI-18): creating a bot's conversation in
 * one commit with its agent, its `hui.bot` document and OptChat; changing its
 * directory (or clearing the instructions a bot had before SOUL.md); what the
 * operator turned off in it and what they can turn off; the model and thinking
 * level a new chat would get; and reading its newest message while no session
 * has it loaded. The gateway is the store's only writer, so these
 * run in it. A bot's persona is not in its conversation: it is the SOUL.md the
 * `soul` section reads on every request.
 */
import { clampThinkingLevel, type Message, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ResetEntry, SystemEntry, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { botKickoffName, previewLine } from "../bots-format.ts";
import { callMinutes, parseCallRecord } from "../calls-format.ts";
import type { BotMemory } from "./memory.ts";
import type { BotConversations, BotStoredMessage } from "./service.ts";
import { BotInputError, BotNotFoundError } from "./bots.ts";
import { BotDoc, conversationBotState } from "./durable.ts";
import { BOT_ALWAYS_ON, builtinBotOffer, offeredSkill } from "./durable-access.ts";
import { ExtensionMessageEntry, isCustomInput } from "../runtimes/durable-extensions.ts";
import { durableContext, type DurableHost } from "../runtimes/durable-host.ts";
import { defaultThinking, durableConversationId, durableReference, initialModel, modelRef, textOf } from "../runtimes/durable.ts";
import { restoreAttachmentNames } from "../runtimes/pi.ts";
import { CallEntry } from "../runtimes/turn-origins.ts";

/** Where the Tools & skills page says a bot's own skills (`skills/` in its home folder) come from. */
export const BOT_OWN_SKILLS_SOURCE = "Its own skills";

/** Entries a cold read looks back through for the newest message. */
const LAST_MESSAGE_ENTRIES = 50;

export type BotConversationOptions = {
  /** Settings' primary model (`settings.models.primary`), the one a session started without a choice uses; empty or
   * undefined while none is set. */
  primaryModel?: () => Promise<string | undefined>;
};

export function durableBotConversations(host: DurableHost, memory: BotMemory, options: BotConversationOptions = {}): BotConversations {
  const conversation = async (reference: string): Promise<Conversation> => {
    const id = durableConversationId(reference);
    const found = id === undefined ? undefined : await (await host.open()).conversation(id, durableContext);
    if (!found) throw new BotNotFoundError("This bot's conversation is not in this gateway's Durable store.");
    return found;
  };
  const checkModel = async (value: string): Promise<void> => {
    await host.open();
    await host.refreshModels();
    const ref = modelRef(value);
    if (!ref || !host.models.getModel(ref.provider, ref.modelId)) throw new BotInputError(`Unknown model: ${value}`);
  };
  /** A bot's chat without a model of its own starts on Settings' primary model, like a new session; PI's default (else
   * the first available model) only while no primary is set. A primary this gateway cannot resolve is refused. */
  const startingModel = async (cwd: string, requested: string | undefined) => {
    const primary = requested ? undefined : (await options.primaryModel?.())?.trim();
    if (primary) await checkModel(primary);
    return initialModel(host, cwd, requested ?? (primary || undefined));
  };
  return {
    checkModel,

    async create(input) {
      const harness = await host.open();
      if (input.model) await checkModel(input.model);
      else await host.refreshModels();
      if (input.memory.model) await checkModel(input.memory.model);
      const model = await startingModel(input.cwd, input.model);
      const known = model ? host.models.getModel(model.provider, model.modelId) : undefined;
      const thinking = input.thinking ?? defaultThinking(host, input.cwd);
      // One commit: no prompt can reach the chat before its bot document (which brings its soul section) and its memory
      // are in place.
      const created = await harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: {
          cwd: input.cwd,
          ...(model ? { model } : {}),
          ...(thinking && known ? { thinkingLevel: clampThinkingLevel(known, thinking as ModelThinkingLevel) } : {}),
        },
        init: async (tx, conversationId) => {
          const doc = await tx.doc(BotDoc, conversationId);
          doc.bot = input.botId;
          // Off from the first turn: the kickoff runs with the lists already in place.
          if (input.access?.disabledTools.length) doc.disabledTools = [...input.access.disabledTools];
          if (input.access?.disabledSkills.length) doc.disabledSkills = input.access.disabledSkills.map(({ name, path }) => ({ name, path }));
          await memory.enable(tx, conversationId, input.memory);
        },
      }, durableContext);
      return durableReference(created.id);
    },

    // One commit: the conversation stops being a bot's chat (no bot sections or tools) and OptChat is off, so nothing
    // reads its memory back; then OptChat's files go. pi-durable cannot delete a conversation, so its raw log stays.
    async forget(reference) {
      const id = durableConversationId(reference);
      if (id === undefined) return;
      const harness = await host.open();
      if (!await harness.conversation(id, durableContext)) return;
      await harness.commit(async (tx) => {
        const doc = await tx.doc(BotDoc, id);
        doc.bot = "";
        delete doc.disabledTools;
        delete doc.disabledSkills;
        await memory.disable(tx, id);
      }, durableContext);
      await memory.purge(reference);
    },

    async access(reference) {
      const found = await conversation(reference);
      const state = await conversationBotState(await host.open(), found.id, durableContext);
      return { disabledTools: state?.disabledTools ?? [], disabledSkills: state?.disabledSkills ?? [] };
    },

    // The document is the truth wherever the chat runs; the live view, if any, offers its tools again from it.
    async setAccess(reference, access) {
      const found = await conversation(reference);
      await (await host.open()).commit(async (tx) => {
        const doc = await tx.doc(BotDoc, found.id);
        if (!doc.bot) throw new BotNotFoundError("This conversation is no bot's chat.");
        if (access.disabledTools.length) doc.disabledTools = [...access.disabledTools];
        else delete doc.disabledTools;
        if (access.disabledSkills.length) doc.disabledSkills = access.disabledSkills.map(({ name, path }) => ({ name, path }));
        else delete doc.disabledSkills;
      }, durableContext);
      await host.chatFor(found.id)?.applyTools();
    },

    async offer(reference, cwd) {
      await host.open();
      const id = reference === undefined ? undefined : durableConversationId(reference);
      const chat = id === undefined ? undefined : host.chatFor(id);
      // A bot's own skills come with its directory's, labelled as its own; before its conversation exists it has none.
      const own = id === undefined ? [] : await host.skillDirsFor(id);
      const skills = chat ? await chat.availableSkills() : (await host.prompt.loader(cwd, own)).getSkills().skills;
      return {
        tools: chat ? [...chat.botOffer()] : await builtinBotOffer(host),
        skills: skills.map((skill) => own.some((dir) => skill.filePath.startsWith(`${dir}/`)) ? { ...offeredSkill(skill), source: BOT_OWN_SKILLS_SOURCE } : offeredSkill(skill)),
        alwaysOn: [...BOT_ALWAYS_ON],
        live: Boolean(chat),
      };
    },

    async configure(reference, change) {
      await (await conversation(reference)).configure({
        ...(change.instructions !== undefined ? { instructions: change.instructions } : {}),
        ...(change.cwd !== undefined ? { cwd: change.cwd } : {}),
      }, durableContext);
    },

    // What the dialog calls "Gateway default": Settings' primary model, as for a new session, else PI's default.
    async defaultModel(cwd) {
      await host.open();
      await host.refreshModels();
      const model = await startingModel(cwd, undefined);
      return model ? `${model.provider}/${model.modelId}` : undefined;
    },

    async defaultThinking(cwd, model) {
      await host.open();
      const ref = modelRef(model);
      const known = ref ? host.models.getModel(ref.provider, ref.modelId) : undefined;
      const requested = defaultThinking(host, cwd);
      // A new conversation without a level stored runs at Durable's "off".
      return requested && known ? clampThinkingLevel(known, requested as ModelThinkingLevel) : "off";
    },

    // One passive, data-only write: Durable appends it at once, during a running turn too. Admitted once the store
    // schedules work, as extensions' writes are.
    async writeCallRecord(reference, record) {
      const found = await conversation(reference);
      await host.resumed;
      await found.submit({ type: "write", entry: { kind: CallEntry.kind, data: JSON.parse(JSON.stringify(record)) } }, durableContext);
    },

    async lastMessage(reference) {
      const page = await (await conversation(reference)).entries({}, LAST_MESSAGE_ENTRIES, undefined, durableContext);
      // Newest first; a reset starts a new context the transcript shows from.
      for (const entry of page.items) {
        if (ResetEntry.is(entry)) return undefined;
        const message = shownMessage(entry);
        if (message) return message;
      }
      return undefined;
    },
  };
}

/** The newest user or assistant text an entry shows in the transcript, as the transcript projects it. */
function shownMessage(entry: EntryRecord): BotStoredMessage | undefined {
  if (CallEntry.is(entry)) {
    const record = parseCallRecord(entry.data);
    if (!record) return undefined;
    const text = previewLine(`📞 Call · ${callMinutes(record)} min${record.summary ? ` · ${record.summary.replace(/[*#_]/gu, "")}` : ""}`);
    return { role: "assistant", text, ...(Number.isFinite(record.endedAt) ? { at: new Date(record.endedAt).toISOString() } : {}) };
  }
  if (SystemEntry.is(entry) || ExtensionMessageEntry.is(entry)) return undefined;
  for (const message of [...entry.model ?? []].reverse() as Message[]) {
    if ((message.role !== "user" && message.role !== "assistant") || isCustomInput(message)) continue;
    const raw = textOf(message);
    // HUI's kickoff is a note in the chat, not a message.
    if (message.role === "user" && botKickoffName(raw) !== undefined) continue;
    const text = previewLine(message.role === "user" ? restoreAttachmentNames(raw).text : raw);
    if (!text) continue;
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    return {
      role: message.role,
      text,
      ...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { at: new Date(timestamp).toISOString() } : {}),
    };
  }
  return undefined;
}
