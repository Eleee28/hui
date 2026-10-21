import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { resolveCommandReference } from "./command-references.ts";

const fixtures: { input: { text: string; catalog: Parameters<typeof resolveCommandReference>[1] }; expected: string }[] = JSON.parse(readFileSync(new URL("./command-references.fixture.json", import.meta.url), "utf8"));

test("command-references preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.equal(resolveCommandReference(fixture.input.text, fixture.input.catalog), fixture.expected);
  }
});
