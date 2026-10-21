/**
 * Browser half of the bots API (`/__hui/bots`, owned by `server/`; the contract
 * is in `docs/api.md`): parsing records and stream frames, drafts and edits, and
 * session lists; and the browser's copy of the gateway's bot limits, faces,
 * labels, tagging and sender parsing (server/bots-format.ts and
 * server/runtimes/turn-origins.ts). A bot is a named agent with one permanent
 * chat: its session is an ordinary HUI session whose view carries `bot`. The
 * requests live in src/api/bots.ts.
 *
 * Responses are normalized on the way in, like settings: a malformed or newer
 * record is skipped or narrowed rather than reaching the roster as `undefined`.
 */
import type { BotAvatar, BotAvatarPatch, BotFaceEars, BotFaceShape, BotInput, BotMemoryStatus, BotMemoryUsage, BotPatch, BotSessionStatus, BotsUpdate, BotTagging, BotView, BotVoice } from "../../api/schema/bots.ts";
import { gptLiveVoice } from "../voice/calls.ts";
import { voiceLanguage } from "../voice/languages.ts";
import type { SessionGroup, SessionView } from "../../api/sessions.ts";
import { sessionTreeIds } from "../session/tree.ts";

export type { BotAvatar, BotInput, BotMemoryStatus, BotMemoryUsage, BotPatch, BotsUpdate, BotView } from "../../api/schema/bots.ts";

/** Limits the gateway enforces at its boundary; the CLI and browser mirror them. */
export const BOT_LIMITS = {
  name: 60,
  handle: 32,
  title: 80,
  description: 500,
  /** SOUL.md, in characters: what a bot's chat reads of it, and what `PUT …/soul` accepts. */
  soul: 20_000,
  /** One `message_bot` message. */
  message: 20_000,
  /** `lastMessage.text`, a one-line preview. */
  preview: 200,
} as const;

export const BOT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Who may tag a bot (`message_bot`), as a skill's frontmatter says when it loads: `anyone` (the default, never stored)
 * whenever a task fits its description; `mention` only in a turn whose operator message names `@handle`, as a skill with
 * `disable-model-invocation` waits for `/skill:name`; `nobody` never, and it is in no list.
 */
const BOT_TAGGING = ["anyone", "mention", "nobody"] as const;

export function isBotTagging(value: unknown): value is BotTagging {
  return typeof value === "string" && (BOT_TAGGING as readonly string[]).includes(value);
}

/** `tagging` as a record keeps it: `mention` or `nobody`; anything else, the default `anyone` included, is nothing. */
export function storedTagging(value: unknown): Exclude<BotTagging, "anyone"> | undefined {
  return value === "mention" || value === "nobody" ? value : undefined;
}

/**
 * A bot's face, after OpenAI's Dots: a plush shape in a color, with two dot
 * eyes and no mouth, and optionally ears (or an antenna, a sprout, horns) on
 * top. Stored in `avatar` beside the emoji, which still wins while set (a bot
 * switches to its face when the emoji is cleared).
 */
export const BOT_FACE_SHAPES = ["blob", "round", "triangle", "heart", "cookie", "star", "flower", "cloud", "drop", "ghost", "pill", "block", "hexagon"] as const;
export const BOT_FACE_SHAPE_LABELS: Readonly<Record<BotFaceShape, string>> = {
  blob: "Blob", round: "Pebble", triangle: "Triangle", heart: "Heart", cookie: "Cookie", star: "Star", flower: "Flower",
  cloud: "Cloud", drop: "Drop", ghost: "Ghost", pill: "Pill", block: "Block", hexagon: "Hexagon",
};
/** The shapes a bot's id picks from without a stored one: the first five, so the faces bots had before the others
 * came stay as they were. */
const PICKED_SHAPES = BOT_FACE_SHAPES.slice(0, 5);

