/**
 * Entries every Durable conversation's history may hold beside the model's
 * messages, which history projection and OptChat read for all conversations:
 * the record of a GPT-Live call; and who started a bot's turn, which its gated
 * tools judge.
 */
import { defineEntry } from "@earendil-works/pi-durable";
import { AGENT_TAG, BOT_IMPORTED_KICKOFF_LINE, botKickoffName } from "../bots-format.ts";
import type { CallRecord } from "../calls-format.ts";

/**
 * The record of one GPT-Live call with the bot (HUI-18): its summary and its whole transcript (`CallRecord`), written
 * once at hang-up as a passive entry, so no model turn runs for it. It carries no model messages: the chat shows it
 * as one card, OptChat logs it (its transcript and summary, marked `[call]`), and Durable places it at a running
 * turn's next boundary.
 */
export const CallEntry = defineEntry<CallRecord>("hui.call");

/** Who started a bot's turn, by the message that started it: a routine (`[routine: name] …`), a trigger
 * (`[trigger: name · …] …`), another bot (`[from @handle] …`), a session's agent (`[from agent: title] …`), HUI's
 * kickoff of a new bot, an imported bot's first turn (a kickoff with `from: template`), or else the operator. */
export type BotTurnOrigin =
  | { kind: "operator" } | { kind: "kickoff" } | { kind: "imported" } | { kind: "routine"; name: string } | { kind: "trigger"; name: string }
  | { kind: "bot"; handle: string } | { kind: "agent"; title: string };

export function botTurnOrigin(text: string | undefined): BotTurnOrigin {
  if (!text) return { kind: "operator" };
  if (text.startsWith("[routine: ")) return { kind: "routine", name: /^\[routine: (.*?)\] /u.exec(text)?.[1] ?? "" };
  // A trigger's name holds no `[`, `]` or `·`: it ends at the summary's ` · ` or at the bracket.
  if (text.startsWith("[trigger: ")) return { kind: "trigger", name: /^\[trigger: ([^\]·\n]*?)(?: · |\])/u.exec(text)?.[1] ?? "" };
  const bot = /^\[from @([a-z0-9-]+)(?: · hop [1-9]\d*)?\] /u.exec(text);
  if (bot) return { kind: "bot", handle: bot[1]! };
  const agent = AGENT_TAG.exec(text);
  if (agent) return { kind: "agent", title: agent[1]! };
  if (botKickoffName(text) === undefined) return { kind: "operator" };
  return text.split("\n", 3).includes(BOT_IMPORTED_KICKOFF_LINE) ? { kind: "imported" } : { kind: "kickoff" };
}

/**
 * Who brought each input of a bot's running turn, as its gated tools judge it: they refuse when any of them is an
 * origin they refuse. The message that started the run, as the gateway recorded it (`runPrompt`), then every input the
 * host running the chat saw the run take (`runOrigins`, sent with the tool call: the first message and every steer and
 * follow-up since). A host that can't tell sends none, which leaves the check on `runPrompt` alone.
 */
export function runTurnOrigins(runPrompt: string | undefined, runOrigins: readonly BotTurnOrigin[] | undefined): BotTurnOrigin[] {
  return [botTurnOrigin(runPrompt), ...runOrigins ?? []];
}

/** Most origins a tool call carries: a host sends each one once. */
const MAX_RUN_ORIGINS = 1_000;

/** `runOrigins` as a worker's host sends them with a tool call; undefined for anything else (an older host sends
 * none), which leaves the check on `runPrompt` alone. */
export function parseRunOrigins(value: unknown): BotTurnOrigin[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RUN_ORIGINS) return undefined;
  const origins: BotTurnOrigin[] = [];
  for (const item of value) {
    const { kind, name, handle, title } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (kind === "operator" || kind === "kickoff" || kind === "imported") origins.push({ kind });
    else if ((kind === "routine" || kind === "trigger") && typeof name === "string") origins.push({ kind, name });
    else if (kind === "bot" && typeof handle === "string") origins.push({ kind, handle });
    else if (kind === "agent" && typeof title === "string") origins.push({ kind, title });
    else return undefined;
  }
  return origins;
}
