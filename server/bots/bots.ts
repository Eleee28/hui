/**
 * HUI's bot registry (HUI-18).
 *
 * A bot is a named, persistent agent whose one chat is an ordinary Durable
 * session (its record carries `bot`). Only HUI writes this file; the chat's
 * conversation and OptChat memory stay in the Durable store.
 *
 *   ~/.config/hui/bots.json   { version: 1, bots: BotRecord[] }
 *
 * Writes go through a temporary file and a rename, and every read/modify/write
 * is serialized, like the session registry. A record that does not validate is
 * skipped, reported once and written back untouched, so a hand edit never
 * takes the gateway down or loses data. A file that is not JSON or comes from
 * a newer HUI is refused and never overwritten.
 *
 * A bot's persona is not here: it is SOUL.md in its home folder
 * (`souls.ts`). Records from before SOUL.md may still carry
 * `instructions`: the registry keeps that field in the file, untouched by every
 * write, until `BotService.migrate` has turned it into SOUL.md and
 * `forgetInstructions` drops it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  BOT_FACE_EARS, BOT_FACE_SHAPES, BOT_HANDLE, BOT_LIMITS, BOT_TAGGING, BOT_THINKING_LEVELS, handleFromName, isBotFaceEars, isBotFaceShape, isBotTagging,
  NEW_BOT_NAME, storedTagging,
  type BotAccess, type BotAvatar, type BotAvatarPatch, type BotInput, type BotPatch, type BotRecord, type BotSkillRef, type BotSkillSelector, type BotVoice,
  type BotVoicePatch,
} from "../bots-format.ts";
import { GPT_LIVE_VOICES, gptLiveVoice } from "../calls-format.ts";
import { VOICE_LANGUAGE_EXAMPLES, voiceLanguage } from "./voice-languages.ts";
import { CONFIG_DIR } from "../paths.ts";

export const BOTS_FILE = join(CONFIG_DIR, "bots.json");
/** Default working directories, one per bot, created with it. */
export const BOTS_DIR = join(CONFIG_DIR, "bots");
/** What deleting a bot left on its worker while HUI was not connected to it, done at that worker's next connection. */
export const BOT_CLEANUP_FILE = join(CONFIG_DIR, "bot-cleanup.json");
export const BOTS_VERSION = 1;
/** Handles a route already uses: `/__hui/bots/events` is the list stream, `/__hui/bots/import` imports a bot. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(["events", "import"]);

/** Rejected input: the route answers 400 with the message. */
export class BotInputError extends Error {
  override name = "BotInputError";
}

export class BotNotFoundError extends Error {
  override name = "BotNotFoundError";
}

/** The request is valid but the bot's state refuses it now (409). */
export class BotConflictError extends Error {
  override name = "BotConflictError";
}

/** bots.json cannot be read or written safely; it is left untouched. */
export class BotStoreError extends Error {
  override name = "BotStoreError";
}

/** The bot runs on a remote worker HUI is not connected to now (503): the worker's name is in the message. */
export class BotWorkerOfflineError extends Error {
  override name = "BotWorkerOfflineError";
}

const ID = /^[A-Za-z0-9_-]{1,100}$/u;
/** Only the first slash separates the provider; model ids may contain more. */
const MODEL = /^[^/\s]+\/\S+$/u;
const COLOR = /^#[0-9a-f]{6}$/u;
const CONTROL = /\p{Cc}/u;
const LEVELS: ReadonlySet<string> = new Set(BOT_THINKING_LEVELS);
/** A tool's name: what PI and Durable accept, without spaces or control characters. */
const TOOL_NAME = /^[^\s\p{Cc}]{1,100}$/u;
/** Most tools or skills one list may name. */
const MAX_LISTED = 500;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Exactly one user-perceived character (an emoji with its modifiers counts as one). */
export function isOneGrapheme(value: string): boolean {
  if (!value || value.length > 32 || CONTROL.test(value) || value.trim() !== value) return false;
  const segments = GRAPHEMES.segment(value)[Symbol.iterator]();
  return !segments.next().done && segments.next().done === true;
}

