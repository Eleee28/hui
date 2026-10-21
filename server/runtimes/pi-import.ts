/**
 * Moves a PI session into a Pi Durable conversation; `hui doctor --fix` runs it for every session still on PI.
 *
 * The PI file is only read, as text: PI's `SessionManager` and `loadEntriesFromFile` may rewrite it (a format
 * upgrade, a missing final newline). PI's pure helpers then upgrade the entries in memory and project each one into
 * the messages PI sends the model. The active branch, from the last entry PI wrote back to the root, becomes the
 * conversation's history in order: its pi-ai messages as Durable user, assistant and tool-result entries, each
 * compaction as Durable's summary entry whose `head` is PI's first kept entry, and each context edit as a Durable
 * edit. The next request therefore carries what PI would have sent, after Durable's own system prompt. Entries on
 * abandoned branches stay only in the PI file; their spend is still counted.
 *
 * The conversation, its spend (`pi.usage`) and an index entry keyed by the HUI session are written in one commit:
 * a crash leaves nothing or a complete copy, and a rerun reuses that copy while the PI file is unchanged.
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm, migrateSessionEntries, parseSessionEntries, sessionEntryToContextMessages, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry, CompactionEntry, defineDocFamily, ToolResultEntry, UsageDoc, UserEntry,
  type ConversationId, type EntryDraft, type EntryId,
} from "@earendil-works/pi-durable";
import { transcriptUsage } from "../observability.ts";
import { durableContext, type DurableHost } from "./durable-host.ts";
import { fitThinking } from "./model-controls.ts";
import { defaultThinking, initialModel, modelRef, SUMMARY_PREFIX, SUMMARY_SUFFIX } from "./durable.ts";

type ModelRef = { provider: string; modelId: string };
/** Durable's usage counters (`pi.usage`), every one present: Durable adds later turns to them. */
type DurableUsage = {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
type Edit = { target: number; action: "omit" } | { target: number; action: "replace"; messages: Message[] };
/** One Durable entry to write; `head` and edit targets name earlier drafts by index. */
export type PiImportDraft = { kind: string; model?: Message[]; data?: JsonValue; head?: number | "self"; edits?: Edit[] };

export type PiImportPlan = {
  drafts: PiImportDraft[];
  /** Spend by `provider/model`, as HUI totals the PI file: every record, abandoned branches included. */
  usage: Record<string, DurableUsage>;
  /** The model and thinking level the branch last used. */
  model?: ModelRef;
  thinkingLevel?: string;
  /** Entries that carry model messages: user input, answers, tool results and PI's own message kinds. */
  messages: number;
  summaries: number;
  /** Entries off the active branch, left only in the PI file. */
  abandoned: number;
};

export type PiImportResult = {
  conversationId: ConversationId;
  /** An earlier run had already copied this unchanged file. */
  reused: boolean;
  messages: number;
  summaries: number;
  abandoned: number;
  /** `provider/model` the conversation continues on. */
  model?: string;
};

/** An entry with no model messages that overrides an earlier entry's contribution, as PI's `context_edit` does. */
export const CONTEXT_EDIT_KIND = "hui.context-edit";

/** Store-wide index of imported PI sessions by HUI session, so a rerun finds the copy instead of making another. */
export const PiImportDoc = defineDocFamily({
  kind: "hui.pi-import",
  version: 1,
  scope: "session",
  family: true,
  initial: (huiSessionId: string) => ({
    huiSessionId, conversationId: null as number | null, source: "", sha256: "", importedAt: "",
  }),
});

/** What a PI session file becomes in Durable. Pure: nothing is read or written. */
export function planPiImport(content: string): PiImportPlan {
  const entries = parseSessionEntries(content);
  if (entries[0]?.type !== "session") throw new Error("This is not a PI session file.");
  migrateSessionEntries(entries);
  const body = entries.slice(1) as SessionEntry[];
  const byId = new Map(body.map((entry) => [entry.id, entry]));
  // PI resumes at the last entry it wrote; its active branch runs from there back to the root.
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  for (let entry = body.at(-1); entry && !seen.has(entry.id); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    seen.add(entry.id);
    path.push(entry);
  }
  path.reverse();
  const plan: PiImportPlan = { drafts: [], usage: spend(body), messages: 0, summaries: 0, abandoned: body.length - path.length };
  const drafted = new Map<string, number>();
  const add = (entry: SessionEntry, draft: PiImportDraft) => {
    drafted.set(entry.id, plan.drafts.length);
    plan.drafts.push(draft);
  };
  const messages = (entry: SessionEntry, model: Message[], kind = UserEntry.kind, data?: JsonValue) => {
    if (!model.length) return;
    add(entry, { kind, model, ...(data !== undefined ? { data } : {}) });
    plan.messages += 1;
  };
  for (const [index, entry] of path.entries()) {
    if (entry.type === "message") {
      // PI's projection, which also repairs a message stored without content.
      const [message] = sessionEntryToContextMessages(entry);
      if (!message) continue;
      if (message.role === "assistant") plan.model = { provider: message.provider, modelId: message.model };
      // Durable writes its own prompt baseline before the next request.
      if (message.role === "system") continue;
      if (message.role === "user") messages(entry, [message]);
      else if (message.role === "assistant") messages(entry, [message], AssistantEntry.kind);
      else if (message.role === "toolResult") messages(entry, [message], ToolResultEntry.kind, { diagnostics: [] });
      // PI's own roles (a `!` command, an extension's message) reach the model as user messages.
      else messages(entry, convertToLlm([message]));
    } else if (entry.type === "custom_message" || entry.type === "branch_summary") {
      messages(entry, convertToLlm(sessionEntryToContextMessages(entry)));
    } else if (entry.type === "compaction") {
      add(entry, {
        kind: CompactionEntry.kind,
        head: firstKept(path, index, entry.firstKeptEntryId, drafted, plan.drafts),
        model: [summaryMessage(entry.summary, entry.timestamp)],
        // PI does not record why it compacted.
        data: { reason: "threshold" },
      });
      plan.summaries += 1;
    } else if (entry.type === "context_edit") {
      const target = drafted.get(entry.targetId);
      const original = target === undefined ? undefined : plan.drafts[target]!.model;
      if (target === undefined || !original) continue;
      const replacement = entry.replacement;
      add(entry, {
        kind: CONTEXT_EDIT_KIND,
        edits: [replacement === null
          ? { target, action: "omit" }
          : { target, action: "replace", messages: original.map((message) => withContent(message, replacement.content)) }],
      });
    } else if (entry.type === "model_change") {
      plan.model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "thinking_level_change") {
      plan.thinkingLevel = entry.thinkingLevel;
    }
    // Usage, custom state, labels and session names carry nothing for the model; usage is counted in `spend`.
  }
  return plan;
}

/**
 * Copies a PI session into a new Durable conversation in one commit and records it in `PiImportDoc`. An unchanged
 * file imported before returns that conversation. The conversation continues on the session's model, else the one PI
 * last used, else a new conversation's default, with its thinking level clamped to that model.
 */
export async function importPiSession(
  host: DurableHost,
  session: { id: string; cwd: string; source: string; model?: string; thinking?: string },
  content: string,
): Promise<PiImportResult> {
  const plan = planPiImport(content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const counts = { messages: plan.messages, summaries: plan.summaries, abandoned: plan.abandoned };
  const harness = await host.open();
  const earlier = await harness.commit(async (tx) => {
    const index = await tx.doc(PiImportDoc, session.id, session.id);
    return index.conversationId !== null && index.sha256 === sha256 ? index.conversationId : undefined;
  }, durableContext);
  if (earlier !== undefined && await harness.conversation(earlier as ConversationId, durableContext)) {
    return { conversationId: earlier as ConversationId, reused: true, ...counts };
  }
  const agent = await agentFor(host, session, plan);
  const conversation = await harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: {
      cwd: session.cwd,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    },
    init: async (tx, conversationId) => {
      const ids: EntryId[] = [];
      for (const draft of plan.drafts) {
        const entry: EntryDraft = {
          kind: draft.kind,
          ...(draft.model ? { model: draft.model } : {}),
          ...(draft.data !== undefined ? { data: draft.data } : {}),
          ...(draft.head !== undefined ? { head: draft.head === "self" ? "self" : ids[draft.head]! } : {}),
          ...(draft.edits ? {
            edits: draft.edits.map((edit) => edit.action === "omit"
              ? { target: ids[edit.target]!, action: "omit" as const }
              : { target: ids[edit.target]!, action: "replace" as const, messages: edit.messages }),
          } : {}),
        };
        ids.push((await tx.appendEntry(conversationId, entry)).id);
      }
      const usage = await tx.doc(UsageDoc, conversationId);
      for (const [key, total] of Object.entries(plan.usage)) usage.models[key] = total;
      const index = await tx.doc(PiImportDoc, session.id, session.id);
      index.conversationId = conversationId;
      index.source = session.source;
      index.sha256 = sha256;
      index.importedAt = new Date().toISOString();
    },
  }, durableContext);
  return {
    conversationId: conversation.id, reused: false, ...counts,
    ...(agent.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}),
  };
}