/** What sits on top of a face; absent: nothing. Never picked by the id. */
export const BOT_FACE_EARS = ["cat", "bear", "bunny", "antenna", "sprout", "horns"] as const;
export const BOT_FACE_EARS_LABELS: Readonly<Record<BotFaceEars, string>> = {
  cat: "Cat ears", bear: "Bear ears", bunny: "Bunny ears", antenna: "Antenna", sprout: "Sprout", horns: "Horns",
};

/** The palette the Bots tab and `hui bot --color` name; the API takes any #rrggbb. */
export const BOT_FACE_COLORS = [
  { id: "blue", label: "Blue", hex: "#3a7bfa" },
  { id: "yellow", label: "Yellow", hex: "#f5c21b" },
  { id: "magenta", label: "Magenta", hex: "#d23ce0" },
  { id: "mint", label: "Mint", hex: "#2fc49a" },
  { id: "coral", label: "Coral", hex: "#ff6b4a" },
  { id: "lilac", label: "Lilac", hex: "#9b7cf6" },
] as const;
type BotFaceColor = (typeof BOT_FACE_COLORS)[number];

/**
 * The first line of the message HUI sends a new bot without a soul, so it speaks
 * first: an ordinary user-role message (like a routine's), which the chat shows
 * as a note ("<name> was created"), never as the operator's bubble.
 */
const BOT_KICKOFF_MARKER = "[HUI bot created]";

/** The line after a kickoff's name that makes it an import's first turn: not the operator's, so its gated tools refuse
 * (the template's soul and skills can't make the bot rewrite itself before the operator has said a word). */
const BOT_IMPORTED_KICKOFF_LINE = "from: template";

/** The bot's name when `text` is a kickoff message (`""` if it names none); undefined for every other message. */
export function botKickoffName(text: string): string | undefined {
  if (text !== BOT_KICKOFF_MARKER && !text.startsWith(`${BOT_KICKOFF_MARKER}\n`)) return undefined;
  return /^name: (.*)$/mu.exec(text)?.[1]?.trim() ?? "";
}

/** The two answers of an access request. */
export const BOT_ACCESS_ANSWERS = ["Allow", "Deny"] as const;

/** Who started a bot's turn, by the message that started it: a routine (`[routine: name] …`), a trigger
 * (`[trigger: name · …] …`), another bot (`[from @handle] …`), a session's agent (`[from agent: title] …`), HUI's
 * kickoff of a new bot, an imported bot's first turn (a kickoff with `from: template`), or else the operator. */
export type BotTurnOrigin =
  | { kind: "operator" } | { kind: "kickoff" } | { kind: "imported" } | { kind: "routine"; name: string } | { kind: "trigger"; name: string }
  | { kind: "bot"; handle: string } | { kind: "agent"; title: string };

const AGENT_TAG = /^\[from agent: ([^\]\n]*?)(?: · reply-to (agent:[A-Za-z0-9_-]{1,94}))?(?: · hop [1-9]\d*)?\] /u;

export function botTurnOrigin(text: string | undefined): BotTurnOrigin {
  if (!text) return { kind: "operator" };
  if (text.startsWith("[routine: ")) return { kind: "routine", name: /^\[routine: (.*?)\] /u.exec(text)?.[1] ?? "" };
  // A trigger's name holds no `[`, `]` or `·`: it ends at the summary's ` · ` or at the bracket.
  if (text.startsWith("[trigger: ")) return { kind: "trigger", name: /^\[trigger: ([^\]·\n]*?)(?: · |\])/u.exec(text)?.[1] ?? "" };
  const bot = /^\[from @([a-z0-9-]+)(?: · hop [1-9]\d*)?\] /u.exec(text);
  if (bot) return { kind: "bot", handle: bot[1]! };
  const agent = AGENT_TAG.exec(text);
  if (agent) return { kind: "agent", title: agent[1]! };
  if (botKickoffName(text) === undefined) return { kind: "operator" };
  return text.split("\n", 3).includes(BOT_IMPORTED_KICKOFF_LINE) ? { kind: "imported" } : { kind: "kickoff" };
}

