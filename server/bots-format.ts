/**
 * Bots (HUI-18): named, persistent agents, each with one forever chat whose
 * memory is OptChat and whose persona is the SOUL.md it writes in its first
 * conversation. The gateway's and the `hui bot` CLI's records, limits, faces,
 * kickoff and tags; the browser keeps its own copy of what it shows in
 * src/lib/bots/bots.ts, and who started a turn is in runtimes/turn-origins.ts.
 * The chat itself is an ordinary Durable session (`BotRecord.sessionId`); the
 * session API drives it like any other.
 */
import type { BotAvatar, BotFaceEars, BotFaceShape, BotSkillRef, BotTagging, BotView, BotVoice } from "./api/bots.ts";

export type {
  BotAccessRequest, BotAvatar, BotAvatarPatch, BotCatalog, BotCatalogSkill, BotCatalogTool, BotDelivery, BotFaceEars, BotFaceShape, BotInput,
  BotLastMessage, BotMemoryStatus, BotMemoryUsage, BotMessageResult, BotPatch, BotQuestion, BotReply, BotSessionStatus, BotSkillRef,
  BotSkillSelector, BotSoul, BotsUpdate, BotTagging, BotToolGroup, BotView, BotVoice, BotVoicePatch,
} from "./api/bots.ts";

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

/** Lowercase ASCII letters, digits and inner dashes, 1–32 characters. */
export const BOT_HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

/**
 * Who may tag a bot (`message_bot`), as a skill's frontmatter says when it loads: `anyone` (the default, never stored)
 * whenever a task fits its description; `mention` only in a turn whose operator message names `@handle`, as a skill with
 * `disable-model-invocation` waits for `/skill:name`; `nobody` never, and it is in no list.
 */
export const BOT_TAGGING = ["anyone", "mention", "nobody"] as const;

export function isBotTagging(value: unknown): value is BotTagging {
  return typeof value === "string" && (BOT_TAGGING as readonly string[]).includes(value);
}

/** `tagging` as a record keeps it: `mention` or `nobody`; anything else, the default `anyone` included, is nothing. */
export function storedTagging(value: unknown): Exclude<BotTagging, "anyone"> | undefined {
  return value === "mention" || value === "nobody" ? value : undefined;
}

/** Whether `text` tags `@handle`, any case: the handle whole, not inside an address (`me@ada.dev`), a longer handle
 * (`@ada-2`) or a path (`@ada/notes.md`, `@ada.md`). */
export function mentionsBot(text: string, handle: string): boolean {
  return new RegExp(`(?<![\\w@./-])@${handle}(?![\\w/-]|\\.\\w)`, "iu").test(text);
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
export type BotFaceColor = (typeof BOT_FACE_COLORS)[number];

/** What the operator turned off in a bot's chat. */
export type BotAccess = { disabledTools: string[]; disabledSkills: BotSkillRef[] };

/** One bot as `bots.json` stores it. */
export type BotRecord = {
  id: string;
  /** Unique; how other bots and the CLI address it (`@handle`). */
  handle: string;
  name: string;
  /** Its role, one line. */
  title?: string;
  /** What it does and when to tag it, as a skill's description: what agents and other bots read to decide. */
  description?: string;
  /** Who may tag it; absent: anyone. */
  tagging?: Exclude<BotTagging, "anyone">;
  /** Absolute working directory of its chat; on a worker, a directory there. Its persona is not here: it is SOUL.md in
   * the bot's home folder, on the machine its chat runs on. */
  cwd: string;
  /**
   * The remote worker (Settings → Workers) its chat runs on, by id: its conversation and OptChat memory live in that
   * worker's Durable store. Absent: this machine. Chosen at creation; a bot never moves.
   */
  worker?: string;
  /** `provider/id` of its chat. */
  model?: string;
  thinking?: string;
  /** `provider/id` OptChat's compactor uses; absent: the chat's own model. */
  memoryModel?: string;
  memoryThinking?: string;
  avatar?: BotAvatar;
  /** Its voice on calls: `voice.live` is its GPT-Live voice (absent: Settings' choice) and `voice.language` the
   * language it speaks there (absent: Auto). */
  voice?: BotVoice;
  hidden?: boolean;
  /** Archived bots keep their chat and memory; their routines are disabled. */
  archived?: boolean;
  /**
   * Tools and skills the operator turned off in its chat; absent: none. Everything else a session in its directory
   * gets is on, tools and skills that appear later included. A mirror: the chat's `hui.bot` document holds the lists,
   * and the host that runs the chat enforces them.
   */
  disabledTools?: string[];
  disabledSkills?: BotSkillRef[];
  /** HUI session record of its chat. */
  sessionId: string;
  createdAt: string;
  updatedAt: string;
};

/** The name of a bot created without one; it asks the operator for a real one in its first conversation. */
export const NEW_BOT_NAME = "New Bot";

/** The persona file in each bot's home folder. */
export const BOT_SOUL_FILE = "SOUL.md";

/**
 * The first line of the message HUI sends a new bot without a soul, so it speaks
 * first: an ordinary user-role message (like a routine's), which the chat shows
 * as a note ("<name> was created"), never as the operator's bubble.
 */
export const BOT_KICKOFF_MARKER = "[HUI bot created]";

/** The line after a kickoff's name that makes it an import's first turn: not the operator's, so its gated tools refuse
 * (the template's soul and skills can't make the bot rewrite itself before the operator has said a word). */
export const BOT_IMPORTED_KICKOFF_LINE = "from: template";

/** The kickoff message: the marker, the bot's name, and what HUI asks of it. */
export function botKickoffText(name: string): string {
  return [
    BOT_KICKOFF_MARKER,
    `name: ${name.replace(/\s+/gu, " ").trim()}`,
    "HUI just created you. This note is from HUI, not the operator, who will read your chat when they open it. Write your opening message to them now (your greeting and first question, as your soul section says) and reply with that message only.",
  ].join("\n");
}

/** The bot's name when `text` is a kickoff message (`""` if it names none); undefined for every other message. */
export function botKickoffName(text: string): string | undefined {
  if (text !== BOT_KICKOFF_MARKER && !text.startsWith(`${BOT_KICKOFF_MARKER}\n`)) return undefined;
  return /^name: (.*)$/mu.exec(text)?.[1]?.trim() ?? "";
}

/* ── tools and skills ─────────────────────────────────────────────────── */

/* ── access requests ──────────────────────────────────────────────────── */

/** The two answers of an access request. */
export const BOT_ACCESS_ANSWERS = ["Allow", "Deny"] as const;

/** Whether a session question is a bot's access request, as `request_access` asks it. */
export function isBotAccessQuestion(question: { method: string; title?: string; options?: readonly string[] }): boolean {
  return question.method === "select" && (question.title ?? "").startsWith("Allow access to ")
    && question.options?.length === 2 && question.options[0] === BOT_ACCESS_ANSWERS[0] && question.options[1] === BOT_ACCESS_ANSWERS[1];
}

export const AGENT_TAG = /^\[from agent: ([^\]\n]*?)(?: · reply-to (agent:[A-Za-z0-9_-]{1,94}))?(?: · hop [1-9]\d*)?\] /u;

