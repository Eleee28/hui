/**
 * How a template meets this gateway: its integrations against the tools a bot's chat has, its model hint against the
 * models this gateway resolves, its memories into SOUL.md, and a template that came back from the browser checked
 * again before anything is created from it. Pure: the service passes what the gateway knows.
 */
import { BOT_LIMITS, BOT_THINKING_LEVELS, isBotFaceEars, isBotFaceShape, storedTagging } from "../../bots-format.ts";
import { BOT_TEMPLATE_FORMATS, BOT_TEMPLATE_LIMITS, type BotTemplate, type BotTemplateFormat, type BotTemplateIntegration } from "./formats.ts";
import type { AutomationSchedule } from "../../automation.ts";
import { gptLiveVoice } from "../../calls-format.ts";
import { voiceLanguage } from "../voice-languages.ts";
import { isRecord, oneLine, str, TemplateFormatError } from "./common.ts";
import { needsList, openPoints, skillFiles, templateTriggers } from "./hui-export.ts";

/* ── integrations ─────────────────────────────────────────────────────── */

/** Words in an integration's name, by the HUI tools that do that job (the first one the chat has wins). */
const INTEGRATION_TOOLS: readonly [RegExp, readonly string[]][] = [
  [/\b(?:browser|browsing|browse|web ?search|search the web|internet|google search|bing|web ?fetch|fetch[ _]webpage|web ?pages?|websites?|web|url)\b/u, ["browser"]],
  [/\b(?:shell|bash|terminal|command line|code execution|code interpreter|run[ _]code|execute code|python|scripts?)\b/u, ["bash", "terminal"]],
  [/\b(?:files?|file ?system|documents?|read[ _]files?)\b/u, ["read"]],
  [/\b(?:sub ?agents?|delegat(?:e|ion)|spawn)\b/u, ["sessions_spawn"]],
  [/\b(?:secrets?|credentials?|api keys?|passwords?)\b/u, ["secret_request"]],
  [/\b(?:widgets?|charts?|visuali[sz]ations?|graphs?|diagrams?)\b/u, ["show_widget"]],
  [/\b(?:message (?:other )?bots?|bot messages?)\b/u, ["message_bot"]],
  [/\b(?:todos?|to-?do lists?|task lists?|progress)\b/u, ["progress_card"]],
];

export type OfferedToolInfo = { name: string; label: string };

/** The HUI tool an integration maps to, by its name: the tool itself, or one that does its job; undefined: missing. */
export function matchIntegration(integration: BotTemplateIntegration, tools: readonly OfferedToolInfo[]): OfferedToolInfo | undefined {
  const name = integration.name.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
  const direct = tools.find((tool) => tool.name.toLowerCase() === name.replaceAll(" ", "_") || tool.label.toLowerCase() === name);
  if (direct) return direct;
  for (const [pattern, candidates] of INTEGRATION_TOOLS) {
    if (!pattern.test(name)) continue;
    const tool = candidates.map((candidate) => tools.find((each) => each.name === candidate)).find(Boolean);
    if (tool) return tool;
  }
  return undefined;
}

/* ── models ───────────────────────────────────────────────────────────── */

export type ModelInfo = { provider: string; id: string };

/** The version numbers of a model id, a date left out: `claude-sonnet-4-5-20250929` is [4, 5]. */
function version(id: string): number[] {
  return (id.match(/\d+/gu) ?? []).filter((part) => part.length < 6).map(Number);
}

function newer(a: ModelInfo, b: ModelInfo): number {
  const [left, right] = [version(a.id), version(b.id)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? -1) - (left[index] ?? -1);
    if (difference) return difference;
  }
  return a.id.length - b.id.length;
}

/**
 * The model a hint names, as `provider/id`, among the models this gateway has: the exact reference, a bare id (any
 * provider), or an alias such as Claude Code's `sonnet`, `opus` and `haiku` (the newest such model, Anthropic's first).
 * Undefined when nothing matches: the bot starts on the gateway's default.
 */
export function resolveModel(hint: string, models: readonly ModelInfo[]): string | undefined {
  const wanted = hint.trim().toLowerCase();
  if (!wanted) return undefined;
  const ref = (model: ModelInfo) => `${model.provider}/${model.id}`;
  const exact = models.find((model) => ref(model).toLowerCase() === wanted);
  if (exact) return ref(exact);
  const bare = wanted.includes("/") ? wanted.slice(wanted.indexOf("/") + 1) : wanted;
  const byId = models.filter((model) => model.id.toLowerCase() === bare);
  if (byId.length) return ref(byId.find((model) => wanted.startsWith(`${model.provider.toLowerCase()}/`)) ?? byId[0]!);
  if (/^(?:sonnet|opus|haiku)$/u.test(bare)) {
    const family = models.filter((model) => model.id.toLowerCase().includes(bare) && !/latest$/u.test(model.id)).sort(newer);
    const pick = family.find((model) => model.provider === "anthropic") ?? family[0];
    return pick ? ref(pick) : undefined;
  }
  return undefined;
}

