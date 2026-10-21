/**
 * Importing bots from other platforms' templates and HUI's own (HUI-18; docs/api.md#importing-and-exporting-bots).
 *
 * An import reads its source (`bot-templates/`) into a `BotTemplate`, then plans it against this gateway: the handle it
 * gets, SOUL.md (its persona, then its memories under "What you already know": OptChat's memory is the chat's own log,
 * so nothing else can seed it), the model it names when one resolves, the tools a Claude Code subagent keeps, its
 * skills (renamed when a skill of its directory has the name), its routines' schedules and the HUI tool each
 * integration maps to. The preview is that plan; creating runs it again on the template the preview showed and makes
 * the bot through `BotService.create`, then its own skills, then its routines and triggers (disabled): a failure there
 * deletes the new bot again. Its opener is its first turn, a kickoff that asks it to send it.
 *
 * A HUI template (`server/bots/export-format.ts` makes them) brings more: `{{user}}` becomes this operator's name, its open
 * points go into SOUL.md under "Not agreed yet", and its first turn asks the bot to go through them with the operator;
 * its triggers and the files beside its skills come with it.
 *
 * Nothing an import brings turns on more than a new bot has: a template can only turn tools off, routines and triggers
 * start disabled, a model is kept only when it resolves, and its first turn is not the operator's (its gated tools
 * refuse). Its skills are on, like every skill of a bot: they are text the operator read in the preview, they widen no
 * tool, and each can be turned off on the Tools & skills page. The export side is `export.ts`.
 */
import { BOT_HANDLE, BOT_LIMITS, BOT_THINKING_LEVELS, handleFromName, isBotFaceEars, isBotFaceShape, type BotAvatar } from "../bots-format.ts";
import type { BotTemplateTrigger } from "./export-format.ts";
import {
  BOT_SKILL_TEXT_FILE, BOT_TEMPLATE_FORMATS, BOT_TEMPLATE_LIMITS, botOpenerKickoffText, botTemplateKickoffText, notAgreedSection,
  type BotImportPreview, type BotImportResult, type BotImportRoutine, type BotTemplate,
} from "./templates/formats.ts";
import type { BotTriggerInput } from "./triggers-format.ts";
import type { AutomationSchedule, AutomationTask, AutomationTaskInput } from "../automation.ts";
import { nextScheduleAt } from "../automation.ts";
import type { BotOffer, BotService } from "./service.ts";
import type { BotSkillFiles } from "./skills.ts";
import { BotInputError, isOneGrapheme, RESERVED_HANDLES, uniqueHandle } from "./bots.ts";
import { CLAUDE_CODE_TOOLS } from "./templates/claude-code.ts";
import { isRecord, oneLine, skillFileText, skillName, TemplateFormatError, type ImportFile } from "./templates/common.ts";
import { readFileTemplates, readFolderTemplates, readTextTemplates, type TemplateChoice } from "./templates/detect.ts";
import { parseGrokBotPage, grokBotUrl } from "./templates/grok.ts";
import { composeSoul, matchIntegration, normalizeTemplate, resolveModel, type ModelInfo } from "./templates/mapping.ts";
import { readSchedule } from "./templates/schedule.ts";
import { safeRelativePath } from "./templates/zip.ts";

