/**
 * Syntax colours for the Diff view: each hunk's old side (context and removed lines) and new side (context and added
 * lines) is parsed as one block with the file's CodeMirror language (`code-languages.ts`), and the tokens are cut
 * back into lines as class names (`tok-*`, @lezer/highlight's class highlighter) that `styles/diff-view.css` colours
 * from the same variables as the Files editor. A hunk is a fragment, so a line inside a long comment or string may
 * be coloured as code; that is the price of not reading whole files. Loaded with the view, never on the main bundle.
 */
import type { Language } from "@codemirror/language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import { loadLanguageParser } from "../code-languages.ts";
import type { DiffHunk, DiffLine } from "./hunks.ts";
import { fileLanguage } from "../files/languages.ts";

export type HighlightSegment = { text: string; className?: string };
export type LineHighlights = Map<DiffLine, HighlightSegment[]>;

/** Diffs larger than this many lines are shown without colours. */
export const MAX_HIGHLIGHTED_LINES = 4_000;

/** The text of one block cut into per-line segments, coloured where the parser found a token. */
export function highlightBlock(language: Language, lines: readonly string[]): HighlightSegment[][] {
  const text = lines.join("\n");
  const ranges: { from: number; to: number; className: string }[] = [];
  highlightTree(language.parser.parse(text), classHighlighter, (from, to, className) => { ranges.push({ from, to, className }); });
  const result: HighlightSegment[][] = [];
  let offset = 0;
  let range = 0;
  for (const line of lines) {
    const start = offset;
    const end = start + line.length;
    const segments: HighlightSegment[] = [];
    let cursor = start;
    while (range < ranges.length && ranges[range]!.to <= start) range++;
    for (let index = range; index < ranges.length && ranges[index]!.from < end; index++) {
      const { from, to, className } = ranges[index]!;
      const left = Math.max(from, start);
      const right = Math.min(to, end);
      if (right <= left) continue;
      if (left > cursor) segments.push({ text: text.slice(cursor, left) });
      segments.push({ text: text.slice(left, right), className });
      cursor = right;
    }
    if (cursor < end) segments.push({ text: text.slice(cursor, end) });
    result.push(segments);
    offset = end + 1;
  }
  return result;
}

/** Colours for the lines of `hunks`, or `undefined` when the file has no language worth colouring. */
export async function highlightHunks(path: string, hunks: readonly DiffHunk[]): Promise<LineHighlights | undefined> {
  const language = fileLanguage(path);
  if (language === "plain" || language === "diff") return undefined;
  if (hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0) > MAX_HIGHLIGHTED_LINES) return undefined;
  const parser = await loadLanguageParser(language);
  if (!parser) return undefined;
  const highlights: LineHighlights = new Map();
  for (const hunk of hunks) {
    const before = hunk.lines.filter((line) => line.kind !== "add");
    const after = hunk.lines.filter((line) => line.kind !== "del");
    highlightBlock(parser, before.map((line) => line.text)).forEach((segments, index) => {
      if (before[index]!.kind === "del") highlights.set(before[index]!, segments);
    });
    highlightBlock(parser, after.map((line) => line.text)).forEach((segments, index) => highlights.set(after[index]!, segments));
  }
  return highlights;
}
