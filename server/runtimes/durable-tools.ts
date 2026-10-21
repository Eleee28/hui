/**
 * HUI-owned tools for Durable conversations. The definitions are the same ones
 * the PI worker registers; here they run inside the gateway and reach HUI's
 * agent-tool handler directly, as the conversation's bound HUI session.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, type ConversationId, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { AgentToolInvocation } from "../agent-tools/bridge.ts";
import { directHuiBridge } from "./bridge-client.mjs";
import { huiToolDefinitions } from "./hui-tools.ts";

export type DurableToolInvoker = (invocation: AgentToolInvocation) => Promise<unknown>;
type ConversationInvoker = (conversationId: ConversationId, action: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** HUI tools an interrupted call may simply run again after a crash: they only read (`agents_wait` marks what it
 * returns as delivered, which a rerun returns again). Every other HUI action can have taken effect (a spawned child, a
 * typed terminal line), so it is not replayed: the model is told the call was interrupted and decides what to do. */
const READ_ONLY = new Set(["sessions_list", "sessions_history", "agents_wait"]);

export function replayPolicy(name: string): "safe" | "unsafe" {
  return READ_ONLY.has(name) ? "safe" : "unsafe";
}

function durableTool(tool: ToolDefinition, invoke: ConversationInvoker): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    replay: replayPolicy(tool.name),
    execute: async (args, api, context) => {
      const result = await directHuiBridge.run(
        (action, params, signal) => invoke(api.conversationId, action, params, signal),
        () => tool.execute(api.callId, args as never, context.abortSignal, undefined, undefined as never),
      );
      return {
        output: result.content,
        ...(result.details === undefined ? {} : { details: result.details as never }),
      };
    },
  });
}

export function huiDurableTools(options: { invoke: ConversationInvoker }): Extension {
  return defineExtension({
    name: "hui-tools",
    // Settings → Tools → Browser removes `browser` per conversation at start.
    tools: huiToolDefinitions({ browser: true }).map((tool) => durableTool(tool, options.invoke)),
  });
}
