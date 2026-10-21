/**
 * Maps shadcn/tweakcn themes onto HUI's design tokens.
 *
 * This is the format tweakcn's editor publishes, and it fits an application
 * shell far better than an editor theme does: the vocabulary is UI-shaped
 * (`background`, `card`, `border`, `ring`, `sidebar`), and one file carries both
 * modes, so nothing has to be paired up.
 *
 * Two shapes are accepted, and they are the same data:
 *
 *   { "name": "...", "light": { ... }, "dark": { ... } }        what we write
 *   { "cssVars": { "theme": {}, "light": {}, "dark": {} } }     a registry item
 *
 * Nothing here touches the DOM — it is a pure transform so it can be tested
 * without a browser. Every value it emits is a bare color, because the pairing
 * step wraps them in `light-dark()`, which accepts nothing else.
 *
 * It also owns the contrast contract (`CONTRAST_RULES`): where a theme's colors
 * meet, the foreground must stay readable. A theme color that falls short keeps
 * its hue and moves only its lightness, through `color-contrast.ts`.
 */
import type { ThemeVariant } from "./theme.ts";
import { parseColor, mixRgb, readableOn, toHex, worstContrast, TEXT_CONTRAST, UI_CONTRAST, type Rgb } from "./color-contrast.ts";

export type ThemeBlock = Record<string, string>;

export type ShadcnTheme = {
  name?: unknown;
  light?: unknown;
  dark?: unknown;
  cssVars?: { light?: unknown; dark?: unknown; theme?: unknown };
};

/**
 * OpenClaw's complete semantic color contract. Keeping this list explicit is
 * intentional: a theme switch must update every surface, not only the page
 * background and one accent swatch.
 */
export const THEME_COLOR_TOKENS = [
  "--bg",
  "--bg-accent",
  "--bg-elevated",
  "--bg-hover",
  "--bg-muted",
  "--bg-content",
  "--card",
  "--card-foreground",
  "--card-highlight",
  "--popover",
  "--popover-foreground",
  "--panel",
  "--panel-strong",
  "--panel-hover",
  "--chrome",
  "--chrome-strong",
  "--text",
  "--text-strong",
  "--chat-text",
  "--muted",
  "--muted-strong",
  "--muted-foreground",
  "--border",
  "--border-strong",
  "--border-hover",
  "--input",
  "--ring",
  "--accent",
  "--accent-hover",
  "--accent-muted",
  "--accent-subtle",
  "--accent-foreground",
  "--accent-glow",
  "--primary",
  "--primary-hover",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--accent-2",
  "--accent-2-muted",
  "--accent-2-subtle",
  "--destructive",
  "--destructive-hover",
  "--destructive-foreground",
  "--danger",
  "--danger-muted",
  "--danger-subtle",
  "--focus",
  "--grid-line",
] as const;

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
export type ThemeTokens = Record<ThemeColorToken, string>;

export type ThemeSwatches = {
  accent: string;
  text: string;
  raised: string;
  background: string;
};

export type MappedTheme = {
  tokens: ThemeTokens;
  /** Which modes the file actually carries. */
  variant: ThemeVariant;
  /** Each mode's own tokens before pairing, for code that solves colors against that mode's surfaces. */
  modes: { light?: ThemeTokens; dark?: ThemeTokens };
};

/**
 * Every place a foreground meets a surface, and the WCAG 2 contrast it needs there: text levels for anything
 * read as text (body, metadata, links in the accent, errors), the UI level for focus rings and filled actions
 * against the page. Rules run in order, so a fill is settled before the text drawn on it.
 */
