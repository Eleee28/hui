/**
 * Character cards (Character Card V2 and V3, and the older V1 fields), as JSON or inside a PNG's `chara` (V2) or `ccv3`
 * (V3) text chunk, base64. The soul is the card's system prompt (its `{{original}}` slot dropped), then its description,
 * personality and scenario; `first_mes` is the opener, and the character book's enabled entries become memories.
 * `{{char}}` is the bot's name and `{{user}}` the operator's (Settings' profile name, else "the operator", or "you" in
 * the opener). Example messages, alternate greetings, post-history instructions, creator notes and the image stay out.
 */
import { BOT_LIMITS } from "../../bots-format.ts";
import type { BotTemplate } from "./formats.ts";
import { blankTemplate, isRecord, macros, oneLine, sections, str } from "./common.ts";
import { pngTextChunks } from "./png.ts";

/** The card's fields: V2/V3's `data`, or a V1 card's top level. */
function cardData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (/^chara_card_v[23]$/u.test(str(value["spec"])) && isRecord(value["data"])) return value["data"];
  if (typeof value["name"] === "string" && ["first_mes", "personality", "scenario", "mes_example", "char_persona", "char_greeting"].some((key) => typeof value[key] === "string")) return value;
  return undefined;
}

export function isCharacterCard(value: unknown): boolean {
  return cardData(value) !== undefined;
}

/** The card a PNG carries (V3's chunk first), parsed; undefined when it carries none. */
export function cardFromPng(data: Buffer): unknown {
  const chunks = pngTextChunks(data);
  for (const keyword of ["ccv3", "chara"]) {
    const encoded = chunks.get(keyword);
    if (!encoded) continue;
    try {
      return JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8")) as unknown;
    } catch {
      // A chunk that isn't base64 JSON; the other keyword may still hold the card.
    }
  }
  return undefined;
}

export function parseCharacterCard(value: unknown, origin?: string, options: { operator?: string } = {}): BotTemplate {
  const data = cardData(value) ?? {};
  const name = oneLine(str(data["name"]) || "Character", BOT_LIMITS.name);
  const template = blankTemplate("character-card", name, origin);
  const soulMacros = { char: name, user: options.operator || "the operator" };
  const system = str(data["system_prompt"]).replace(/\{\{\s*original\s*\}\}/giu, "").trim();
  template.soul = macros(sections([
    [undefined, system],
    ["Who I am", str(data["description"]) || str(data["char_persona"])],
    ["Personality", str(data["personality"])],
    ["Scenario", str(data["scenario"]) || str(data["world_scenario"])],
  ]), soulMacros);
  const opener = str(data["first_mes"]) || str(data["char_greeting"]);
  if (opener) template.opener = macros(opener, { char: name, user: options.operator || "you" });
  const nickname = str(data["nickname"]);
  if (nickname) template.title = oneLine(nickname, BOT_LIMITS.title);
  const creator = str(data["creator"]);
  if (creator) template.author = creator;
  const book = isRecord(data["character_book"]) && Array.isArray(data["character_book"]["entries"]) ? data["character_book"]["entries"] : [];
  let disabled = 0;
  for (const entry of book) {
    if (!isRecord(entry)) continue;
    const content = macros(str(entry["content"]), soulMacros);
    if (entry["enabled"] === false) {
      disabled += 1;
      continue;
    }
    if (!content) continue;
    const keys = Array.isArray(entry["keys"]) ? entry["keys"].map(str).filter(Boolean) : [];
    const label = str(entry["name"]) || str(entry["comment"]) || keys.slice(0, 3).join(", ");
    template.memories.push({ ...(label ? { name: oneLine(label, 80) } : {}), text: content });
  }
  if (disabled) template.dropped.push(`${disabled} disabled character book entr${disabled === 1 ? "y" : "ies"}.`);
  const left = [
    ["mes_example", "its example messages"],
    ["post_history_instructions", "its post-history instructions"],
    ["creator_notes", "its creator notes"],
  ].filter(([key]) => str(data[key!])).map(([, label]) => label!);
  const greetings = Array.isArray(data["alternate_greetings"]) ? data["alternate_greetings"].filter((greeting) => str(greeting)).length : 0;
  if (greetings) left.push(`${greetings} alternate greeting${greetings === 1 ? "" : "s"}`);
  if (left.length) template.dropped.push(`The card's ${left.join(", ")}: a HUI bot has no place for them.`);
  if (Array.isArray(data["assets"]) && data["assets"].length || origin?.toLowerCase().endsWith(".png")) template.dropped.push("Its picture: a HUI bot shows a face or an emoji.");
  return template;
}
