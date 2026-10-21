/**
 * Completion of the composer's `@` mentions and paths: finding the path or `@` mention at the caret, the bots a
 * mention suggests and splicing a chosen suggestion back in. The gateway lists matching paths (src/api/local-paths.ts).
 */
import type { BotView } from "../api/schema/bots.ts";
import type { LocalPathSuggestion as PathSuggestion } from "../api/schema/local-paths.ts";

export type LocalPathSuggestion =
  | PathSuggestion
  /** A bot an `@` mention tags: `path` is its handle. */
  | { path: string; kind: "bot"; bot: Pick<BotView, "id" | "name" | "title" | "avatar"> };

export type LocalPathQuery = {
  input: string;
  start: number;
  end: number;
  mention: boolean;
};

/** Most bots one mention suggests, before the paths. */
const MAX_BOT_SUGGESTIONS = 5;

/** Find the path token at the caret; leading slash prefixes also join command discovery. */
export function localPathQuery(
  text: string,
  caret: number,
  selectionEnd = caret,
): LocalPathQuery | null {
  if (caret !== selectionEnd || caret < 1) return null;
  let start = caret;
  while (start > 0 && !/\s/u.test(text[start - 1] ?? "")) start -= 1;
  const token = text.slice(start, caret);
  const mention = token.startsWith("@");
  const input = mention ? token.slice(1) : token;
  if (!mention && !/^(?:\.\.?\/|~\/|\/)/u.test(input)) return null;
  return { input, start, end: caret, mention };
}

/** A bot ends the mention with a space, so the message goes on; a path stays open for more. */
export function completeLocalPath(
  text: string,
  query: LocalPathQuery,
  suggestion: LocalPathSuggestion,
): { text: string; caret: number } {
  const replacement = `${query.mention ? "@" : ""}${suggestion.path}${suggestion.kind === "bot" ? " " : ""}`;
  const completed = `${text.slice(0, query.start)}${replacement}${text.slice(query.end)}`;
  return { text: completed, caret: query.start + replacement.length };
}

/**
 * The bots an `@` mention suggests while `input` follows it: those whose handle or name starts with it, any case, that
 * this chat may tag (never an archived bot, one nobody may tag, or `own`, the bot whose chat it is), by handle.
 */
export function botMentionSuggestions(bots: readonly BotView[], input: string, own?: string): LocalPathSuggestion[] {
  const query = input.toLowerCase();
  return bots
    .filter((bot) => !bot.archived && bot.tagging !== "nobody" && bot.id !== own && (bot.handle.startsWith(query) || bot.name.toLowerCase().startsWith(query)))
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .slice(0, MAX_BOT_SUGGESTIONS)
    .map((bot) => ({ path: bot.handle, kind: "bot", bot: { id: bot.id, name: bot.name, title: bot.title, avatar: bot.avatar } }));
}
