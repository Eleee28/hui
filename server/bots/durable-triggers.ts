/**
 * The `triggers` tool (HUI-18) of bots' chats, in the `hui-bots-tools` extension: a bot lists its own triggers, what
 * wakes it when a listener the operator runs reports something, and removes one. Only the operator adds or changes
 * them. HUI's agent-tool handler does the work (`BotTriggerService.tool`), as the calling chat's session.
 *
 * It is an ordinary tool of the Tools & skills page, under Bots: on by default, not powerful, and the operator can turn it off.
 * It imports nothing from `durable.ts`, which builds the extension with it.
 */
import { defineTool, type ConversationId, type DocumentReader, type ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Type } from "typebox";

export const TRIGGERS_TOOL = "triggers";

/** What the tool adds to HUI's active-tool section. */
export const TRIGGERS_TOOL_CONTRIBUTION = {
  snippet: "List or remove your own triggers: what wakes you when a listener the operator runs reports something",
  guidelines: [] as readonly string[],
};

/** How the Tools & skills page names it. */
export const TRIGGERS_TOOL_INFO = { label: "Triggers", description: "List and remove its own triggers: what its listeners report wakes it" };

export function triggersTool(options: {
  invoke(conversationId: ConversationId, action: string, params: Record<string, unknown>): Promise<unknown>;
  /** Whether the conversation is a bot's chat. */
  isBot(reader: DocumentReader, conversationId: ConversationId, context: Context): Promise<boolean>;
}): ToolRegistration {
  return defineTool({
    name: TRIGGERS_TOOL,
    description: [
      "Your triggers wake you when a listener the operator runs reports something: each event arrives in this chat as \"[trigger: <name> · <summary>] <prompt>\" with its details.",
      "action list shows them; remove names the trigger (its name or id) in trigger.",
      "Only the operator adds or changes triggers, on the Triggers page of your panel or with hui bot trigger add.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.Union(["list", "remove"].map((action) => Type.Literal(action))),
      trigger: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "remove: the trigger's name or id." })),
    }),
    // Removing again finds nothing: an interrupted call is reported, never repeated.
    replay: "unsafe",
    execute: async (args, api, context) => {
      try {
        if (!await options.isBot(api, api.conversationId, context)) throw new Error(`${TRIGGERS_TOOL} is only available in a bot's chat.`);
        const params = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
        const result = await options.invoke(api.conversationId, TRIGGERS_TOOL, params);
        const text = typeof result === "object" && result !== null && typeof (result as { text?: unknown }).text === "string" ? (result as { text: string }).text : "Done.";
        return { output: [{ type: "text", text }] };
      } catch (error) {
        if (context.abortSignal?.aborted) throw error;
        // A refusal (an unknown trigger, say) is the model's to read and act on.
        return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  });
}
