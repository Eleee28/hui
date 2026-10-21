/**
 * Reading HUI's own bot exports: a zip with `bot.json`, `SOUL.md` and the bot's own skills' folders. Version 2 is a
 * template, reviewed for personal information before it left (`server/bots/export-format.ts` makes it): its open points, what it
 * needs, its triggers and the files beside each SKILL.md come with it. Version 1 was an exact copy: its handle and, when
 * asked for, `memory.md` (its memory's view), which joins the soul's "What you already know" as every template's
 * memories do. Importing either gives the profile, soul, skills, routines (disabled, as every import's) and lists back.
 */
import { BOT_EXPORT_FILES, BOT_EXPORT_FORMAT, BOT_EXPORT_VERSION, type BotOpenPoint, type BotTemplateTrigger } from "../export-format.ts";
import { BOT_LIMITS, isBotFaceEars, isBotFaceShape, storedTagging, type BotVoice } from "../../bots-format.ts";
import { BOT_TEMPLATE_LIMITS, type BotTemplate, type BotTemplateSkillFile } from "./formats.ts";
import { BOT_TRIGGER_LIMITS } from "../triggers-format.ts";
import type { AutomationSchedule } from "../../automation.ts";
import { normalizeTriggerInput } from "../triggers-input.ts";
import { blankTemplate, fileText, findFile, isRecord, oneLine, skillFilePath, skillFromFile, str, TemplateFormatError, unwrapFolder, within, type ImportFile } from "./common.ts";

function manifestOf(files: readonly ImportFile[]): unknown {
  const file = findFile(unwrapFolder(files).files, BOT_EXPORT_FILES.manifest);
  const text = file ? fileText(file) : undefined;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a parsed JSON file is a HUI export's manifest. */
export function isHuiManifest(value: unknown): boolean {
  return isRecord(value) && value["format"] === BOT_EXPORT_FORMAT;
}

export function isHuiExport(files: readonly ImportFile[]): boolean {
  return isHuiManifest(manifestOf(files));
}

/** A routine's schedule as an export wrote it: exact, or (a version 2 cron, which has no time zone) undefined. */
function schedule(value: unknown): AutomationSchedule | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "at" && typeof value["at"] === "string") return { kind: "at", at: value["at"] };
  if (value["kind"] === "every" && typeof value["everyMs"] === "number") return { kind: "every", everyMs: value["everyMs"] };
  if (value["kind"] === "cron" && typeof value["expression"] === "string" && str(value["timezone"])) return { kind: "cron", expression: value["expression"], timezone: str(value["timezone"]) };
  return undefined;
}

/** `AutomationSchedule` as the text the schedule reader reads back exactly. */
export function scheduleLabel(value: AutomationSchedule): string {
  if (value.kind === "at") return `at ${value.at}`;
  if (value.kind === "every") return `every ${Math.round(value.everyMs / 60_000)}m`;
  return `cron ${value.expression} ${value.timezone}`;
}

/* ── what a version 2 template adds, checked here and again when it comes back from the browser ── */

/** A template's trigger, as `POST /__hui/bots/:id/triggers` would take it; undefined: not one. */
function templateTrigger(value: unknown): BotTemplateTrigger | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const input = normalizeTriggerInput({
      name: value["name"], filter: value["filter"] ?? {},
      ...(value["prompt"] !== undefined ? { prompt: value["prompt"] } : {}),
      ...(value["delivery"] !== undefined ? { delivery: value["delivery"] } : {}),
      ...(value["cooldownSeconds"] !== undefined ? { cooldownSeconds: value["cooldownSeconds"] } : {}),
    });
    return { name: input.name, filter: input.filter, ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.delivery ? { delivery: input.delivery } : {}), cooldownSeconds: input.cooldownSeconds ?? BOT_TRIGGER_LIMITS.cooldownDefault };
  } catch {
    return undefined;
  }
}

/** A template's triggers: each one a trigger's route would take, names unique, at most a bot's 20. */
export function templateTriggers(value: unknown, dropped: string[]): BotTemplateTrigger[] {
  const triggers: BotTemplateTrigger[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const trigger = templateTrigger(item);
    const named = isRecord(item) && typeof item["name"] === "string" ? oneLine(item["name"], 80) : "";
    if (!trigger) dropped.push(`A trigger HUI can't read${named ? `: ${named}` : ""}.`);
    else if (triggers.some((each) => each.name.toLowerCase() === trigger.name.toLowerCase())) dropped.push(`Trigger ${trigger.name}: another one has its name.`);
    else if (triggers.length >= BOT_TEMPLATE_LIMITS.triggers) dropped.push(`Trigger ${trigger.name}: a bot has at most ${BOT_TEMPLATE_LIMITS.triggers}.`);
    else triggers.push(trigger);
  }
  return triggers;
}

