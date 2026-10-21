/**
 * A bot's export as a template someone else imports (HUI-18; SPEC.md, "Bot exports are templates, reviewed for
 * personal information"): `bot.json` version 2 (`BotExportManifest`), the review the gateway answers before a download
 * (`BotExportReview`: the bot's parts after its automatic cleanup and what the utility model would change in them), and
 * `buildExport`, which turns a review and the operator's picks into the files the zip holds. Pure; the gateway and
 * the CLI use it, and the browser's copy (`src/lib/bots/export-preview.ts`) makes the dialog show exactly the files the
 * gateway then saves. See docs/api.md#importing-and-exporting-bots.
 */
import { handleFromName, type BotTagging, type BotVoice } from "../bots-format.ts";
import type {
  BotExportAddition, BotExportAvatar, BotExportChange, BotExportGroup, BotExportPart, BotExportReview, BotExportSchedule, BotOpenPoint, BotTemplateTrigger,
} from "../api/bot-templates.ts";

export type {
  BotExportAddition, BotExportChange, BotExportCleanup, BotExportField, BotExportFileChange, BotExportGroup, BotExportMeta, BotExportPart, BotExportReview,
  BotExportSchedule, BotOpenPoint, BotTemplateTrigger,
} from "../api/bot-templates.ts";

export const BOT_EXPORT_FORMAT = "hui-bot";
/** 2: a template, reviewed for personal information. A version 1 export (an exact copy, memory included) still imports. */
export const BOT_EXPORT_VERSION = 2;
/** The zip's files: `bot.json`, `SOUL.md`, each own skill's folder under `skills/`; `memory.md` only in version 1. */
export const BOT_EXPORT_FILES = { manifest: "bot.json", soul: "SOUL.md", memory: "memory.md", skills: "skills" } as const;

/** `bot.json`, version 2: what of a bot travels once its review is done. No handle, path, date or memory. */
export type BotExportManifest = {
  format: typeof BOT_EXPORT_FORMAT;
  version: typeof BOT_EXPORT_VERSION;
  bot: {
    name: string;
    title?: string;
    description?: string;
    avatar?: BotExportAvatar;
    /** Bare model ids: the provider stays behind. */
    model?: string;
    thinking?: string;
    memoryModel?: string;
    memoryThinking?: string;
    voice?: BotVoice;
    /** Who may tag it, when not anyone: a policy, it travels as it is. */
    tagging?: Exclude<BotTagging, "anyone">;
  };
  routines: { name: string; description?: string; prompt: string; schedule: BotExportSchedule }[];
  triggers: BotTemplateTrigger[];
  /** Built-in tools it turned off. */
  disabledTools: string[];
  /** Its own skills it turned off, by name. */
  disabledSkills: string[];
  /** Its own skills: each `skills/<name>/` with SKILL.md and the files beside it. */
  skills: string[];
  open: BotOpenPoint[];
  /** What it needs to work, one line each. */
  needs: string[];
};

/* ── the review ───────────────────────────────────────────────────────── */

/** keep: travels as written; remove: never leaves; ask: the new owner gives theirs; confirm: they agree to it first. */
export const BOT_EXPORT_GROUPS = ["keep", "remove", "ask", "confirm"] as const;

/** What a change in this part can become. The profile (the bot's name and title) is set before its first chat, so it
 * can't hold a blank or a point to agree. */
export function changeGroups(part: string): readonly BotExportGroup[] {
  return part === "profile" ? ["keep", "remove"] : BOT_EXPORT_GROUPS;
}

/** What `buildExport` makes: the bot's final name, the zip's file name, its files in order, its open points, and what each
 * change picked comes to in them (what a passage becomes, what it asks), for the dialog to say. */
export type BotExportBuild = {
  name: string;
  fileName: string;
  files: { path: string; text: string }[];
  open: BotOpenPoint[];
  outcomes: Record<string, { replacement?: string; question?: string }>;
};

/** The mark an asked passage becomes. */
export const askMark = (label: string): string => `[ask: ${label}]`;

/** What a change asks the new owner in the group picked: the reviewer's question in its own group, else one that fits,
 * from its label and its excerpt as they travel (an asked passage is never quoted: it is the owner's). */
