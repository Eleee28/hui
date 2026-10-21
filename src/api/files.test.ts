/** Checks the browser's file-path helpers against the portable wire fixtures. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { fileExtension, isMarkdownPath, MAX_RESOLVE_PATHS } from "./files.ts";

test("file extensions and resolve limits match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./files.fixture.json", import.meta.url), "utf8"));
  assert.equal(MAX_RESOLVE_PATHS, fixture.maxResolvePaths);
  for (const item of fixture.paths) {
    assert.equal(fileExtension(item.input), item.extension);
    assert.equal(isMarkdownPath(item.input), ["md", "markdown", "mdx"].includes(item.extension));
  }
});
