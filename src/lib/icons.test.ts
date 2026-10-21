import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import type { TemplateResult } from "lit";
import { icons } from "./icons.ts";

test("all shared icons retain the pinned original SVG geometry and stroke shell", () => {
  const manifest = JSON.parse(readFileSync(new URL("./openclaw-icon-geometry.json", import.meta.url), "utf8")) as {
    icons: Array<{ name: keyof typeof icons; sha256: string }>;
  };
  assert.equal(manifest.icons.length, 56);
  assert.deepEqual(manifest.icons.map((icon) => icon.name).sort(), Object.keys(icons).sort());
  for (const expected of manifest.icons) {
    const icon = icons[expected.name];
    assert.match(icon.strings.join(""), /stroke-width="2"/);
    assert.equal(icon.values.length, 1);
    const body = icon.values[0] as TemplateResult;
    assert.equal(body.values.length, 0, expected.name);
    const normalized = body.strings.join("").replace(/\s+/g, " ").trim();
    assert.equal(createHash("sha256").update(normalized).digest("hex"), expected.sha256, expected.name);
  }
});