/* ── the soul ─────────────────────────────────────────────────────────── */

export const KNOWN_HEADING = "## What you already know";

/**
 * SOUL.md for an imported bot: its persona (cut to fit), then its memories under "What you already know", each as a
 * line or a short section, while they fit in `BOT_LIMITS.soul`. A persona that already has that section (a HUI export
 * of an imported bot) gets them at its end, under no second heading. Memories need a persona: without one the bot writes
 * its own soul in its first conversation, and they stay out.
 */
export function composeSoul(persona: string, memories: readonly { name?: string; text: string }[], source: string, limit: number = BOT_LIMITS.soul): { soul: string; included: number; cut: boolean } {
  let soul = persona.trim();
  const cut = soul.length > limit;
  if (cut) soul = soul.slice(0, limit).trimEnd();
  if (!soul || !memories.length) return { soul, included: 0, cut };
  const head = soul.includes(KNOWN_HEADING) ? "" : `${KNOWN_HEADING}\n\nBrought over from ${source} when HUI created you. It is what you knew there; the operator may correct it.\n\n`;
  let body = "";
  let previous = "";
  let included = 0;
  for (const memory of memories) {
    const text = memory.text.trim();
    const line = text.includes("\n") ? `### ${memory.name ? oneLine(memory.name, 120) : "Note"}\n\n${text}` : `- ${memory.name ? `**${oneLine(memory.name, 120)}:** ` : ""}${text}`;
    // Bullets stay together; a section stands apart from what is around it.
    const next = body ? `${body}${line.startsWith("- ") && previous.startsWith("- ") ? "\n" : "\n\n"}${line}` : line;
    if (`${soul}\n\n${head}${next}`.length > limit) break;
    body = next;
    previous = line;
    included += 1;
  }
  return { soul: included ? `${soul}\n\n${head}${body}` : soul, included, cut };
}

/* ── a template from the browser ──────────────────────────────────────── */

const MAX_FIELD = 200_000;

function text(value: unknown, what: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new TemplateFormatError(`The template's ${what} is missing.`);
    return "";
  }
  if (typeof value !== "string") throw new TemplateFormatError(`The template's ${what} must be text.`);
  if (value.length > max) throw new TemplateFormatError(`The template's ${what} is longer than ${max.toLocaleString("en-US")} characters.`);
  if (value.includes("\0")) throw new TemplateFormatError(`The template's ${what} must be text.`);
  if (required && !value.trim()) throw new TemplateFormatError(`The template's ${what} is empty.`);
  return value.trim();
}

function items(value: unknown, what: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TemplateFormatError(`The template's ${what} must be a list.`);
  if (value.length > max) throw new TemplateFormatError(`The template has ${value.length} ${what}; HUI imports at most ${max}.`);
  return value;
}

function automation(value: unknown): AutomationSchedule | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "at" && typeof value["at"] === "string") return { kind: "at", at: value["at"] };
  if (value["kind"] === "every" && Number.isSafeInteger(value["everyMs"])) return { kind: "every", everyMs: value["everyMs"] as number };
  if (value["kind"] === "cron" && typeof value["expression"] === "string" && typeof value["timezone"] === "string") return { kind: "cron", expression: value["expression"], timezone: value["timezone"] };
  return undefined;
}

