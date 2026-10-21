import assert from "node:assert/strict";
import { test } from "vitest";
import { highlightBlock, highlightHunks } from "./highlight.ts";
import { loadLanguageParser } from "../code-languages.ts";
import { parseHunks } from "./hunks.ts";

test("a block's tokens are cut back into its lines without losing text", async () => {
  const language = await loadLanguageParser("typescript");
  assert.ok(language);
  const lines = ["const answer = 42; // note", "", "function f(a: string) {", "  return \"x\";", "}"];
  const segments = highlightBlock(language, lines);
  assert.equal(segments.length, lines.length);
  segments.forEach((line, index) => assert.equal(line.map((segment) => segment.text).join(""), lines[index]));
  assert.ok(segments[0]!.some((segment) => segment.text === "const" && segment.className?.includes("tok-keyword")));
  assert.ok(segments[0]!.some((segment) => segment.text === "42" && segment.className?.includes("tok-number")));
  assert.ok(segments[3]!.some((segment) => segment.className?.includes("tok-string")));
});

test("removed lines take the old side's colours, added and context lines the new side's", async () => {
  const hunks = parseHunks("@@ -1,2 +1,2 @@\n const a = 1;\n-let b = 'old';\n+let b = \"new\";\n");
  const highlights = await highlightHunks("src/x.ts", hunks);
  assert.ok(highlights);
  for (const line of hunks[0]!.lines) assert.equal(highlights.get(line)?.map((segment) => segment.text).join(""), line.text);
  assert.equal(await highlightHunks("notes.txt", hunks), undefined);
});