/** A template's open points, bounded. */
export function openPoints(value: unknown): BotOpenPoint[] {
  return (Array.isArray(value) ? value : []).flatMap((item): BotOpenPoint[] => {
    if (!isRecord(item) || (item["kind"] !== "ask" && item["kind"] !== "confirm")) return [];
    const question = oneLine(str(item["question"]), 300);
    if (!question) return [];
    const excerpt = oneLine(str(item["excerpt"]), 200);
    return [{ kind: item["kind"], where: oneLine(str(item["where"]), 160) || "SOUL.md", question, ...(excerpt ? { excerpt } : {}), ...(item["operator"] === true ? { operator: true as const } : {}) }];
  }).slice(0, BOT_TEMPLATE_LIMITS.open);
}

/** What a template says the bot needs, one line each, bounded. */
export function needsList(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : []).map((need) => oneLine(str(need), 200)).filter(Boolean))].slice(0, BOT_TEMPLATE_LIMITS.needs);
}

/** The files beside a skill's SKILL.md, within a skill's limits; the rest listed as left out. */
export function skillFiles(value: unknown, skill: string, dropped: string[]): BotTemplateSkillFile[] {
  const files: BotTemplateSkillFile[] = [];
  let total = 0;
  for (const item of Array.isArray(value) ? value : []) {
    if (!isRecord(item) || typeof item["path"] !== "string" || typeof item["text"] !== "string") continue;
    const path = skillFilePath(item["path"]);
    const bytes = Buffer.byteLength(item["text"]);
    const problem = !path ? "hidden, outside the skill's folder, or a second SKILL.md"
      : files.some((file) => file.path.toLowerCase() === path.toLowerCase()) ? "another file has its path, in another case"
      : files.length >= BOT_TEMPLATE_LIMITS.skillFiles ? `more than ${BOT_TEMPLATE_LIMITS.skillFiles} files`
      : bytes > BOT_TEMPLATE_LIMITS.skillFileBytes ? `larger than ${BOT_TEMPLATE_LIMITS.skillFileBytes / 1024} KB`
      : total + bytes > BOT_TEMPLATE_LIMITS.skillFilesBytes ? `past the skill's ${BOT_TEMPLATE_LIMITS.skillFilesBytes / 1024 / 1024} MB`
      : undefined;
    if (problem || !path) {
      dropped.push(`Skill ${skill}: ${oneLine(item["path"], 120)} (${problem}).`);
      continue;
    }
    total += bytes;
    files.push({ path, text: item["text"] });
  }
  return files;
}

