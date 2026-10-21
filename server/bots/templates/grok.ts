/**
 * Grok Bot marketplace pages (`https://x.ai/bot/marketplace/bots/<slug>`). The page is a Next.js app: the bot arrives in
 * the React Server Components payload it pushes in `self.__next_f.push([1, "…"])` chunks, as an object with its name,
 * creator, description and instructions, its memories (`{ name, description }`), skills (`{ name, description, content }`),
 * routines (`{ name, summary }`) and integrations (`{ name, description }`), and a color and shape. Long texts may sit in
 * rows of their own that the object names (`"$1f"`); they are resolved. Many marketplace bots leave their instructions
 * empty and keep their job in their memories; that is still a bot. x.ai can change that page at any time, so this is
 * best effort: a page where no bot is found is a clear error that suggests pasting the instructions instead.
 */
import { BOT_FACE_COLORS, BOT_FACE_SHAPES, BOT_LIMITS, type BotFaceShape } from "../../bots-format.ts";
import type { BotTemplate, BotTemplateRoutine } from "./formats.ts";
import { blankTemplate, displayName, isRecord, oneEmoji, oneLine, str, templateSkill, TemplateFormatError } from "./common.ts";

/** A marketplace bot's link: x.ai (or www.x.ai) over https, the slug, nothing else. */
export const GROK_BOT_URL = /^https:\/\/(?:www\.)?x\.ai\/bot\/marketplace\/bots\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/?(?:[?#]\S*)?$/u;

/** The canonical page of a marketplace link, or undefined for any other link. */
export function grokBotUrl(raw: string): string | undefined {
  const match = GROK_BOT_URL.exec(raw.trim());
  return match ? `https://x.ai/bot/marketplace/bots/${match[1]}` : undefined;
}

export const GROK_PASTE_HINT = "Open the bot's page, copy its instructions and paste them instead.";

const PUSH = /self\.__next_f\.push\(\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/gu;
/** Objects the search looks at before it gives up, and how deep it follows references. */
const MAX_NODES = 250_000;
const MAX_DEPTH = 24;

/** Whether text is a page of a Next.js app that pushes a server-components payload, as Grok Bot pages do. */
export function isNextFlightPage(text: string): boolean {
  return text.includes("self.__next_f.push");
}

/** The page's server-components payload: every pushed string, in order. */
export function flightPayload(html: string): string {
  let payload = "";
  for (const match of html.matchAll(PUSH)) {
    try {
      payload += JSON.parse(match[1]!) as string;
    } catch {
      // A chunk that isn't a JSON string carries nothing readable.
    }
  }
  return payload;
}

type Rows = { json: Map<string, string>; text: Map<string, string> };

/**
 * The payload's rows: `id:<json>` lines, and text rows `id:T<hex length>,<text>`, whose length is in bytes and whose
 * text may hold line breaks. Rows of other kinds (module references, hints, errors) are kept as text nobody parses.
 */
export function flightRows(payload: string): Rows {
  const data = Buffer.from(payload, "utf8");
  const rows: Rows = { json: new Map(), text: new Map() };
  let at = 0;
  while (at < data.length) {
    while (data[at] === 0x0a) at += 1;
    const colon = data.indexOf(0x3a, at);
    if (colon === -1) break;
    const id = data.subarray(at, colon).toString("latin1");
    if (!/^[0-9a-f]{1,8}$/u.test(id)) {
      const next = data.indexOf(0x0a, at);
      if (next === -1) break;
      at = next + 1;
      continue;
    }
    if (data[colon + 1] === 0x54) {
      const comma = data.indexOf(0x2c, colon + 2);
      const hex = comma === -1 ? "" : data.subarray(colon + 2, comma).toString("latin1");
      if (/^[0-9a-f]{1,8}$/u.test(hex)) {
        const size = Number.parseInt(hex, 16);
        rows.text.set(id, data.subarray(comma + 1, comma + 1 + size).toString("utf8"));
        at = comma + 1 + size;
        continue;
      }
    }
    const end = data.indexOf(0x0a, colon + 1);
    const stop = end === -1 ? data.length : end;
    rows.json.set(id, data.subarray(colon + 1, stop).toString("utf8"));
    at = stop + 1;
  }
  return rows;
}

function parsed(raw: string | undefined): unknown {
  if (raw === undefined || !/^[[{"\d-]/u.test(raw)) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A value with the payload's references (`"$1f"`) replaced by what they name; `"$$…"` is a literal dollar. */
function resolved(value: unknown, rows: Rows, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    if (value.startsWith("$$")) return value.slice(1);
    const reference = /^\$([0-9a-f]{1,8})$/u.exec(value)?.[1];
    if (reference === undefined) return value;
    const text = rows.text.get(reference);
    if (text !== undefined) return text;
    const json = parsed(rows.json.get(reference));
    return json === undefined ? value : resolved(json, rows, depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => resolved(item, rows, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolved(item, rows, depth + 1)]));
  return value;
}

/** How much an object looks like a marketplace bot. */
function score(value: Record<string, unknown>): number {
  if (!("instructions" in value)) return 0;
  return 3 + ["memories", "skills", "routines", "integrations", "name", "author", "description"].filter((key) => key in value).length;
}

/** The object of the payload that looks most like a bot, or undefined. */
function findBot(rows: Rows): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestScore = 0;
  let nodes = 0;
  for (const raw of rows.json.values()) {
    const stack: unknown[] = [parsed(raw)];
    while (stack.length && nodes < MAX_NODES) {
      const value = stack.pop();
      nodes += 1;
      if (Array.isArray(value)) stack.push(...value);
      else if (isRecord(value)) {
        const points = score(value);
        if (points > bestScore) {
          best = value;
          bestScore = points;
        }
        stack.push(...Object.values(value));
      }
    }
  }
  return best;
}

/** The end of the JSON object that starts at `start`, strings and escapes respected; -1 when it doesn't close. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === "\\") at += 1;
      else if (char === "\"") quoted = false;
    } else if (char === "\"") quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return at;
  }
  return -1;
}

/** When no row parses as JSON (the payload split it some other way): the object around an `"instructions"` key. */
function scanForBot(payload: string): Record<string, unknown> | undefined {
  for (let key = payload.indexOf("\"instructions\""); key !== -1; key = payload.indexOf("\"instructions\"", key + 1)) {
    let tries = 0;
    for (let start = payload.lastIndexOf("{", key); start !== -1 && tries < 50; start = payload.lastIndexOf("{", start - 1), tries += 1) {
      const end = objectEnd(payload, start);
      if (end < key) continue;
      try {
        const value = JSON.parse(payload.slice(start, end + 1)) as unknown;
        if (isRecord(value) && "instructions" in value) return value;
        // An outer object parsed: the bot's own did not, so this occurrence holds none.
        break;
      } catch {
        // Not an object boundary; look further out.
      }
    }
  }
  return undefined;
}

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Grok Bot's colors and shapes as a HUI face's, where one is close. */
const COLORS: Readonly<Record<string, string>> = { blue: "blue", sky: "blue", yellow: "yellow", amber: "yellow", pink: "magenta", magenta: "magenta", green: "mint", mint: "mint", teal: "mint", orange: "coral", red: "coral", coral: "coral", purple: "lilac", violet: "lilac", lilac: "lilac" };
const SHAPES: Readonly<Record<string, BotFaceShape>> = { ...Object.fromEntries(BOT_FACE_SHAPES.map((shape) => [shape, shape])), circle: "round" };

/** A routine's schedule as text, whatever shape the page gives it. */
function scheduleText(routine: Record<string, unknown>): string | undefined {
  for (const key of ["schedule", "cron", "cronExpression", "frequency", "recurrence", "interval", "when"]) {
    const value = routine[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (isRecord(value)) {
      const cron = str(value["cron"]) || str(value["expression"]);
      const zone = str(value["timezone"]) || str(value["timeZone"]) || str(value["tz"]);
      if (cron) return `cron ${cron}${zone ? ` ${zone}` : ""}`;
      const parts = [str(value["frequency"]) || str(value["type"]) || str(value["kind"]), str(value["days"]) || list(value["days"]).map(str).filter(Boolean).join(" and "), str(value["time"]) && `at ${str(value["time"])}`];
      const text = parts.filter(Boolean).join(" ");
      if (text) return `${text}${zone ? ` ${zone}` : ""}`;
    }
  }
  return undefined;
}

/** The template a marketplace bot's object describes. */
export function grokTemplate(bot: Record<string, unknown>, origin?: string): BotTemplate {
  const slug = origin ? /\/bots\/([^/?#]+)/u.exec(origin)?.[1] : undefined;
  const name = str(bot["name"]) || str(bot["title"]) || str(bot["displayName"]) || (slug ? displayName(slug) : "Grok Bot");
  const template = blankTemplate("grok", oneLine(name, BOT_LIMITS.name), origin);
  const author = bot["author"] ?? bot["creatorName"] ?? bot["creator"] ?? bot["owner"];
  const authorName = typeof author === "string" ? author.trim() : isRecord(author) ? str(author["name"]) || str(author["displayName"]) || str(author["username"]) || str(author["handle"]) : "";
  if (authorName) template.author = authorName;
  const description = str(bot["description"]) || str(bot["summary"]) || str(bot["tagline"]) || str(bot["shortDescription"]);
  if (description) template.description = description;
  const color = BOT_FACE_COLORS.find((entry) => entry.id === COLORS[str(bot["color"]).toLowerCase()])?.hex;
  const shape = SHAPES[str(bot["shape"]).toLowerCase()];
  if (color || shape) template.avatar = { ...(shape ? { shape } : {}), ...(color ? { color } : {}) };
  template.soul = str(bot["instructions"]);
  const emoji = oneEmoji(bot["emoji"]) ?? oneEmoji(bot["icon"]);
  if (emoji) template.emoji = emoji;
  else if (str(bot["avatar"]) || str(bot["avatarUrl"]) || str(bot["image"]) || str(bot["imageUrl"])) template.dropped.push("Its picture: a HUI bot shows a face or an emoji.");
  const opener = str(bot["greeting"]) || str(bot["welcomeMessage"]) || str(bot["firstMessage"]) || str(bot["openingMessage"]);
  if (opener) template.opener = opener;
  const model = str(bot["model"]) || str(bot["modelId"]);
  if (model) template.model = model;
  for (const memory of list(bot["memories"])) {
    if (typeof memory === "string" && memory.trim()) template.memories.push({ text: memory.trim() });
    else if (isRecord(memory)) {
      const text = str(memory["description"]) || str(memory["content"]) || str(memory["text"]) || str(memory["value"]);
      const title = str(memory["name"]) || str(memory["title"]);
      if (text || title) template.memories.push({ ...(title && text ? { name: title } : {}), text: text || title });
    }
  }
  for (const skill of list(bot["skills"])) {
    if (!isRecord(skill)) continue;
    const parsedSkill = templateSkill(str(skill["name"]) || str(skill["title"]) || "skill", str(skill["description"]), str(skill["content"]) || str(skill["instructions"]) || str(skill["prompt"]), template.dropped);
    if (parsedSkill) template.skills.push(parsedSkill);
  }
  for (const routine of list(bot["routines"])) {
    if (!isRecord(routine)) continue;
    const prompt = str(routine["prompt"]) || str(routine["instructions"]) || str(routine["content"]) || str(routine["task"]) || str(routine["description"]) || str(routine["summary"]);
    const routineName = str(routine["name"]) || str(routine["title"]) || oneLine(prompt, 60) || "Routine";
    if (!prompt) {
      template.dropped.push(`Routine ${routineName}: it has no prompt.`);
      continue;
    }
    const schedule = scheduleText(routine);
    const description = str(routine["description"]) || str(routine["summary"]);
    const entry: BotTemplateRoutine = { name: routineName, prompt, ...(schedule ? { schedule } : {}), ...(description && description !== prompt ? { description } : {}) };
    template.routines.push(entry);
  }
  for (const integration of list(bot["integrations"])) {
    if (typeof integration === "string" && integration.trim()) template.integrations.push({ name: integration.trim() });
    else if (isRecord(integration)) {
      const integrationName = str(integration["name"]) || str(integration["title"]) || str(integration["id"]);
      const about = str(integration["description"]);
      if (integrationName) template.integrations.push({ name: integrationName, ...(about ? { description: about } : {}) });
    }
  }
  const starters = [...list(bot["conversationStarters"]), ...list(bot["starters"]), ...list(bot["suggestedPrompts"])].length;
  if (starters) template.dropped.push(`${starters} conversation starter${starters === 1 ? "" : "s"}: a HUI bot's chat has none.`);
  return template;
}

/** A marketplace page's bot. Throws `TemplateFormatError`, suggesting a paste, when the page holds none HUI can read. */
export function parseGrokBotPage(html: string, origin?: string): BotTemplate {
  const payload = flightPayload(html);
  if (!payload) throw new TemplateFormatError(`This page carries no Grok Bot data HUI can read: x.ai may have changed it. ${GROK_PASTE_HINT}`);
  const rows = flightRows(payload);
  const found = findBot(rows) ?? scanForBot(payload);
  const bot = found ? resolved(found, rows) : undefined;
  // Instructions may be empty (the job then lives in its memories); a bot with nothing at all is no bot.
  const content = isRecord(bot) && (str(bot["instructions"]) || list(bot["memories"]).length || list(bot["skills"]).length || str(bot["description"]));
  if (!isRecord(bot) || !content) {
    throw new TemplateFormatError(`HUI could not find the bot's instructions on this Grok Bot page: x.ai may have changed it. ${GROK_PASTE_HINT}`);
  }
  return grokTemplate(bot, origin);
}
