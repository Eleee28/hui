import assert from "node:assert/strict";
import { test } from "vitest";
import { pickerRows } from "./picker-options.ts";

const fonts = ["JetBrains Mono", "MesloLGS NF", "Hack Nerd Font Mono"].map((font) => ({ value: font, label: font }));
const custom = (query: string) => (query.includes(";") ? null : { value: query, label: query, description: "Custom" });

test("an empty query lists every option, not only the current value", () => {
  assert.deepEqual(pickerRows(fonts, "", custom).map((row) => row.value), fonts.map((font) => font.value));
});

test("queries filter options and offer typed text as a custom row", () => {
  assert.deepEqual(pickerRows(fonts, "nerd", custom).map((row) => row.value), ["Hack Nerd Font Mono", "nerd"]);
  assert.deepEqual(pickerRows(fonts, " Iosevka Term ", custom).map((row) => row.value), ["Iosevka Term"]);
});

test("custom rows are skipped for known, invalid or unsupported entries", () => {
  assert.deepEqual(pickerRows(fonts, "mesloLGS nf", custom).map((row) => row.value), ["MesloLGS NF"]);
  assert.deepEqual(pickerRows(fonts, "a; b", custom), []);
  assert.deepEqual(pickerRows(fonts, "Iosevka"), []);
});