function storedAvatar(raw: unknown): BotAvatar | undefined {
  if (!isRecord(raw)) return undefined;
  const emoji = str(raw["emoji"]);
  const color = str(raw["color"]);
  const shape = raw["shape"];
  const ears = raw["ears"];
  const avatar = {
    ...(isOneGrapheme(emoji) ? { emoji } : {}), ...(COLOR.test(color) ? { color } : {}), ...(isBotFaceShape(shape) ? { shape } : {}), ...(isBotFaceEars(ears) ? { ears } : {}),
  };
  return Object.keys(avatar).length ? avatar : undefined;
}

/** The language and GPT-Live voice of a stored voice. A record written while HUI still had VoiceStudio may also carry
 * its voice `profile` and `speed`: they are not read, so the next write leaves them out. */
function storedVoice(raw: unknown): BotVoice | undefined {
  if (!isRecord(raw)) return undefined;
  const language = voiceLanguage(raw["language"]);
  const live = gptLiveVoice(raw["live"]);
  const voice = { ...(language ? { language } : {}), ...(live ? { live } : {}) };
  return Object.keys(voice).length ? voice : undefined;
}

/** A stored list of tool names: the valid, distinct ones. */
function storedTools(raw: unknown): string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((name): name is string => typeof name === "string" && TOOL_NAME.test(name)))] : [];
}

/** A stored list of skills: the valid, distinct ones. */
function storedSkills(raw: unknown): BotSkillRef[] {
  const refs: BotSkillRef[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isRecord(item) || typeof item["name"] !== "string" || typeof item["path"] !== "string" || !item["name"].trim() || !item["path"].trim()) continue;
    if (!refs.some((ref) => ref.name === item["name"] && ref.path === item["path"])) refs.push({ name: item["name"], path: item["path"] });
  }
  return refs;
}

/**
 * A stored record, or undefined when a required field is missing or invalid.
 * Optional fields that do not validate are dropped, so a bad color never hides
 * a bot.
 */
export function parseBotRecord(raw: unknown): BotRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw["id"]);
  const handle = str(raw["handle"]);
  const name = str(raw["name"]).trim();
  const cwd = str(raw["cwd"]);
  const sessionId = str(raw["sessionId"]);
  const createdAt = str(raw["createdAt"]);
  const updatedAt = str(raw["updatedAt"]);
  if (!ID.test(id) || !BOT_HANDLE.test(handle) || !name || name.length > BOT_LIMITS.name || CONTROL.test(name)
    || !isAbsolute(cwd) || !ID.test(sessionId) || !createdAt || !updatedAt) return undefined;
  const text = (key: string, maximum: number): string | undefined => {
    const value = str(raw[key]);
    return value.trim() && value.length <= maximum ? value : undefined;
  };
  const model = (key: string): string | undefined => MODEL.test(str(raw[key])) ? str(raw[key]) : undefined;
  const level = (key: string): string | undefined => LEVELS.has(str(raw[key])) ? str(raw[key]) : undefined;
  const title = text("title", BOT_LIMITS.title);
  const description = text("description", BOT_LIMITS.description);
  const tagging = storedTagging(raw["tagging"]);
  const chatModel = model("model");
  const thinking = level("thinking");
  const memoryModel = model("memoryModel");
  const memoryThinking = level("memoryThinking");
  const avatar = storedAvatar(raw["avatar"]);
  const voice = storedVoice(raw["voice"]);
  const disabledTools = storedTools(raw["disabledTools"]);
  const disabledSkills = storedSkills(raw["disabledSkills"]);
  const worker = ID.test(str(raw["worker"])) ? str(raw["worker"]) : undefined;
  return {
    id, handle, name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(tagging ? { tagging } : {}),
    cwd,
    ...(worker ? { worker } : {}),
    ...(chatModel ? { model: chatModel } : {}),
    ...(thinking ? { thinking } : {}),
    ...(memoryModel ? { memoryModel } : {}),
    ...(memoryThinking ? { memoryThinking } : {}),
    ...(avatar ? { avatar } : {}),
    ...(voice ? { voice } : {}),
    ...(raw["hidden"] === true ? { hidden: true } : {}),
    ...(raw["archived"] === true ? { archived: true } : {}),
    ...(disabledTools.length ? { disabledTools } : {}),
    ...(disabledSkills.length ? { disabledSkills } : {}),
    sessionId, createdAt, updatedAt,
  };
}

