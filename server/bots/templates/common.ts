/**
 * What every bot-template importer shares: the error a source that isn't one throws, the files of a folder or an
 * archive, text helpers, YAML through PI's front-matter parser (HUI adds no YAML dependency of its own) and SKILL.md
 * files. Importers are pure: they read what they are given and never touch the disk or the network.
 */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BOT_LIMITS } from "../../bots-format.ts";
import { BOT_TEMPLATE_LIMITS, type BotTemplate, type BotTemplateFormat, type BotTemplateSkill } from "./formats.ts";
import { isOneGrapheme } from "../bots.ts";
import { safeRelativePath } from "./zip.ts";

/** The source is not a template HUI reads, or it is broken: the routes answer 400 with the message. */
export class TemplateFormatError extends Error {
  override name = "TemplateFormatError";
}

/** One file of a folder or an archive, by its path inside it. */
export type ImportFile = { path: string; data: Buffer };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string field, trimmed; "" for anything else. */
export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Text with Windows and old Mac line ends as `\n`, without a byte-order mark. */
export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A file's text, or undefined for one that isn't text (a NUL byte, or not UTF-8). */
export function fileText(file: Pick<ImportFile, "data">): string | undefined {
  if (file.data.includes(0)) return undefined;
  try {
    return normalizeText(UTF8.decode(file.data));
  } catch {
    return undefined;
  }
}

/** One line: whitespace runs as single spaces, at most `max` characters (an ellipsis marks a cut). */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** `code-reviewer` and `data_researcher` as `Code Reviewer` and `Data Researcher`; other names as they are. */
export function displayName(raw: string): string {
  const name = raw.trim();
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(name)) return oneLine(name, BOT_LIMITS.name);
  return oneLine(name.split(/[-_]/u).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "), BOT_LIMITS.name);
}

/** One emoji, or undefined. */
export function oneEmoji(value: unknown): string | undefined {
  const emoji = str(value);
  return emoji && isOneGrapheme(emoji) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji) ? emoji : undefined;
}

/** A template with nothing but its format and name; importers fill in the rest. */
export function blankTemplate(format: BotTemplateFormat, name: string, origin?: string): BotTemplate {
  return { format, ...(origin ? { origin } : {}), name, soul: "", memories: [], skills: [], routines: [], integrations: [], dropped: [], notes: [] };
}

/** Markdown sections, each a `## heading` and its text, of the parts that have text. */
export function sections(parts: readonly (readonly [heading: string | undefined, text: string])[]): string {
  return parts.filter(([, text]) => text.trim()).map(([heading, text]) => heading ? `## ${heading}\n\n${text.trim()}` : text.trim()).join("\n\n");
}

/**
 * A YAML document as a value, through PI's front-matter parser (the `yaml` package PI already ships): its first
 * document only. Throws `TemplateFormatError` with the parser's reason.
 */
export function parseYaml(text: string, what: string): unknown {
  const body = normalizeText(text).replace(/^---[ \t]*\n/u, "");
  const end = /^(?:---|\.\.\.)[ \t]*$/mu.exec(body);
  const document = end ? body.slice(0, end.index) : body;
  try {
    return parseFrontmatter(`---\n${document}\n---\n`).frontmatter;
  } catch (error) {
    throw new TemplateFormatError(`${what} is not valid YAML: ${error instanceof Error ? oneLine(error.message, 200) : "it could not be read"}.`);
  }
}

/** Front matter and body of a Markdown file; empty front matter when it has none or it doesn't parse. */
export function frontMatter(text: string): { data: Record<string, unknown>; body: string; valid: boolean } {
  const normalized = normalizeText(text);
  if (!normalized.startsWith("---")) return { data: {}, body: normalized.trim(), valid: false };
  try {
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(normalized);
    return { data: isRecord(frontmatter) ? frontmatter : {}, body: body.trim(), valid: true };
  } catch {
    return { data: {}, body: normalized.trim(), valid: false };
  }
}

