import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { HUI_PAGES } from "../lib/pages.ts";
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../lib/settings/settings.ts";
import { renderOwnedSurface } from "./hui-owned-surfaces.ts";

const source = await readFile(new URL("./hui-owned-surfaces.ts", import.meta.url), "utf8");

/** A template's text with every nested template and value in place; handlers and directives drop out. */
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: readonly unknown[] };
    return template.strings.map((part, index) => part + (index < template.values.length ? text(template.values[index]) : "")).join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** The template's handlers in document order. */
function handlers(value: unknown, found: Array<(event: unknown) => void> = []): Array<(event: unknown) => void> {
  if (typeof value === "function") found.push(value as (event: unknown) => void);
  else if (Array.isArray(value)) for (const item of value) handlers(item, found);
  else if (value && typeof value === "object" && "strings" in value && "values" in value) handlers((value as { values: unknown }).values, found);
  return found;
}

const LABS = HUI_PAGES.find((page) => page.id === "labs")!;
const labs = (settings: Settings, onSettings: (patch: Partial<Settings>) => void = () => {}) =>
  renderOwnedSurface({ page: LABS, settings, health: undefined, onSettings });

test("HUI-10 implements every retained HUI-owned surface", () => {
  for (const id of ["labs", "profile", "about"]) assert.match(source, new RegExp(`case \\"${id}\\"`));
  assert.doesNotMatch(source, /dashboards|dashboardWidgets/u);
  assert.match(source, /Experimental and opt-in features\./u);
  assert.match(source, /does not change PI/u);
});

test("Labs holds the presentation flags and no Bots switch, and a switch saves its flag with the others", () => {
  const page = text(labs(DEFAULT_SETTINGS));
  assert.match(page, /Experimental and opt-in features\./u, "the subtitle fits more than presentation flags");
  assert.doesNotMatch(page, /HUI-only presentation flags/u);
  assert.doesNotMatch(page, />Bots</u, "bots are always on");
  const saved: Array<Partial<Settings>> = [];
  const [, change] = handlers(labs(normalizeSettings({ labs: { detailedDebug: true } }), (patch) => saved.push(patch)));
  change!({ currentTarget: { checked: true } });
  assert.deepEqual(saved, [{ labs: { denseObservability: true, detailedDebug: true } }]);
});
