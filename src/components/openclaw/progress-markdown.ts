import { createMarkdownParser } from "../../lib/markdown/markdown.ts";

/** Same safe HUI Markdown renderer, with the progress_card-only HTML allowlist. */
const parser = createMarkdownParser();
parser.inline.ruler.before("html_inline", "progress_bar", (state, silent) => {
  const match = /^<progress\b([^>]*)>(?:\s*)<\/progress>/i.exec(state.src.slice(state.pos));
  if (!match) return false;
  if (!silent) {
    const token = state.push("progress_bar", "progress", 0);
    for (const attr of match[1]!.matchAll(/\b(value|max|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const name = attr[1]!.toLowerCase();
      const value = attr[2] ?? attr[3] ?? "";
      if (name === "aria-label" || (Number.isFinite(Number(value)) && Number(value) >= 0 && (name !== "max" || Number(value) > 0))) token.attrSet(name, value);
    }
  }
  state.pos += match[0].length;
  return true;
});
parser.renderer.rules.progress_bar = (tokens, index, _options, _env, renderer) =>
  `<progress${renderer.renderAttrs(tokens[index]!)}></progress>`;
export function toSanitizedMarkdownHtml(markdown: string, _options: { progressBars: boolean }): string {
  return parser.render(markdown);
}