/** A skill's name as PI's loader wants it: lowercase letters, digits and single inner hyphens, at most 64 characters. */
export function skillName(raw: string): string {
  const slug = raw.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64).replace(/-+$/u, "");
  return slug || "skill";
}

/** A skill from its parts: its description one line (PI needs one), its instructions within the limit. */
export function templateSkill(name: string, description: string, content: string, dropped: string[]): BotTemplateSkill | undefined {
  const body = content.trim();
  const about = oneLine(description, 1_024) || oneLine(body.split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? "", 300) || `The ${name} skill.`;
  if (!body && !description.trim()) {
    dropped.push(`Skill ${name}: it has no instructions.`);
    return undefined;
  }
  if (body.length > BOT_TEMPLATE_LIMITS.skill) {
    dropped.push(`Skill ${name}: its instructions have ${body.length.toLocaleString("en-US")} characters; HUI takes at most ${BOT_TEMPLATE_LIMITS.skill.toLocaleString("en-US")}.`);
    return undefined;
  }
  return { name: name.trim() || "skill", description: about, content: body || about };
}

/** A SKILL.md's skill: its front matter's name (else `fallbackName`) and description, its body as the instructions. */
export function skillFromFile(text: string, fallbackName: string, dropped: string[]): BotTemplateSkill | undefined {
  const { data, body } = frontMatter(text);
  return templateSkill(str(data["name"]) || fallbackName, str(data["description"]), body, dropped);
}

/**
 * A SKILL.md as HUI writes it into a bot's own skills folder: front matter with its name and description (JSON-quoted,
 * which YAML reads as written), then its instructions.
 */
export function skillFileText(skill: Pick<BotTemplateSkill, "name" | "description" | "content">): string {
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(oneLine(skill.description, 1_024))}\n---\n\n${skill.content.trim()}\n`;
}

/** A file's path inside its skill's folder, or undefined: relative, inside it, no hidden part, and not SKILL.md itself in
 * any case (a case-insensitive disk would write it over the skill's instructions). */
export function skillFilePath(raw: string): string | undefined {
  const path = safeRelativePath(raw);
  if (!path || path.toLowerCase() === "skill.md" || path.split("/").some((part) => part.startsWith("."))) return undefined;
  return path;
}

/** The first path that differs from an earlier one only by case: one would overwrite the other on a case-insensitive disk. */
export function caseClash(paths: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path.toLowerCase())) return path;
    seen.add(path.toLowerCase());
  }
  return undefined;
}

/** Files under one folder, by their path below it. */
export function within(files: readonly ImportFile[], folder: string): ImportFile[] {
  const prefix = `${folder}/`;
  return files.filter((file) => file.path.startsWith(prefix)).map((file) => ({ path: file.path.slice(prefix.length), data: file.data }));
}

/** When every file lies in one top folder (a zipped folder), the files below it and the folder's name. */
export function unwrapFolder(files: readonly ImportFile[]): { files: ImportFile[]; folder?: string } {
  const tops = new Set(files.map((file) => file.path.split("/")[0]));
  if (tops.size !== 1 || files.some((file) => !file.path.includes("/"))) return { files: [...files] };
  const folder = [...tops][0]!;
  return { files: within(files, folder), folder };
}

/** A file by its path, any case. */
export function findFile(files: readonly ImportFile[], path: string): ImportFile | undefined {
  return files.find((file) => file.path === path) ?? files.find((file) => file.path.toLowerCase() === path.toLowerCase());
}

/** Replaces character cards' and other templates' `{{char}}` and `{{user}}`, any case and spacing. */
export function macros(text: string, values: { char: string; user: string }): string {
  return text.replace(/\{\{\s*char\s*\}\}|<BOT>/giu, values.char).replace(/\{\{\s*user\s*\}\}|<USER>/giu, values.user);
}