export function changeQuestion(change: Pick<BotExportChange, "group" | "question">, picked: "ask" | "confirm", words: { label: string; excerpt: string }): string {
  if (picked === change.group && change.question) return change.question;
  return picked === "ask" ? `What should stand for ${askMark(words.label)}?` : `Keep this as it is: “${words.excerpt}”?`;
}

/**
 * An operator's addition as one more change of the review, or why it can't be one: its passage must stand, four
 * characters or more, in a part's text as the review holds it (spacing as copied is forgiven), in a part that takes its
 * group, and not be a change already. The dialog and the gateway make it alike, so what the dialog shows is the zip.
 */
export function additionChange(review: BotExportReview, addition: BotExportAddition, id: string): BotExportChange | string {
  const typed = addition.quote.trim();
  if (typed.replace(/\s+/gu, "").length < 4) return "Copy a passage of four characters or more.";
  const pattern = new RegExp(escape(typed).replace(/\s+/gu, "\\s+"), "u");
  let quote: string | undefined;
  let home: BotExportPart | undefined;
  for (const part of review.parts.filter((each) => each.kind === "text")) {
    const found = part.fields.map((field) => field.text.match(pattern)?.[0]).find(Boolean);
    if (!found) continue;
    quote ??= found;
    if (changeGroups(part.id).includes(addition.group)) {
      home = part;
      quote = found;
      break;
    }
  }
  if (!quote) return "It isn't in the bot's text as the review read it: copy it from text no change touches.";
  if (!home) return "Only the bot's name or title holds it, and those can only be removed.";
  if (review.changes.some((change) => change.quote === quote)) return "It is a change already: pick its group above.";
  const becomes = oneLine(addition.becomes ?? "", 120);
  return {
    id, part: home.id, quote, group: addition.group, reason: "Added by you.",
    replacement: addition.group === "remove" ? becomes : "", label: becomes || "your own value", question: "",
  };
}

/** The picks once addition `index` is undone: later additions move up a place (`a3` is `a2`), their picks with them. */
export function picksWithoutAddition(picks: Readonly<Record<string, BotExportGroup>>, index: number): Record<string, BotExportGroup> {
  const result: Record<string, BotExportGroup> = {};
  for (const [id, group] of Object.entries(picks)) {
    const at = /^a\d+$/u.test(id) ? Number(id.slice(1)) - 1 : -1;
    if (at === -1 || at < index) result[id] = group;
    else if (at > index) result[`a${at}`] = group;
  }
  return result;
}

/** The review with the operator's additions as changes `a1`, `a2`…; one that can't be a change throws why. */
export function withAdditions(review: BotExportReview, additions: readonly BotExportAddition[]): BotExportReview {
  let result = review;
  for (const [index, addition] of additions.entries()) {
    const change = additionChange(result, addition, `a${index + 1}`);
    if (typeof change === "string") throw new Error(`Addition a${index + 1}: ${change}`);
    result = { ...result, changes: [...result.changes, change] };
  }
  return result;
}

/** Brackets and quotes a passage taken out may fill whole. */
const ENCLOSURES: Readonly<Record<string, string>> = { "(": ")", "[": "]", "`": "`", '"': '"', "“": "”" };

/**
 * `text` with each quote replaced, every time it appears, in one pass over the text as it was, so a replacement is never
 * matched again. Quotes that overlap become one span, all of it replaced by the longer one's replacement: no part of
 * either is left behind. A passage taken out with nothing in its place leaves no gap: brackets or quotes it fills go
 * with it, a whole sentence takes its stop, a clause the space before it (and an "and" or "or" joining it to the end of
 * its sentence), and a list item left with its marker alone goes, line and all.
 */
