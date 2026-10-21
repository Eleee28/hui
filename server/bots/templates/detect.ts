/**
 * Which importer reads a source, and every bot it holds. A file is looked at by its content first (a zip, a PNG, JSON,
 * front matter, YAML), its name second; a folder (or a zip, unpacked) by the files at its top. Text that is no format
 * HUI knows becomes a plain persona. A source that holds no bot throws `TemplateFormatError`, naming what HUI reads.
 */
import { BOT_TEMPLATE_FORMATS, BOT_TEMPLATE_LIMITS, type BotTemplate } from "./formats.ts";
import { cardFromPng, isCharacterCard, parseCharacterCard } from "./character-card.ts";
import { isClaudeCodeAgent, parseClaudeCodeAgent } from "./claude-code.ts";
import { fileText, findFile, frontMatter, normalizeText, TemplateFormatError, unwrapFolder, type ImportFile } from "./common.ts";
import { isCrewAiAgents, parseCrewAiAgents } from "./crewai.ts";
import { isNextFlightPage, parseGrokBotPage } from "./grok.ts";
import { isHuiExport, isHuiManifest, parseHuiExport } from "./hui-export.ts";
import { isLettaAgentFile, parseLettaAgentFile } from "./letta.ts";
import { isOpenClawWorkspace, parseOpenClawWorkspace } from "./openclaw.ts";
import { isPng } from "./png.ts";
import { parseTextTemplate } from "./text.ts";
import { isZip, readZip, ZipError } from "./zip.ts";

/** One bot of a source; a file with several agents has one per agent, each keyed for the preview's choice. */
export type TemplateChoice = { key: string; template: BotTemplate };

export type ReadOptions = {
  /** Settings' profile name, which a character card's `{{user}}` becomes. */
  operator?: string;
};

const MAX_CANDIDATES = 50;
const KNOWN = Object.values(BOT_TEMPLATE_FORMATS).filter((label) => label !== BOT_TEMPLATE_FORMATS.text).join(", ");

const one = (template: BotTemplate): TemplateChoice[] => [{ key: "0", template }];