/** The `instructions` a record from before SOUL.md still carries, or undefined. */
function legacyInstructions(raw: unknown): string | undefined {
  const value = isRecord(raw) ? raw["instructions"] : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** `legacy`: bot id → the `instructions` its record still carries, written back with it until forgotten. */
type BotsFile = { bots: BotRecord[]; invalid: unknown[]; legacy: Map<string, string> };

export class BotRegistry {
  readonly file: string;
  readonly #onInvalid: (count: number) => void;
  #mutation: Promise<unknown> = Promise.resolve();
  #cache: readonly BotRecord[] = [];
  /** Invalid records last reported, so a lasting problem is reported once. */
  #reported = 0;

  constructor(file = BOTS_FILE, onInvalid: (count: number) => void = () => {}) {
    this.file = file;
    this.#onInvalid = onInvalid;
  }

  /** The list last read or written, for synchronous projections such as session views. */
  get cached(): readonly BotRecord[] {
    return this.#cache;
  }

  async #read(): Promise<BotsFile> {
    let source: string;
    try {
      source = await readFile(this.file, "utf8");
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") {
        this.#cache = [];
        return { bots: [], invalid: [], legacy: new Map() };
      }
      throw new BotStoreError("HUI's bot registry could not be read.", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new BotStoreError("HUI's bot registry (bots.json) is not valid JSON. Fix or move it; HUI will not overwrite it.", { cause: error });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["bots"])) throw new BotStoreError("HUI's bot registry (bots.json) has an invalid shape.");
    if (typeof parsed["version"] === "number" && parsed["version"] > BOTS_VERSION) {
      throw new BotStoreError("bots.json was written by a newer HUI. Update HUI to manage these bots.");
    }
    const bots: BotRecord[] = [];
    const invalid: unknown[] = [];
    const legacy = new Map<string, string>();
    const ids = new Set<string>();
    const handles = new Set<string>();
    const sessions = new Set<string>();
    for (const raw of parsed["bots"]) {
      const bot = parseBotRecord(raw);
      // A duplicate would make addressing ambiguous: the first one wins, the rest are kept aside.
      if (!bot || ids.has(bot.id) || handles.has(bot.handle) || sessions.has(bot.sessionId)) {
        invalid.push(raw);
        continue;
      }
      ids.add(bot.id);
      handles.add(bot.handle);
      sessions.add(bot.sessionId);
      bots.push(bot);
      const instructions = legacyInstructions(raw);
      if (instructions !== undefined) legacy.set(bot.id, instructions);
    }
    if (invalid.length !== this.#reported) {
      this.#reported = invalid.length;
      if (invalid.length) this.#onInvalid(invalid.length);
    }
    this.#cache = bots;
    return { bots, invalid, legacy };
  }

  async list(): Promise<BotRecord[]> {
    return [...(await this.#read()).bots];
  }

  /** Bot id → the `instructions` its record still carries from before SOUL.md (`BotService.migrate`). */
  async legacyInstructions(): Promise<Map<string, string>> {
    return new Map((await this.#read()).legacy);
  }

  /** Drops a record's legacy `instructions` once they live on as its SOUL.md; nothing else changes. */
  forgetInstructions(id: string): Promise<void> {
    return this.#serialized(async () => {
      const current = await this.#read();
      if (!current.legacy.delete(id)) return;
      await this.#write(current.bots, current.invalid, current.legacy);
    });
  }

  /** Serialized read/modify/write. `mutate` returns the next list and a result; a failed write changes nothing. */
  update<T>(mutate: (bots: readonly BotRecord[]) => { bots: readonly BotRecord[]; result: T }): Promise<T> {
    return this.#serialized(async () => {
      const current = await this.#read();
      const { bots, result } = mutate(current.bots);
      await this.#write(bots, current.invalid, current.legacy);
      this.#cache = [...bots];
      return result;
    });
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.#mutation.then(work);
    // A failed mutation must not poison the queue for later requests.
    this.#mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Legacy `instructions` go back on their records (a deleted bot's go with it). */
  async #write(bots: readonly BotRecord[], invalid: readonly unknown[], legacy: ReadonlyMap<string, string>): Promise<void> {
    // A unique name: a slower writer must not clobber another's temporary file.
    const temporary = `${this.file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      // Personas can be private: owner-only, like the Durable store.
      const records = bots.map((bot) => legacy.has(bot.id) ? { ...bot, instructions: legacy.get(bot.id) } : bot);
      await writeFile(temporary, `${JSON.stringify({ version: BOTS_VERSION, bots: [...records, ...invalid] }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new BotStoreError("HUI's bot registry could not be written.", { cause: error });
    }
  }
}

