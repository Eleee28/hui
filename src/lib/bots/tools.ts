/**
 * A bot's Tools & skills page (HUI-18): what the operator can turn off in the bot's chat,
 * what is off, and an access request waiting for them. Everything is on until
 * the operator turns it off; each change is a `PATCH /__hui/bots/:id` with the
 * whole list, and applies from the chat's next request. The page reads
 * `GET /__hui/bots/:id/catalog` when it opens and again when the bots stream
 * shows the bot changed (a grant in its chat, a request that waits).
 *
 * This module narrows the catalog and holds what the page shows; the page's
 * state lives in `controllers/bot-tools-controller.ts`.
 */
import { BOT_ACCESS_ANSWERS } from "./bots.ts";
import type { BotAccessRequest, BotCatalog, BotCatalogSkill, BotCatalogTool, BotSkillRef, BotToolGroup, BotView } from "../../api/schema/bots.ts";

/** Skills a tab shows before it offers a search. */
export const SKILL_SEARCH_MIN = 8;

export type BotAccessAnswer = (typeof BOT_ACCESS_ANSWERS)[number];

/* ── catalog ─────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const GROUPS: readonly BotToolGroup[] = ["files", "shell", "hui", "extension", "bots"];

function parseSkillRef(value: unknown): BotSkillRef | undefined {
  return isRecord(value) && str(value["name"]) && str(value["path"]) ? { name: str(value["name"]), path: str(value["path"]) } : undefined;
}

/** `GET /__hui/bots/:id/catalog`, narrowed: entries that don't validate are left out. */
export function parseBotCatalog(body: unknown): BotCatalog {
  if (!isRecord(body) || !Array.isArray(body["tools"]) || !Array.isArray(body["skills"])) throw new Error("The bot's tools did not come back.");
  const tools: BotCatalogTool[] = body["tools"].flatMap((raw) => {
    if (!isRecord(raw) || !str(raw["name"])) return [];
    const group = GROUPS.find((candidate) => candidate === raw["group"]) ?? "extension";
    return [{
      name: str(raw["name"]), label: str(raw["label"]) || str(raw["name"]), description: str(raw["description"]),
      group, source: str(raw["source"]), powerful: raw["powerful"] === true, enabled: raw["enabled"] !== false,
    }];
  });
  const skills: BotCatalogSkill[] = body["skills"].flatMap((raw) => {
    const ref = parseSkillRef(raw);
    return ref && isRecord(raw) ? [{ ...ref, description: str(raw["description"]), source: str(raw["source"]), enabled: raw["enabled"] !== false }] : [];
  });
  const request = isRecord(body["request"]) && str(body["request"]["id"]) && str(body["request"]["sessionId"])
    ? { id: str(body["request"]["id"]), sessionId: str(body["request"]["sessionId"]), title: str(body["request"]["title"]), message: str(body["request"]["message"]) } satisfies BotAccessRequest
    : undefined;
  return {
    tools,
    skills,
    alwaysOn: Array.isArray(body["alwaysOn"]) ? body["alwaysOn"].flatMap((raw) => isRecord(raw) && str(raw["name"]) ? [{ name: str(raw["name"]), description: str(raw["description"]) }] : []) : [],
    disabledTools: Array.isArray(body["disabledTools"]) ? body["disabledTools"].filter((name): name is string => typeof name === "string") : [],
    disabledSkills: Array.isArray(body["disabledSkills"]) ? body["disabledSkills"].flatMap((raw) => parseSkillRef(raw) ?? []) : [],
    live: body["live"] === true,
    ...(request ? { request } : {}),
  };
}

/* ── what the tab shows ──────────────────────────────────────────────── */

export type BotToolsGroup = { key: string; title: string; source?: string; tools: BotCatalogTool[] };

const GROUP_TITLES: Record<Exclude<BotToolGroup, "extension">, string> = { files: "Files", shell: "Shell", hui: "HUI", bots: "Bots" };

