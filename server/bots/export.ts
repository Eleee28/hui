/**
 * Exporting a bot as a template someone else imports (HUI-18; SPEC.md, "Bot exports are templates, reviewed for
 * personal information"; the contract is docs/api.md#importing-and-exporting-bots).
 *
 * `review` reads what of the bot would travel (its profile, SOUL.md, its own skills' folders, routines, triggers and
 * turned-off lists), cleans it (`bot-templates/cleanup.ts`), has Settings' utility model read each part as a plain
 * completion, with no tools (`bot-templates/review.ts`), and keeps the result as the bot's latest review until the
 * gateway restarts. `export` takes only the operator's picks for that review and refuses when anything the export holds
 * changed since, so nothing leaves unreviewed; otherwise it zips exactly what `buildExport` makes of the review: the
 * files the dialog showed.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  buildExport, changeGroups, withAdditions, type BotExportAddition, type BotExportChange, type BotExportCleanup, type BotExportFileChange, type BotExportGroup,
  type BotExportMeta, type BotExportPart, type BotExportReview, type BotExportSchedule,
} from "./export-format.ts";
import { BOT_SKILL_TEXT_FILE } from "./templates/formats.ts";
import type { BotView } from "../bots-format.ts";
import type { BotTrigger } from "./triggers-format.ts";
import type { AutomationTask } from "../automation.ts";
import type { BotOffer, BotService } from "./service.ts";
import type { BotOwnSkill, BotSkillFiles } from "./skills.ts";
import { BotConflictError, BotInputError } from "./bots.ts";
import { cleanText, personalIn, type CleanupIdentity } from "./templates/cleanup.ts";
import { isRecord, oneLine } from "./templates/common.ts";
import { NEEDS_MERGE_PROMPT, parseNeeds, parseReviewAnswer, reviewChunks, reviewPrompt, reviewSystemPrompt, type ReviewAnswer, type ReviewedChange } from "./templates/review.ts";
import { writeZip } from "./templates/zip.ts";
import type { CallCompletion } from "./call-helper.ts";
import { runCommand } from "../git/worktree-inventory.ts";

export type BotExportDeps = {
  bots: Pick<BotService, "get" | "list" | "soul">;
  /** What a new bot's chat is offered, here or on a worker: its tools are the built-in ones an export lists. */
  offer(worker?: string): Promise<BotOffer>;
  routines: { tasks(): Promise<readonly AutomationTask[]> };
  triggers: { list(botId: string): Promise<readonly BotTrigger[]> };
  /** A bot's own skills where its chat runs; undefined when that worker can't keep them. */
  skills(worker?: string): BotSkillFiles | undefined;
  /** Settings' utility model; undefined: the review is the cleanup alone. */
  utilityModel(): Promise<string | undefined>;
  /** One plain completion, no tools: the reviewer. */
  completion: CallCompletion;
  /** Who the operator is, for the cleanup: this machine's identity and, for a bot on a worker, the worker's too. */
  identity(worker?: string): Promise<CleanupIdentity>;
  now?: () => number;
};

/** One request to the reviewer, the whole review, and how many requests run at once. A utility model behind a gateway
 * can take over a minute on a long SOUL.md. */
const CALL_MS = 150_000;
const REVIEW_MS = 6 * 60_000;
const READ_AT_ONCE = 8;
/** Passages an operator adds to one download, at most. */
const MAX_ADDITIONS = 50;
/** Longer than this, what the bot needs is merged (`NEEDS_MERGE_PROMPT`). */
const MERGE_NEEDS_OVER = 6;
/** Inside a zip every file is dated 1980-01-01, the earliest a ZIP date can be: a local date would tell the time zone. */
const ZIP_DATE = new Date(1980, 0, 1);
const RANK = { remove: 0, ask: 1, confirm: 2 } as const;