export type BotTemplateDeps = {
  bots: Pick<BotService, "create" | "get" | "list" | "send" | "delete" | "update" | "catalog">;
  /** What a new bot's chat is offered (the tools every chat has, the skills of a new home folder), here or on a worker. */
  offer(worker?: string): Promise<BotOffer>;
  /** Every model this gateway resolves. */
  models(): Promise<readonly ModelInfo[]>;
  routines: { tasks(): Promise<readonly AutomationTask[]>; create(input: AutomationTaskInput): Promise<AutomationTask> };
  /** A HUI template's triggers, made for the new bot (disabled). */
  triggers: { create(botId: string, input: BotTriggerInput): Promise<unknown> };
  /** A bot's own skills where its chat runs; undefined when that worker can't keep them. */
  skills(worker?: string): BotSkillFiles | undefined;
  /** A remote worker by id or exact name; absent: bots run here only. */
  findWorker?(target: string): Promise<{ id: string; name: string }>;
  /** Settings' profile name, which a character card's `{{user}}` becomes. */
  operator(): Promise<string | undefined>;
  /** The time zone routines' schedules are read in. */
  timezone(): string;
  /** A Grok Bot marketplace page's HTML, fetched only now, on the operator's request. */
  fetchPage(url: string): Promise<string>;
  /** A bot's own skills changed on this machine: its chat's resources load again. */
  skillsWritten?(cwd: string): void;
  now?: () => number;
  report?(event: { level: "warning" | "error"; action: string; summary: string; detail?: string }): void;
};

type Plan = {
  preview: Omit<BotImportPreview, "template" | "candidates" | "pick">;
  /** `POST /__hui/bots`'s body. */
  input: Record<string, unknown>;
  skills: { name: string; text: string; files?: { path: string; text: string }[] }[];
  routines: (BotImportRoutine & { description?: string })[];
  triggers: BotTemplateTrigger[];
  /** A HUI export's turned-off skills, by name: set once its own skills exist. */
  disabledSkills: string[];
  /** Its open points' first turn can run there: never on an older worker, whose host would read it as the operator's. */
  pointsTurn: boolean;
};