/** A HUI export's bot, from its manifest (parsed) and its files. */
export function parseHuiExport(all: readonly ImportFile[], origin?: string, parsedManifest?: unknown): BotTemplate {
  const { files } = unwrapFolder(all);
  const manifest = parsedManifest ?? manifestOf(all);
  if (!isRecord(manifest) || manifest["format"] !== BOT_EXPORT_FORMAT) throw new TemplateFormatError("This is not a HUI bot export: its bot.json is missing or broken.");
  if (typeof manifest["version"] === "number" && manifest["version"] > BOT_EXPORT_VERSION) throw new TemplateFormatError("This bot was exported by a newer HUI. Update HUI to import it.");
  const bot = isRecord(manifest["bot"]) ? manifest["bot"] : {};
  const name = str(bot["name"]);
  if (!name) throw new TemplateFormatError("This HUI bot export names no bot.");
  const template = blankTemplate("hui", oneLine(name, BOT_LIMITS.name), origin);
  const title = str(bot["title"]);
  if (title) template.title = title;
  const description = str(bot["description"]);
  if (description) template.description = description;
  const avatar = isRecord(bot["avatar"]) ? bot["avatar"] : {};
  if (str(avatar["emoji"])) template.emoji = str(avatar["emoji"]);
  const shape = isBotFaceShape(avatar["shape"]) ? avatar["shape"] : undefined;
  const ears = isBotFaceEars(avatar["ears"]) ? avatar["ears"] : undefined;
  const color = /^#[0-9a-f]{6}$/iu.test(str(avatar["color"])) ? str(avatar["color"]).toLowerCase() : undefined;
  if (shape || ears || color) template.avatar = { ...(shape ? { shape } : {}), ...(ears ? { ears } : {}), ...(color ? { color } : {}) };
  if (str(bot["model"])) template.model = str(bot["model"]);
  const voice = isRecord(bot["voice"]) ? bot["voice"] : undefined;
  const tagging = storedTagging(bot["tagging"]);
  const extras: NonNullable<BotTemplate["hui"]> = {
    ...(str(bot["handle"]) ? { handle: str(bot["handle"]) } : {}),
    ...(str(bot["thinking"]) ? { thinking: str(bot["thinking"]) } : {}),
    ...(str(bot["memoryModel"]) ? { memoryModel: str(bot["memoryModel"]) } : {}),
    ...(str(bot["memoryThinking"]) ? { memoryThinking: str(bot["memoryThinking"]) } : {}),
    ...(voice ? { voice: { ...(str(voice["language"]) ? { language: str(voice["language"]) } : {}), ...(str(voice["live"]) ? { live: str(voice["live"]) } : {}) } as BotVoice } : {}),
    ...(tagging ? { tagging } : {}),
    disabledTools: Array.isArray(manifest["disabledTools"]) ? manifest["disabledTools"].map(str).filter(Boolean) : [],
    disabledSkills: Array.isArray(manifest["disabledSkills"]) ? manifest["disabledSkills"].map((skill) => isRecord(skill) ? str(skill["name"]) : str(skill)).filter(Boolean) : [],
  };
  template.hui = extras;
  const soul = findFile(files, BOT_EXPORT_FILES.soul);
  template.soul = (soul ? fileText(soul) ?? "" : "").trim();
  for (const skill of Array.isArray(manifest["skills"]) ? manifest["skills"].map(str).filter(Boolean) : []) {
    const folder = within(files, `${BOT_EXPORT_FILES.skills}/${skill}`);
    const file = findFile(folder, "SKILL.md");
    const text = file ? fileText(file) : undefined;
    if (text === undefined) {
      template.dropped.push(`Skill ${skill}: its SKILL.md is missing from the export.`);
      continue;
    }
    const parsed = skillFromFile(text, skill, template.dropped);
    if (!parsed) continue;
    const beside = folder.filter((each) => each !== file).flatMap((each) => {
      const content = fileText(each);
      if (content === undefined) template.dropped.push(`Skill ${skill}: ${each.path} (not text).`);
      return content === undefined ? [] : [{ path: each.path, text: content }];
    });
    const kept = skillFiles(beside, skill, template.dropped);
    template.skills.push(kept.length ? { ...parsed, files: kept } : parsed);
  }
  for (const routine of Array.isArray(manifest["routines"]) ? manifest["routines"].filter(isRecord) : []) {
    const routineName = str(routine["name"]);
    const prompt = str(routine["prompt"]);
    if (!routineName || !prompt) continue;
    const exact = schedule(routine["schedule"]);
    const raw = isRecord(routine["schedule"]) ? routine["schedule"] : {};
    // A version 2 cron has no time zone: read as text, it runs in the importer's.
    const text = exact ? scheduleLabel(exact) : raw["kind"] === "cron" && typeof raw["expression"] === "string" ? `cron ${raw["expression"]}` : undefined;
    const about = str(routine["description"]);
    template.routines.push({ name: routineName, prompt, ...(exact ? { automation: exact } : {}), ...(text ? { schedule: text } : {}), ...(about ? { description: about } : {}) });
  }
  if (manifest["triggers"] !== undefined) template.triggers = templateTriggers(manifest["triggers"], template.dropped);
  if (manifest["open"] !== undefined) template.open = openPoints(manifest["open"]);
  if (manifest["needs"] !== undefined) template.needs = needsList(manifest["needs"]);
  // memory.md (version 1): a header for people, a line, then the memory's view; a file without the line is the memory whole.
  const memory = findFile(files, BOT_EXPORT_FILES.memory);
  const text = memory ? fileText(memory) ?? "" : "";
  const separator = text.search(/^---[ \t]*$/mu);
  const remembered = (separator === -1 ? text : text.slice(separator).replace(/^---[ \t]*\n?/u, "")).trim();
  if (remembered && !/^<chat>\s*<\/chat>$/u.test(remembered)) template.memories.push({ name: `Memory of @${extras.handle ?? name} when it was exported`, text: remembered });
  else if (memory) template.notes.push("Its exported memory was empty.");
  return template;
}