/** `base`, or `base-2`, `base-3`… while another bot holds it, still within 32 characters. */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  const free = (handle: string) => !taken.has(handle) && !RESERVED_HANDLES.has(handle);
  if (free(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, BOT_LIMITS.handle - tail.length).replace(/-+$/u, "")}${tail}`;
    if (free(candidate)) return candidate;
  }
}

/**
 * Whether `handle` is the one `name` gives a bot automatically: its slug, or that slug with the `-2`, `-3`… suffix
 * `uniqueHandle` adds. A renamed bot's handle follows the new name only while this holds; a chosen handle stays.
 */
export function isDerivedHandle(handle: string, name: string): boolean {
  const base = handleFromName(name);
  if (handle === base) return true;
  const match = /^(.+)-([1-9]\d*)$/u.exec(handle);
  if (!match || Number(match[2]) < 2) return false;
  const tail = `-${match[2]}`;
  return match[1] === base.slice(0, BOT_LIMITS.handle - tail.length).replace(/-+$/u, "");
}

/** A bot by id, handle (`@` optional, any case) or exact name; a name two bots share must be given as id or handle. */
export function findBot(bots: readonly BotRecord[], target: string): BotRecord {
  const value = target.trim();
  const byId = bots.find((bot) => bot.id === value);
  if (byId) return byId;
  const handle = value.replace(/^@/u, "").toLowerCase();
  const byHandle = bots.find((bot) => bot.handle === handle);
  if (byHandle) return byHandle;
  const named = bots.filter((bot) => bot.name === value);
  if (named.length === 1) return named[0]!;
  if (named.length) throw new BotConflictError(`${named.length} bots are named ${value}. Use a handle or an id.`);
  throw new BotNotFoundError(`No bot named ${value}.`);
}

const INPUT_KEYS = new Set([
  "name", "handle", "title", "description", "tagging", "soul", "cwd", "worker", "model", "thinking", "memoryModel", "utilityModel", "memoryThinking", "avatar", "voice",
  "hidden", "disabledTools", "disabledSkills",
]);
const LABELS: Record<string, string> = {
  name: "Bot name", handle: "Bot handle", title: "Bot title", description: "Bot description", soul: "SOUL.md",
  cwd: "Working directory", worker: "Worker", model: "Bot model", thinking: "Thinking level", memoryModel: "Utility model", utilityModel: "Utility model", memoryThinking: "Memory thinking level",
};

function body(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BotInputError(`${what} must be an object.`);
  // A client from before SOUL.md: say where the persona went instead of only refusing the field.
  if ("instructions" in value) {
    throw new BotInputError("Bots have no instructions any more: a bot's persona is its SOUL.md, which it writes in its first conversation. Send soul when creating it, or PUT /__hui/bots/:id/soul.");
  }
  const unknown = Object.keys(value).filter((key) => !INPUT_KEYS.has(key));
  if (unknown.length) throw new BotInputError(`Unknown bot field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  return value;
}

