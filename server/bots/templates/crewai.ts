/**
 * CrewAI's `agents.yaml`: agents by key, each with a `role` (its title), a `goal` and a `backstory` (its soul), and maybe
 * an `llm` and `tools`. A file usually holds several agents; each is a candidate the preview offers. CrewAI fills
 * `{placeholders}` from a crew's inputs at run time; HUI leaves them in and says so.
 */
import { BOT_LIMITS } from "../../bots-format.ts";
import type { BotTemplate } from "./formats.ts";
import { blankTemplate, displayName, isRecord, oneLine, parseYaml, sections, str } from "./common.ts";

const AGENT_KEYS = ["role", "goal", "backstory"];

/** The agents of a parsed agents.yaml, by key: entries with a role, a goal or a backstory. */
function agents(value: unknown): [string, Record<string, unknown>][] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, agent]): [string, Record<string, unknown>][] => isRecord(agent) && AGENT_KEYS.some((field) => typeof agent[field] === "string") ? [[key, agent]] : []);
}

/** Whether YAML text is a CrewAI agents file. */
export function isCrewAiAgents(text: string): boolean {
  try {
    return agents(parseYaml(text, "agents.yaml")).length > 0;
  } catch {
    return false;
  }
}

/** Each agent of the file, by its key. */
export function parseCrewAiAgents(text: string, origin?: string): { key: string; template: BotTemplate }[] {
  return agents(parseYaml(text, "agents.yaml")).map(([key, agent]) => {
    const template = blankTemplate("crewai", displayName(key), origin);
    const role = str(agent["role"]);
    if (role) {
      template.title = oneLine(role, BOT_LIMITS.title);
      if (oneLine(role, Number.POSITIVE_INFINITY).length > BOT_LIMITS.title) template.notes.push(`Its role was cut to ${BOT_LIMITS.title} characters for its title.`);
    }
    template.soul = sections([["Goal", str(agent["goal"])], ["Backstory", str(agent["backstory"])]]);
    const placeholders = [...new Set([role, template.soul].join("\n").match(/\{[A-Za-z_][A-Za-z0-9_]*\}/gu) ?? [])];
    if (placeholders.length) template.notes.push(`It keeps CrewAI's placeholders ${placeholders.join(", ")}, which a crew fills in at run time: ask it to replace them, or replace them with hui bot soul.`);
    const llm = str(agent["llm"]) || (isRecord(agent["llm"]) ? str(agent["llm"]["model"]) : "");
    if (llm) template.model = llm;
    const tools = Array.isArray(agent["tools"]) ? agent["tools"].map(str).filter(Boolean) : [];
    for (const tool of tools) template.integrations.push({ name: tool });
    const ignored = Object.keys(agent).filter((each) => ![...AGENT_KEYS, "llm", "tools"].includes(each));
    if (ignored.length) template.dropped.push(`CrewAI settings ${ignored.join(", ")}: HUI runs the bot its own way.`);
    return { key, template };
  });
}