/** What of a bot an export reads, and the hash that tells whether it changed since its review. */
type Input = {
  bot: BotView;
  soul: string;
  skills: BotOwnSkill[];
  skillsKept: "all" | "skill-md" | "none";
  routines: AutomationTask[];
  triggers: BotTrigger[];
  disabledTools: string[];
  disabledSkills: string[];
  /** Turned off, but left out: tools of its extensions and skills of its directories. */
  otherTools: number;
  otherSkills: number;
  hash: string;
};

const bare = (model: string | undefined) => model?.slice(model.indexOf("/") + 1) || undefined;

export class BotExportService {
  readonly #deps: BotExportDeps;
  readonly #now: () => number;
  /** Each bot's latest review, until the gateway restarts. */
  readonly #reviews = new Map<string, { review: BotExportReview; hash: string }>();
  /** Each bot's reviews started: only the latest one started is kept, whichever ends last. */
  readonly #started = new Map<string, number>();

  constructor(deps: BotExportDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** `POST /__hui/bots/:id/export/review`. */
  async review(target: string): Promise<BotExportReview> {
    const bot = await this.#deps.bots.get(target);
    const ticket = (this.#started.get(bot.id) ?? 0) + 1;
    this.#started.set(bot.id, ticket);
    const input = await this.#read(bot);
    if (!input.soul.trim()) throw new BotConflictError(`${bot.name} has no soul yet: finish its first conversation, then export it.`);
    const identity = await this.#deps.identity(bot.worker?.id);
    const { parts, cleanup, copies, meta, leftOut } = this.#parts(input, identity);
    const others = (await this.#deps.bots.list({ archived: "all" })).filter((each) => each.id !== bot.id).map((each) => each.handle);
    const { model, found, needs, warning: unread } = await this.#reviewParts(parts, copies, identity, others);
    // Without a name for the operator the cleanup can't take it out: only the reviewer looks for it.
    const warning = [identity.operator || identity.names?.length ? "" : "Your name isn't set in Settings → Profile, so HUI couldn't take it out for you: look for it in every file below.", unread ?? ""].filter(Boolean).join(" ");

    // One change per passage, the strictest group first. A change lives in the part it was found in if that part can take
    // its group, else in the first text part that holds the passage and can (a passage found in a script changes the text
    // where it also appears; the script itself is a file change). The profile can't ask or confirm (`changeGroups`): a
    // passage only it holds leaves it like a removed one when asked, which the operator sees and can keep, and stays as
    // written when confirmed; the bot's whole name starts kept. What the reviewer wrote is checked against the picks when
    // the zip is made (`buildExport`).
    const byQuote = new Map<string, ReviewedChange & { part: string }>();
    for (const change of found) {
      const seen = byQuote.get(change.quote);
      if (!seen || RANK[change.group] < RANK[seen.group]) byQuote.set(change.quote, change);
    }
    const quoted = [...byQuote.values()];
    // Two reads quote one rule more or less widely: a narrower confirm gives way to a wider change in the same part, its
    // open point said by that one. A removed or asked passage always stays: it changes wherever it appears in the bot,
    // in other parts and scripts too, which a wider quote doesn't.
    const kept = quoted.filter((change) => change.group !== "confirm" || !quoted.some((other) => other !== change && other.part === change.part
      && other.quote.length > change.quote.length && other.quote.includes(change.quote)));
    const text = parts.filter((part) => part.kind === "text");
    const holds = (part: BotExportPart, quote: string) => part.fields.some((field) => field.text.includes(quote));
    // The bot's whole name is the template's: a change to it starts kept, for the operator to see and decide.
    const name = text.find((part) => part.id === "profile")?.fields.find((field) => field.key === "name")?.text.trim();
    const isName = (change: ReviewedChange) => Boolean(name) && change.quote.trim() === name;
    const changes: BotExportChange[] = kept.flatMap((change): Omit<BotExportChange, "id">[] => {
      if (isName(change)) return [{ ...change, part: "profile", group: "keep" as const }];
      const fits = (part: BotExportPart) => changeGroups(part.id).includes(change.group);
      const home = text.find((part) => part.id === change.part && fits(part)) ?? text.find((part) => fits(part) && holds(part, change.quote));
      if (home) return [{ ...change, part: home.id }];
      const profile = text.find((part) => part.id === "profile" && holds(part, change.quote));
      return profile && change.group === "ask" ? [{ ...change, part: profile.id, group: "remove" as const, replacement: "" }] : [];
    }).map((change, index) => ({ id: `c${index + 1}`, ...change }));
    const files = this.#scripts(parts, cleanup, copies, kept.filter((change) => !isName(change)));
    const review: BotExportReview = {
      id: randomUUID(), botId: bot.id, name: bot.name,
      ...(model ? { model } : {}), ...(warning ? { warning } : {}),
      parts, cleanup, changes, files,
      needs: [...new Map(needs.map((need) => [need.toLowerCase(), need])).values()].slice(0, 30).map((text, index) => ({ id: `n${index + 1}`, text })),
      leftOut, meta,
    };
    // A review started after this one replaces it, even when this one ends last.
    if (this.#started.get(bot.id) === ticket) this.#reviews.set(bot.id, { review, hash: input.hash });
    return review;
  }

  /** `POST /__hui/bots/:id/export`: `{ review, picks }`, the zip of what the review and the picks make. */
  async export(target: string, body: unknown): Promise<{ name: string; data: Buffer }> {
    if (!isRecord(body)) throw new BotInputError("An export needs { review, picks, added }.");
    const unknown = Object.keys(body).filter((key) => key !== "review" && key !== "picks" && key !== "added");
    if (unknown.length) throw new BotInputError(`Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
    if (typeof body["review"] !== "string" || !body["review"]) throw new BotInputError("review must name the review the picks are for.");
    const bot = await this.#deps.bots.get(target);
    const held = this.#reviews.get(bot.id);
    if (!held || held.review.id !== body["review"]) throw new BotConflictError("This review is gone (HUI restarted, or a newer review replaced it): review the bot again.");
    if ((await this.#read(bot)).hash !== held.hash) throw new BotConflictError(`${bot.name} changed since its review: review it again before you download it.`);
    // The operator's additions join the reviewer's changes, made as the dialog makes them; what they wrote travels, so
    // the cleanup must find nothing in it as it travels.
    const additions = this.#additions(body["added"]);
    let review: BotExportReview;
    try {
      review = withAdditions(held.review, additions);
    } catch (error) {
      throw new BotInputError(error instanceof Error ? error.message : "An addition can't be a change.");
    }
    const identity = await this.#deps.identity(bot.worker?.id);
    for (const [index] of additions.entries()) {
      const change = review.changes.find((each) => each.id === `a${index + 1}`)!;
      const hit = [change.replacement, change.label].map((text) => cleanText(text, identity).hits[0]).find(Boolean);
      if (hit) throw new BotInputError(`What addition a${index + 1} becomes holds ${hit.kind}: write it without.`);
    }
    const picks = this.#picks(review, body["picks"]);
    const build = buildExport(review, picks);
    return { name: build.fileName, data: writeZip(build.files.map((file) => ({ path: file.path, data: Buffer.from(file.text, "utf8") })), ZIP_DATE) };
  }

  /** The passages the operator added, as sent: at most 50, each a quote, a group and what it becomes. */
  #additions(value: unknown): BotExportAddition[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_ADDITIONS) throw new BotInputError(`added lists at most ${MAX_ADDITIONS} passages.`);
    return value.map((item, index) => {
      const group = isRecord(item) ? item["group"] : undefined;
      if (!isRecord(item) || typeof item["quote"] !== "string" || item["quote"].length > 2_000 || (group !== "remove" && group !== "ask" && group !== "confirm")
        || (item["becomes"] !== undefined && (typeof item["becomes"] !== "string" || item["becomes"].length > 300))) {
        throw new BotInputError(`Addition a${index + 1} takes { quote, group: remove | ask | confirm, becomes? }.`);
      }
      return { quote: item["quote"], group, ...(typeof item["becomes"] === "string" ? { becomes: item["becomes"] } : {}) };
    });
  }

  /** Each pick names a change, script or need of the review, with a group it takes. */
  #picks(review: BotExportReview, value: unknown): Record<string, BotExportGroup> {
    if (value === undefined) return {};
    if (!isRecord(value)) throw new BotInputError("picks must map a change's id to its group.");
    const allowed = new Map<string, readonly string[]>([
      ...review.changes.map((change) => [change.id, changeGroups(change.part)] as const),
      ...review.files.map((file) => [file.id, ["keep", "remove", "confirm"]] as const),
      ...review.needs.map((need) => [need.id, ["keep", "remove"]] as const),
    ]);
    for (const [id, group] of Object.entries(value)) {
      const groups = allowed.get(id);
      if (!groups) throw new BotInputError(`This review has no change ${id}.`);
      if (typeof group !== "string" || !groups.includes(group)) throw new BotInputError(`${id} takes ${groups.join(", ")}.`);
    }
    return value as Record<string, BotExportGroup>;
  }

  /** What of the bot would travel, read where it runs, and its hash: exactly what the export holds, nothing else. */
  async #read(bot: BotView): Promise<Input> {
    const own = this.#deps.skills(bot.worker?.id);
    const [soul, tasks, triggers, offer, skills] = await Promise.all([
      this.#deps.bots.soul(bot.id), this.#deps.routines.tasks(), this.#deps.triggers.list(bot.id), this.#deps.offer(bot.worker?.id), own ? own.read(bot.id) : [],
    ]);
    // A new bot's tools: the built-in ones. An extension's tool may be the operator's own, and a new owner's bot has its own.
    const builtIn = new Set(offer.tools.filter((tool) => tool.group !== "extension").map((tool) => tool.name));
    const disabledTools = (bot.disabledTools ?? []).filter((name) => builtIn.has(name));
    const ownNames = new Set(skills.map((skill) => skill.name));
    const disabledSkills = (bot.disabledSkills ?? []).filter((ref) => ownNames.has(ref.name) && ref.path.includes(`/${bot.id}/skills/`)).map((ref) => ref.name);
    const routines = tasks.filter((task) => task.sessionId === bot.sessionId);
    const exported = {
      name: bot.name, title: bot.title, description: bot.description, avatar: bot.avatar, model: bot.model, thinking: bot.thinking,
      memoryModel: bot.memoryModel, memoryThinking: bot.memoryThinking, voice: bot.voice, tagging: bot.tagging, soul, skills,
      routines: routines.map(({ name, description, prompt, schedule }) => ({ name, description, prompt, schedule })),
      triggers: triggers.map(({ name, filter, prompt, cooldownSeconds, delivery }) => ({ name, filter, prompt, cooldownSeconds, ...(delivery ? { delivery } : {}) })),
      disabledTools, disabledSkills,
    };
    return {
      bot, soul: soul ?? "", skills, skillsKept: !own ? "none" : own.files ? "all" : "skill-md", routines, triggers: [...triggers], disabledTools, disabledSkills,
      otherTools: (bot.disabledTools ?? []).length - disabledTools.length, otherSkills: (bot.disabledSkills ?? []).length - disabledSkills.length,
      hash: createHash("sha256").update(JSON.stringify(exported)).digest("hex"),
    };
  }

  /** The bot as parts, cleaned (a script only searched), what the reviewer reads of each, and what travels unread. */
  #parts(input: Input, identity: CleanupIdentity) {
    const { bot } = input;
    const parts: BotExportPart[] = [];
    const cleanup: BotExportCleanup[] = [];
    const copies = new Map<string, { key: string; text: string }[]>();
    const leftOut = ["Its memory and its chat: an export never carries them."];
    const clean = (part: string, field: string, value: string) => {
      const result = cleanText(value, identity);
      for (const hit of result.hits) cleanup.push({ part, field, ...hit });
      return result.text;
    };
    const text = (id: string, label: string, fields: readonly (readonly [key: string, value: string | undefined])[]) => {
      const cleaned = fields.flatMap(([key, value]) => value ? [{ key, text: clean(id, key, value) }] : []);
      parts.push({ id, label, kind: "text", fields: cleaned, read: false });
      copies.set(id, cleaned);
    };
    // A label is the operator's to read; what the cleanup finds in it is counted with its part's own field.
    const plain = (value: string) => cleanText(value, identity).text;
    const script = (id: string, label: string, value: string) => {
      parts.push({ id, label, kind: "script", fields: [{ key: "text", text: value }], read: false });
      copies.set(id, [{ key: "text", text: clean(id, "text", value) }]);
    };

    text("profile", "Profile", [["name", bot.name], ["title", bot.title], ["description", bot.description]]);
    text("SOUL.md", "SOUL.md", [["text", input.soul]]);
    // A skill's name and a file's path travel as they are (they can't be rewritten): one that gives the operator away stays.
    const skills = input.skills.filter((skill) => {
      const kind = personalIn(skill.name, identity);
      if (kind) leftOut.push(`Skill ${skill.name}: its name holds ${kind}; rename it to share it.`);
      return !kind;
    });
    for (const skill of skills) {
      text(`skills/${skill.name}/SKILL.md`, `Skill ${skill.name}: SKILL.md`, [["text", skill.text]]);
      for (const file of skill.files ?? []) {
        const kind = personalIn(file.path, identity);
        if (kind) {
          leftOut.push(`Skill ${skill.name}: ${file.path}, whose path holds ${kind}; rename it to share it.`);
          continue;
        }
        const id = `skills/${skill.name}/${file.path}`;
        const label = `Skill ${skill.name}: ${file.path}`;
        if (BOT_SKILL_TEXT_FILE.test(file.path)) text(id, label, [["text", file.text]]);
        else script(id, label, file.text);
      }
      for (const skipped of skill.skipped ?? []) leftOut.push(`Skill ${skill.name}: ${skipped.path} (${skipped.reason}).`);
    }
    if (input.skillsKept === "skill-md" && input.skills.length) leftOut.push(`The files beside its skills' SKILL.md: ${bot.worker?.name ?? "its worker"} runs an older HUI worker that can't send them.`);
    if (input.skillsKept === "none") leftOut.push(`Its own skills: ${bot.worker?.name ?? "its worker"} runs an older HUI worker that can't keep them.`);

    const routines: BotExportMeta["routines"] = [];
    for (const task of input.routines) {
      if (task.schedule.kind === "at") {
        leftOut.push(`Routine “${plain(task.name)}”: it runs once, at a time of yours.`);
        continue;
      }
      const schedule: BotExportSchedule = task.schedule.kind === "every" ? { kind: "every", everyMs: task.schedule.everyMs } : { kind: "cron", expression: task.schedule.expression };
      const id = `routines/${routines.length}`;
      routines.push({ schedule });
      text(id, `Routine “${plain(task.name)}”`, [["name", task.name], ["description", task.description], ["prompt", task.prompt]]);
    }
    const triggers: BotExportMeta["triggers"] = input.triggers.map((trigger, index) => {
      const id = `triggers/${index}`;
      text(id, `Trigger “${plain(trigger.name)}”`, [["name", trigger.name], ["prompt", trigger.prompt], ["match", trigger.filter.match?.value]]);
      return { filter: trigger.filter, cooldownSeconds: trigger.cooldownSeconds, ...(trigger.delivery ? { delivery: trigger.delivery } : {}) };
    });
    if (input.otherTools) leftOut.push(`${input.otherTools} turned-off tool${input.otherTools === 1 ? "" : "s"} of your extensions: a new owner's bot has its own.`);
    if (input.otherSkills) leftOut.push(`${input.otherSkills} turned-off skill${input.otherSkills === 1 ? "" : "s"} of your folders: a new owner's bot has its own.`);

    const avatar = bot.avatar && Object.keys(bot.avatar).length ? { ...bot.avatar } : undefined;
    const meta: BotExportMeta = {
      ...(avatar ? { avatar } : {}),
      ...(bare(bot.model) ? { model: bare(bot.model)! } : {}),
      ...(bot.thinking ? { thinking: bot.thinking } : {}),
      ...(bare(bot.memoryModel) ? { memoryModel: bare(bot.memoryModel)! } : {}),
      ...(bot.memoryThinking ? { memoryThinking: bot.memoryThinking } : {}),
      ...(bot.voice && Object.keys(bot.voice).length ? { voice: { ...bot.voice } } : {}),
      ...(bot.tagging ? { tagging: bot.tagging } : {}),
      routines, triggers,
      disabledTools: input.disabledTools, disabledSkills: input.disabledSkills.filter((name) => skills.some((skill) => skill.name === name)), skills: skills.map((skill) => skill.name),
    };
    return { parts, cleanup, copies, meta, leftOut };
  }

  /** The utility model reads the parts in pieces, each twice, several at once, one quicker retry each, within the review's
   * time; a part it can't read whole is unread. What it found comes back in the parts' order, however the requests end. */
  async #reviewParts(parts: BotExportPart[], copies: Map<string, { key: string; text: string }[]>, identity: CleanupIdentity, others: readonly string[]): Promise<{
    model?: string; warning?: string; found: (ReviewedChange & { part: string })[]; needs: string[];
  }> {
    const model = await this.#deps.utilityModel().catch(() => undefined);
    if (!model) {
      for (const part of parts) part.unread = "No utility model is set.";
      return { found: [], needs: [], warning: "No utility model is set in Settings → Models, so only the automatic cleanup ran: read every file below before you share it." };
    }
    const known = [...new Set([identity.operator, ...identity.names ?? []].filter((name): name is string => Boolean(name)))];
    const system = reviewSystemPrompt({ ...(known.length ? { name: known.join(", also ") } : {}), username: identity.username, bots: others });
    const deadline = this.#now() + REVIEW_MS;
    // Every piece of every part is read twice, independently, and both reads count: what one read passes over the other
    // usually finds. A piece is read when one of its reads is, a part when all its pieces are.
    const pieces = parts.flatMap((part, index) => reviewChunks({ label: part.label, script: part.kind === "script", fields: copies.get(part.id) ?? [] }).map((chunk) => ({ index, chunk })));
    const reads = pieces.flatMap((piece, at) => [{ ...piece, at }, { ...piece, at }]);
    const results: { changes: (ReviewedChange & { part: string })[]; needs: string[] }[] = reads.map(() => ({ changes: [], needs: [] }));
    const failed = new Map<number, string[]>();
    const read = async (r: number) => {
      const { index, chunk, at } = reads[r]!;
      const part = parts[index]!;
      const answer = this.#now() >= deadline ? "The review ran out of time before this part."
        : await this.#ask(model, system, reviewPrompt(chunk), (copies.get(part.id) ?? []).map((field) => field.text), identity, deadline);
      if (typeof answer === "string") {
        failed.set(at, [...failed.get(at) ?? [], answer]);
        return;
      }
      results[r]!.changes.push(...answer.changes.map((change) => ({ ...change, part: part.id })));
      results[r]!.needs.push(...answer.needs);
    };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, reads.length) }, async () => {
      for (let r = next++; r < reads.length; r = next++) await read(r);
    }));
    const unread = new Map<number, string>();
    for (const [at, why] of failed) if (why.length === 2 && !unread.has(pieces[at]!.index)) unread.set(pieces[at]!.index, why.at(-1)!);
    for (const [index, part] of parts.entries()) {
      part.read = !unread.has(index);
      if (unread.has(index)) part.unread = unread.get(index)!;
    }
    const missed = parts.filter((part) => !part.read).length;
    const needs = await this.#mergeNeeds(model, results.flatMap((result) => result.needs), identity, deadline);
    return { model, found: results.flatMap((result) => result.changes), needs, ...(missed ? { warning: `The utility model didn't read ${missed} of ${parts.length} parts (each says why): read them yourself before you share it.` } : {}) };
  }

