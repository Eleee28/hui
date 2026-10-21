import assert from "node:assert/strict";
import { test } from "vitest";
import { readToolPresentation, renderToolFileReference, toolFilePath } from "./read-tool-card.ts";

test("read rows summarize their target and retain unsummarized arguments", () => {
  const view = readToolPresentation({ kind: "tool", id: "1", name: "read", args: { path: "/home/test/project/file.ts", offset: 5, limit: 20 } });
  assert.deepEqual(view, {
    target: "file.ts", path: "/home/test/project/file.ts", shortPath: "~/project/file.ts", detail: "from ~/project/file.ts", extras: [["offset", 5], ["limit", 20]],
  });
});

test("read presentation handles Windows paths without inventing a path for other tools", () => {
  assert.deepEqual(readToolPresentation({ kind: "tool", id: "1", name: "read", args: { path: "C:\\Users\\test\\project\\file.ts" } }),
    { target: "file.ts", path: "C:\\Users\\test\\project\\file.ts", shortPath: "~\\project\\file.ts", detail: "from ~\\project\\file.ts", extras: [] });
  assert.equal(readToolPresentation({ kind: "tool", id: "1", name: "read", args: {} }), null);
  assert.equal(readToolPresentation({ kind: "tool", id: "1", name: "read", args: { path: "/tmp/file name " } })?.target, "file name ");
  assert.equal(readToolPresentation({ kind: "tool", id: "1", name: "bash", args: { path: "file.ts" } }), null);
});

test("read, edit and write tools name the file they touch as a file reference; other tools do not", () => {
  assert.equal(toolFilePath({ kind: "tool", id: "1", name: "read", args: { path: "src/a.ts" } }), "src/a.ts");
  assert.equal(toolFilePath({ kind: "tool", id: "2", name: "edit", args: { path: "src/a.ts", oldText: "a", newText: "b" } }), "src/a.ts");
  assert.equal(toolFilePath({ kind: "tool", id: "3", name: "Write", args: { file_path: "/srv/app/b.md", content: "" } }), "/srv/app/b.md");
  assert.equal(toolFilePath({ kind: "tool", id: "4", name: "bash", args: { path: "src/a.ts", command: "ls" } }), undefined);
  assert.equal(toolFilePath({ kind: "tool", id: "5", name: "edit", args: { path: "  " } }), undefined);
  assert.equal(toolFilePath({ kind: "tool", id: "6", name: "write", args: "src/a.ts" }), undefined);
  const reference = renderToolFileReference(" src/a.ts ", "a.ts");
  assert.match(reference.strings.join(""), /<hui-file-ref data-path=/u);
  assert.deepEqual(reference.values, ["src/a.ts", "a.ts"]);
});