/** Files, Shell, HUI, one group per extension source, then Bots; tools keep their offer order inside each. */
export function groupBotTools(tools: readonly BotCatalogTool[]): BotToolsGroup[] {
  const groups: BotToolsGroup[] = [];
  for (const group of GROUPS) {
    if (group !== "extension") {
      const members = tools.filter((tool) => tool.group === group);
      if (members.length) groups.push({ key: group, title: GROUP_TITLES[group], tools: members });
      continue;
    }
    const sources = [...new Set(tools.filter((tool) => tool.group === "extension").map((tool) => tool.source))];
    for (const source of sources) {
      groups.push({ key: `extension:${source}`, title: "Extension", source, tools: tools.filter((tool) => tool.group === "extension" && tool.source === source) });
    }
  }
  return groups;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Everything is on: 19 tools and 4 skills." or "2 of 19 tools and 1 of 4 skills are off." */
export function botToolsSummary(catalog: Pick<BotCatalog, "tools" | "skills">): string {
  const tools = catalog.tools.length;
  const skills = catalog.skills.length;
  const offTools = catalog.tools.filter((tool) => !tool.enabled).length;
  const offSkills = catalog.skills.filter((skill) => !skill.enabled).length;
  if (!offTools && !offSkills) return `Everything is on: ${count(tools, "tool")} and ${count(skills, "skill")}.`;
  const parts = [
    ...(offTools ? [`${offTools} of ${count(tools, "tool")}`] : []),
    ...(offSkills ? [`${offSkills} of ${count(skills, "skill")}`] : []),
  ];
  return `${parts.join(" and ")} ${offTools + offSkills === 1 ? "is" : "are"} off.`;
}

/** The overview's Tools & skills row, from what the bot's record says is off: "Everything on", "2 tools off",
 * "1 tool and 3 skills off". */
export function botToolsOffLabel(bot: Pick<BotView, "disabledTools" | "disabledSkills">): string {
  const tools = bot.disabledTools?.length ?? 0;
  const skills = bot.disabledSkills?.length ?? 0;
  if (!tools && !skills) return "Everything on";
  return `${[...(tools ? [count(tools, "tool")] : []), ...(skills ? [count(skills, "skill")] : [])].join(" and ")} off`;
}

/** Skills whose name, description or source contain every word of `query`. */
export function matchingSkills(skills: readonly BotCatalogSkill[], query: string): BotCatalogSkill[] {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return [...skills];
  return skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.description} ${skill.source}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const sameSkill = (a: BotSkillRef, b: BotSkillRef) => a.name === b.name && a.path === b.path;

/** The whole `disabledTools` list after turning one tool on or off. */
export function toolsAfter(catalog: Pick<BotCatalog, "disabledTools">, name: string, enabled: boolean): string[] {
  const rest = catalog.disabledTools.filter((each) => each !== name);
  return enabled ? rest : [...rest, name];
}

/** The whole `disabledSkills` list after turning one skill on or off. */
export function skillsAfter(catalog: Pick<BotCatalog, "disabledSkills">, skill: BotSkillRef, enabled: boolean): BotSkillRef[] {
  const rest = catalog.disabledSkills.filter((each) => !sameSkill(each, skill));
  return enabled ? rest : [...rest, { name: skill.name, path: skill.path }];
}

/** What changes on the bots stream when the catalog may have: its chat waits on a question or moves on, or its record
 * (its lists) changed. */
export function botToolsKey(bot: Pick<BotView, "status" | "updatedAt">): string {
  return `${bot.status}|${bot.updatedAt}`;
}

/* ── the tab's state ─────────────────────────────────────────────────── */

export type BotToolsState = {
  botId: string;
  loading: boolean;
  error: string;
  catalog?: BotCatalog;
  /** A change on its way to the gateway: every switch waits for it, so no two lists race. */
  saving: boolean;
  saveError: string;
  answering: boolean;
  query: string;
};

export type BotToolsActions = {
  onToggleTool: (name: string, enabled: boolean) => void;
  onToggleSkill: (skill: BotSkillRef, enabled: boolean) => void;
  onSearch: (query: string) => void;
  onAnswer: (answer: BotAccessAnswer) => void;
  onRetry: () => void;
};