/**
 * SOUL.md as `POST /__hui/bots` or `PUT /__hui/bots/:id/soul` gives it: text of
 * at most 20,000 characters, trimmed. `""` means none: the bot has (again) its
 * first conversation.
 */
export function normalizeSoul(raw: unknown): string {
  if (typeof raw !== "string") throw new BotInputError("SOUL.md must be text.");
  const value = raw.replace(/\r\n?/gu, "\n").trim();
  if (value.length > BOT_LIMITS.soul) throw new BotInputError(`SOUL.md must be at most ${BOT_LIMITS.soul} characters (it has ${value.length}).`);
  if (value.includes("\0")) throw new BotInputError("SOUL.md must be text.");
  return value;
}

function textField(raw: unknown, key: string, maximum: number, options: { line?: boolean; required?: boolean } = {}): string {
  if (typeof raw !== "string") throw new BotInputError(`${LABELS[key]} must be text.`);
  const value = raw.trim();
  if (options.required && !value) throw new BotInputError(`${LABELS[key]} must be 1-${maximum} characters.`);
  if (value.length > maximum) throw new BotInputError(`${LABELS[key]} must be ${options.required ? `1-${maximum}` : `at most ${maximum}`} characters.`);
  if (options.line && /[\r\n]|\p{Cc}/u.test(value)) throw new BotInputError(`${LABELS[key]} must be one line.`);
  return value;
}

/** `provider/id`, or `""` to clear it. */
function modelField(raw: unknown, key: string): string {
  const value = textField(raw, key, 200);
  if (!value) return "";
  if (!MODEL.test(value)) throw new BotInputError(`${LABELS[key]} must use provider/id format.`);
  return value;
}

/** A thinking level, or `""` to clear it. */
function levelField(raw: unknown, key: string): string {
  const value = textField(raw, key, 16);
  if (!value) return "";
  if (!LEVELS.has(value)) throw new BotInputError(`${LABELS[key]} must be one of: ${BOT_THINKING_LEVELS.join(", ")}.`);
  return value;
}

function handleField(raw: unknown): string {
  const value = textField(raw, "handle", BOT_LIMITS.handle, { line: true }).replace(/^@/u, "");
  if (!BOT_HANDLE.test(value)) {
    throw new BotInputError("Bot handle must be 1-32 lowercase letters, digits or dashes, without a leading or trailing dash.");
  }
  if (RESERVED_HANDLES.has(value)) throw new BotInputError(`@${value} is reserved; choose another handle.`);
  return value;
}