/** A source that holds no bot. */
function nothing(what: string): TemplateFormatError {
  return new TemplateFormatError(`HUI found no bot to import in ${what}. It reads: ${KNOWN}, or a persona as plain text.`);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The bots a parsed JSON value holds. */
function fromJson(value: unknown, origin: string | undefined, options: ReadOptions): TemplateChoice[] | undefined {
  if (isHuiManifest(value)) return one(parseHuiExport([], origin, value));
  if (isLettaAgentFile(value)) return parseLettaAgentFile(value, origin);
  if (isCharacterCard(value)) return one(parseCharacterCard(value, origin, options));
  return undefined;
}

/** Whether text reads as a YAML mapping (its first meaningful line a `key:`). */
function looksLikeYaml(text: string): boolean {
  const first = text.split("\n").find((line) => line.trim() && !line.trim().startsWith("#"));
  return first !== undefined && /^[A-Za-z0-9_-]+:\s*(?:#.*)?$/u.test(first.trimEnd());
}

/** The bots in text: a page, JSON, a subagent, an agents.yaml, else a persona. */
export function readTextTemplates(raw: string, origin: string | undefined, options: ReadOptions = {}): TemplateChoice[] {
  const text = normalizeText(raw);
  const trimmed = text.trim();
  if (!trimmed) throw new TemplateFormatError("There is nothing to import: the text is empty.");
  if (trimmed.length > BOT_TEMPLATE_LIMITS.text) throw new TemplateFormatError(`This text has ${trimmed.length.toLocaleString("en-US")} characters; HUI imports at most ${BOT_TEMPLATE_LIMITS.text.toLocaleString("en-US")}.`);
  if (trimmed.startsWith("<") && isNextFlightPage(trimmed)) return one(parseGrokBotPage(trimmed, origin));
  if (/^[[{]/u.test(trimmed)) {
    const value = json(trimmed);
    if (value !== undefined) {
      const found = fromJson(value, origin, options);
      if (found?.length) return found.slice(0, MAX_CANDIDATES);
      throw nothing("this JSON");
    }
  }
  if (trimmed.startsWith("---")) {
    if (isClaudeCodeAgent(trimmed)) return one(parseClaudeCodeAgent(trimmed, origin));
    const yaml = frontMatter(trimmed);
    if (!yaml.body && isCrewAiAgents(trimmed)) return parseCrewAiAgents(trimmed, origin).slice(0, MAX_CANDIDATES);
  }
  if ((/\.ya?ml$/iu.test(origin ?? "") || looksLikeYaml(trimmed)) && isCrewAiAgents(trimmed)) return parseCrewAiAgents(trimmed, origin).slice(0, MAX_CANDIDATES);
  if (/\.ya?ml$/iu.test(origin ?? "")) throw nothing("this YAML file");
  return one(parseTextTemplate(trimmed, origin));
}

/** One file's bots: an archive (unpacked as a folder), a PNG card, else its text. */
function readFile(file: ImportFile, options: ReadOptions): TemplateChoice[] {
  if (file.data.length > BOT_TEMPLATE_LIMITS.fileBytes) throw new TemplateFormatError(`${file.path} is larger than ${BOT_TEMPLATE_LIMITS.fileBytes / 1024 / 1024} MB.`);
  if (isZip(file.data) || /\.zip$/iu.test(file.path)) {
    let entries: ImportFile[];
    try {
      entries = readZip(file.data, { files: BOT_TEMPLATE_LIMITS.files, totalBytes: BOT_TEMPLATE_LIMITS.totalBytes });
    } catch (error) {
      throw error instanceof ZipError ? new TemplateFormatError(error.message) : error;
    }
    if (!entries.length) throw new TemplateFormatError(`${file.path} is an empty archive.`);
    return readFolderTemplates(entries, options, file.path);
  }
  if (isPng(file.data)) {
    const card = cardFromPng(file.data);
    if (!isCharacterCard(card)) throw new TemplateFormatError(`${file.path} is an image without a character card in it.`);
    return one(parseCharacterCard(card, file.path, options));
  }
  const text = fileText(file);
  if (text === undefined) throw new TemplateFormatError(`${file.path} is neither text nor a format HUI reads (zip, PNG card).`);
  if (/(^|\/)SOUL\.md$/u.test(file.path)) return one(parseOpenClawWorkspace([file], file.path));
  return readTextTemplates(text, file.path, options);
}

/** A folder's bots (or an unpacked archive's), by the files at its top. */
export function readFolderTemplates(all: readonly ImportFile[], options: ReadOptions = {}, origin?: string): TemplateChoice[] {
  if (!all.length) throw new TemplateFormatError("There is nothing to import: the folder is empty.");
  if (all.length > BOT_TEMPLATE_LIMITS.files) throw new TemplateFormatError(`This folder holds ${all.length} files; HUI imports at most ${BOT_TEMPLATE_LIMITS.files}.`);
  const total = all.reduce((sum, file) => sum + file.data.length, 0);
  if (total > BOT_TEMPLATE_LIMITS.totalBytes) throw new TemplateFormatError(`This folder holds more than ${BOT_TEMPLATE_LIMITS.totalBytes / 1024 / 1024} MB.`);
  const { files } = unwrapFolder(all);
  if (isHuiExport(files)) return one(parseHuiExport(files, origin));
  if (isOpenClawWorkspace(files)) return one(parseOpenClawWorkspace(files, origin));
  const agents = files.filter((file) => /(^|\/)\.claude\/agents\/[^/]+\.md$|^agents\/[^/]+\.md$/u.test(file.path)).flatMap((file) => {
    const text = fileText(file);
    return text !== undefined && isClaudeCodeAgent(text) ? [{ key: file.path, template: parseClaudeCodeAgent(text, file.path) }] : [];
  });
  if (agents.length) return agents.slice(0, MAX_CANDIDATES);
  const crew = [...files].filter((file) => /(^|\/)agents\.ya?ml$/iu.test(file.path)).sort((a, b) => a.path.length - b.path.length)[0];
  const crewText = crew ? fileText(crew) : undefined;
  if (crew && crewText !== undefined && isCrewAiAgents(crewText)) return parseCrewAiAgents(crewText, crew.path).slice(0, MAX_CANDIDATES);
  if (files.length === 1) return readFile(files[0]!, options);
  const single = findFile(files, "agent.af") ?? files.find((file) => /\.af$/iu.test(file.path));
  if (single) return readFile(single, options);
  throw nothing(origin ? origin.split("/").pop()! : "this folder");
}

/** The bots of one picked file, by its name and bytes. */
export function readFileTemplates(name: string, data: Buffer, options: ReadOptions = {}): TemplateChoice[] {
  return readFile({ path: name, data }, options);
}
