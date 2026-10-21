import assert from "node:assert/strict";
import { test } from "vitest";
import { parseFileLinkTarget, parseFileReference } from "./references.ts";

test("relative, dotted, absolute and home paths are file references", () => {
  assert.deepEqual(parseFileReference("src/lib/x.ts"), { path: "src/lib/x.ts" });
  assert.deepEqual(parseFileReference("./a/b.md"), { path: "./a/b.md" });
  assert.deepEqual(parseFileReference("../shared/files.ts"), { path: "../shared/files.ts" });
  assert.deepEqual(parseFileReference("/etc/hosts"), { path: "/etc/hosts" });
  assert.deepEqual(parseFileReference("~/notes/todo.txt"), { path: "~/notes/todo.txt" });
  assert.deepEqual(parseFileReference("src/lib/"), { path: "src/lib/" });
  assert.deepEqual(parseFileReference("docs/"), { path: "docs/" });
  assert.deepEqual(parseFileReference("package.json"), { path: "package.json" });
  assert.deepEqual(parseFileReference("README.md"), { path: "README.md" });
  assert.deepEqual(parseFileReference(".gitignore"), { path: ".gitignore" });
  assert.deepEqual(parseFileReference("Makefile"), { path: "Makefile" });
  assert.deepEqual(parseFileReference("node_modules/@scope/pkg/index.d.ts"), { path: "node_modules/@scope/pkg/index.d.ts" });
});

test("a line, a line and column, a range or a GitHub anchor are read off the end", () => {
  assert.deepEqual(parseFileReference("src/x.ts:42"), { path: "src/x.ts", line: 42 });
  assert.deepEqual(parseFileReference("src/x.ts:42:7"), { path: "src/x.ts", line: 42, column: 7 });
  assert.deepEqual(parseFileReference("src/x.ts:10-20"), { path: "src/x.ts", line: 10 });
  assert.deepEqual(parseFileReference("src/x.ts#L42"), { path: "src/x.ts", line: 42 });
  assert.deepEqual(parseFileReference("src/x.ts#L42C3"), { path: "src/x.ts", line: 42, column: 3 });
  assert.deepEqual(parseFileReference("src/x.ts#L10-L20"), { path: "src/x.ts", line: 10 });
  assert.deepEqual(parseFileReference("Makefile:3"), { path: "Makefile", line: 3 });
  assert.deepEqual(parseFileReference("src/x.ts:0"), { path: "src/x.ts" });
});

test("commands, calls, versions, flags, URLs, globs and prose are not file references", () => {
  for (const text of [
    "npm test", "npm run build", "foo()", "foo.bar()", "obj.method(arg)", "1.2.3", "v1.2.3", "0.1.0-beta", "node@18.0",
    "--flag", "-v", "--out=dist", "https://github.com/a/b", "http://localhost:3000/x", "mailto:a@b.c", "C:\\Users\\x",
    "localhost:3000", "*.ts", "src/**/*.ts", "$HOME/x", "${dir}/x.ts", "a = b", "e.g.", "etc.", "x", "README",
    "useState", "true", "1920/1080", "+/-", "//comment", "...", "a...b/c", "", "  ", "'src/x.ts'", "\"src/x.ts\"",
    "src/x.ts,", "<src/x.ts>", "[src/x.ts]", "foo~bar.ts", "~", "~user/x.ts", "file.", "a b/c.ts", "a..b/c.ts",
  ]) {
    assert.equal(parseFileReference(text), undefined, `${JSON.stringify(text)} is not a file reference`);
  }
});

test("link targets: relative and absolute paths and file URLs, not web, mail or in-page targets", () => {
  assert.deepEqual(parseFileLinkTarget("src/x.ts#L12"), { path: "src/x.ts", line: 12 });
  assert.deepEqual(parseFileLinkTarget("./docs/a%2Bb.md"), { path: "./docs/a+b.md" }, "percent-encoding is decoded");
  assert.equal(parseFileLinkTarget("docs/My%20Notes.md"), undefined, "a decoded space is not a path in prose");
  assert.deepEqual(parseFileLinkTarget("file:///srv/app/main.go"), { path: "/srv/app/main.go" });
  assert.deepEqual(parseFileLinkTarget("file://localhost/srv/app/main.go:4"), { path: "/srv/app/main.go", line: 4 });
  assert.equal(parseFileLinkTarget("https://example.com/a.ts"), undefined);
  assert.equal(parseFileLinkTarget("mailto:a@example.com"), undefined);
  assert.equal(parseFileLinkTarget("#section"), undefined);
  assert.equal(parseFileLinkTarget("?q=1"), undefined);
  assert.equal(parseFileLinkTarget("file://host/x.ts"), undefined);
  assert.equal(parseFileLinkTarget("%E0%A4%A"), undefined);
});