/** The gateway's return address in an agent's attribution header; never one embedded in a forwarded message. */
export function agentReplyTo(text: string | undefined): string | undefined {
  return AGENT_TAG.exec(text ?? "")?.[2];
}

export function isBotFaceShape(value: unknown): value is BotFaceShape {
  return typeof value === "string" && (BOT_FACE_SHAPES as readonly string[]).includes(value);
}

export function isBotFaceEars(value: unknown): value is BotFaceEars {
  return typeof value === "string" && (BOT_FACE_EARS as readonly string[]).includes(value);
}

/** A palette color by its name (`mint`, any case) or hex; undefined for anything else. */
function botFaceColor(value: string): BotFaceColor | undefined {
  const key = value.trim().toLowerCase();
  return BOT_FACE_COLORS.find((color) => color.id === key || color.hex === key);
}

/** A 32-bit hash of a bot's id (FNV-1a with a final mix): stable across renames, reloads and machines. */
export function botSeed(id: string): number {
  let hash = 0x811c9dc5;
  for (const character of id) hash = Math.imul(hash ^ character.codePointAt(0)!, 0x01000193);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** What a bot looks like everywhere (roster, chat, call, CLI). `emoji` while it has one, else its face. */
export type BotLook = {
  kind: "face" | "emoji";
  emoji?: string;
  shape: BotFaceShape;
  ears?: BotFaceEars;
  /** #rrggbb: the face's body, the emoji's tile and the call's tint. */
  color: string;
  /** The shape or color comes from the id, not from the record. */
  derived: { shape: boolean; color: boolean };
  /** Seeds the plush texture, so the same bot has the same face everywhere. */
  seed: number;
};

/** The face a bot gets without a stored shape or color: picked by its id, the same everywhere. */
export function defaultBotLook(id: string): { shape: BotFaceShape; color: string } {
  const seed = botSeed(id);
  return {
    shape: PICKED_SHAPES[seed % PICKED_SHAPES.length]!,
    color: BOT_FACE_COLORS[Math.floor(seed / PICKED_SHAPES.length) % BOT_FACE_COLORS.length]!.hex,
  };
}

export function botLook(bot: { id: string; avatar?: BotAvatar | undefined }): BotLook {
  const fallback = defaultBotLook(bot.id);
  const shape = isBotFaceShape(bot.avatar?.shape) ? bot.avatar.shape : undefined;
  const color = bot.avatar?.color && /^#[0-9a-f]{6}$/iu.test(bot.avatar.color) ? bot.avatar.color.toLowerCase() : undefined;
  return {
    kind: bot.avatar?.emoji ? "emoji" : "face",
    ...(bot.avatar?.emoji ? { emoji: bot.avatar.emoji } : {}),
    shape: shape ?? fallback.shape,
    ...(isBotFaceEars(bot.avatar?.ears) ? { ears: bot.avatar.ears } : {}),
    color: color ?? fallback.color,
    derived: { shape: !shape, color: !color },
    seed: botSeed(bot.id),
  };
}

/** `Mint` for a palette color, the hex for any other. */
export function botColorName(hex: string): string {
  return botFaceColor(hex)?.label ?? hex;
}

/** One line: whitespace runs as single spaces, at most `max` characters (an ellipsis marks a cut). */
export function previewLine(text: string, max: number = BOT_LIMITS.preview): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A bot's editable fields as its Settings page holds them. Empty model fields mean the default: the gateway's
 * model, the default thinking level, Settings' utility model. The persona is not here: the bot writes its SOUL.md in
 * its first conversation. */
export type BotDraft = {
  name: string;
  title: string;
  /** Empty: a private folder the gateway creates for the bot. On a worker's bot, a folder there. */
  cwd: string;
  emoji: string;
  /** The look: "face" sends the shape and color and clears the emoji, "emoji" sends the emoji. Absent: the emoji
   * decides, as before faces. */
  look?: "face" | "emoji";
  shape?: BotFaceShape;
  /** "" for none. */
  ears?: BotFaceEars | "";
  /** #rrggbb */
  color?: string;
  model: string;
  thinking: string;
  memoryModel: string;
  /** The language the bot speaks on calls ("" for Auto); absent leaves it as it is. */
  voiceLanguage?: string;
  /** A GPT-Live call voice ("" for Settings' default); absent leaves it as it is. */
  callVoice?: string;
  /** What it does and when to tag it ("" clears it); absent leaves it as it is. */
  description?: string;
  /** Who may tag it (`BOT_TAGGING`); absent leaves it as it is. */
  tagging?: string;
};

const SESSION_STATUSES: readonly BotSessionStatus[] = ["idle", "running", "waiting", "starting", "error", "reconnecting", "disconnected"];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 20_000): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function optionalText(value: unknown, maximum = 20_000): string | undefined {
  return text(value, maximum) || undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** A provider-reported amount such as a cost in USD: finite, never negative. */
function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function parseAvatar(value: unknown): BotAvatar | undefined {
  if (!isRecord(value)) return undefined;
  const emoji = optionalText(value["emoji"], 32);
  const color = typeof value["color"] === "string" && /^#[0-9a-f]{6}$/iu.test(value["color"].trim())
    ? value["color"].trim().toLowerCase()
    : undefined;
  const shape = isBotFaceShape(value["shape"]) ? value["shape"] : undefined;
  const ears = isBotFaceEars(value["ears"]) ? value["ears"] : undefined;
  return emoji || color || shape || ears
    ? { ...(emoji ? { emoji } : {}), ...(color ? { color } : {}), ...(shape ? { shape } : {}), ...(ears ? { ears } : {}) }
    : undefined;
}

/** The compactor's spend; a gateway that reports none spent nothing it can show. */
function parseBotMemoryUsage(value: unknown): BotMemoryUsage {
  const usage = isRecord(value) ? value : {};
  return {
    calls: count(usage["calls"]),
    input: count(usage["input"]),
    output: count(usage["output"]),
    cacheRead: count(usage["cacheRead"]),
    cacheWrite: count(usage["cacheWrite"]),
    cost: amount(usage["cost"]),
  };
}

function parseVoice(value: unknown): BotVoice | undefined {
  if (!isRecord(value)) return undefined;
  const language = voiceLanguage(value["language"]);
  const live = gptLiveVoice(value["live"]);
  const voice: BotVoice = { ...(language ? { language } : {}), ...(live ? { live } : {}) };
  return Object.keys(voice).length ? voice : undefined;
}

export function parseBotMemoryStatus(value: unknown): BotMemoryStatus | undefined {
  if (!isRecord(value)) return undefined;
  const failing = isRecord(value["failing"]) ? value["failing"] : undefined;
  const failingError = text(failing?.["error"], 2_000);
  return {
    messages: count(value["messages"]),
    built: count(value["built"]),
    pending: count(value["pending"]),
    viewBytes: count(value["viewBytes"]),
    viewLines: count(value["viewLines"]),
    ...(value["waiting"] === true ? { waiting: true } : {}),
    // A failure is shown only with its reason; node and time are details.
    ...(failingError ? { failing: { node: text(failing?.["node"], 200), error: failingError, since: text(failing?.["since"], 100) } } : {}),
    usage: parseBotMemoryUsage(value["usage"]),
  };
}

function parseLastMessage(value: unknown): BotView["lastMessage"] {
  if (!isRecord(value)) return undefined;
  const role = value["role"];
  const at = text(value["at"], 100);
  if ((role !== "user" && role !== "assistant") || !at) return undefined;
  // The gateway already sends one short line; keep the roster safe from a long one.
  return { role, text: text(value["text"], 400).replace(/\s+/gu, " "), at };
}

/** A bot record the roster can render, or undefined when it lacks identity. */
export function parseBot(value: unknown): BotView | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value["id"], 200);
  const name = text(value["name"], 200);
  const sessionId = text(value["sessionId"], 200);
  if (!id || !name || !sessionId) return undefined;
  const status = SESSION_STATUSES.find((candidate) => candidate === value["status"]) ?? "idle";
  const avatar = parseAvatar(value["avatar"]);
  const voice = parseVoice(value["voice"]);
  const lastMessage = parseLastMessage(value["lastMessage"]);
  const memory = parseBotMemoryStatus(value["memory"]);
  // What the operator turned off in its chat (the Tools & skills page reads the details from the catalog).
  const disabledTools = Array.isArray(value["disabledTools"]) ? value["disabledTools"].filter((name): name is string => typeof name === "string") : [];
  const disabledSkills = Array.isArray(value["disabledSkills"])
    ? value["disabledSkills"].flatMap((raw) => isRecord(raw) && typeof raw["name"] === "string" && typeof raw["path"] === "string" ? [{ name: raw["name"], path: raw["path"] }] : [])
    : [];
  const worker = isRecord(value["worker"]) && text(value["worker"]["id"], 200) && text(value["worker"]["name"], 200)
    ? { id: text(value["worker"]["id"], 200), name: text(value["worker"]["name"], 200) }
    : undefined;
  const optional: Partial<Record<"title" | "description" | "model" | "thinking" | "memoryModel" | "memoryThinking", string>> = {};
  for (const [key, maximum] of [["title", 200], ["description", 2_000], ["model", 200], ["thinking", 40], ["memoryModel", 200], ["memoryThinking", 40]] as const) {
    const entry = optionalText(value[key], maximum);
    if (entry) optional[key] = entry;
  }
  const tagging = storedTagging(value["tagging"]);
  return {
    id,
    handle: text(value["handle"], 64),
    name,
    ...optional,
    ...(tagging ? { tagging } : {}),
    cwd: text(value["cwd"], 4_096),
    ...(worker ? { worker } : {}),
    ...(avatar ? { avatar } : {}),
    ...(voice ? { voice } : {}),
    ...(value["hidden"] === true ? { hidden: true } : {}),
    ...(value["archived"] === true ? { archived: true } : {}),
    ...(disabledTools.length ? { disabledTools } : {}),
    ...(disabledSkills.length ? { disabledSkills } : {}),
    sessionId,
    createdAt: text(value["createdAt"], 100),
    updatedAt: text(value["updatedAt"], 100),
    status,
    soul: value["soul"] === true,
    ...(lastMessage ? { lastMessage } : {}),
    unread: value["unread"] === true,
    ...(memory ? { memory } : {}),
    routines: count(value["routines"]),
  };
}

