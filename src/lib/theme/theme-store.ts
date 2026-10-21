/**
 * Themes come from the config backend, which merges the repo's built-ins with
 * any theme files in `~/.config/hui/themes/`. A theme is one file carrying both
 * modes, so there is nothing to pair here. A user accent is applied over the
 * active theme, its lightness solved per mode so it reads on that theme's page.
 */
import { currentSettings } from "../settings/settings-store.ts";
import { fetchThemeFile, fetchThemeList, postThemeImport, type ThemeRef } from "../../api/themes.ts";
import { applyThemeMode, type ThemeMode, type ThemeVariant } from "./theme.ts";
import { mapTheme, swatchesFor, themeColor, type ShadcnTheme, type ThemeSwatches, type ThemeTokens } from "./shadcn-theme.ts";
import { controlUiAccentInk } from "./accent-contrast.ts";
import { parseColor, readableOn, toHex, TEXT_CONTRAST, type Rgb } from "./color-contrast.ts";

export type ThemePreview = { id: string; name: string } & ThemeSwatches;

let themes: ThemeRef[] = [];
let selectedId = "";
let selectedVariant: ThemeVariant = "both";
let selectedTokens: Readonly<Record<string, string>> | undefined;
let selectedSurfaces: AccentSurfaces = {};

/** The page surfaces a user accent must read on, per mode the active theme carries. */
export type AccentSurfaces = { light?: readonly Rgb[]; dark?: readonly Rgb[] };

/** A mode's page and card colors, the surfaces accent text appears on. */
export function accentSurfaces(modes: { light?: ThemeTokens; dark?: ThemeTokens }): AccentSurfaces {
  const read = (tokens: ThemeTokens | undefined) => {
    const surfaces = tokens ? [themeColor(tokens["--bg"]), themeColor(tokens["--card"])] : [];
    return surfaces.every((surface): surface is Rgb => surface !== undefined) && surfaces.length ? surfaces : undefined;
  };
  const light = read(modes.light);
  const dark = read(modes.dark);
  return { ...(light ? { light } : {}), ...(dark ? { dark } : {}) };
}

const ACCENT_TOKENS = [
  "--ring", "--accent", "--accent-foreground", "--accent-hover",
  "--accent-muted", "--accent-subtle", "--accent-glow", "--primary",
  "--primary-hover", "--primary-foreground", "--focus",
  "--focus-ring", "--focus-glow",
] as const;

export function listThemes(): readonly ThemeRef[] {
  return themes;
}

export function selectedThemeId(): string {
  return selectedId;
}

export function selectedThemeVariant(): ThemeVariant {
  return selectedVariant;
}

export function builtinPalette(theme: ThemeRef): "claw" | "rose" | "miami" | undefined {
  return (theme.id === "claw" || theme.id === "rose" || theme.id === "miami")
    && theme.url === `/__hui/themes/file/builtin/${theme.id}.json` ? theme.id : undefined;
}

async function readTheme(theme: ThemeRef): Promise<ShadcnTheme | undefined> {
  try {
    return await fetchThemeFile(theme);
  } catch {
    return undefined;
  }
}

function applyTokens(tokens: Readonly<Record<string, string>>): void {
  const style = document.documentElement.style;
  for (const token of Object.keys(selectedTokens ?? {})) style.removeProperty(token);
  for (const token of ACCENT_TOKENS) style.removeProperty(token);
  for (const [token, value] of Object.entries(tokens)) {
    style.setProperty(token, value);
  }
}

/** The accent as chosen, or moved to the lightness that reads on these surfaces (hue kept). */
function solvedAccent(accent: string, surfaces: readonly Rgb[] | undefined): string {
  const source = parseColor(accent);
  if (!source || !surfaces?.length) return accent;
  const solved = readableOn(source, surfaces, TEXT_CONTRAST);
  return solved === source ? accent : toHex(solved);
}

/**
 * The accent roles for a user accent. Without surfaces the accent is used as
 * chosen. With them, each mode the theme carries gets the accent at a lightness
 * that reads on its page (a bright amber darkens on a light theme and stays as
 * it is on a dark one), paired through `light-dark()` when the theme has both;
 * hover then moves toward that mode's ink instead of always toward white.
 */
