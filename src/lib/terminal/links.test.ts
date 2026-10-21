import assert from "node:assert/strict";
import { test } from "vitest";
import { terminalLinkAt, textLinkAt, webLink, type LinkRow } from "./links.ts";

test("OSC 8 destinations open only web pages", () => {
  assert.equal(webLink("https://example.com/a.ts"), "https://example.com/a.ts");
  assert.equal(webLink("http://localhost:3000"), "http://localhost:3000/");
  for (const uri of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "not a url"]) assert.equal(webLink(uri), undefined);
});

test("plain web URLs exclude surrounding prose punctuation", () => {
  const text = "Open (https://example.com/a.ts?x=1). Done";
  assert.equal(textLinkAt(text, 10), "https://example.com/a.ts?x=1");
  assert.equal(textLinkAt(text, 34), undefined);
  assert.equal(textLinkAt("Visit http://localhost:3000/", 6), "http://localhost:3000/");
  assert.equal(textLinkAt("src/example.ts:42 has no scheme", 3), undefined);
});

const row = (text: string, links: Record<number, string> = {}): LinkRow => ({
  text,
  cells: [...text].map((character, x) => ({ x, text: character, width: "narrow", hyperlinkUri: links[x] ?? null })),
});

test("a cell resolves to its OSC 8 destination before any visible text", () => {
  const linked = row("see docs here", { 4: "https://example.com/docs", 5: "https://example.com/docs" });
  assert.equal(terminalLinkAt(linked, 4), "https://example.com/docs");
  assert.equal(terminalLinkAt(linked, 0), undefined);
  assert.equal(terminalLinkAt(row("x", { 0: "file:///tmp/a" }), 0), undefined, "an OSC 8 file link is not followed");
});

test("a visible URL is found from the clicked column, also past the last painted cell", () => {
  const text = "  -> https://hui.example/a b";
  assert.equal(terminalLinkAt(row(text), 8), "https://hui.example/a");
  assert.equal(terminalLinkAt(row(text), 27), undefined);
  // Trailing blank cells are omitted from a row; columns beyond them still map onto its text.
  assert.equal(terminalLinkAt({ text: "abc https://x.example", cells: [] }, 6), "https://x.example/");
});

test("wide characters before a URL keep the column-to-text mapping", () => {
  const cells = [
    { x: 0, text: "界", width: "wide" }, { x: 1, text: "", width: "spacer-tail" },
    ...[..." https://w.example"].map((character, index) => ({ x: index + 2, text: character, width: "narrow" })),
  ];
  assert.equal(terminalLinkAt({ text: "界 https://w.example", cells }, 5), "https://w.example/");
});
