/** Color mode is a document-level preference; the token layer in tokens.css
 * owns the actual colors. "system" defers to the OS. Nothing here is persisted;
 * settings.ts owns that. */

export const THEME_MODES = ["system", "light", "dark"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

/** Which color modes a theme actually carries. A VS Code theme file describes
 * one mode, so a theme built from a single file can only render that one. */
export type ThemeVariant = "light" | "dark" | "both";

export function normalizeThemeMode(value: unknown): ThemeMode {
  return THEME_MODES.find((mode) => mode === value) ?? "system";
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const index = (THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length;
  return THEME_MODES[index] ?? "system";
}

/**
 * The scheme the document should actually use. A single-mode theme wins over
 * the preference: a dark-only theme must not leave the browser painting light
 * scrollbars, selects and form controls over dark surfaces. An empty string
 * means "let the OS decide", which only the stylesheet can do.
 */
export function effectiveColorScheme(mode: ThemeMode, variant: ThemeVariant): "light" | "dark" | "" {
  if (variant === "light") {
    return "light";
  }
  if (variant === "dark") {
    return "dark";
  }
  return mode === "system" ? "" : mode;
}

/** Whether the active theme can honour the mode at all. */
export function modeIsSelectable(variant: ThemeVariant): boolean {
  return variant === "both";
}

export function resolvedThemeMode(mode: ThemeMode, variant: ThemeVariant, prefersDark: boolean): "light" | "dark" {
  return effectiveColorScheme(mode, variant) || (prefersDark ? "dark" : "light");
}

/** Built-in palettes use their original selectors; user files remain custom. */
export function resolvedPaletteSelector(palette: string, mode: "light" | "dark"): string {
  if (palette === "claw") return mode;
  if (palette === "rose" || palette === "miami") return mode === "light" ? `${palette}-light` : palette;
  return mode === "light" ? "custom-light" : "custom";
}

let modePreference: ThemeMode = "system";
let activeVariant: ThemeVariant = "both";
let colorSchemeQuery: MediaQueryList | undefined;

export function applyThemeMode(mode: ThemeMode, variant: ThemeVariant): void {
  modePreference = mode;
  activeVariant = variant;
  if (!colorSchemeQuery && typeof matchMedia === "function") {
    colorSchemeQuery = matchMedia("(prefers-color-scheme: dark)");
    colorSchemeQuery.addEventListener("change", () => applyThemeMode(modePreference, activeVariant));
  }
  const root = document.documentElement;
  const resolved = resolvedThemeMode(mode, variant, colorSchemeQuery?.matches ?? false);
  // Upstream selectors consume the resolved mode, not the saved preference.
  root.dataset["themePreference"] = mode;
  root.dataset["themeMode"] = resolved;
  root.classList.toggle("wa-light", resolved === "light");
  root.classList.toggle("wa-dark", resolved === "dark");
  root.dataset["theme"] = resolvedPaletteSelector(root.dataset["themePalette"] ?? "claw", resolved);
  root.style.colorScheme = resolved;
}
