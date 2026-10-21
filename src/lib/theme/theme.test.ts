import assert from "node:assert/strict";
import { test } from "vitest";

import {
  effectiveColorScheme,
  modeIsSelectable,
  nextThemeMode,
  resolvedThemeMode,
  resolvedPaletteSelector,
  THEME_MODES,
  type ThemeMode,
} from "./theme.ts";

test("cycles system -> light -> dark", () => {
  assert.equal(nextThemeMode("system"), "light");
  assert.equal(nextThemeMode("light"), "dark");
});

test("wraps back to the start after every mode", () => {
  let mode: ThemeMode = "system";
  for (let step = 0; step < THEME_MODES.length; step += 1) {
    mode = nextThemeMode(mode);
  }
  assert.equal(mode, "system");
});

test("a paired theme follows the preference", () => {
  assert.equal(effectiveColorScheme("system", "both"), "");
  assert.equal(effectiveColorScheme("light", "both"), "light");
  assert.equal(effectiveColorScheme("dark", "both"), "dark");
});

// The bug this guards: a dark-only theme left the browser painting light native
// controls (scrollbars, select popups) over the theme's dark surfaces.
test("a single-mode theme overrules the preference", () => {
  assert.equal(effectiveColorScheme("light", "dark"), "dark");
  assert.equal(effectiveColorScheme("dark", "dark"), "dark");
  assert.equal(effectiveColorScheme("system", "dark"), "dark");
  assert.equal(effectiveColorScheme("dark", "light"), "light");
  assert.equal(effectiveColorScheme("system", "light"), "light");
});

test("only a paired theme exposes the mode control", () => {
  assert.equal(modeIsSelectable("both"), true);
  assert.equal(modeIsSelectable("dark"), false);
  assert.equal(modeIsSelectable("light"), false);
});

test("upstream CSS always receives a resolved light or dark mode", () => {
  assert.equal(resolvedThemeMode("system", "both", true), "dark");
  assert.equal(resolvedThemeMode("system", "both", false), "light");
  assert.equal(resolvedThemeMode("light", "both", true), "light");
  assert.equal(resolvedThemeMode("dark", "both", false), "dark");
  assert.equal(resolvedThemeMode("system", "dark", false), "dark");
  assert.equal(resolvedThemeMode("dark", "light", true), "light");
});

test("native palettes retain their upstream selectors in both modes", () => {
  assert.equal(resolvedPaletteSelector("claw", "light"), "light");
  assert.equal(resolvedPaletteSelector("rose", "dark"), "rose");
  assert.equal(resolvedPaletteSelector("rose", "light"), "rose-light");
  assert.equal(resolvedPaletteSelector("miami", "dark"), "miami");
  assert.equal(resolvedPaletteSelector("miami", "light"), "miami-light");
  assert.equal(resolvedPaletteSelector("custom", "dark"), "custom");
  assert.equal(resolvedPaletteSelector("custom", "light"), "custom-light");
});