export function accentOverrideTokens(accent: string, surfaces: AccentSurfaces = {}): Record<string, string> {
  const light = surfaces.light ? solvedAccent(accent, surfaces.light) : undefined;
  const dark = surfaces.dark ? solvedAccent(accent, surfaces.dark) : undefined;
  const pair = (forLight: string, forDark: string) => light !== undefined && dark !== undefined
    ? (forLight === forDark ? forLight : `light-dark(${forLight}, ${forDark})`)
    : light !== undefined ? forLight : forDark;
  const color = light === undefined && dark === undefined ? accent : pair(light ?? accent, dark ?? accent);
  const ink = light === undefined && dark === undefined
    ? controlUiAccentInk(accent)
    : pair(controlUiAccentInk(light ?? accent), controlUiAccentInk(dark ?? accent));
  const hover = (token: string) => {
    const toward = (target: string) => `color-mix(in srgb, var(${token}) 82%, ${target} 18%)`;
    return light === undefined && dark === undefined ? toward("white") : pair(toward("black"), toward("white"));
  };
  return {
    "--ring": color,
    "--accent": color,
    "--accent-muted": color,
    "--primary": color,
    "--accent-foreground": ink,
    "--primary-foreground": ink,
    "--accent-hover": hover("--accent"),
    "--primary-hover": hover("--primary"),
    "--accent-subtle": "color-mix(in srgb, var(--accent) 16%, transparent)",
    "--accent-glow": "color-mix(in srgb, var(--accent) 30%, transparent)",
    "--focus": "color-mix(in srgb, var(--ring) 22%, transparent)",
    "--focus-ring": "0 0 0 2px var(--bg), 0 0 0 3px color-mix(in srgb, var(--ring) 80%, transparent)",
    "--focus-glow": "0 0 0 2px var(--bg), 0 0 0 3px var(--ring), 0 0 16px var(--accent-glow)",
  };
}

/** Same semantic override OpenClaw applies: accent also owns primary and focus. */
export function applyAccent(accent: string): void {
  const style = document.documentElement.style;
  if (!accent) {
    for (const token of ACCENT_TOKENS) {
      const inherited = selectedTokens?.[token];
      if (inherited) style.setProperty(token, inherited);
      else style.removeProperty(token);
    }
    return;
  }
  for (const [token, value] of Object.entries(accentOverrideTokens(accent, selectedSurfaces))) style.setProperty(token, value);
}

function acceptList(body: { themes?: ThemeRef[] }): readonly ThemeRef[] {
  themes = (body.themes ?? []).filter((theme) => theme.id && theme.url);
  return themes;
}

export async function loadThemes(): Promise<readonly ThemeRef[]> {
  try {
    acceptList(await fetchThemeList());
  } catch {
    themes = [];
  }
  return themes;
}

/**
 * Applies a theme's tokens. Returns its variant, or undefined if the file did
 * not resolve — in which case nothing is committed, so the previous theme stays
 * fully in place instead of half-applied.
 */
export async function applyTheme(id: string): Promise<ThemeVariant | undefined> {
  const theme = themes.find((candidate) => candidate.id === id) ?? themes[0];
  if (!theme) {
    return undefined;
  }
  const raw = await readTheme(theme);
  const mapped = raw ? mapTheme(raw) : undefined;
  if (!mapped) {
    return undefined;
  }
  // Built-ins use the complete version-pinned CSS, including shadows/focus.
  // Preview JSON is not a substitute. A user file with the same id stays custom.
  const palette = builtinPalette(theme);
  const tokens = palette ? {} : mapped.tokens;
  applyTokens(tokens);
  selectedTokens = tokens;
  selectedSurfaces = accentSurfaces(mapped.modes);
  applyAccent(currentSettings().accent);
  document.documentElement.dataset["themeFamily"] = theme.id;
  document.documentElement.dataset["themePalette"] = palette ?? "custom";
  selectedId = theme.id;
  selectedVariant = mapped.variant;
  // The variant is what decides the forced color-scheme, so it is re-applied
  // here rather than left to each caller. Forgetting it is how a dark-only
  // theme ends up under light native controls.
  applyThemeMode(currentSettings().themeMode, selectedVariant);
  return selectedVariant;
}

/** Applies the mode against the active theme's variant, never in isolation. */
export function applyMode(mode: ThemeMode): void {
  applyThemeMode(mode, selectedVariant);
}

/**
 * Swatch colors for every theme, so Settings can show what a theme looks like
 * before it is applied. Loaded after first paint and skippable: a theme whose
 * file fails to load simply gets no card.
 */
export async function loadThemePreviews(): Promise<ThemePreview[]> {
  const previews = await Promise.all(
    themes.map(async (theme) => {
      const raw = await readTheme(theme);
      const swatches = raw ? swatchesFor(raw) : undefined;
      return swatches ? { id: theme.id, name: theme.name, ...swatches } : undefined;
    }),
  );
  return previews.filter((preview) => preview !== undefined);
}

/**
 * Fetches a tweakcn theme through the backend and refreshes the list. Throws
 * with a message worth showing, because the user typed the link.
 */
export async function importTheme(url: string): Promise<string> {
  const body = await postThemeImport(url);
  if (!body.id) {
    throw new Error("The theme was imported but could not be read back.");
  }
  acceptList(body);
  return body.id;
}