/** `{ emoji?, color?, shape?, ears? }`; `""` clears a key (kept as `""` so a patch can tell). */
function avatarField(raw: unknown): BotAvatarPatch {
  if (!isRecord(raw)) throw new BotInputError("Avatar must be an object with emoji, color, shape and/or ears.");
  const unknown = Object.keys(raw).filter((key) => key !== "emoji" && key !== "color" && key !== "shape" && key !== "ears");
  if (unknown.length) throw new BotInputError(`Unknown avatar field: ${unknown.join(", ")}.`);
  const avatar: BotAvatarPatch = {};
  if ("emoji" in raw) {
    if (typeof raw["emoji"] !== "string" || (raw["emoji"] !== "" && !isOneGrapheme(raw["emoji"]))) throw new BotInputError("Avatar emoji must be one character.");
    avatar.emoji = raw["emoji"];
  }
  if ("color" in raw) {
    const color = typeof raw["color"] === "string" ? raw["color"].toLowerCase() : undefined;
    if (color === undefined || (color !== "" && !COLOR.test(color))) throw new BotInputError("Avatar color must be #rrggbb.");
    avatar.color = color;
  }
  if ("shape" in raw) {
    const shape = raw["shape"];
    if (shape !== "" && !isBotFaceShape(shape)) throw new BotInputError(`Avatar shape must be one of: ${BOT_FACE_SHAPES.join(", ")}.`);
    avatar.shape = shape;
  }
  if ("ears" in raw) {
    const ears = raw["ears"];
    if (ears !== "" && !isBotFaceEars(ears)) throw new BotInputError(`Avatar ears must be one of: ${BOT_FACE_EARS.join(", ")}, or "" for none.`);
    avatar.ears = ears;
  }
  return avatar;
}

/** `{ language?, live? }`; `language: ""` and `live: ""` clear a key (kept so a patch can tell). */
function voiceField(raw: unknown): BotVoicePatch {
  if (!isRecord(raw)) throw new BotInputError("Voice must be an object with language and/or live.");
  const unknown = Object.keys(raw).filter((key) => key !== "language" && key !== "live");
  if (unknown.length) throw new BotInputError(`Unknown voice field: ${unknown.join(", ")}.`);
  const voice: BotVoicePatch = {};
  if ("language" in raw) {
    // One of Whisper's codes: the language the bot speaks on calls. "" goes back to Auto (the language the user speaks).
    const language = raw["language"] === "" ? "" : voiceLanguage(raw["language"]);
    if (language === undefined) throw new BotInputError(`Voice language must be one of Whisper's language codes, such as ${VOICE_LANGUAGE_EXAMPLES}, or "" for Auto.`);
    voice.language = language;
  }
  if ("live" in raw) {
    // A GPT-Live voice for calls; "" goes back to the one Settings → Models → Calls chose.
    const live = raw["live"] === "" ? "" : gptLiveVoice(raw["live"]);
    if (live === undefined) throw new BotInputError(`Call voice must be one of GPT-Live's voices: ${GPT_LIVE_VOICES.join(", ")}, or "" for the default.`);
    voice.live = live;
  }
  return voice;
}

/** `disabledTools`: distinct tool names. Whether the bot's chat has them is the service's check. */
function toolsField(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_LISTED) throw new BotInputError(`disabledTools must be a list of at most ${MAX_LISTED} tool names.`);
  const names = raw.map((name) => (typeof name === "string" ? name.trim() : ""));
  const bad = names.find((name) => !TOOL_NAME.test(name));
  if (bad !== undefined) throw new BotInputError(`disabledTools must name tools: ${JSON.stringify(bad)} is not a tool name.`);
  return [...new Set(names)];
}

/**
 * A bot's lists as a gateway and a worker's host pass them (`bot.create`, `bot.access.write`): both lists, every entry
 * valid; anything else is refused. Duplicates go.
 */
export function accessField(raw: unknown): BotAccess {
  if (!isRecord(raw)) throw new BotInputError("A bot's tool and skill lists are required.");
  const disabledTools = toolsField(raw["disabledTools"] ?? []);
  const skills = raw["disabledSkills"] ?? [];
  if (!Array.isArray(skills) || skills.length > MAX_LISTED) throw new BotInputError(`disabledSkills must be a list of at most ${MAX_LISTED} skills.`);
  const disabledSkills: BotSkillRef[] = [];
  for (const item of skills) {
    if (!isRecord(item) || typeof item["name"] !== "string" || !item["name"].trim() || typeof item["path"] !== "string" || !item["path"].trim()) {
      throw new BotInputError("disabledSkills must name skills as { name, path }.");
    }
    if (!disabledSkills.some((ref) => ref.name === item["name"] && ref.path === item["path"])) disabledSkills.push({ name: item["name"], path: item["path"] });
  }
  return { disabledTools, disabledSkills };
}

