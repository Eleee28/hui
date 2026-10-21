import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
export default function agentToolsExtension(pi: { registerTool(tool: ToolDefinition): void }): void;
export function agentsWaitTransportMs(params: { timeoutSeconds?: number } | undefined): number;
