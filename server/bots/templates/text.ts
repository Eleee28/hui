/**
 * Text that is no other format: a persona as it was pasted (a Grok Bot's instructions copied from its page, a prompt
 * from anywhere). It all becomes the soul; a short first heading names the bot.
 */
import { BOT_LIMITS } from "../../bots-format.ts";
import type { BotTemplate } from "./formats.ts";
import { blankTemplate, displayName, normalizeText, oneLine } from "./common.ts";

export function parseTextTemplate(raw: string, origin?: string): BotTemplate {
  const text = normalizeText(raw).trim();
  const heading = /^#\s+(.+)$/mu.exec(text.split("\n").find((line) => line.trim()) ?? "")?.[1]?.replace(/[*_`]/gu, "").trim();
  const file = origin && !/^https?:/u.test(origin) ? origin.split("/").pop()?.replace(/\.[^.]+$/u, "") : undefined;
  const name = heading && heading.length <= BOT_LIMITS.name && !/\.md\b/iu.test(heading) ? heading : file && !/^(soul|prompt|instructions|readme)$/iu.test(file) ? displayName(file) : "Imported Bot";
  const template = blankTemplate("text", oneLine(name, BOT_LIMITS.name), origin);
  template.soul = text;
  return template;
}