/** `{ bots: [...] }`; invalid entries are skipped and duplicate ids keep the first. */
export function parseBotList(body: unknown): BotView[] {
  const list = isRecord(body) && Array.isArray(body["bots"]) ? body["bots"] : [];
  const seen = new Set<string>();
  return list.flatMap((entry) => {
    const bot = parseBot(entry);
    if (!bot || seen.has(bot.id)) return [];
    seen.add(bot.id);
    return [bot];
  });
}

/* ── live list ────────────────────────────────────────────────────────────── */

/** Reads one frame of `GET /__hui/bots/events`: the complete list first, then
 * only the bots whose views changed; `ids` (every bot, in order) when that
 * changed. The stream includes archived bots; the roster leaves them out. */
export function parseBotsUpdate(payload: unknown): BotsUpdate | undefined {
  if (!isRecord(payload) || typeof payload["revision"] !== "number" || !Number.isFinite(payload["revision"])) return undefined;
  const ids = Array.isArray(payload["ids"]) ? payload["ids"].filter((id): id is string => typeof id === "string") : undefined;
  return { revision: payload["revision"], ...(ids ? { ids } : {}), upserts: parseBotList({ bots: payload["upserts"] }) };
}

/** Whether a stream frame says something the list has not seen. Every
 * (re)connect starts with the gateway's cached list: at the revision already
 * applied it replays what the list shows (older, even, once confirmed edits
 * landed on top), so it is not news. Any other first revision is newer, or
 * comes from a gateway that started again. Later frames only move forward. */
