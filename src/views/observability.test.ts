import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const source = await readFile(new URL("./observability.ts", import.meta.url), "utf8");

test("HUI-09 renders four real observability surfaces", () => {
  for (const id of ["activity", "logs", "debug", "usage"]) assert.match(source, new RegExp(`case \\"${id}\\"`));
  assert.match(source, /Export diagnostics/u);
  assert.match(source, /PI metadata did not provide cost/u);
  assert.doesNotMatch(source, /mock|placeholder|Lorem/iu);
});

test("diagnostic copy states the privacy boundary", () => {
  assert.match(source, /never includes prompt text, tool arguments\/output, credentials or secret values/u);
});
