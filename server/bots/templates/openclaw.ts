/**
 * OpenClaw agent workspaces (a folder, or a zip of one). Its persona is SOUL.md; IDENTITY.md names it in
 * `- Name:` / `- Emoji:` / `- Avatar:` / `- Vibe:` / `- Creature:` lines (bold or not); its skills are `skills/<name>/SKILL.md`.
 *
 * What else maps: MEMORY.md (its curated memory) and USER.md (about its human) become memories, and HEARTBEAT.md's
 * checklist a routine every 30 minutes, as OpenClaw's heartbeat runs it. AGENTS.md is left out, and the preview says
 * why: it is OpenClaw's operating manual (memory files, heartbeats, group chats), which describes OpenClaw's runtime
 * rather than the bot, and HUI's own prompt covers how a bot works here. So are TOOLS.md (notes about that machine),
 * BOOTSTRAP.md (OpenClaw's first-run ritual; HUI's first conversation is skipped since the bot has a soul) and the
 * daily `memory/*.md` logs.
 */
import { BOT_LIMITS } from "../../bots-format.ts";
import type { BotTemplate } from "./formats.ts";
import { blankTemplate, displayName, fileText, findFile, oneEmoji, oneLine, skillFromFile, unwrapFolder, type ImportFile } from "./common.ts";

/** Whether files look like an OpenClaw workspace: SOUL.md or IDENTITY.md at its top. */
export function isOpenClawWorkspace(files: readonly ImportFile[]): boolean {
  const { files: inside } = unwrapFolder(files);
  return Boolean(findFile(inside, "SOUL.md") ?? findFile(inside, "IDENTITY.md"));
}

/** A value IDENTITY.md's template leaves for its owner to fill in: empty, or an italic hint in parentheses. */
function placeholder(value: string): boolean {
  const text = value.trim();
  return !text || /^[_*]*\(.*\)[_*]*$/u.test(text) || /^_[^_]*_$/u.test(text);
}

/**
 * IDENTITY.md's `- Key: value` lines (also `- **Key:** value` and `- **Key**: value`), keys lowercase. A value may sit on
 * the indented line below its key, as OpenClaw's template puts its hints; placeholders are left out.
 */
export function identityFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^\s*[-*+]\s+(?:\*\*|__)?([A-Za-z][A-Za-z ]{0,30}?)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase();
    let value = match[2]!.trim();
    const next = lines[index + 1] ?? "";
    if (!value && /^\s{2,}\S/u.test(next) && !/^\s*[-*+]\s/u.test(next)) value = next.trim();
    if (!fields.has(key) && !placeholder(value)) fields.set(key, value);
  }
  return fields;
}

/** Whether a file has more than headings, comments and placeholders: a template nobody filled in has not. */
function filledIn(text: string): boolean {
  return text.split("\n").some((line) => {
    const value = line.trim();
    if (!value || value.startsWith("#") || value.startsWith("<!--") || value === "---") return false;
    const field = /^[-*+]\s+(?:\*\*|__)?[^:]{1,40}:(?:\*\*|__)?\s*(.*)$/u.exec(value);
    return field ? !placeholder(field[1] ?? "") : !placeholder(value);
  });
}