export function isNewBotsFrame(revision: number, first: boolean, applied: number): boolean {
  return first ? revision !== applied : revision > applied;
}

/** Changed bots replace their copies; `ids`, when present, is the whole list. */
export function applyBotsUpdate(bots: readonly BotView[], update: Pick<BotsUpdate, "ids" | "upserts">): BotView[] {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  for (const bot of update.upserts) byId.set(bot.id, bot);
  if (update.ids) return update.ids.flatMap((id) => byId.get(id) ?? []);
  const known = new Set(bots.map(({ id }) => id));
  return [...bots.map((bot) => byId.get(bot.id) ?? bot), ...update.upserts.filter((bot) => !known.has(bot.id))];
}

/** The session status stream wins over a bot list read before it, its unread marks as its statuses; the bot on screen
 * is read. The maps are keyed by session id. */
export function withLiveChats(
  bots: readonly BotView[],
  live: { statuses: ReadonlyMap<string, BotSessionStatus>; unread: ReadonlyMap<string, boolean>; presented: (sessionId: string) => boolean },
): BotView[] {
  return bots.map((bot) => {
    const status = live.statuses.get(bot.sessionId);
    const unread = (live.unread.get(bot.sessionId) ?? bot.unread) && !live.presented(bot.sessionId);
    return status || unread !== bot.unread ? { ...bot, ...(status ? { status } : {}), unread } : bot;
  });
}

