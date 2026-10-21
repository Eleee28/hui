import assert from "node:assert/strict";
import { test } from "vitest";
import { mixedLineEndings, parseHunks, patchLineCount, splitRows } from "./hunks.ts";

test("hunks number their lines from the @@ header on both sides", () => {
  const [hunk] = parseHunks("@@ -10,4 +10,5 @@ function area()\n keep\n-old\n+new\n+extra\n same\n");
  assert.equal(hunk!.section, "function area()");
  assert.deepEqual(hunk!.lines, [
    { kind: "context", text: "keep", oldNumber: 10, newNumber: 10 },
    { kind: "del", text: "old", oldNumber: 11 },
    { kind: "add", text: "new", newNumber: 11 },
    { kind: "add", text: "extra", newNumber: 12 },
    { kind: "context", text: "same", oldNumber: 12, newNumber: 13 },
  ]);
});

test("a missing count means one line, and a new file starts at zero", () => {
  const [single] = parseHunks("@@ -3 +3 @@\n-a\n+b");
  assert.deepEqual([single!.oldCount, single!.newCount], [1, 1]);
  const [created] = parseHunks("@@ -0,0 +1,2 @@\n+one\n+two\n");
  assert.deepEqual(created!.lines.map((line) => line.newNumber), [1, 2]);
});

test("no newline at end of file marks the line before it; CRLF is kept as a flag", () => {
  const [hunk] = parseHunks("@@ -1,2 +1,2 @@\n a\r\n-b\n\\ No newline at end of file\n+b\r\n\\ No newline at end of file\n");
  assert.deepEqual(hunk!.lines, [
    { kind: "context", text: "a", oldNumber: 1, newNumber: 1, cr: true },
    { kind: "del", text: "b", oldNumber: 2, noNewline: true },
    { kind: "add", text: "b", newNumber: 2, cr: true, noNewline: true },
  ]);
  assert.equal(mixedLineEndings([hunk!]), true);
  assert.equal(mixedLineEndings(parseHunks("@@ -1 +1 @@\n-a\r\n+b\r\n")), false);
});

test("several hunks and trimmed empty context lines", () => {
  const hunks = parseHunks("@@ -1,3 +1,3 @@\n a\n\n-c\n+C\n@@ -20,1 +20,1 @@\n-x\n+y\n");
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0]!.lines[1], { kind: "context", text: "", oldNumber: 2, newNumber: 2 });
  assert.equal(hunks[1]!.lines[0]!.oldNumber, 20);
});

test("side by side pairs a removed run with the added run after it", () => {
  const [hunk] = parseHunks("@@ -1,4 +1,4 @@\n same\n-a\n-b\n-c\n+A\n+B\n tail\n+only new\n");
  const rows = splitRows(hunk!);
  assert.deepEqual(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null]), [
    ["same", "same"], ["a", "A"], ["b", "B"], ["c", null], ["tail", "tail"], [null, "only new"],
  ]);
});

test("line counts for collapsing", () => {
  assert.equal(patchLineCount(""), 0);
  assert.equal(patchLineCount("@@ -1 +1 @@\n-a\n+b"), 3);
  assert.equal(patchLineCount("@@ -1 +1 @@\n-a\n+b\n"), 3);
});