/** MEMORY.md as memories: each `## section`, or the whole file when it has none. */
function memorySections(text: string): { name?: string; text: string }[] {
  const body = text.replace(/^#\s[^\n]*\n/u, "").trim();
  const parts = body.split(/^##\s+/mu);
  const memories: { name?: string; text: string }[] = [];
  const lead = parts.shift()?.trim();
  if (lead) memories.push({ text: lead });
  for (const part of parts) {
    const [heading, ...rest] = part.split("\n");
    const content = rest.join("\n").trim();
    if (content) memories.push({ name: heading!.trim(), text: content });
  }
  return memories;
}

export function parseOpenClawWorkspace(all: readonly ImportFile[], origin?: string): BotTemplate {
  const { files, folder } = unwrapFolder(all);
  const text = (path: string) => {
    const file = findFile(files, path);
    return file ? fileText(file) : undefined;
  };
  const identity = identityFields(text("IDENTITY.md") ?? "");
  const named = identity.get("name");
  const fallback = folder && !/^(workspace|agent|openclaw)$/iu.test(folder) ? displayName(folder) : "OpenClaw Bot";
  const template = blankTemplate("openclaw", oneLine(named ?? fallback, BOT_LIMITS.name), origin);
  template.soul = (text("SOUL.md") ?? "").trim();
  if (!template.soul) template.notes.push("The workspace has no SOUL.md: the bot starts with its first conversation and writes one.");
  const emoji = identity.get("emoji");
  if (emoji && oneEmoji(emoji)) template.emoji = oneEmoji(emoji)!;
  else if (emoji) template.dropped.push(`IDENTITY.md's emoji "${oneLine(emoji, 40)}": a HUI bot's emoji is one character.`);
  const creature = identity.get("creature") ?? identity.get("role");
  if (creature) template.title = oneLine(creature, BOT_LIMITS.title);
  const vibe = identity.get("vibe");
  if (vibe) template.description = oneLine(vibe, BOT_LIMITS.description);
  if (identity.get("avatar")) template.dropped.push(`IDENTITY.md's avatar (${oneLine(identity.get("avatar")!, 80)}): a HUI bot shows a face or an emoji.`);
  const memory = text("MEMORY.md");
  if (memory && filledIn(memory)) template.memories.push(...memorySections(memory));
  const user = text("USER.md");
  if (user && filledIn(user)) template.memories.push({ name: "About the operator (USER.md)", text: user.replace(/^#\s[^\n]*\n/u, "").trim() });
  const heartbeat = text("HEARTBEAT.md");
  const checklist = heartbeat?.split("\n").filter((line) => line.trim() && !/^#(?:\s|$)/u.test(line.trim())).join("\n").trim();
  if (checklist) template.routines.push({ name: "Heartbeat", prompt: checklist, schedule: "every 30m", description: "HEARTBEAT.md, which OpenClaw checks about every 30 minutes." });
  if (findFile(files, "AGENTS.md")) {
    template.dropped.push("AGENTS.md: OpenClaw's operating manual (memory files, heartbeats, group chats) describes OpenClaw's runtime, not the bot; HUI's own prompt covers how a bot works here. Copy any rule you want into the soul.");
  }
  if (findFile(files, "TOOLS.md")) template.dropped.push("TOOLS.md: notes about the machine that workspace ran on.");
  if (findFile(files, "BOOTSTRAP.md")) template.dropped.push("BOOTSTRAP.md: OpenClaw's first-run ritual; with a soul, the bot skips HUI's first conversation.");
  const daily = files.filter((file) => /^memory\/[^/]+\.md$/iu.test(file.path)).length;
  if (daily) template.dropped.push(`${daily} daily memory log${daily === 1 ? "" : "s"} (memory/*.md): HUI's memory is the bot's chat.`);
  const skillFolders = new Map<string, ImportFile[]>();
  for (const file of files) {
    const match = /^skills\/([^/]+)\/(.+)$/u.exec(file.path);
    if (!match) continue;
    const entries = skillFolders.get(match[1]!) ?? [];
    entries.push({ path: match[2]!, data: file.data });
    skillFolders.set(match[1]!, entries);
  }
  for (const [name, entries] of [...skillFolders].sort(([a], [b]) => a.localeCompare(b))) {
    const main = entries.find((entry) => entry.path === "SKILL.md");
    const body = main ? fileText(main) : undefined;
    if (body === undefined) {
      template.dropped.push(`skills/${name}: it has no SKILL.md.`);
      continue;
    }
    const skill = skillFromFile(body, name, template.dropped);
    if (skill) template.skills.push(skill);
    const others = entries.length - 1;
    if (others) template.dropped.push(`Skill ${skill?.name ?? name}: ${others} supporting file${others === 1 ? "" : "s"} beside its SKILL.md (HUI imports a skill's instructions only).`);
  }
  return template;
}