async function agentFor(host: DurableHost, session: { cwd: string; model?: string; thinking?: string }, plan: PiImportPlan) {
  const known = (ref: ModelRef | undefined) => ref && host.models.getModel(ref.provider, ref.modelId) ? ref : undefined;
  const model = known(modelRef(session.model)) ?? known(plan.model) ?? await initialModel(host, session.cwd, undefined);
  const resolved = model ? host.models.getModel(model.provider, model.modelId) : undefined;
  const requested = session.thinking ?? plan.thinkingLevel ?? defaultThinking(host, session.cwd);
  return {
    model,
    thinkingLevel: requested && resolved ? fitThinking(resolved, requested) : undefined,
  };
}

/**
 * The draft PI's first kept entry became, or the next one before the summary. An earlier summary or an edit cannot
 * start a context; without a kept message the summary starts it alone, as in PI.
 */
function firstKept(
  path: readonly SessionEntry[], index: number, id: string, drafted: ReadonlyMap<string, number>, drafts: readonly PiImportDraft[],
): number | "self" {
  const start = path.findIndex((entry) => entry.id === id);
  if (start < 0 || start >= index) return "self";
  for (let position = start; position < index; position++) {
    const draft = drafted.get(path[position]!.id);
    if (draft === undefined) continue;
    const kind = drafts[draft]!.kind;
    if (kind !== CompactionEntry.kind && kind !== CONTEXT_EDIT_KIND) return draft;
  }
  return "self";
}