const listed = (items: readonly string[]) => items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** A body's fields, refusing any other. */
function fields(body: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!isRecord(body)) throw new BotInputError(`${what} must be an object.`);
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new BotInputError(`Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  return body;
}

function base64(value: unknown, what: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/=\s]*$/u.test(value)) throw new BotInputError(`${what} must be base64.`);
  if (value.length > Math.ceil(BOT_TEMPLATE_LIMITS.fileBytes / 3) * 4 + 1_024) throw new BotInputError(`${what} is larger than ${BOT_TEMPLATE_LIMITS.fileBytes / 1024 / 1024} MB.`);
  return Buffer.from(value, "base64");
}

/**
 * A HUI template with `{{user}}` as this operator's name ("the operator" without one): in its profile, Markdown, prompts
 * and open points, never in a script or a trigger's filter. Other formats as they are (a character card's macros were
 * filled in when it was read).
 */
function withOperator(template: BotTemplate, operator: string | undefined): BotTemplate {
  if (template.format !== "hui") return template;
  const user = operator || "the operator";
  const fill = (text: string) => text.replace(/\{\{\s*user\s*\}\}/giu, user);
  return {
    ...template,
    name: fill(template.name),
    ...(template.title !== undefined ? { title: fill(template.title) } : {}),
    ...(template.description !== undefined ? { description: fill(template.description) } : {}),
    soul: fill(template.soul),
    skills: template.skills.map((skill) => ({
      ...skill, description: fill(skill.description), content: fill(skill.content),
      ...(skill.files ? { files: skill.files.map((file) => BOT_SKILL_TEXT_FILE.test(file.path) ? { ...file, text: fill(file.text) } : file) } : {}),
    })),
    routines: template.routines.map((routine) => ({ ...routine, name: fill(routine.name), prompt: fill(routine.prompt), ...(routine.description !== undefined ? { description: fill(routine.description) } : {}) })),
    ...(template.triggers ? { triggers: template.triggers.map((trigger) => ({ ...trigger, name: fill(trigger.name), ...(trigger.prompt !== undefined ? { prompt: fill(trigger.prompt) } : {}) })) } : {}),
    ...(template.open ? { open: template.open.map((point) => ({ ...point, where: fill(point.where), question: fill(point.question), ...(point.excerpt !== undefined ? { excerpt: fill(point.excerpt) } : {}) })) } : {}),
    ...(template.needs ? { needs: template.needs.map(fill) } : {}),
  };
}

/** A schedule HUI keeps as it is: a HUI export's, when it still has a next run. */
function exactSchedule(schedule: AutomationSchedule, now: number): AutomationSchedule | undefined {
  try {
    return nextScheduleAt(schedule, now) === null ? undefined : schedule;
  } catch {
    return undefined;
  }
}

export class BotTemplateService {
  readonly #deps: BotTemplateDeps;
  readonly #now: () => number;

  constructor(deps: BotTemplateDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** `POST /__hui/bots/import/preview`: `{ source, pick?, worker? }`. Reads the source (fetching a Grok Bot page now) and
   * says what creating its bot would do; nothing is created. */
  async preview(body: unknown): Promise<BotImportPreview> {
    const input = fields(body, ["source", "pick", "worker"], "An import preview");
    const choices = await this.#read(input["source"]);
    const pick = input["pick"] === undefined ? undefined : String(input["pick"]);
    const choice = pick === undefined ? choices[0]! : choices.find((each) => each.key === pick);
    if (!choice) throw new BotInputError(`This source holds no agent ${JSON.stringify(pick)}.`);
    const worker = await this.#worker(input["worker"]);
    // The template the browser gets back is exactly what creating it checks again.
    const template = normalizeTemplate(JSON.parse(JSON.stringify(choice.template)) as unknown);
    const plan = await this.#plan(template, worker);
    return {
      template,
      ...(choices.length > 1 ? { candidates: choices.map(({ key, template: each }) => ({ key, name: each.name, ...(each.title ? { title: each.title } : {}) })), pick: choice.key } : {}),
      ...plan.preview,
    };
  }

  /** `POST /__hui/bots/import`: `{ template, worker? }`, the template a preview returned. */
  async create(body: unknown): Promise<BotImportResult> {
    const input = fields(body, ["template", "worker"], "An import");
    const template = normalizeTemplate(input["template"]);
    const worker = await this.#worker(input["worker"]);
    const plan = await this.#plan(template, worker);
    const bot = await this.#deps.bots.create(plan.input);
    const warnings: string[] = [];
    try {
      if (plan.skills.length) {
        const files = this.#deps.skills(worker?.id);
        if (!files) throw new BotInputError(`${worker?.name ?? "This machine"} can't keep a bot's own skills.`);
        await files.write(bot.id, plan.skills);
        if (!worker) this.#deps.skillsWritten?.(bot.cwd);
      }
      for (const routine of plan.routines) {
        await this.#deps.routines.create({
          name: routine.name, sessionId: bot.sessionId, prompt: routine.prompt, schedule: routine.schedule, enabled: false,
          ...(routine.description ? { description: routine.description } : {}),
        });
      }
      for (const trigger of plan.triggers) {
        await this.#deps.triggers.create(bot.id, { name: trigger.name, source: "listener", filter: trigger.filter, ...(trigger.prompt ? { prompt: trigger.prompt } : {}), ...(trigger.delivery ? { delivery: trigger.delivery } : {}), enabled: false, cooldownSeconds: trigger.cooldownSeconds });
      }
    } catch (error) {
      // Half an import is no import: the bot goes again, with its folder and the routines and triggers made so far.
      await this.#deps.bots.delete(bot.id).catch((cleanup: unknown) => this.#report("error", "bot_import_rollback_failed", `@${bot.handle} was left half imported`, cleanup));
      throw error;
    }
    if (plan.disabledSkills.length) {
      try {
        const catalog = await this.#deps.bots.catalog(bot.id);
        const known = plan.disabledSkills.filter((name) => catalog.skills.some((skill) => skill.name === name));
        if (known.length) await this.#deps.bots.update(bot.id, { disabledSkills: known });
      } catch (error) {
        warnings.push(`Its skills ${listed(plan.disabledSkills)} stay on: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Its first turn: going through a HUI template's open points, or sending its template's opener.
    let opener = false;
    const kickoff = plan.pointsTurn ? botTemplateKickoffText(bot.name) : plan.preview.opener ? botOpenerKickoffText(bot.name, plan.preview.opener) : undefined;
    if (kickoff) {
      try {
        await this.#deps.bots.send(bot.id, { text: kickoff });
        opener = true;
      } catch (error) {
        warnings.push(`Its first message was not sent: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { bot: await this.#deps.bots.get(bot.id), skills: plan.skills.map((skill) => skill.name), routines: plan.routines.length, opener, warnings };
  }

  async #worker(value: unknown): Promise<{ id: string; name: string } | undefined> {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 100) throw new BotInputError("worker must name a worker: its name or id.");
    if (!this.#deps.findWorker) throw new BotInputError("This gateway cannot run bots on remote workers.");
    return this.#deps.findWorker(value.trim());
  }

  /** Every bot a source holds. */
  async #read(source: unknown): Promise<TemplateChoice[]> {
    if (!isRecord(source)) throw new BotInputError("source is required: a file, a folder, a link or text.");
    const options = { operator: await this.#deps.operator().catch(() => undefined) };
    const { kind } = source;
    if (kind === "text") {
      const input = fields(source, ["kind", "text"], "A pasted source");
      if (typeof input["text"] !== "string") throw new BotInputError("text must be text.");
      return readTextTemplates(input["text"], undefined, options.operator ? options : {});
    }
    if (kind === "url") {
      const input = fields(source, ["kind", "url"], "A link");
      const url = typeof input["url"] === "string" ? grokBotUrl(input["url"]) : undefined;
      if (!url) throw new TemplateFormatError("HUI fetches Grok Bot marketplace links only (https://x.ai/bot/marketplace/bots/…). For anything else, download the file and import it, or paste its text.");
      return [{ key: "0", template: parseGrokBotPage(await this.#deps.fetchPage(url), url) }];
    }
    if (kind === "file") {
      const input = fields(source, ["kind", "name", "data"], "A file");
      const name = typeof input["name"] === "string" ? input["name"].split(/[\\/]/u).pop()!.slice(0, 255) : "";
      if (!name) throw new BotInputError("A file needs its name.");
      return readFileTemplates(name, base64(input["data"], name), options.operator ? options : {});
    }
    if (kind === "files") {
      const input = fields(source, ["kind", "files"], "A folder");
      const list = input["files"];
      if (!Array.isArray(list) || !list.length) throw new BotInputError("A folder needs its files.");
      if (list.length > BOT_TEMPLATE_LIMITS.files) throw new TemplateFormatError(`This folder holds ${list.length} files; HUI imports at most ${BOT_TEMPLATE_LIMITS.files}.`);
      const files: ImportFile[] = [];
      for (const entry of list) {
        if (!isRecord(entry) || typeof entry["path"] !== "string") throw new BotInputError("Each file of a folder needs its path and data.");
        const path = safeRelativePath(entry["path"]);
        if (!path) throw new BotInputError(`${JSON.stringify(entry["path"].slice(0, 200))} is not a path inside the folder.`);
        files.push({ path, data: base64(entry["data"], path) });
      }
      return readFolderTemplates(files, options.operator ? options : {});
    }
    throw new BotInputError("source.kind must be file, files, url or text.");
  }

  async #plan(read: BotTemplate, worker: { id: string; name: string } | undefined): Promise<Plan> {
    const template = withOperator(read, await this.#deps.operator().catch(() => undefined));
    const now = this.#now();
    const dropped = [...template.dropped];
    const notes = [...template.notes];
    const [bots, offer, models] = await Promise.all([this.#deps.bots.list({ archived: "all" }), this.#deps.offer(worker?.id), this.#deps.models().catch(() => [])]);
    const taken = new Set(bots.map((bot) => bot.handle));
    const name = oneLine(template.name, BOT_LIMITS.name) || "Imported Bot";
    const own = template.hui?.handle;
    const keepHandle = own !== undefined && BOT_HANDLE.test(own) && !taken.has(own) && !RESERVED_HANDLES.has(own);
    const handle = keepHandle ? own : uniqueHandle(handleFromName(name), taken);
    if (own && !keepHandle) notes.push(`@${own} is taken here, so it is @${handle}.`);
    const input: Record<string, unknown> = { name, ...(keepHandle ? { handle } : {}) };
    if (worker) input["worker"] = worker.id;
    if (template.title) input["title"] = oneLine(template.title, BOT_LIMITS.title);
    if (template.description) input["description"] = template.description.slice(0, BOT_LIMITS.description);
    const avatar: BotAvatar = {
      ...(template.emoji && isOneGrapheme(template.emoji) ? { emoji: template.emoji } : {}),
      ...(isBotFaceShape(template.avatar?.shape) ? { shape: template.avatar.shape } : {}),
      ...(isBotFaceEars(template.avatar?.ears) ? { ears: template.avatar.ears } : {}),
      ...(template.avatar?.color && /^#[0-9a-f]{6}$/u.test(template.avatar.color) ? { color: template.avatar.color } : {}),
    };
    if (template.emoji && !avatar.emoji) dropped.push(`Its emoji "${oneLine(template.emoji, 20)}": a HUI bot's emoji is one character.`);
    if (Object.keys(avatar).length) input["avatar"] = avatar;

    // Tools: a Claude Code subagent's list keeps only what it maps to; a HUI export turns its own list off. Never more on.
    const offered = offer.tools.map((tool) => tool.name);
    let disabledTools: string[] = [];
    if (template.tools) {
      const keep = new Set(template.tools.flatMap((tool) => CLAUDE_CODE_TOOLS[tool] ?? []));
      const unknown = template.tools.filter((tool) => !CLAUDE_CODE_TOOLS[tool]);
      disabledTools = offered.filter((tool) => !keep.has(tool));
      if (unknown.length) dropped.push(`Claude Code tools with nothing like them here: ${listed(unknown)}.`);
      const kept = offered.filter((tool) => keep.has(tool));
      notes.push(`Its tools list keeps ${kept.length ? listed(kept) : "none of HUI's tools"} on and turns the other ${plural(disabledTools.length, "tool")} off; turn any back on from its Tools & skills page.`);
    } else if (template.hui?.disabledTools?.length) {
      disabledTools = template.hui.disabledTools.filter((tool) => offered.includes(tool));
      const missing = template.hui.disabledTools.filter((tool) => !offered.includes(tool));
      if (missing.length) dropped.push(`Turned off there, but no tool of a new bot here: ${listed(missing)}.`);
    }
    if (disabledTools.length) input["disabledTools"] = disabledTools;

    // Its own skills, named as PI wants them, and apart from the skills its directory already has.
    const skills: Plan["skills"] = [];
    const previewSkills: BotImportPreview["skills"] = [];
    const keepsFiles = this.#deps.skills(worker?.id)?.files === true;
    if (template.skills.length) {
      if (!this.#deps.skills(worker?.id)) {
        dropped.push(`${plural(template.skills.length, "skill")}: ${worker?.name ?? "This machine"} runs an older HUI worker that can't keep a bot's own skills.`);
      } else {
        const names = new Set(offer.skills.map((skill) => skill.name));
        for (const skill of template.skills) {
          const wanted = skillName(skill.name);
          let unique = wanted;
          for (let suffix = 2; names.has(unique); suffix += 1) unique = `${wanted.slice(0, 64 - String(suffix).length - 1).replace(/-+$/u, "")}-${suffix}`;
          names.add(unique);
          if (unique !== wanted) notes.push(`Skill ${skill.name} is imported as ${unique}: a skill of its directory has the name ${wanted}.`);
          const files = keepsFiles ? skill.files ?? [] : [];
          if (skill.files?.length && !keepsFiles) dropped.push(`Skill ${skill.name}: its ${plural(skill.files.length, "file")} beside SKILL.md, as ${worker?.name ?? "this machine"} runs an older HUI worker that keeps SKILL.md only.`);
          skills.push({ name: unique, text: skillFileText({ ...skill, name: unique }), ...(files.length ? { files } : {}) });
          previewSkills.push({ name: unique, original: skill.name, description: skill.description, content: skill.content, ...(files.length ? { files } : {}) });
        }
      }
    }

    // SOUL.md: the persona, then what it already knows.
    const source = `${BOT_TEMPLATE_FORMATS[template.format]}${template.origin ? ` (${oneLine(template.origin, 120)})` : ""}`;
    // A template whose job lives in its memories (many Grok marketplace bots leave their instructions empty) keeps them:
    // its description stands in as the persona they follow.
    let persona = template.soul;
    if (!persona.trim() && template.memories.length) {
      persona = template.description?.trim() || `You are ${name}${template.title ? `, ${template.title}` : ""}.`;
      notes.push("It has no instructions of its own: its description stands in as its persona, followed by what it already knows.");
    }
    // A HUI template's open points close SOUL.md under "Not agreed yet". Their room comes first: the persona is cut, never
    // the points (they take at most half of it; any beyond are listed as left out).
    let open = persona.trim() ? template.open ?? [] : [];
    if (template.open?.length && !open.length) dropped.push(`Its ${plural(template.open.length, "open point")}: without a persona the bot writes its own soul in its first conversation.`);
    while (open.length > 1 && notAgreedSection(open).length > BOT_LIMITS.soul / 2) open = open.slice(0, -1);
    if (template.open && open.length && open.length < template.open.length) dropped.push(`${plural(template.open.length - open.length, "open point")} that didn't fit in SOUL.md.`);
    const section = open.length ? notAgreedSection(open) : "";
    const room = section ? BOT_LIMITS.soul - section.length - 2 : BOT_LIMITS.soul;
    const composed = composeSoul(persona, template.memories, source, room);
    if (composed.cut) notes.push(`Its persona has ${template.soul.length.toLocaleString("en-US")} characters; SOUL.md keeps the first ${room.toLocaleString("en-US")}.`);
    if (section) composed.soul = `${composed.soul}\n\n${section}`;
    const left = template.memories.length - composed.included;
    if (left) dropped.push(composed.soul ? `${plural(left, "memory", "memories")} that didn't fit in SOUL.md's ${BOT_LIMITS.soul.toLocaleString("en-US")} characters.` : `${plural(left, "memory", "memories")}: without a persona the bot writes its own soul in its first conversation.`);
    if (composed.soul) input["soul"] = composed.soul;
    else notes.push("It has no persona, so it starts with its first conversation: it asks what you expect and writes its SOUL.md.");
    const opener = composed.soul ? template.opener : undefined;
    if (template.opener && !opener) dropped.push("Its first message: without a persona the bot opens its first conversation itself.");

    // Models: only what this gateway resolves.
    let model: string | undefined;
    if (template.model) {
      model = resolveModel(template.model, models);
      if (model) input["model"] = model;
      else dropped.push(`Its model ${oneLine(template.model, 80)}: this gateway has none by that name, so it starts on the default.`);
    }
    const levels: readonly string[] = BOT_THINKING_LEVELS;
    const thinking = template.hui?.thinking && levels.includes(template.hui.thinking) ? template.hui.thinking : undefined;
    if (thinking) input["thinking"] = thinking;
    let utilityModel: string | undefined;
    if (template.hui?.memoryModel) {
      utilityModel = resolveModel(template.hui.memoryModel, models);
      if (utilityModel) input["memoryModel"] = utilityModel;
      else dropped.push(`Its utility model ${template.hui.memoryModel}: this gateway has none by that name.`);
    }
    if (template.hui?.memoryThinking && levels.includes(template.hui.memoryThinking)) input["memoryThinking"] = template.hui.memoryThinking;
    if (template.hui?.voice && Object.keys(template.hui.voice).length) input["voice"] = { ...template.hui.voice };
    if (template.hui?.tagging) input["tagging"] = template.hui.tagging;

    // Routines: disabled, each on the schedule HUI reads from it.
    const timezone = this.#deps.timezone();
    const routines: Plan["routines"] = template.routines.map((routine) => {
      const exact = routine.automation ? exactSchedule(routine.automation, now) : undefined;
      const read = exact ? { schedule: exact, guessed: false } : readSchedule(routine.schedule, timezone, now);
      return {
        name: oneLine(routine.name, 200) || "Routine", prompt: routine.prompt, schedule: read.schedule, guessed: read.guessed,
        ...(routine.schedule ? { scheduleText: routine.schedule } : {}),
        ...(routine.description ? { description: routine.description.slice(0, 500) } : {}),
      };
    });
    if (routines.length) notes.push(`${routines.length === 1 ? "Its routine starts" : `Its ${routines.length} routines start`} disabled: check ${routines.length === 1 ? "it" : "them"} on its Routines page, then turn ${routines.length === 1 ? "it" : "them"} on.`);
    const triggers = template.triggers ?? [];
    if (triggers.length) notes.push(`${triggers.length === 1 ? "Its trigger starts" : `Its ${triggers.length} triggers start`} disabled: a listener you run wakes ${triggers.length === 1 ? "it" : "them"}, through a URL from New URL on its Triggers page.`);
    // An older worker's host reads an import's first turn as the operator's (it lets the bot rewrite its soul there): on
    // one the bot waits for the operator's first message instead. A worker that keeps skills' files knows the turn.
    const pointsTurn = open.length > 0 && (!worker || keepsFiles);
    if (open.length) notes.push(pointsTurn ? `It goes through ${plural(open.length, "open point")} with you in its first chat, then rewrites its SOUL.md.` : `It goes through ${plural(open.length, "open point")} once you write to it: ${worker?.name ?? "its worker"} runs an older HUI worker, so it doesn't speak first.`);

    const integrations = template.integrations.map((integration) => {
      const tool = matchIntegration(integration, offer.tools);
      return { ...integration, ...(tool ? { tool: { name: tool.name, label: tool.label } } : {}) };
    });
    const disabledSkills = template.hui?.disabledSkills ?? [];
    return {
      input,
      skills,
      routines,
      triggers,
      disabledSkills,
      pointsTurn,
      preview: {
        bot: {
          name, handle,
          ...(input["title"] ? { title: input["title"] as string } : {}),
          ...(input["description"] ? { description: input["description"] as string } : {}),
          ...(avatar.emoji ? { emoji: avatar.emoji } : {}),
          ...(avatar.shape || avatar.ears || avatar.color
            ? { avatar: { ...(avatar.shape ? { shape: avatar.shape } : {}), ...(avatar.ears ? { ears: avatar.ears } : {}), ...(avatar.color ? { color: avatar.color } : {}) } }
            : {}),
          ...(worker ? { worker } : {}),
        },
        soul: composed.soul,
        ...(opener ? { opener } : {}),
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(utilityModel ? { utilityModel } : {}),
        memories: { included: composed.included, total: template.memories.length },
        skills: previewSkills,
        routines: routines.map(({ description: _description, ...routine }) => routine),
        integrations,
        disabledTools,
        disabledSkills,
        open,
        needs: template.needs ?? [],
        triggers,
        dropped,
        notes,
      },
    };
  }

  #report(level: "warning" | "error", action: string, summary: string, error?: unknown): void {
    this.#deps.report?.({ level, action, summary, ...(error === undefined ? {} : { detail: error instanceof Error ? error.message : String(error) }) });
  }
}
