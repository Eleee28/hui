/**
 * The terminal's colors from HUI's active theme: background and text from the pane, the accent for the cursor and
 * selection, and an ANSI palette solved for that background. The palette keeps the hues of Gespenst's default dark
 * palette on dark themes (GitHub Light's on light ones) and moves each color's lightness only as far as it needs to
 * read on the actual pane, as Pi's system theme does (`color-contrast.ts`). The terminal pane resolves the CSS colors
 * and reapplies this whenever the theme, mode or accent changes, so open terminals recolor live.
 */
import { luminance, parseColor, readableOn, toHex, TEXT_CONTRAST, UI_CONTRAST, type Rgb } from "../theme/color-contrast.ts";

export { luminance, type Rgb };
export type TerminalThemeColors = { background: Rgb; foreground: Rgb; accent: Rgb };

export const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
export type AnsiName = (typeof ANSI_NAMES)[number];
type AnsiPalette = Record<AnsiName, string>;

/** Gespenst's default (Tomorrow Night) palette, the hues dark themes start from. */
const DARK_ANSI: AnsiPalette = {
  black: "#1d1f21", red: "#cc6666", green: "#b5bd68", yellow: "#f0c674", blue: "#81a2be", magenta: "#b294bb", cyan: "#8abeb7", white: "#c5c8c6",
  brightBlack: "#666666", brightRed: "#d57878", brightGreen: "#c3ca7c", brightYellow: "#f9d78e", brightBlue: "#95b6d2", brightMagenta: "#c6a8cf", brightCyan: "#9ed2cb", brightWhite: "#ffffff",
};

/** GitHub Light's terminal palette, the hues light themes start from. */
const LIGHT_ANSI: AnsiPalette = {
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
};

/**
 * The contrast each ANSI color needs on the background. Colors and the far neutrals are text (programs print in
 * them); the dim neutral next to the background (bright black on dark, white on light) is secondary text and needs
 * the UI level; the neutral that matches the background (black on dark, bright white on light) is meant to blend in
 * and is left alone.
 */
function ansiTarget(name: AnsiName, light: boolean): number | undefined {
  if (name === (light ? "brightWhite" : "black")) return undefined;
  if (name === (light ? "white" : "brightBlack")) return UI_CONTRAST;
  return TEXT_CONTRAST;
}

/** The sixteen ANSI colors for this background, each moved in lightness only as far as it needs to read there. */
export function ansiPalette(background: Rgb, light: boolean): AnsiPalette {
  const source = light ? LIGHT_ANSI : DARK_ANSI;
  const palette = { ...source };
  for (const name of ANSI_NAMES) {
    const ratio = ansiTarget(name, light);
    const color = parseColor(source[name]);
    if (ratio === undefined || !color) continue;
    const solved = readableOn(color, [background], ratio);
    if (solved !== color) palette[name] = toHex(solved);
  }
  return palette;
}

function mix(top: Rgb, bottom: Rgb, amount: number): Rgb {
  const blend = (a: number, b: number) => Math.round(a * amount + b * (1 - amount));
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b) };
}

/** A complete Gespenst theme (setTheme replaces the previous one, so a dark theme drops the light palette). */
export function terminalTheme({ background, foreground, accent }: TerminalThemeColors) {
  const light = luminance(background) > 0.4;
  return {
    appearance: light ? "light" as const : "dark" as const,
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: mix(accent, background, light ? 0.28 : 0.4),
    selectionInactiveBackground: mix(accent, background, 0.18),
    ...ansiPalette(background, light),
  };
}

/** Reads `rgb(…)`/`rgba(…)` (as getImageData or computed styles report sRGB) into channels; undefined otherwise. */
export function parseRgb(value: string): Rgb | undefined {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/u.exec(value.trim());
  if (!match) return undefined;
  const [r, g, b] = match.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))));
  return { r: r!, g: g!, b: b! };
}
