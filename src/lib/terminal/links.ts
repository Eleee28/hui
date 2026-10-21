/**
 * Finds the web link under a terminal cell: an OSC 8 hyperlink's destination, else a plain http(s) URL in the row's
 * text. Gespenst paints into a canvas, so there are no anchors to click; the terminal pane reads the cells Gespenst
 * reports and opens what this returns. Only http and https destinations are ever returned.
 * Ported from AgentsInTheCloud (MIT) packages/observable-terminal/src/client/links.ts, limited to web links.
 */

/** The parts of a Gespenst buffer row and cell this reads. */
export type LinkCell = { x: number; text: string; width: string; hyperlinkUri?: string | null };
export type LinkRow = { text: string; cells: readonly LinkCell[] };

/** An OSC 8 destination, when it is a web page. Other schemes (file:, javascript:, …) are never followed. */
export function webLink(uri: string): string | undefined {
  let url: URL;
  try { url = new URL(uri); } catch { return undefined; }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
}

// Trailing sentence punctuation and closing brackets belong to the prose, not the URL.
const webReference = /https?:\/\/[^\s<>"'`]+?(?=[.,;:!?)\]}'"`]*(?:$|[\s<>"'`]))/g;

/** The plain-text URL covering `offset` in `text`. */
export function textLinkAt(text: string, offset: number): string | undefined {
  for (const match of text.matchAll(webReference)) {
    if (offset >= match.index && offset < match.index + match[0].length) return webLink(match[0]);
  }
  return undefined;
}

/** The link under `column` of `row`: its OSC 8 destination, else a visible URL. */
export function terminalLinkAt(row: LinkRow, column: number): string | undefined {
  // Compute the string offset and inspect OSC 8 metadata in one pass. Cell
  // columns and JavaScript string offsets diverge for wide or Unicode text.
  let offset = 0;
  let nextColumn = 0;
  let uri: string | null | undefined;
  for (const cell of row.cells) {
    if (cell.x >= column) {
      if (cell.x === column) uri = cell.hyperlinkUri ?? uri;
      break;
    }
    offset += cell.x - nextColumn;
    if (cell.width !== "spacer-tail") offset += cell.text.length;
    nextColumn = cell.x + 1;
    if (cell.width === "wide" && cell.x + 1 === column) uri = cell.hyperlinkUri;
  }
  if (uri) return webLink(uri);
  return textLinkAt(row.text, offset + Math.max(0, column - nextColumn));
}
