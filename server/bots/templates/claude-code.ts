/**
 * Claude Code subagents (`.claude/agents/<name>.md`): YAML front matter (`name`, `description`, `tools`, `model`, `color`)
 * and a body, the subagent's system prompt, which becomes the soul. A `tools` list restricts the subagent to those
 * tools; HUI keeps on only the tools they map to (`CLAUDE_CODE_TOOLS`) and turns the rest off. Without one the subagent
 * inherits every tool, and so does the bot.
 */
import { BOT_FACE_COLORS, BOT_LIMITS } from "../../bots-format.ts";
import type { BotTemplate } from "./formats.ts";
import { blankTemplate, displayName, frontMatter, oneLine, str } from "./common.ts";

/**
 * Claude Code's tools by the HUI tools that do their job. Grep, Glob and LS have no tool of their own here: reading files
 * is the closest, and a bot greps with bash when it has it. A tool missing from this table (an MCP server's
 * `mcp__…` tools) maps to nothing and is listed as an integration.
 */
export const CLAUDE_CODE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  MultiEdit: ["edit"],
  NotebookEdit: ["edit"],
  NotebookRead: ["read"],
  Bash: ["bash"],
  BashOutput: ["bash"],
  KillBash: ["bash"],
  KillShell: ["bash"],
  Grep: ["read"],
  Glob: ["read"],
  LS: ["read"],
  WebFetch: ["browser"],
  WebSearch: ["browser"],
  Task: ["sessions_spawn", "subagents"],
  TodoWrite: ["progress_card"],
};

/** Claude Code's agent colors as HUI's palette. */
const COLORS: Readonly<Record<string, string>> = {
  blue: "blue", cyan: "blue", green: "mint", yellow: "yellow", orange: "coral", red: "coral", purple: "lilac", pink: "magenta",
};

/** Whether text is a Claude Code subagent: front matter naming it or saying what it does. */
export function isClaudeCodeAgent(text: string): boolean {
  const { data, valid } = frontMatter(text);
  return valid && Boolean(str(data["name"]) || str(data["description"])) && !("role" in data) && !("spec" in data);
}

/** A front-matter list: YAML's, or a comma-separated string. */
function names(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
}

export function parseClaudeCodeAgent(text: string, origin?: string): BotTemplate {
  const { data, body } = frontMatter(text);
  const file = origin?.split("/").pop()?.replace(/\.md$/iu, "");
  const template = blankTemplate("claude-code", displayName(str(data["name"]) || file || "Claude Code agent"), origin);
  template.soul = body;
  const description = str(data["description"]);
  if (description.length > BOT_LIMITS.description) {
    template.description = oneLine(description, BOT_LIMITS.description);
    template.notes.push(`Its description was cut to ${BOT_LIMITS.description} characters.`);
  } else if (description) template.description = description;
  if ("tools" in data) {
    const tools = names(data["tools"]);
    template.tools = tools.filter((tool) => !tool.startsWith("mcp__"));
    for (const tool of tools.filter((each) => each.startsWith("mcp__"))) {
      const [, server, name] = tool.split("__");
      template.integrations.push({ name: tool, description: `${name ?? "A tool"} of the ${server ?? "unknown"} MCP server` });
    }
  }
  const model = str(data["model"]);
  if (model && model !== "inherit") template.model = model;
  const color = COLORS[str(data["color"]).toLowerCase()];
  const hex = BOT_FACE_COLORS.find((entry) => entry.id === color)?.hex;
  if (hex) template.avatar = { color: hex };
  for (const key of Object.keys(data).filter((key) => !["name", "description", "tools", "model", "color"].includes(key))) {
    template.dropped.push(`Front matter ${key}: HUI has no setting for it.`);
  }
  return template;
}