  /** What each piece's reader said the bot needs, merged by one quick request when the list runs long (pieces repeat the
   * same need in other words); as it was when that request fails. */
  async #mergeNeeds(model: string, needs: readonly string[], identity: CleanupIdentity, deadline: number): Promise<string[]> {
    const unique = [...new Map(needs.map((need) => [need.toLowerCase(), need])).values()];
    const left = Math.ceil(deadline - this.#now());
    if (unique.length <= MERGE_NEEDS_OVER || left <= 0) return unique;
    try {
      return parseNeeds(await this.#deps.completion(model, { system: NEEDS_MERGE_PROMPT, prompt: unique.join("\n"), signal: AbortSignal.timeout(Math.min(CALL_MS, left)), least: true }), identity) ?? unique;
    } catch {
      return unique;
    }
  }

  /** One part (or a chunk of it) to the reviewer: its checked answer, or why there is none. No request or retry outlives
   * the review's end. */
  async #ask(model: string, system: string, prompt: string, fields: readonly string[], identity: CleanupIdentity, deadline: number): Promise<ReviewAnswer | string> {
    let failure = "The utility model's answer couldn't be read.";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const left = Math.ceil(deadline - this.#now());
      if (left <= 0) break;
      try {
        // The retry reasons as little as the model allows: a slow model still reads the part, if less carefully.
        const answer = parseReviewAnswer(await this.#deps.completion(model, { system, prompt, signal: AbortSignal.timeout(Math.min(CALL_MS, left)), least: attempt > 0 }), fields, identity);
        if (answer) return answer;
      } catch (error) {
        failure = `The utility model failed: ${error instanceof Error ? oneLine(error.message, 200) : "no answer"}.`;
      }
    }
    return failure;
  }

  /** A script is never rewritten: a cleanup hit or a removed passage in it keeps it behind, an asked or confirmed one
   * (wherever the reviewer flagged it) lets it travel for the new owner to confirm, else it travels as it is. */
  #scripts(parts: readonly BotExportPart[], cleanup: readonly BotExportCleanup[], copies: Map<string, { key: string; text: string }[]>, changes: readonly (ReviewedChange & { part: string })[]): BotExportFileChange[] {
    const files: BotExportFileChange[] = [];
    for (const part of parts.filter((each) => each.kind === "script")) {
      const copy = copies.get(part.id)?.[0]?.text ?? "";
      const hits = cleanup.filter((each) => each.part === part.id);
      const found = changes.filter((change) => copy.includes(change.quote));
      if (!hits.length && !found.length) continue;
      const reasons = [...hits.map((hit) => `HUI found ${hit.kind} in it (${hit.sample}).`), ...found.map((change) => `${change.reason} “${oneLine(change.quote, 80)}”`)];
      const group = hits.length || found.some((change) => change.group === "remove") ? "remove" : "confirm";
      // Its open point is where the script is; what the reviewer asked about it follows.
      const asked = found.find((change) => change.group !== "remove")?.question;
      const question = `It came from someone else's setup: check it before it runs.${asked ? ` ${asked}` : ""}`;
      files.push({ id: `f${files.length + 1}`, part: part.id, group, reasons, question });
    }
    return files;
  }
}

/** This account's full name, for an export's cleanup: macOS keeps it in the directory service, Linux in the password
 * entry's comment. Read once; none when neither answers. */
let accountName: Promise<string | undefined> | undefined;
export function accountFullName(username: string): Promise<string | undefined> {
  return accountName ??= (process.platform === "darwin"
    ? runCommand("dscl", [".", "-read", `/Users/${username}`, "RealName"], { timeoutMs: 5_000 }).then((result) => result.code ? "" : result.stdout.replace(/^RealName:/u, ""))
    : runCommand("getent", ["passwd", username], { timeoutMs: 5_000 }).then((result) => result.code ? "" : result.stdout.split(":")[4]?.split(",")[0] ?? "")
  ).then((name) => name.replace(/\s+/gu, " ").trim() || undefined);
}