/** The lists a worker's host reports, read as a stored record's: what does not validate is dropped. */
export function storedAccess(raw: unknown): BotAccess {
  const source = isRecord(raw) ? raw : {};
  return { disabledTools: storedTools(source["disabledTools"]), disabledSkills: storedSkills(source["disabledSkills"]) };
}

/** `disabledSkills`: skill names, or `{ name, path }` where a name alone is ambiguous. */
function skillsField(raw: unknown): BotSkillSelector[] {
  if (!Array.isArray(raw) || raw.length > MAX_LISTED) throw new BotInputError(`disabledSkills must be a list of at most ${MAX_LISTED} skills.`);
  return raw.map((item) => {
    if (typeof item === "string" && item.trim() && item.length <= 200 && !CONTROL.test(item)) return item.trim();
    if (isRecord(item) && Object.keys(item).every((key) => key === "name" || key === "path")
      && typeof item["name"] === "string" && item["name"].trim() && typeof item["path"] === "string" && item["path"].trim()) {
      return { name: item["name"].trim(), path: item["path"].trim() };
    }
    throw new BotInputError("disabledSkills must name skills: a skill's name, or { name, path }.");
  });
}

function cwdField(raw: unknown): string {
  const value = textField(raw, "cwd", 4_096, { required: true });
  if (value.includes("\0")) throw new BotInputError("Working directory must be a path.");
  return value;
}

/** Validates `POST /__hui/bots`. Optional text left empty is omitted. The directory (and the worker) are checked by the
 * service. */
export function normalizeBotInput(value: unknown): BotInput & { name: string } {
  const input = body(value, "A bot");
  // Without a name the bot is "New Bot" until its first conversation names it (set_profile). Where it runs is chosen
  // here, once; a patch refuses it.
  const { soul: rawSoul, worker: rawWorker, ...fields } = "name" in input ? input : { ...input, name: NEW_BOT_NAME };
  const soul = rawSoul === undefined ? "" : normalizeSoul(rawSoul);
  const worker = rawWorker === undefined ? "" : textField(rawWorker, "worker", 100, { line: true });
  // The patch rules, then empty optional text and avatar keys dropped: a new bot has nothing to clear.
  const patch = normalizeBotPatch(fields);
  const result: BotInput & { name: string } = { name: patch.name! };
  if (worker) result.worker = worker;
  if (patch.handle) result.handle = patch.handle;
  if (patch.title) result.title = patch.title;
  if (patch.description) result.description = patch.description;
  const tagging = storedTagging(patch.tagging);
  if (tagging) result.tagging = tagging;
  if (soul) result.soul = soul;
  if (patch.cwd) result.cwd = patch.cwd;
  if (patch.model) result.model = patch.model;
  if (patch.thinking) result.thinking = patch.thinking;
  if (patch.memoryModel) result.memoryModel = patch.memoryModel;
  if (patch.memoryThinking) result.memoryThinking = patch.memoryThinking;
  const avatar = patch.avatar ? patchedAvatar(undefined, patch.avatar) : undefined;
  if (avatar) result.avatar = avatar;
  const voice = patch.voice ? patchedVoice(undefined, patch.voice) : undefined;
  if (voice) result.voice = voice;
  if (patch.hidden) result.hidden = true;
  if (patch.disabledTools?.length) result.disabledTools = patch.disabledTools;
  if (patch.disabledSkills?.length) result.disabledSkills = patch.disabledSkills;
  return result;
}

