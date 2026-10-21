import assert from "node:assert/strict";
import { test } from "vitest";

import { contrastRatio, parseColor } from "./color-contrast.ts";
import { mapTheme } from "./shadcn-theme.ts";
import { accentOverrideTokens, accentSurfaces, builtinPalette } from "./theme-store.ts";

const LIGHT_PAGE = [parseColor("#faf9f7")!, parseColor("#ffffff")!];
const DARK_PAGE = [parseColor("#0e1015")!, parseColor("#151b21")!];

function pairOf(value: string | undefined): [string, string] {
  const match = /^light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)$/u.exec(value ?? "");
  assert.ok(match, `a light-dark() pair: ${value}`);
  return [match[1]!, match[2]!];
}

test("accent overrides the same semantic roles as OpenClaw", () => {
  const tokens = accentOverrideTokens("#a78bfa");

  for (const token of ["--ring", "--accent", "--accent-muted", "--primary"]) {
    assert.equal(tokens[token], "#a78bfa");
  }
  assert.equal(tokens["--accent-subtle"], "color-mix(in srgb, var(--accent) 16%, transparent)");
  assert.equal(tokens["--accent-glow"], "color-mix(in srgb, var(--accent) 30%, transparent)");
  assert.equal(tokens["--focus"], "color-mix(in srgb, var(--ring) 22%, transparent)");
  assert.equal(tokens["--focus-ring"], "0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) 80%, transparent)");
  assert.equal(tokens["--focus-glow"], "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)");
});

test("accent foreground keeps readable contrast", () => {
  for (const [accent, ink] of [
    ["#f5b942", "#000000"], ["#5b9cf6", "#000000"],
    ["#a78bfa", "#000000"], ["#777777", "#000000"],
    ["#747474", "#ffffff"], ["#2563eb", "#ffffff"],
  ] as const) {
    const tokens = accentOverrideTokens(accent);
    assert.equal(tokens["--primary-foreground"], ink, accent);
    assert.equal(tokens["--accent-foreground"], ink, accent);
  }
});

test("a user accent reads on each mode's page, keeping the chosen color where it already does", () => {
  for (const accent of ["#ff5c5c", "#f5b942", "#52c99a", "#35b9b0", "#5b9cf6", "#a78bfa", "#f472b6", "#8795a8"]) {
    const tokens = accentOverrideTokens(accent, { light: LIGHT_PAGE, dark: DARK_PAGE });
    const [light, dark] = pairOf(tokens["--accent"]);
    assert.equal(dark, accent, `${accent} already reads on the dark page`);
    for (const surface of LIGHT_PAGE) assert.ok(contrastRatio(parseColor(light)!, surface) >= 4.5, `${accent} → ${light}`);
    for (const token of ["--ring", "--accent-muted", "--primary"]) assert.equal(tokens[token], tokens["--accent"]);
    const [lightInk, darkInk] = pairOf(tokens["--accent-foreground"]);
    assert.ok(contrastRatio(parseColor(lightInk)!, parseColor(light)!) >= 4.5, `ink on ${light}`);
    assert.ok(contrastRatio(parseColor(darkInk)!, parseColor(dark)!) >= 4.5, `ink on ${dark}`);
    assert.equal(tokens["--accent-hover"], "light-dark(color-mix(in srgb, var(--accent) 82%, black 18%), color-mix(in srgb, var(--accent) 82%, white 18%))");
  }
});

test("an accent that reads in every mode, or a one-mode theme, stays a plain value", () => {
  const both = accentOverrideTokens("#2563eb", { light: LIGHT_PAGE, dark: [parseColor("#ffffff")!] });
  assert.equal(both["--accent"], "#2563eb");
  const darkOnly = accentOverrideTokens("#2563eb", { dark: DARK_PAGE });
  assert.notEqual(darkOnly["--accent"], "#2563eb", "a dark blue lightens on a dark-only theme");
  assert.doesNotMatch(darkOnly["--accent"]!, /light-dark/u);
  assert.equal(darkOnly["--accent-hover"], "color-mix(in srgb, var(--accent) 82%, white 18%)");
});

test("accent surfaces come from each mode's page and card", () => {
  const mapped = mapTheme({
    light: { background: "#faf9f7", foreground: "#151b21", card: "#ffffff" },
    dark: { background: "#0e1015", foreground: "#eef4f8", card: "#151b21" },
  })!;
  assert.deepEqual(accentSurfaces(mapped.modes), { light: LIGHT_PAGE, dark: DARK_PAGE });
  assert.deepEqual(accentSurfaces({}), {});
});

test("native palettes never replace a user theme with the same name", () => {
  for (const id of ["claw", "rose", "miami"]) {
    assert.equal(builtinPalette({ id, name: id, url: `/__hui/themes/file/builtin/${id}.json` }), id);
    assert.equal(builtinPalette({ id, name: id, url: `/__hui/themes/file/user/${id}.json` }), undefined);
  }
});