export function applyChanges(text: string, changes: readonly { quote: string; replacement: string }[]): string {
  const ranges: { start: number; end: number; replacement: string }[] = [];
  for (const { quote, replacement } of changes) {
    if (!quote) continue;
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + quote.length)) ranges.push({ start: at, end: at + quote.length, replacement });
  }
  const spans: { start: number; end: number; replacement: string; longest: number }[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = spans.at(-1);
    if (!last || range.start >= last.end) {
      spans.push({ ...range, longest: range.end - range.start });
      continue;
    }
    if (range.end - range.start > last.longest) Object.assign(last, { replacement: range.replacement, longest: range.end - range.start });
    last.end = Math.max(last.end, range.end);
  }
  let result = "";
  let at = 0;
  for (const [index, span] of spans.entries()) {
    let { start, end } = span;
    const limit = spans[index + 1]?.start ?? text.length;
    if (!span.replacement) {
      // Only brackets or quotes that stand alone: a call's (`f(x)`), an index's or a link's text stays bracketed.
      const close = ENCLOSURES[text[start - 1] ?? ""];
      const alone = (start - 1 === 0 || /[\s([{"“'`]/u.test(text[start - 2] ?? "")) && (end + 1 === text.length || /[\s.,;:!?)\]}"”'`]/u.test(text[end + 1] ?? ""));
      if (close && text[end] === close && alone && start - 1 >= at && end + 1 <= limit) {
        start -= 1;
        end += 1;
      }
      // The space before: still in the text, or already written when the span before ended on it.
      const spaceBefore = start > at ? text[start - 1] === " " : result.endsWith(" ");
      const dropSpaceBefore = () => {
        if (start > at) start -= 1;
        else result = result.slice(0, -1);
      };
      // The line so far as it will be written, the span before may have cut part of it.
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const sameLine = lineStart < at;
      const written = sameLine ? result.slice(result.lastIndexOf("\n") + 1) + text.slice(at, start) : text.slice(lineStart, start);
      const listItem = /^[ \t]*(?:[-*+]|\d+[.)]) $/u.test(written);
      const opensSentence = start === 0 || text[start - 1] === "\n" || listItem || /^[.!?:] $/u.test(text.slice(start - 2, start));
      if (opensSentence && end < limit && /^[.;!?,:](?:\s|$)/u.test(text.slice(end, end + 2))) {
        if (text[end + 1] === " " && end + 2 <= limit) end += 2;
        else {
          end += 1;
          if (spaceBefore && !listItem) dropSpaceBefore();
        }
      } else if (spaceBefore && !listItem && /^[.,;:!?)]/u.test(text[end] ?? "")) {
        // A clause ending its sentence takes the "and" or "or" that joined it: "A and B." without B is "A.". Looked for in
        // what is written, where a removal just before may have taken a space.
        // ponytail: one joining word; "X and Y and Z." without Y and Z keeps the first "and".
        const joined = /(?:,[ \t]*|[ \t])(?:and|or) $/u.exec((result + text.slice(at, start)).slice(-8));
        if (joined) {
          const cut = joined[0].length;
          if (cut <= start - at) start -= cut;
          else {
            result = result.slice(0, result.length - (cut - (start - at)));
            start = at;
          }
        } else dropSpaceBefore();
      }
      else if (spaceBefore && text[end] === " " && end + 1 <= limit) end += 1;
      const newline = text.indexOf("\n", end);
      const lineEnd = newline === -1 ? text.length : newline;
      if (listItem && !text.slice(end, lineEnd).trim()) {
        const last = newline === -1;
        const after = last ? lineEnd : lineEnd + 1;
        if (after <= limit) {
          // The last line takes the line break before it (and a Windows one's carriage return).
          if (sameLine) {
            const cut = result.lastIndexOf("\n") + 1;
            result = result.slice(0, last && cut > 0 ? cut - (result[cut - 2] === "\r" ? 2 : 1) : cut);
            start = at;
          } else start = last && lineStart > at ? lineStart - (lineStart - 2 >= at && text[lineStart - 2] === "\r" ? 2 : 1) : lineStart;
          end = after;
        }
      }
    }
    result += text.slice(at, start) + span.replacement;
    at = end;
  }
  return result + text.slice(at);
}

/** The zip's name, from the bot's final name: `{{user}}` (and its `'s`) left out. */
export function botExportFileName(name: string): string {
  return `${handleFromName(name.replace(/\{\{\s*user\s*\}\}(?:['’]s)?/giu, ""))}.hui-bot.zip`;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/** A review and the operator's picks as the files of the zip, in the order a person opening it reads them. */
export function buildExport(review: BotExportReview, picks: Readonly<Record<string, BotExportGroup>> = {}): BotExportBuild {
  const group = (id: string, fallback: BotExportGroup): BotExportGroup => picks[id] ?? fallback;
  // What the reviewer wrote travels too (replacements, labels, questions, needs): none of it may repeat a passage the
  // picks remove or ask, in any case. A label or replacement that would gives way to a plain one; other text is scrubbed.
  const hidden = review.changes.filter((change) => ["remove", "ask"].includes(group(change.id, change.group))).map((change) => change.quote.trim()).filter(Boolean);
  // Any case and any spacing: a reviewer writes "Pat Doe" for a passage that wraps a line.
  const hiddenPattern = hidden.length ? new RegExp([...hidden].sort((a, b) => b.length - a.length).map((quote) => escape(quote).replace(/\s+/gu, "\\s+")).join("|"), "giu") : undefined;
  const leaks = (text: string) => hiddenPattern !== undefined && text.search(hiddenPattern) !== -1;
  const scrub = (text: string) => hiddenPattern ? text.replace(hiddenPattern, "[removed]") : text;
  // A label that would repeat a passage gives way to a numbered plain one, so the new owner can tell them apart.
  let plain = 0;
  const labels = new Map(review.changes.map((change) => [change.id, group(change.id, change.group) === "ask" && leaks(change.label) ? `your own value${(plain += 1) > 1 ? ` ${plain}` : ""}` : change.label]));
  const label = (change: BotExportChange) => labels.get(change.id) ?? change.label;
  const replacements = review.changes.flatMap((change) => {
    const picked = group(change.id, change.group);
    return picked === "remove" ? [{ quote: change.quote, replacement: leaks(change.replacement) ? "" : change.replacement }]
      : picked === "ask" ? [{ quote: change.quote, replacement: askMark(label(change)) }]
      : [];
  });
  /** Text the reviewer wrote, as it travels: the picks' replacements (a passage taken out shows as `[removed]`), then a scrub
   * of what they missed (another case). */
  const marks = replacements.map((pair) => ({ quote: pair.quote, replacement: pair.replacement || "[removed]" }));
  const tidy = (text: string) => scrub(applyChanges(text, marks));
  // The profile is set before the first chat, so a passage asked elsewhere leaves it like a removed one: never a blank.
  const asked = new Set(review.changes.filter((change) => group(change.id, change.group) === "ask").map((change) => change.quote));
  const inProfile = replacements.map((pair) => asked.has(pair.quote) ? { ...pair, replacement: "" } : pair);
  const parts = new Map(review.parts.map((part) => [part.id, part]));
  const fields = (id: string): Record<string, string> => {
    const part = parts.get(id);
    return Object.fromEntries((part?.fields ?? []).map((field) => [field.key, part!.kind !== "text" ? field.text
      // A passage taken out of a name or title leaves no double space behind.
      : id === "profile" ? applyChanges(field.text, inProfile).replace(/[ \t]{2,}/gu, " ").trim()
      : applyChanges(field.text, replacements)]));
  };
  // Where an open point is: a routine or a trigger by its name as it travels, so a removed passage never names it.
  const where = (id: string) => id.startsWith("routines/") ? `Routine “${fields(id)["name"] ?? ""}”` : id.startsWith("triggers/") ? `Trigger “${fields(id)["name"] ?? ""}”` : parts.get(id)?.label ?? id;
  const onlyOperator = (id: string) => id.startsWith("triggers/") ? { operator: true as const } : {};

  // A passage cut short or squeezed onto one line could slip past the scrub: it is tidied first, then shortened. Where
  // two quotes overlap the longer's replacement takes the span, so the other's open point may name a mark that isn't there.
  const open: BotOpenPoint[] = [];
  const outcomes: BotExportBuild["outcomes"] = {};
  const askedLabels = new Map<string, BotOpenPoint>();
  for (const change of review.changes) {
    const picked = group(change.id, change.group);
    const replacement = replacements.find((pair) => pair.quote === change.quote)?.replacement;
    if (picked === "remove") outcomes[change.id] = { replacement: replacement ?? "" };
    if (picked !== "ask" && picked !== "confirm") continue;
    const excerpt = oneLine(tidy(change.quote), 160);
    const question = tidy(changeQuestion(change, picked, { label: label(change), excerpt: oneLine(excerpt, 80) }));
    outcomes[change.id] = { ...(picked === "ask" ? { replacement: replacement ?? askMark(label(change)) } : {}), question };
    // Two passages asked as the same blank are one answer: the new owner is asked once, where both are.
    const place = tidy(where(change.part));
    // Keyed with who can change it: a trigger's blank, the operator's alone, stays its own point.
    const key = `${label(change).toLowerCase()}${change.part.startsWith("triggers/") ? " (operator)" : ""}`;
    const seen = picked === "ask" ? askedLabels.get(key) : undefined;
    if (seen) {
      if (!seen.where.split(", ").includes(place)) seen.where = `${seen.where}, ${place}`;
      continue;
    }
    const point: BotOpenPoint = { kind: picked, where: place, question, ...(picked === "confirm" ? { excerpt } : {}), ...onlyOperator(change.part) };
    if (picked === "ask") askedLabels.set(key, point);
    open.push(point);
  }
  for (const file of review.files) {
    if (group(file.id, file.group) === "confirm") open.push({ kind: "confirm", where: tidy(where(file.part)), question: tidy(file.question) });
  }

  const { meta } = review;
  const profile = fields("profile");
  // Never the name as it was: a name the picks removed whole becomes a plain one.
  const name = profile["name"]?.trim() || "Bot";
  const routines = meta.routines.map((routine, index) => {
    const text = fields(`routines/${index}`);
    return { name: text["name"] || `Routine ${index + 1}`, ...(text["description"] ? { description: text["description"] } : {}), prompt: text["prompt"] ?? "", schedule: routine.schedule };
  });
  const triggers = meta.triggers.map((trigger, index) => {
    const id = `triggers/${index}`;
    const text = fields(id);
    const original = parts.get(id)?.fields.find((field) => field.key === "match")?.text;
    const { match, ...filter } = trigger.filter;
    // A value the cleanup or a removed or asked passage touched would never match: its owner sets a new one.
    const touched = match !== undefined && (text["match"] !== original || review.cleanup.some((hit) => hit.part === id && hit.field === "match"));
    if (touched) {
      open.push({ kind: "ask", where: tidy(where(id)), question: `Which ${match.field || "event"} should wake it? Its filter matched a value of the previous owner's: set yours on its Triggers page.`, operator: true });
    }
    return {
      name: text["name"] || `Trigger ${index + 1}`,
      filter: match && !touched ? { ...filter, match: { ...match, value: text["match"] ?? match.value } } : filter,
      ...(text["prompt"] ? { prompt: text["prompt"] } : {}),
      cooldownSeconds: trigger.cooldownSeconds,
      ...(trigger.delivery ? { delivery: trigger.delivery } : {}),
    };
  });
  const manifest: BotExportManifest = {
    format: BOT_EXPORT_FORMAT,
    version: BOT_EXPORT_VERSION,
    bot: {
      name,
      ...(profile["title"] ? { title: profile["title"] } : {}),
      ...(profile["description"] ? { description: profile["description"] } : {}),
      ...(meta.avatar ? { avatar: meta.avatar } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.thinking ? { thinking: meta.thinking } : {}),
      ...(meta.memoryModel ? { memoryModel: meta.memoryModel } : {}),
      ...(meta.memoryThinking ? { memoryThinking: meta.memoryThinking } : {}),
      ...(meta.voice ? { voice: meta.voice } : {}),
      ...(meta.tagging ? { tagging: meta.tagging } : {}),
    },
    routines,
    triggers,
    disabledTools: meta.disabledTools,
    disabledSkills: meta.disabledSkills,
    skills: meta.skills,
    open,
    needs: review.needs.filter((need) => group(need.id, "keep") !== "remove").map((need) => tidy(need.text)),
  };

  const ending = (text: string) => text.endsWith("\n") ? text : `${text}\n`;
  const files: BotExportBuild["files"] = [{ path: BOT_EXPORT_FILES.manifest, text: ending(JSON.stringify(manifest, null, 2)) }];
  for (const part of review.parts) {
    if (part.id !== BOT_EXPORT_FILES.soul && !part.id.startsWith(`${BOT_EXPORT_FILES.skills}/`)) continue;
    const change = review.files.find((file) => file.part === part.id);
    if (change && group(change.id, change.group) === "remove") continue;
    files.push({ path: part.id, text: ending(fields(part.id)["text"] ?? "") });
  }
  return { name, fileName: botExportFileName(name), files, open, outcomes };
}
