/**
 * Letta Agent Files (`.af`, JSON): one agent or several (`agents`, whose memory blocks and tools sit beside them by id,
 * in `blocks` and `tools`). An agent's `persona` block is its soul; its system prompt joins it when it is the agent's
 * own, and is left out when it is Letta's stock prompt, which teaches Letta's memory functions that HUI doesn't have.
 * The `human` block and custom blocks become memories. Its tools become integrations (their code is never imported),
 * except Letta's memory and messaging tools, which HUI's chat and OptChat memory replace. The message history is
 * skipped.
 */
import { BOT_LIMITS } from "../../bots-format.ts";
import type { BotTemplate } from "./formats.ts";
import { blankTemplate, isRecord, oneLine, sections, str } from "./common.ts";

/** Letta's own memory and messaging tools: HUI's chat and its OptChat memory do their job. */
const LETTA_CORE_TOOL = /^(?:send_message|conversation_search|archival_memory_|core_memory_|memory(?:_|$)|rethink_memory|finish_rethinking_memory)/u;

/** Letta's endpoint types by the provider names PI uses. */
const PROVIDERS: Readonly<Record<string, string>> = { google_ai: "google", google_vertex: "google-vertex", azure: "azure-openai-responses", together: "together", groq: "groq", openai: "openai", anthropic: "anthropic", ollama: "ollama", mistral: "mistral", deepseek: "deepseek", xai: "xai" };

function agentList(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value["agents"])) return value["agents"].filter(isRecord);
  return "system" in value && ("core_memory" in value || "memory" in value || "llm_config" in value || "memory_blocks" in value) ? [value] : [];
}

/** Whether a parsed JSON file is a Letta agent file. */
export function isLettaAgentFile(value: unknown): boolean {
  return agentList(value).some((agent) => typeof agent["system"] === "string" || Array.isArray(agent["block_ids"]) || isRecord(agent["llm_config"]));
}

/** Whether a system prompt is Letta's (or MemGPT's) stock one, all about memory functions. */
export function isStockLettaPrompt(system: string): boolean {
  return /\b(?:Letta|MemGPT)\b/u.test(system) && /core memory|archival memory|recall memory|memory blocks/iu.test(system);
}

type Block = { label: string; value: string };

function blocksOf(agent: Record<string, unknown>, file: Record<string, unknown>): Block[] {
  const byId = new Map((Array.isArray(file["blocks"]) ? file["blocks"] : []).filter(isRecord).map((block) => [str(block["id"]), block]));
  const memory = isRecord(agent["memory"]) ? agent["memory"]["blocks"] : undefined;
  const inline = [agent["core_memory"], agent["memory_blocks"], agent["blocks"], memory].find(Array.isArray) as unknown[] | undefined;
  const found = inline ?? (Array.isArray(agent["block_ids"]) ? agent["block_ids"].map((id) => byId.get(str(id))) : []);
  return found.filter(isRecord).map((block) => ({ label: str(block["label"]) || str(block["name"]), value: str(block["value"]) })).filter((block) => block.label && block.value);
}

function toolsOf(agent: Record<string, unknown>, file: Record<string, unknown>): { name: string; description?: string; code: boolean }[] {
  const byId = new Map((Array.isArray(file["tools"]) ? file["tools"] : []).filter(isRecord).map((tool) => [str(tool["id"]), tool]));
  const listed = Array.isArray(agent["tools"]) ? agent["tools"] : Array.isArray(agent["tool_ids"]) ? agent["tool_ids"].map((id) => byId.get(str(id)) ?? id) : [];
  return listed.flatMap((tool) => {
    if (typeof tool === "string") return tool.trim() ? [{ name: tool.trim(), code: false }] : [];
    if (!isRecord(tool) || !str(tool["name"])) return [];
    const description = str(tool["description"]);
    return [{ name: str(tool["name"]), ...(description ? { description: oneLine(description, 300) } : {}), code: Boolean(str(tool["source_code"])) }];
  });
}

/** The model an agent's `llm_config` names, as `provider/id` where it can tell. */
function modelOf(agent: Record<string, unknown>): string | undefined {
  const config = isRecord(agent["llm_config"]) ? agent["llm_config"] : undefined;
  if (!config) return undefined;
  const handle = str(config["handle"]);
  if (handle.includes("/")) return handle;
  const model = str(config["model"]);
  const provider = PROVIDERS[str(config["model_endpoint_type"])];
  return model ? (provider && !model.includes("/") ? `${provider}/${model}` : model) : undefined;
}

/** Each agent of the file, keyed by its position. */
export function parseLettaAgentFile(value: unknown, origin?: string): { key: string; template: BotTemplate }[] {
  if (!isRecord(value)) return [];
  return agentList(value).map((agent, index) => {
    const template = blankTemplate("letta", oneLine(str(agent["name"]) || `Letta agent ${index + 1}`, BOT_LIMITS.name), origin);
    const description = str(agent["description"]);
    if (description) template.description = oneLine(description, BOT_LIMITS.description);
    const blocks = blocksOf(agent, value);
    const persona = blocks.find((block) => block.label === "persona")?.value ?? "";
    const system = str(agent["system"]);
    const stock = Boolean(system) && isStockLettaPrompt(system);
    if (stock) template.dropped.push("Its system prompt: Letta's stock prompt, which teaches Letta's memory functions; HUI's memory is OptChat and its own prompt covers it.");
    template.soul = sections([[undefined, persona], [persona ? "Instructions" : undefined, stock ? "" : system]]);
    for (const block of blocks.filter((each) => each.label !== "persona")) {
      template.memories.push({ name: block.label === "human" ? "About the operator" : block.label, text: block.value });
    }
    const tools = toolsOf(agent, value);
    const core = tools.filter((tool) => LETTA_CORE_TOOL.test(tool.name));
    if (core.length) template.dropped.push(`Letta's memory and messaging tools (${core.map((tool) => tool.name).join(", ")}): HUI's chat and OptChat memory do their job.`);
    for (const tool of tools.filter((each) => !LETTA_CORE_TOOL.test(each.name))) {
      template.integrations.push({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) });
    }
    if (tools.some((tool) => tool.code && !LETTA_CORE_TOOL.test(tool.name))) template.notes.push("Its custom tools' code is not imported: HUI never runs a template's code.");
    const model = modelOf(agent);
    if (model) template.model = model;
    const messages = Array.isArray(agent["messages"]) ? agent["messages"].length : 0;
    if (messages) template.dropped.push(`${messages} message${messages === 1 ? "" : "s"} of its history: a new bot's chat starts empty.`);
    return { key: String(index), template };
  });
}