export const CONTRAST_RULES: readonly { token: ThemeColorToken; on: readonly ThemeColorToken[]; ratio: number }[] = [
  { token: "--text", on: ["--bg", "--card", "--popover"], ratio: TEXT_CONTRAST },
  { token: "--card-foreground", on: ["--card"], ratio: TEXT_CONTRAST },
  { token: "--popover-foreground", on: ["--popover"], ratio: TEXT_CONTRAST },
  { token: "--muted", on: ["--bg", "--card", "--popover"], ratio: TEXT_CONTRAST },
  { token: "--accent", on: ["--bg", "--card"], ratio: TEXT_CONTRAST },
  { token: "--destructive", on: ["--bg", "--card"], ratio: TEXT_CONTRAST },
  { token: "--ring", on: ["--bg"], ratio: UI_CONTRAST },
  { token: "--primary", on: ["--bg"], ratio: UI_CONTRAST },
  { token: "--accent-foreground", on: ["--accent"], ratio: TEXT_CONTRAST },
  { token: "--primary-foreground", on: ["--primary"], ratio: TEXT_CONTRAST },
  { token: "--secondary-foreground", on: ["--secondary"], ratio: TEXT_CONTRAST },
  { token: "--destructive-foreground", on: ["--destructive"], ratio: TEXT_CONTRAST },
];

/** Roles that default to a ruled token's value follow it when it moves, unless the theme set them itself. */
const FOLLOWERS: Partial<Record<ThemeColorToken, readonly ThemeColorToken[]>> = {
  "--text": ["--text-strong", "--chat-text"],
  "--muted": ["--muted-foreground"],
  "--accent": ["--accent-muted"],
  "--primary": ["--accent-2"],
  "--destructive": ["--danger"],
};

/**
 * Theme files arrive over the network, so a color has to look like a color.
 * Without this a crafted value would reach an inline `style` attribute and could
 * add declarations of its own.
 */
const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([a-z0-9+\-.,/%\s]+\)|transparent|currentcolor|[a-z]{3,20})$/i;

/**
 * Mixing toward the foreground darkens a light theme and lightens a dark one,
 * so a single derivation rule covers both modes. A complete tweakcn theme never
 * needs this, but a hand-written or partial one does.
 */
