import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { additionChange, buildExport, changeGroups, picksWithoutAddition, withAdditions } from "./export-preview.ts";

test("building an export matches the portable fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("./export-preview.fixture.json", import.meta.url), "utf8"));
  for (const item of fixture.changeGroups) assert.deepEqual(changeGroups(item.input), item.expected, item.input);
  for (const item of fixture.additions) assert.deepEqual(additionChange(fixture.review, item.input, "a9"), item.expected, item.input.quote);
  for (const item of fixture.picksWithoutAddition) assert.deepEqual(picksWithoutAddition(item.input.picks, item.input.index), item.expected);
  for (const item of fixture.builds) assert.deepEqual(buildExport(withAdditions(fixture.review, item.input.additions), item.input.picks), item.expected);
});