/** A template as `POST /__hui/bots/import` receives it, checked field by field: every limit an importer keeps, again. */
export function normalizeTemplate(value: unknown): BotTemplate {
  if (!isRecord(value)) throw new TemplateFormatError("A template is required: preview the source first, then send its template.");
  const format = str(value["format"]) as BotTemplateFormat;
  if (!(format in BOT_TEMPLATE_FORMATS)) throw new TemplateFormatError("The template's format is not one HUI reads.");
  const lines = (key: string) => items(value[key], key, 200).map((line) => oneLine(text(line, key, 2_000), 2_000)).filter(Boolean);
  const template: BotTemplate = {
    format,
    name: oneLine(text(value["name"], "name", 1_000), BOT_LIMITS.name) || "Imported Bot",
    soul: text(value["soul"], "soul", MAX_FIELD),
    memories: items(value["memories"], "memories", BOT_TEMPLATE_LIMITS.memories).map((memory) => {
      if (!isRecord(memory)) throw new TemplateFormatError("Each memory must be an object.");
      const name = oneLine(text(memory["name"], "memory name", 1_000), 200);
      return { ...(name ? { name } : {}), text: text(memory["text"], "memory", 50_000) };
    }).filter((memory) => memory.text),
    skills: items(value["skills"], "skills", BOT_TEMPLATE_LIMITS.skills).map((skill) => {
      if (!isRecord(skill)) throw new TemplateFormatError("Each skill must be an object.");
      const name = text(skill["name"], "skill name", 200, true);
      const files = skillFiles(skill["files"], name, []);
      return { name, description: oneLine(text(skill["description"], "skill description", 5_000), 1_024), content: text(skill["content"], "skill", BOT_TEMPLATE_LIMITS.skill), ...(files.length ? { files } : {}) };
    }),
    routines: items(value["routines"], "routines", BOT_TEMPLATE_LIMITS.routines).map((routine) => {
      if (!isRecord(routine)) throw new TemplateFormatError("Each routine must be an object.");
      const schedule = text(routine["schedule"], "routine schedule", 500);
      const exact = automation(routine["automation"]);
      const description = text(routine["description"], "routine description", 2_000);
      return {
        name: oneLine(text(routine["name"], "routine name", 1_000), 200) || "Routine",
        prompt: text(routine["prompt"], "routine prompt", 20_000, true),
        ...(schedule ? { schedule } : {}), ...(exact ? { automation: exact } : {}), ...(description ? { description: oneLine(description, 500) } : {}),
      };
    }),
    integrations: items(value["integrations"], "integrations", BOT_TEMPLATE_LIMITS.integrations).map((integration) => {
      if (!isRecord(integration)) throw new TemplateFormatError("Each integration must be an object.");
      const description = oneLine(text(integration["description"], "integration description", 5_000), 300);
      return { name: oneLine(text(integration["name"], "integration name", 500, true), 120), ...(description ? { description } : {}) };
    }),
    dropped: lines("dropped"),
    notes: lines("notes"),
  };
  const optional = (key: string, max: number, oneLined = false) => {
    const found = text(value[key], key, max);
    return oneLined ? oneLine(found, max) : found;
  };
  const origin = optional("origin", 2_000, true);
  if (origin) template.origin = origin;
  const author = optional("author", 200, true);
  if (author) template.author = author;
  const title = oneLine(optional("title", 1_000), BOT_LIMITS.title);
  if (title) template.title = title;
  const description = optional("description", 5_000);
  if (description) template.description = oneLine(description, BOT_LIMITS.description);
  const emoji = optional("emoji", 32);
  if (emoji) template.emoji = emoji;
  const opener = optional("opener", BOT_LIMITS.message);
  if (opener) template.opener = opener;
  const model = optional("model", 200, true);
  if (model) template.model = model;
  if (isRecord(value["avatar"])) {
    const shape = value["avatar"]["shape"];
    const ears = value["avatar"]["ears"];
    const color = str(value["avatar"]["color"]).toLowerCase();
    template.avatar = { ...(isBotFaceShape(shape) ? { shape } : {}), ...(isBotFaceEars(ears) ? { ears } : {}), ...(/^#[0-9a-f]{6}$/u.test(color) ? { color } : {}) };
  }
  if (value["tools"] !== undefined) template.tools = items(value["tools"], "tools", 200).map((tool) => oneLine(text(tool, "tool", 200), 200)).filter(Boolean);
  // A HUI template's points for its new owner, needs and triggers, bounded as its reader bounds them.
  if (value["open"] !== undefined) template.open = openPoints(value["open"]);
  if (value["needs"] !== undefined) template.needs = needsList(value["needs"]);
  if (value["triggers"] !== undefined) template.triggers = templateTriggers(value["triggers"], []);
  if (isRecord(value["hui"])) {
    const hui = value["hui"];
    const levels: readonly string[] = BOT_THINKING_LEVELS;
    const handle = oneLine(text(hui["handle"], "handle", 200), 64);
    const thinking = str(hui["thinking"]);
    const memoryModel = oneLine(text(hui["memoryModel"], "utility model", 200), 200);
    const memoryThinking = str(hui["memoryThinking"]);
    const voice = isRecord(hui["voice"]) ? hui["voice"] : {};
    const language = voiceLanguage(voice["language"]);
    const live = gptLiveVoice(voice["live"]);
    const tagging = storedTagging(hui["tagging"]);
    template.hui = {
      ...(handle ? { handle } : {}),
      ...(levels.includes(thinking) ? { thinking } : {}),
      ...(memoryModel ? { memoryModel } : {}),
      ...(levels.includes(memoryThinking) ? { memoryThinking } : {}),
      ...(language || live ? { voice: { ...(language ? { language } : {}), ...(live ? { live } : {}) } } : {}),
      ...(tagging ? { tagging } : {}),
      disabledTools: items(hui["disabledTools"], "disabled tools", 500).map((name) => oneLine(text(name, "tool", 200), 200)).filter(Boolean),
      disabledSkills: items(hui["disabledSkills"], "disabled skills", 500).map((name) => oneLine(text(name, "skill", 200), 200)).filter(Boolean),
    };
  }
  return template;
}
