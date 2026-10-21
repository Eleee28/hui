/**
 * Turns PI's transcript items into the rows the chat renders: message groups (each user row by its sender: the operator,
 * or the bot, session, routine or trigger HUI delivered it from), every assistant message on a row of its own with the
 * activity between them folded, compactions, calls, subagent events and bot kickoffs, plus the working labels and where
 * the live browser preview goes. Presentation only; PI's transcript keeps the order and the data.
 */
import type { TranscriptItem } from "../../api/sessions.ts";
import { parseSubagentCompletionEvent, type SubagentCompletionItem } from "../../lib/subagent-completion.ts";
import { agentReplyTo, botKickoffName, botTurnOrigin } from "../../lib/bots/bots.ts";

export type ChatMessage = Extract<TranscriptItem, { kind: "message" }>;
export type ChatCompaction = Extract<TranscriptItem, { kind: "compaction" }>;
export type ChatCall = Extract<TranscriptItem, { kind: "call" }>;
export type ChatActivity = Exclude<TranscriptItem, { kind: "message" | "compaction" | "call" }>;

/** Tool calls that present something to the user, or hand a message to another chat, get a row of their own, so
 * they stay visible after the turn's other activity folds into a disclosure. */
const PRESENTATION_TOOLS = new Set(["present_media", "show_widget", "ask_user_question", "message_bot"]);

/** Who HUI delivered a user-role message from when the operator didn't write it, by the header it starts with: a bot's
 * tag, a session's tag or `sessions_send`, a subagent's task (from its parent), a bot's routine or trigger. */
export type MessageSender =
  | { kind: "bot"; handle: string }
  | { kind: "session"; title: string; id?: string }
  | { kind: "parent" }
  | { kind: "routine"; name: string }
  | { kind: "trigger"; name: string; summary: string };

/** `sessions_send` (server/agent-tools/subagents.ts): the sender's title and id on the first line. */
const INTER_SESSION = /^\[Inter-session message from (.*) \(([^()\s]+)\)\]\n/u;
/** A subagent's first prompt, its task from the session that spawned it (server/agent-tools/subagents.ts). */
const SUBAGENT_TASK = "[Subagent Task]\n";

/**
 * A message's sender and the text after its header; undefined for the operator's own words. Bots' and sessions' tags,
 * routines and triggers are read by the gateway's own `botTurnOrigin`, so the chat attributes the headers its gated
 * tools refuse to treat as the operator's.
 */
export function attributedMessage(text: string): { sender: MessageSender; body: string } | undefined {
  if (text.startsWith(SUBAGENT_TASK)) return { sender: { kind: "parent" }, body: text.slice(SUBAGENT_TASK.length) };
  const relayed = INTER_SESSION.exec(text);
  if (relayed) return { sender: { kind: "session", title: relayed[1]!, id: relayed[2]! }, body: text.slice(relayed[0].length) };
  const origin = botTurnOrigin(text);
  if (origin.kind === "operator" || origin.kind === "kickoff" || origin.kind === "imported") return undefined;
  // A header ends at its first `]` (handles, sanitized titles, trigger names and summaries hold none), a routine's after
  // its name, which may hold one.
  const end = text.indexOf("]", origin.kind === "routine" ? "[routine: ".length + origin.name.length : 0);
  // HUI always closes its headers: an unclosed one is the operator's own text.
  if (end < 0) return undefined;
  const body = text.slice(end + 1).replace(/^ /u, "");
  if (origin.kind === "agent") {
    const id = agentReplyTo(text)?.slice("agent:".length);
    return { sender: { kind: "session", title: origin.title, ...(id ? { id } : {}) }, body };
  }
  if (origin.kind === "trigger") {
    const summary = text.slice(0, end).split(" · ").slice(1).join(" · ");
    return { sender: { kind: "trigger", name: origin.name, summary }, body: body.replace(/^\n+/u, "") };
  }
  return { sender: origin, body };
}

const sameSender = (a: MessageSender | undefined, b: MessageSender | undefined) => JSON.stringify(a) === JSON.stringify(b);

export type ChatProjectionRow =
  /** `sender`: who HUI delivered a user row from; absent for the operator's own messages and for the agent's replies. */
  | { kind: "messages"; id: string; role: ChatMessage["role"]; messages: readonly ChatMessage[]; sender?: MessageSender }
  | { kind: "activity"; id: string; items: readonly ChatActivity[] }
  /** Where PI summarized the history above; it stays visible and rewindable. */
  | { kind: "compaction"; id: string; item: ChatCompaction }
  /** A GPT-Live call with a bot: one card (chat-call.ts). */
  | { kind: "call"; id: string; item: ChatCall }
  /** A HUI-injected subagent completion: a system event, never a user turn. */
  | { kind: "subagentEvent"; id: string; items: readonly SubagentCompletionItem[] }
  /** HUI's kickoff of a new bot (`[HUI bot created]`): a note where its first turn began, never the operator's words.
   * `name` is the bot's name when the message carries one. */
  | { kind: "botCreated"; id: string; name: string };

/**
 * Presentation-only projection of PI's durable transcript. OpenClaw groups adjacent user messages by author. Every
 * assistant message keeps a row of its own, live or settled, so what the agent wrote mid-turn (a first finding, links
 * to check) stays in sight; only the activity between messages (thinking, tool calls, errors) folds into a disclosure.
 * PI remains the owner of event order and data.
 */