export type BotsStreamHandlers = {
  /** `first` marks the complete list each (re)connect starts with. */
  onUpdate: (update: BotsUpdate, first: boolean) => void;
  /** `unsupported`: the gateway has no bot stream (an older build): stop asking. */
  onConnection: (state: "live" | "reconnecting" | "unsupported") => void;
};

/* ── drafts ───────────────────────────────────────────────────────────────── */

/** Create payload: trimmed, with empty optional fields left to the gateway's defaults. */
export function botInputFromDraft(draft: BotDraft): BotInput {
  const optional = (value: string) => value.trim() || undefined;
  const entries = {
    title: optional(draft.title),
    cwd: optional(draft.cwd),
    model: optional(draft.model),
    thinking: optional(draft.thinking),
    memoryModel: optional(draft.memoryModel),
  };
  const avatar = draftAvatar(draft);
  const voice = draftVoice(draft);
  return {
    name: draft.name.trim(),
    ...Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)),
    ...(avatar ? { avatar } : {}),
    ...(voice ? { voice } : {}),
  };
}

function draftLook(draft: BotDraft): "face" | "emoji" {
  return draft.look ?? (draft.emoji.trim() ? "emoji" : "face");
}

/** A new bot's look from a draft: the shape and color picked, and the emoji in Emoji. */
function draftAvatar(draft: BotDraft): BotAvatar | undefined {
  const emoji = draft.emoji.trim();
  const avatar: BotAvatar = {
    ...(draftLook(draft) === "emoji" && emoji ? { emoji } : {}),
    ...(draft.color && /^#[0-9a-f]{6}$/iu.test(draft.color) ? { color: draft.color.toLowerCase() } : {}),
    ...(draft.shape && isBotFaceShape(draft.shape) ? { shape: draft.shape } : {}),
    ...(isBotFaceEars(draft.ears) ? { ears: draft.ears } : {}),
  };
  return Object.keys(avatar).length ? avatar : undefined;
}

/** A draft's call voice and language; nothing for Auto and Settings' default. */
function draftVoice(draft: BotDraft): BotVoice | undefined {
  const language = voiceLanguage(draft.voiceLanguage);
  const live = gptLiveVoice(draft.callVoice);
  const voice: BotVoice = { ...(language ? { language } : {}), ...(live ? { live } : {}) };
  return Object.keys(voice).length ? voice : undefined;
}

/** Edit payload: only what changed, so an untouched workspace never trips the
 * gateway's "only while idle" rule. An emptied field clears: the title goes,
 * the memory model goes back to the bot's own, and an empty
 * model or thinking level ("Gateway default") puts the chat back on what a new
 * chat gets. An avatar key set to "" clears that key: Face clears the emoji, and
 * a shape or color is sent only when it differs from what the bot shows now
 * (its own, or the one its id picks). */
export function botPatchFromDraft(bot: BotView, draft: BotDraft): BotPatch {
  const patch: BotPatch = {};
  const name = draft.name.trim();
  if (name && name !== bot.name) patch.name = name;
  for (const key of ["title", "model", "thinking", "memoryModel"] as const) {
    const value = draft[key].trim();
    if (value !== (bot[key] ?? "")) patch[key] = value;
  }
  const cwd = draft.cwd.trim();
  if (cwd && cwd !== bot.cwd) patch.cwd = cwd;
  const avatar = avatarPatch(bot, draft);
  if (avatar) patch.avatar = avatar;
  // The call voice and the language change only when they differ from the bot's.
  const voice: NonNullable<BotPatch["voice"]> = {};
  // Auto ("") clears the language; a draft without one leaves it alone.
  const language = draft.voiceLanguage === undefined ? undefined : voiceLanguage(draft.voiceLanguage) ?? "";
  if (language !== undefined && language !== (bot.voice?.language ?? "")) voice.language = language;
  // "Default" ("") follows Settings → Models → Calls.
  const live = draft.callVoice === undefined ? undefined : gptLiveVoice(draft.callVoice) ?? "";
  if (live !== undefined && live !== (bot.voice?.live ?? "")) voice.live = live;
  if (Object.keys(voice).length) patch.voice = voice;
  const description = draft.description?.trim();
  if (description !== undefined && description !== (bot.description ?? "")) patch.description = description;
  if (isBotTagging(draft.tagging) && draft.tagging !== (bot.tagging ?? "anyone")) patch.tagging = draft.tagging;
  return patch;
}

/** A control of a bot's Settings page, by what it saves through `PATCH /__hui/bots/:id`: the look's shape, color and
 * emoji are parts of `avatar`, a call's voice and language parts of `voice`. */
export type BotSettingKey =
  "name" | "title" | "shape" | "ears" | "color" | "emoji" | "description" | "tagging" | "model" | "thinking" | "memoryModel" | "callVoice" | "voiceLanguage" | "cwd";
export type BotSettingValue = string;

/** What a control shows for the bot as it is: "" for a default, the look as the bot shows it. */
export function botSettingOf(bot: BotView, key: BotSettingKey): BotSettingValue {
  switch (key) {
    case "name": return bot.name;
    case "title": return bot.title ?? "";
    case "shape": return botLook(bot).shape;
    case "ears": return botLook(bot).ears ?? "";
    case "color": return botLook(bot).color;
    case "emoji": return bot.avatar?.emoji ?? "";
    case "description": return bot.description ?? "";
    case "tagging": return bot.tagging ?? "anyone";
    case "model": return bot.model ?? "";
    case "thinking": return bot.thinking ?? "";
    case "memoryModel": return bot.memoryModel ?? "";
    case "callVoice": return bot.voice?.live ?? "";
    case "voiceLanguage": return bot.voice?.language ?? "";
    case "cwd": return bot.cwd;
  }
}

/** A control's new value as the draft change `botChangePatch` turns into a PATCH. An emoji is the Emoji look; an
 * empty one goes back to the face. */
export function botSettingChange(key: BotSettingKey, value: BotSettingValue): Partial<BotDraft> {
  if (key === "emoji") return value.trim() ? { look: "emoji", emoji: value } : { look: "face", emoji: "" };
  return { [key]: value };
}

/** The draft that changes nothing: the bot as it is, its look as it shows, and its call voice and language as stored. */
export function botDraftOf(bot: BotView): BotDraft {
  const look = botLook(bot);
  return {
    name: bot.name,
    title: bot.title ?? "",
    cwd: bot.cwd,
    emoji: bot.avatar?.emoji ?? "",
    look: look.kind,
    shape: look.shape,
    ears: look.ears ?? "",
    color: look.color,
    model: bot.model ?? "",
    thinking: bot.thinking ?? "",
    memoryModel: bot.memoryModel ?? "",
    voiceLanguage: bot.voice?.language ?? "",
    callVoice: bot.voice?.live ?? "",
    description: bot.description ?? "",
    tagging: bot.tagging ?? "anyone",
  };
}

/** One change from the Settings page as the PATCH
 * that makes it: only what differs from the bot now, by the edit rules above
 * (an empty model or thinking level goes back to the gateway's defaults, an
 * empty utility model to Settings', and a blank name or workspace changes
 * nothing). Undefined when there is nothing to send. */
export function botChangePatch(bot: BotView, change: Partial<BotDraft>): BotPatch | undefined {
  const patch = botPatchFromDraft(bot, { ...botDraftOf(bot), ...change });
  return Object.keys(patch).length ? patch : undefined;
}

function avatarPatch(bot: BotView, draft: BotDraft): BotAvatarPatch | undefined {
  const patch: BotAvatarPatch = {};
  const emoji = draftLook(draft) === "emoji" ? draft.emoji.trim() : "";
  if (emoji !== (bot.avatar?.emoji ?? "")) patch.emoji = emoji;
  const look = botLook(bot);
  if (draft.shape && isBotFaceShape(draft.shape) && draft.shape !== look.shape) patch.shape = draft.shape;
  if (draft.ears !== undefined && (draft.ears === "" || isBotFaceEars(draft.ears)) && draft.ears !== (look.ears ?? "")) patch.ears = draft.ears;
  const color = draft.color?.toLowerCase();
  if (color && /^#[0-9a-f]{6}$/u.test(color) && color !== look.color) patch.color = color;
  return Object.keys(patch).length ? patch : undefined;
}

/** Puts a confirmed bot record in place of its old copy, or adds it. */
export function upsertBot(bots: readonly BotView[], bot: BotView): BotView[] {
  return bots.some(({ id }) => id === bot.id) ? bots.map((entry) => entry.id === bot.id ? bot : entry) : [...bots, bot];
}

/* ── session lists ────────────────────────────────────────────────────────── */

export function isBotSession(session: Pick<SessionView, "bot">): boolean {
  return Boolean(session.bot);
}

/** Bot chats live in the Bots tab, never in session lists, search, the board
 * or session pickers, and neither do the subagents a bot spawns, nor theirs:
 * they are the bot's work, which its chat's cards list and open. Configured
 * groups stay even when emptied, as they would without the bot; OTHER exists
 * only for listed sessions, so it goes when a bot's sessions were all it held.
 * Groups without them keep their identity. */
export function withoutBotSessions(groups: readonly SessionGroup[]): SessionGroup[] {
  const all = groups.flatMap((group) => group.sessions);
  const ofBots = new Set(all.filter(isBotSession).flatMap((chat) => [...sessionTreeIds(all, chat.id)]));
  return groups.flatMap((group) => {
    if (!group.sessions.some((session) => ofBots.has(session.id))) return [group];
    const sessions = group.sessions.filter((session) => !ofBots.has(session.id));
    return sessions.length || (group.label && group.label !== "ungrouped") ? [{ ...group, sessions }] : [];
  });
}