function summaryMessage(summary: string, timestamp: string): Message {
  const time = Date.parse(timestamp);
  return {
    role: "user",
    content: [{ type: "text", text: `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}` }],
    timestamp: Number.isFinite(time) ? time : Date.now(),
  };
}

/** PI's replacement of a message's content (`projectContextEntry`): answers and tool results take text blocks. */
function withContent(message: Message, content: unknown): Message {
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return message;
  const replaced = message.role !== "user" && typeof content === "string" ? [{ type: "text", text: content }] : content;
  return { ...message, content: replaced } as Message;
}

const keyOf = (provider: unknown, model: unknown) =>
  typeof provider === "string" && provider && typeof model === "string" && model ? `${provider}/${model}` : undefined;

/** Every usage object in the file, totalled as HUI totals a PI transcript, by the model that produced it. */
function spend(entries: readonly SessionEntry[]): Record<string, DurableUsage> {
  const totals: Record<string, DurableUsage> = {};
  let current: string | undefined;
  for (const entry of entries) {
    const key = entry.type === "message" && entry.message.role === "assistant" ? keyOf(entry.message.provider, entry.message.model)
      : entry.type === "usage" ? keyOf(entry.provider, entry.model)
      : undefined;
    if (key) current = key;
    const counted = transcriptUsage(entry);
    if (!counted) continue;
    const raw = (entry.type === "message" ? (entry.message as { usage?: unknown }).usage : (entry as { usage?: unknown }).usage) as
      { cost?: unknown } | undefined;
    const part = (name: string) => {
      const value = typeof raw?.cost === "object" && raw.cost !== null ? (raw.cost as Record<string, unknown>)[name] : undefined;
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    };
    // A summary records no model: it counts toward the one the session was using.
    const bucket = key ?? current ?? "pi/unknown";
    const total = totals[bucket] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    total.input += counted.input;
    total.output += counted.output;
    total.cacheRead += counted.cacheRead;
    total.cacheWrite += counted.cacheWrite;
    total.totalTokens += counted.totalTokens;
    total.cost.input += part("input");
    total.cost.output += part("output");
    total.cost.cacheRead += part("cacheRead");
    total.cost.cacheWrite += part("cacheWrite");
    total.cost.total += counted.cost;
  }
  return totals;
}