/** The gateway's return address in an agent's attribution header; never one embedded in a forwarded message. */
export function agentReplyTo(text: string | undefined): string | undefined {
  return AGENT_TAG.exec(text ?? "")?.[2];
}

/** How a session's tag starts in the bot's chat: a sanitized title, its return address and the chain's current hop. */
export function agentTagPrefix(title: string, sessionId: string, hop = 1): string {
  return `[from agent: ${previewLine(title.replace(/[[\]·]/gu, " "), 80) || "Untitled session"} · reply-to agent:${sessionId}${hop === 1 ? "" : ` · hop ${hop}`}] `;
}

/* ── look ─────────────────────────────────────────────────────────────── */

export function isBotFaceShape(value: unknown): value is BotFaceShape {
  return typeof value === "string" && (BOT_FACE_SHAPES as readonly string[]).includes(value);
}

/** A shape by its id or its label (`pebble` is `round`), any case; undefined for anything else. */
export function botFaceShape(value: string): BotFaceShape | undefined {
  const key = value.trim().toLowerCase();
  return BOT_FACE_SHAPES.find((shape) => shape === key || BOT_FACE_SHAPE_LABELS[shape].toLowerCase() === key);
}

export function isBotFaceEars(value: unknown): value is BotFaceEars {
  return typeof value === "string" && (BOT_FACE_EARS as readonly string[]).includes(value);
}

/** Ears by their id or their label (`cat ears` is `cat`), any case; undefined for anything else. */
export function botFaceEars(value: string): BotFaceEars | undefined {
  const key = value.trim().toLowerCase();
  return BOT_FACE_EARS.find((ears) => ears === key || BOT_FACE_EARS_LABELS[ears].toLowerCase() === key);
}

/** A palette color by its name (`mint`, any case) or hex; undefined for anything else. */
export function botFaceColor(value: string): BotFaceColor | undefined {
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

/** The handle a name suggests: ASCII-folded and lowercase, every other run as one dash, at most 32 characters. */
export function handleFromName(name: string): string {
  const slug = name.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+/u, "").slice(0, BOT_LIMITS.handle).replace(/-+$/u, "");
  return slug || "bot";
}

/** Where a bot works, as HUI shows it: `devbox:/srv/app` for a bot on a worker. */
export function botDisplayCwd(bot: Pick<BotView, "cwd" | "worker">): string {
  return bot.worker ? `${bot.worker.name}:${bot.cwd}` : bot.cwd;
}

/** One line: whitespace runs as single spaces, at most `max` characters (an ellipsis marks a cut). */
export function previewLine(text: string, max: number = BOT_LIMITS.preview): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