export function projectChatTranscript(items: readonly TranscriptItem[]): ChatProjectionRow[] {
  const rows: ChatProjectionRow[] = [];
  let assistantTurn: (ChatActivity | ChatMessage)[] = [];

  const pushActivity = (items: readonly ChatActivity[]) => {
    let ordinary: ChatActivity[] = [];
    const flushOrdinary = () => {
      if (!ordinary.length) return;
      rows.push({ kind: "activity", id: ordinary[0]!.id, items: ordinary });
      ordinary = [];
    };
    for (const item of items) {
      if (item.kind === "tool" && PRESENTATION_TOOLS.has(item.name)) {
        flushOrdinary();
        rows.push({ kind: "activity", id: item.id, items: [item] });
      } else ordinary.push(item);
    }
    flushOrdinary();
  };

  const flushAssistantTurn = () => {
    let activity: ChatActivity[] = [];
    const flushActivity = () => {
      if (activity.length === 0) return;
      pushActivity(activity);
      activity = [];
    };
    for (const item of assistantTurn) {
      if (item.kind === "message") {
        flushActivity();
        rows.push({ kind: "messages", id: item.id, role: "assistant", messages: [item] });
      } else {
        activity.push(item);
      }
    }
    flushActivity();
    assistantTurn = [];
  };

  for (const item of items) {
    if (item.kind === "message" && item.role === "user") {
      flushAssistantTurn();
      const event = parseSubagentCompletionEvent(item.text);
      if (event) {
        rows.push({ kind: "subagentEvent", id: item.id, items: event });
        continue;
      }
      const created = botKickoffName(item.text);
      if (created !== undefined) {
        rows.push({ kind: "botCreated", id: item.id, name: created });
        continue;
      }
      const sender = attributedMessage(item.text)?.sender;
      const previous = rows.at(-1);
      if (previous?.kind === "messages" && previous.role === "user" && sameSender(previous.sender, sender)) {
        rows[rows.length - 1] = { ...previous, messages: [...previous.messages, item] };
      } else {
        rows.push({ kind: "messages", id: item.id, role: "user", messages: [item], ...(sender ? { sender } : {}) });
      }
      continue;
    }
    if (item.kind === "compaction") {
      flushAssistantTurn();
      rows.push({ kind: "compaction", id: item.id, item });
      continue;
    }
    if (item.kind === "call") {
      flushAssistantTurn();
      rows.push({ kind: "call", id: item.id, item });
      continue;
    }
    assistantTurn.push(item);
  }
  flushAssistantTurn();
  return rows;
}

export function activityLabel(items: readonly ChatActivity[], streaming: boolean): string {
  const tools = items.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool");
  const running = items.findLast(
    (item) => item.kind === "tool" && (item.status ?? "running") === "running",
  );
  if (running?.kind === "tool" && tools.length === 1) return `${running.name}${streaming ? "…" : ""}`;
  if (running?.kind === "tool" && tools.length > 1) return `Ran ${tools.length} commands${streaming ? "…" : ""}`;
  if (tools.length > 0) {
    const edited = tools.filter((item) => /^(apply_patch|edit|write|file_write)$/i.test(item.name)).length;
    const commands = `Ran ${tools.length} ${tools.length === 1 ? "command" : "commands"}`;
    return edited > 0 ? `${commands}, edited ${edited} ${edited === 1 ? "file" : "files"}` : commands;
  }
  if (items.some((item) => item.kind === "thinking")) return streaming ? "Thinking…" : "Reasoning";
  return "Run details";
}

/** Short, user-facing description for the transient working indicator. */
export function workingLabel(items: readonly TranscriptItem[]): string {
  const latest = items.at(-1);
  if (latest?.kind === "message" && latest.role === "assistant") return "Writing response…";
  if (latest?.kind === "thinking") return "Thinking…";
  if (latest?.kind === "tool" && (latest.status ?? "running") === "running") {
    const name = latest.name.toLocaleLowerCase().replace(/[\s-]+/g, "_");
    if (/^(read|read_file|file_read|glob|grep|find|search|list|ls)(_|$)/u.test(name)) return "Reading files…";
    if (/^(write|write_file|file_write|edit|apply_patch)(_|$)/u.test(name)) return "Editing files…";
    if (/^(bash|shell|exec|run_command|command|terminal|npm|pnpm|yarn|test)(_|$)/u.test(name)) return "Running command…";
    if (/^git(_|$)/u.test(name)) return "Checking git…";
  }
  return "Working…";
}

/** Where the chat shows its live browser preview: the index of the activity row
 * holding the conversation's latest `browser` call (an index, since tool call
 * ids and so row ids can repeat across turns). `pending` while that call runs;
 * `currentTurn` while no later prompt started another turn. */
export function browserPreviewRow(rows: readonly ChatProjectionRow[]): { index: number; pending: boolean; currentTurn: boolean } | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== "activity") continue;
    const call = row.items.findLast((item) => item.kind === "tool" && item.name === "browser");
    if (call?.kind !== "tool") continue;
    const currentTurn = !rows.slice(index + 1).some((later) => later.kind === "subagentEvent" || (later.kind === "messages" && later.role === "user"));
    return { index, pending: (call.status ?? "running") === "running", currentTurn };
  }
  return undefined;
}
