/**
 * A bot's own routines (HUI-18; SPEC.md, "Schedules are a CLI, and bots schedule their own routines"): the
 * `routines` tool lists, adds, changes and removes the Automation tasks aimed at the bot's own chat, temporary ones
 * included. It lives in the `hui-bots-tools` extension beside `write_soul`, `set_profile` and `request_access`, so
 * only bots' chats are offered it, and it reaches the gateway through HUI's agent-tool bridge as the chat's session,
 * from a worker's host too: the gateway (`server/bots/routines.ts`) owns every rule. Unlike a bot's own tools, the
 * operator can turn it off on the Tools & skills page ("Manage its own routines", on by default, not powerful).
 */
import { defineTool, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { conversationBot } from "./durable.ts";

export const ROUTINES_TOOL = "routines";

/** What a bot may do with its own routines; the gateway enforces them. */
export const BOT_ROUTINE_LIMITS = {
  /** Enabled routines in one bot's chat (the operator's count too) past which a bot may not add or resume one. */
  active: 20,
  /** The shortest repeat interval, Automation's own. */
  minIntervalMs: 60_000,
  /** The most runs a temporary routine may be given. */
  runs: 1_000,
} as const;

export const ROUTINE_ACTIONS = ["list", "add", "update", "remove"] as const;

/** What the tool adds to HUI's active-tool section. */
export const BOT_ROUTINES_CONTRIBUTION = {
  snippet: "List, add, change and remove your own routines, temporary ones included",
  guidelines: [] as readonly string[],
};

export type BotRoutinesToolOptions = {
  /** HUI's agent-tool handler, called as the conversation's bound HUI session. */
  invoke(conversationId: ConversationId, action: string, params: Record<string, unknown>): Promise<unknown>;
};

const DESCRIPTION = [
  "Manage your own routines: prompts HUI sends you on a schedule, in this chat, as \"[routine: <name>] <prompt>\".",
  "list shows them with their ids. add needs name, prompt and one of every (\"5m\", \"2h\", \"1d\"; at least 1m), cron (five fields, minute hour day month weekday, in timezone, default HUI's) or at (an ISO date and time, once).",
  "update changes only what you give (routine: its id or name; enabled false pauses it, true resumes it). remove deletes one, also from that routine's own turn.",
  "A temporary routine ends by itself: until (an ISO date and time) and/or runs (how many runs it has); HUI deletes it after either. Use one to watch for something, such as every 5m until a check passes, and remove it yourself as soon as you are done.",
  `At most ${BOT_ROUTINE_LIMITS.active} active routines. Only the operator's turns and your routines' turns can add or change routines: a turn another bot started ("[from @…]") can't, nor can any other. You never see or touch other bots' or sessions' tasks.`,
].join(" ");

/** The `routines` tool of bots' chats. */
export function botRoutinesTool(options: BotRoutinesToolOptions): ToolRegistration {
  return defineTool({
    name: ROUTINES_TOOL,
    description: DESCRIPTION,
    parameters: Type.Object({
      action: Type.Union(ROUTINE_ACTIONS.map((action) => Type.Literal(action))),
      routine: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "update and remove: the routine's id or exact name, as list shows it." })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000, description: "What the routine sends you each time." })),
      every: Type.Optional(Type.String({ minLength: 2, maxLength: 12, description: "Repeat interval: a number and s, m, h or d, at least 1m." })),
      cron: Type.Optional(Type.String({ minLength: 9, maxLength: 200, description: "Five-field cron expression." })),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "IANA time zone of cron, such as Europe/Madrid." })),
      at: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Run once at this ISO date and time." })),
      until: Type.Optional(Type.String({ maxLength: 100, description: "When it ends (ISO date and time); HUI deletes it then. On update, \"\" clears it." })),
      runs: Type.Optional(Type.Integer({ minimum: 0, maximum: BOT_ROUTINE_LIMITS.runs, description: "How many runs it has; HUI deletes it after the last. On update, 0 clears the limit." })),
      enabled: Type.Optional(Type.Boolean({ description: "update: false pauses the routine, true resumes it." })),
    }),
    // A routine added or removed is never done twice after a restart: an interrupted call is reported to the model.
    replay: "unsafe",
    execute: async (args, api, context) => {
      try {
        if (!await conversationBot(api, api.conversationId, context)) throw new Error(`${ROUTINES_TOOL} is only available in a bot's chat.`);
        const result = await options.invoke(api.conversationId, ROUTINES_TOOL, { ...args });
        const text = typeof result === "object" && result !== null && typeof (result as { text?: unknown }).text === "string"
          ? (result as { text: string }).text
          : "Done.";
        return { output: [{ type: "text", text }] };
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        // A refusal (another bot's turn, the cap, an unknown routine, a bad schedule) is the model's to read and fix.
        return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });
}