function mix(color: string, percent: number, into: string): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${into})`;
}

function pick(block: ThemeBlock, key: string): string | undefined {
  const value = block[key]?.trim();
  return value && SAFE_COLOR.test(value) ? value : undefined;
}

/** Built-in themes may carry OpenClaw's richer semantic roles in addition to
 * the shadcn vocabulary. Imported tweakcn themes simply fall back to the same
 * derivations OpenClaw uses. */
function semantic(block: ThemeBlock, key: string, fallback: string): string {
  return pick(block, key) ?? fallback;
}

function asBlock(value: unknown): ThemeBlock | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const block: ThemeBlock = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      block[key] = raw;
    }
  }
  return Object.keys(block).length > 0 ? block : undefined;
}

function readBlock(theme: ShadcnTheme, mode: "light" | "dark"): ThemeBlock | undefined {
  const modeBlock = asBlock(theme.cssVars?.[mode]) ?? asBlock(theme[mode]);
  if (!modeBlock) {
    return undefined;
  }
  return { ...(asBlock(theme.cssVars?.theme) ?? {}), ...modeBlock };
}

const OWN_MIX = /^color-mix\(in srgb, (.+) (\d+(?:\.\d+)?)%, (.+)\)$/u;

/**
 * A theme token as sRGB when it is a concrete color or one of this module's own
 * `mix()` derivations of concrete colors; undefined for anything only the page
 * can resolve (`var()`, `light-dark()`, translucent mixes).
 */
export function themeColor(value: string | undefined): Rgb | undefined {
  if (!value) return undefined;
  const direct = parseColor(value);
  if (direct) return direct;
  const mixed = OWN_MIX.exec(value.trim());
  if (!mixed) return undefined;
  const top = parseColor(mixed[1]!);
  const bottom = parseColor(mixed[3]!);
  return top && bottom ? mixRgb(top, bottom, Number(mixed[2]) / 100) : undefined;
}

/**
 * Applies `CONTRAST_RULES` to one mode's tokens. A rule whose colors cannot all
 * be read here is skipped rather than guessed; one that already holds leaves the
 * theme's value untouched.
 */
function withReadableContrast(tokens: ThemeTokens): ThemeTokens {
  const result = { ...tokens };
  for (const rule of CONTRAST_RULES) {
    const color = themeColor(result[rule.token]);
    const surfaces = rule.on.map((token) => themeColor(result[token]));
    if (!color || !surfaces.every((surface): surface is Rgb => surface !== undefined)) continue;
    if (worstContrast(color, surfaces) >= rule.ratio) continue;
    const before = result[rule.token];
    const after = toHex(readableOn(color, surfaces, rule.ratio));
    result[rule.token] = after;
    for (const follower of FOLLOWERS[rule.token] ?? []) {
      if (result[follower] === before) result[follower] = after;
    }
  }
  return result;
}

/** Resolves one mode's block into a full token set, or undefined if it carries
 * no usable background or foreground. Colors that fail `CONTRAST_RULES` come
 * back moved just far enough to pass. */
export function modeTokens(theme: ShadcnTheme, mode: "light" | "dark"): ThemeTokens | undefined {
  const block = readBlock(theme, mode);
  if (!block) {
    return undefined;
  }
  const isLight = mode === "light";
  const contrastTarget = isLight ? "black" : "white";
  const bg = pick(block, "background");
  const fg = pick(block, "foreground");
  if (!bg || !fg) {
    return undefined;
  }

  const card = pick(block, "card") ?? mix(fg, 6, bg);
  const cardForeground = pick(block, "card-foreground") ?? fg;
  const popover = pick(block, "popover") ?? card;
  const popoverForeground = pick(block, "popover-foreground") ?? cardForeground;
  const mutedSurface = pick(block, "muted") ?? mix(fg, 8, bg);
  const mutedForeground = pick(block, "muted-foreground") ?? mix(fg, 60, bg);
  const border = pick(block, "border") ?? mix(fg, 20, bg);
  const input = pick(block, "input") ?? border;
  const ring = pick(block, "ring") ?? fg;
  const accent = pick(block, "accent") ?? ring;
  const accentForeground = pick(block, "accent-foreground") ?? (isLight ? "#ffffff" : "#000000");
  const primary = pick(block, "primary") ?? accent;
  const primaryForeground = pick(block, "primary-foreground") ?? accentForeground;
  const secondary = pick(block, "secondary") ?? card;
  const secondaryForeground = pick(block, "secondary-foreground") ?? fg;
  const destructive = pick(block, "destructive") ?? (isLight ? "#b91c1c" : "#f87171");
  const destructiveForeground = pick(block, "destructive-foreground") ?? "#fafafa";

  return withReadableContrast({
    "--bg": bg,
    "--bg-accent": semantic(block, "bg-accent", "color-mix(in srgb, var(--bg) 88%, var(--card) 12%)"),
    "--bg-elevated": semantic(block, "bg-elevated", card),
    "--bg-hover": semantic(block, "bg-hover", "color-mix(in srgb, var(--muted) 68%, var(--bg) 32%)"),
    "--bg-muted": semantic(block, "bg-muted", mutedSurface),
    "--bg-content": semantic(block, "bg-content", "color-mix(in srgb, var(--bg) 92%, var(--card) 8%)"),
    "--card": card,
    "--card-foreground": cardForeground,
    "--card-highlight": `color-mix(in srgb, var(--text) ${isLight ? "3" : "5"}%, transparent)`,
    "--popover": popover,
    "--popover-foreground": popoverForeground,
    "--panel": semantic(block, "panel", bg),
    "--panel-strong": semantic(block, "panel-strong", card),
    "--panel-hover": semantic(block, "panel-hover", "color-mix(in srgb, var(--card) 76%, var(--muted) 24%)"),
    "--chrome": semantic(block, "chrome", "color-mix(in srgb, var(--bg) 96%, transparent)"),
    "--chrome-strong": semantic(block, "chrome-strong", "color-mix(in srgb, var(--bg) 98%, transparent)"),
    "--text": fg,
    "--text-strong": semantic(block, "text-strong", fg),
    "--chat-text": semantic(block, "chat-text", fg),
    "--muted": mutedForeground,
    "--muted-strong": semantic(block, "muted-strong", "color-mix(in srgb, var(--muted) 84%, var(--text) 16%)"),
    "--muted-foreground": mutedForeground,
    "--border": border,
    "--border-strong": semantic(block, "border-strong", "color-mix(in srgb, var(--border) 72%, var(--text) 28%)"),
    "--border-hover": semantic(block, "border-hover", "color-mix(in srgb, var(--border) 55%, var(--text) 45%)"),
    "--input": input,
    "--ring": ring,
    "--accent": accent,
    "--accent-hover": semantic(block, "accent-hover", `color-mix(in srgb, var(--accent) 82%, ${contrastTarget} 18%)`),
    "--accent-muted": semantic(block, "accent-muted", accent),
    "--accent-subtle": semantic(block, "accent-subtle", `color-mix(in srgb, var(--accent) ${isLight ? "10" : "16"}%, transparent)`),
    "--accent-foreground": accentForeground,
    "--accent-glow": semantic(block, "accent-glow", `color-mix(in srgb, var(--accent) ${isLight ? "18" : "30"}%, transparent)`),
    "--primary": primary,
    "--primary-hover": semantic(block, "primary-hover", `color-mix(in srgb, var(--primary) 82%, ${contrastTarget} 18%)`),
    "--primary-foreground": primaryForeground,
    "--secondary": secondary,
    "--secondary-foreground": secondaryForeground,
    "--accent-2": semantic(block, "accent-2", primary),
    "--accent-2-muted": semantic(block, "accent-2-muted", "color-mix(in srgb, var(--accent-2) 72%, transparent)"),
    "--accent-2-subtle": semantic(block, "accent-2-subtle", `color-mix(in srgb, var(--accent-2) ${isLight ? "8" : "12"}%, transparent)`),
    "--destructive": destructive,
    "--destructive-hover": semantic(block, "destructive-hover", `color-mix(in srgb, var(--destructive) 82%, ${contrastTarget} 18%)`),
    "--destructive-foreground": destructiveForeground,
    "--danger": destructive,
    "--danger-muted": semantic(block, "danger-muted", "color-mix(in srgb, var(--danger) 75%, transparent)"),
    "--danger-subtle": semantic(block, "danger-subtle", `color-mix(in srgb, var(--danger) ${isLight ? "8" : "12"}%, transparent)`),
    "--focus": semantic(block, "focus", `color-mix(in srgb, var(--ring) ${isLight ? "14" : "22"}%, transparent)`),
    "--grid-line": semantic(block, "grid-line", `color-mix(in srgb, var(--text) ${isLight ? "4" : "3"}%, transparent)`),
  });
}

/**
 * Combines the modes into what the token layer expects: with both present every
 * token becomes a `light-dark()` pair, with one it is a plain value and the
 * theme can only render that mode. Undefined means the theme is unusable.
 */
export function mapTheme(theme: ShadcnTheme): MappedTheme | undefined {
  const light = modeTokens(theme, "light");
  const dark = modeTokens(theme, "dark");

  if (!light && !dark) {
    return undefined;
  }
  if (!light) {
    return { tokens: dark as ThemeTokens, variant: "dark", modes: { dark } };
  }
  if (!dark) {
    return { tokens: light, variant: "light", modes: { light } };
  }

  const paired = {} as ThemeTokens;
  for (const token of THEME_COLOR_TOKENS) {
    paired[token] = `light-dark(${light[token]}, ${dark[token]})`;
  }
  return { tokens: paired, variant: "both", modes: { light, dark } };
}

/**
 * A few plain colors for a theme card. Read from the real mapping rather than a
 * hand-maintained copy, so a preview cannot drift from the theme it previews.
 * Prefers the dark block, which reads better as a thumbnail.
 */
export function swatchesFor(theme: ShadcnTheme): ThemeSwatches | undefined {
  const tokens = modeTokens(theme, "dark") ?? modeTokens(theme, "light");
  if (!tokens) {
    return undefined;
  }
  return {
    accent: tokens["--ring"],
    text: tokens["--text"],
    raised: tokens["--card"],
    background: tokens["--bg"],
  };
}