/** Validates `PATCH /__hui/bots/:id`: only the given fields, `""` where a field may be cleared. */
export function normalizeBotPatch(value: unknown): BotPatch {
  const input = body(value, "A bot change");
  if (!Object.keys(input).length) throw new BotInputError("Nothing to change.");
  // Its conversation, memory and SOUL.md live in that machine's store: moving them is not something an edit does.
  if ("worker" in input) throw new BotInputError("A bot stays on the machine it was created on.");
  if ("soul" in input) throw new BotInputError("Change a bot's SOUL.md with PUT /__hui/bots/:id/soul.");
  const patch: BotPatch = {};
  if ("name" in input) patch.name = textField(input["name"], "name", BOT_LIMITS.name, { line: true, required: true });
  if ("handle" in input) patch.handle = handleField(input["handle"]);
  if ("title" in input) patch.title = textField(input["title"], "title", BOT_LIMITS.title, { line: true });
  if ("description" in input) patch.description = textField(input["description"], "description", BOT_LIMITS.description);
  if ("tagging" in input) {
    if (!isBotTagging(input["tagging"])) throw new BotInputError(`Who can tag the bot must be one of: ${BOT_TAGGING.join(", ")}.`);
    patch.tagging = input["tagging"];
  }
  if ("cwd" in input) patch.cwd = cwdField(input["cwd"]);
  // `""` puts the chat back on the model or thinking level a new chat gets, and the memory on the chat's own model.
  if ("model" in input) patch.model = modelField(input["model"], "model");
  if ("thinking" in input) patch.thinking = levelField(input["thinking"], "thinking");
  // The bot's utility model (memory summaries, quick answers on calls, call summaries) is stored as `memoryModel`, its
  // name before calls; `utilityModel` is the same field.
  if ("utilityModel" in input) {
    const utility = modelField(input["utilityModel"], "utilityModel");
    if ("memoryModel" in input && modelField(input["memoryModel"], "memoryModel") !== utility) throw new BotInputError("Give the utility model once: utilityModel and memoryModel are the same field.");
    patch.memoryModel = utility;
  } else if ("memoryModel" in input) patch.memoryModel = modelField(input["memoryModel"], "memoryModel");
  if ("memoryThinking" in input) patch.memoryThinking = levelField(input["memoryThinking"], "memoryThinking");
  if ("avatar" in input) patch.avatar = input["avatar"] === null ? null : avatarField(input["avatar"]);
  if ("voice" in input) patch.voice = input["voice"] === null ? null : voiceField(input["voice"]);
  if ("hidden" in input) {
    if (typeof input["hidden"] !== "boolean") throw new BotInputError("Hidden must be a boolean.");
    patch.hidden = input["hidden"];
  }
  // Whole lists: [] turns everything back on.
  if ("disabledTools" in input) patch.disabledTools = toolsField(input["disabledTools"]);
  if ("disabledSkills" in input) patch.disabledSkills = skillsField(input["disabledSkills"]);
  return patch;
}

/** The voice after a patch: given keys replace, `language: ""` and `live: ""` clear one, `null` clears both. */
export function patchedVoice(current: BotVoice | undefined, patch: BotVoicePatch | null): BotVoice | undefined {
  if (patch === null) return undefined;
  const language = patch.language !== undefined ? patch.language : current?.language;
  const live = patch.live !== undefined ? patch.live : current?.live;
  const voice: BotVoice = { ...(language ? { language } : {}), ...(live ? { live } : {}) };
  return Object.keys(voice).length ? voice : undefined;
}

/** The avatar after a patch: given keys replace, `""` clears a key, `null` clears them all. */
export function patchedAvatar(current: BotAvatar | undefined, patch: BotAvatarPatch | null): BotAvatar | undefined {
  if (patch === null) return undefined;
  const next = { ...current, ...patch };
  const avatar: BotAvatar = {
    ...(next.emoji ? { emoji: next.emoji } : {}), ...(next.color ? { color: next.color } : {}), ...(next.shape ? { shape: next.shape } : {}), ...(next.ears ? { ears: next.ears } : {}),
  };
  return Object.keys(avatar).length ? avatar : undefined;
}
