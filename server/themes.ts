/**
 * Themes: the built-in ones shipped beside the gateway (`themes/`) merged with the user's in the config directory,
 * where a user theme wins on the same id, and importing a tweakcn theme into the user's. Only files discovered here
 * are ever served, by route key, so a request cannot name a path of its own.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { USER_THEME_DIR } from "./paths.ts";
import type { ThemeRef } from "./api/themes.ts";

export const THEME_FILE_ROUTE = "/__hui/themes/file/";

/** Import is the one thing here that reaches the network, so it is tightly
 * bounded: one host, one shape, a size cap and a timeout. */
const TWEAKCN_HOSTS = new Set(["tweakcn.com", "www.tweakcn.com"]);
const TWEAKCN_REGISTRY = "https://tweakcn.com/r/themes/";
const MAX_THEME_BYTES = 200_000;
const FETCH_TIMEOUT_MS = 10_000;
const THEME_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const BUILTIN_THEME_DIR = fileURLToPath(new URL("../themes/", import.meta.url));

type ThemeSource = "builtin" | "user";

export type ThemeEntry = {
  id: string;
  name: string;
  source: ThemeSource;
  /** Filename within the source directory. */
  file: string;
};

type ThemeListing = {
  themes: ThemeRef[];
  /** Route key -> absolute path. Only files we discovered are ever served, so a
   * request can never name a path of its own. */
  files: Map<string, string>;
};

/** Creating both directories is what gives a fresh install somewhere obvious to
 * drop a theme file. */
export async function ensureConfigDir(): Promise<void> {
  await mkdir(USER_THEME_DIR, { recursive: true });
}

/**
 * A file is a theme if it carries at least one usable mode. Its own `name`
 * labels it, so nothing has to be declared anywhere else.
 */
async function readThemeFile(
  dir: string,
  file: string,
  source: ThemeSource,
): Promise<ThemeEntry | undefined> {
  const id = file.slice(0, -".json".length);
  if (!id) {
    return undefined;
  }
  try {
    const theme = JSON.parse(await readFile(join(dir, file), "utf8")) as ShadcnTheme;
    if (!mapTheme(theme)) {
      return undefined;
    }
    const name = typeof theme.name === "string" && theme.name.trim() ? theme.name.trim() : id;
    return { id, name, source, file };
  } catch {
    // A malformed file is skipped rather than taking the whole list down.
    return undefined;
  }
}

export async function discoverThemes(
  dir: string,
  source: ThemeSource,
): Promise<ThemeEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .toSorted()
      .map((name) => readThemeFile(dir, name, source)),
  );
  return found.filter((entry) => entry !== undefined);
}

/**
 * User themes win on an id collision, which is what makes copying a built-in
 * into the config directory the way to customise one.
 */
export function mergeThemes(
  user: readonly ThemeEntry[],
  builtin: readonly ThemeEntry[],
): ThemeEntry[] {
  const merged: ThemeEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...user, ...builtin]) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      merged.push(entry);
    }
  }
  return merged;
}

export async function listThemes(): Promise<ThemeListing> {
  const [builtin, user] = await Promise.all([
    discoverThemes(BUILTIN_THEME_DIR, "builtin"),
    discoverThemes(USER_THEME_DIR, "user"),
  ]);

  const files = new Map<string, string>();
  const themes: ThemeListing["themes"] = [];
  for (const entry of mergeThemes(user, builtin)) {
    const root = entry.source === "user" ? USER_THEME_DIR : BUILTIN_THEME_DIR;
    const key = `${entry.source}/${entry.file}`;
    files.set(key, join(root, entry.file));
    themes.push({ id: entry.id, name: entry.name, url: `${THEME_FILE_ROUTE}${key}` });
  }
  return { themes, files };
}

/* ── tweakcn import ──────────────────────────────────────────────────────── */

/** Accepts an editor link, a share link, a registry link, a bare theme id, or
 * any of those pasted inside a sentence. */
export function registryUrlFor(input: string): URL {
  // Anything before the link is noise, and a trailing full stop is punctuation.
  const embedded = input.match(/https?:\/\/(?:www\.)?tweakcn\.com\/[^\s<>"')]+/i)?.[0];
  const cleaned = (embedded ?? input).trim().replace(/[.,;:]+$/, "");
  if (!cleaned) {
    throw new Error("Paste a tweakcn theme link or theme id.");
  }
  if (!embedded && THEME_ID.test(cleaned)) {
    return new URL(`${TWEAKCN_REGISTRY}${cleaned}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error("Paste a tweakcn theme link or theme id.");
  }
  if (!TWEAKCN_HOSTS.has(parsed.hostname)) {
    throw new Error("Only tweakcn.com links can be imported.");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[0] === "editor" && segments[1] === "theme") {
    const editorTheme = parsed.searchParams.get("theme")?.trim() ?? "";
    if (!THEME_ID.test(editorTheme)) {
      throw new Error("That tweakcn editor link does not select a valid theme.");
    }
    return new URL(`${TWEAKCN_REGISTRY}${editorTheme}`);
  }
  const id = segments.at(-1);
  const shaped =
    (segments.length === 2 && segments[0] === "themes") ||
    (segments.length === 3 && segments[0] === "r" && segments[1] === "themes");
  if (!shaped || !id || !THEME_ID.test(id)) {
    throw new Error("That is not a tweakcn theme link.");
  }
  return new URL(`${TWEAKCN_REGISTRY}${id}`);
}

async function readLimited(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("tweakcn returned an empty response.");
  }
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("That theme is too large to import.");
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** Fetches a tweakcn theme and writes it into the config directory. Returns the
 * id it was stored under. */
export async function importTweakcnTheme(input: string): Promise<string> {
  const url = registryUrlFor(input);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`tweakcn returned HTTP ${response.status} for that theme.`);
  }
  // A redirect is the one way this could be pointed somewhere else.
  if (!TWEAKCN_HOSTS.has(new URL(response.url).hostname)) {
    throw new Error("tweakcn redirected off-site; refusing the import.");
  }

  const item = JSON.parse(await readLimited(response, MAX_THEME_BYTES)) as ShadcnTheme;
  const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;

  // Stored in the shape we read: both blocks at the top level, no cssVars
  // wrapper, and nothing the app cannot use.
  const stored: ShadcnTheme = { name };
  const light = item.cssVars?.light;
  const dark = item.cssVars?.dark;
  if (light && typeof light === "object") {
    stored.light = light;
  }
  if (dark && typeof dark === "object") {
    stored.dark = dark;
  }
  if (!mapTheme(stored)) {
    throw new Error("That theme has no usable light or dark palette.");
  }

  await ensureConfigDir();
  await writeFile(join(USER_THEME_DIR, `${id}.json`), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  return id;
}

type ThemeVariant = "light" | "dark" | "both";

type Rgb = { r: number; g: number; b: number };

type Oklch = { l: number; c: number; h: number };

const TEXT_CONTRAST = 4.5;
const UI_CONTRAST = 3;

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function toLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const c = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return c * 255;
}

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function toOklch({ r, g, b }: Rgb): Oklch {
  const [l, a, bb] = linearToOklab(toLinear(r), toLinear(g), toLinear(b));
  const c = Math.hypot(a, bb);
  const h = c < 1e-6 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { l, c, h };
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const radians = (h * Math.PI) / 180;
  return oklabToLinear(l, c * Math.cos(radians), c * Math.sin(radians));
}

const GAMUT_EPSILON = 1e-4;

function inGamut(linear: readonly number[]): boolean {
  return linear.every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);
}

function maxChroma(l: number, h: number): number {
  if (l <= 0 || l >= 1) return 0;
  let low = 0;
  let high = 0.4;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (inGamut(oklchToLinear({ l, c: mid, h }))) low = mid;
    else high = mid;
  }
  return low;
}

function fromOklch(color: Oklch): Rgb {
  const l = Math.max(0, Math.min(1, color.l));
  const c = Math.min(Math.max(0, color.c), maxChroma(l, color.h));
  const [r, g, b] = oklchToLinear({ l, c, h: color.h }).map((channel) =>
    Math.round(Math.max(0, Math.min(255, fromLinear(Math.max(0, Math.min(1, channel)))))));
  return { r: r!, g: g!, b: b! };
}

function toHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("");
}

function number(part: string, scale: number): number {
  return part.endsWith("%") ? (Number.parseFloat(part) / 100) * scale : Number.parseFloat(part);
}

function clampRgb(r: number, g: number, b: number): Rgb | undefined {
  if (![r, g, b].every(Number.isFinite)) return undefined;
  const clamp = (value: number) => Math.round(Math.max(0, Math.min(255, value)));
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

function hslToRgb(h: number, s: number, l: number): Rgb | undefined {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return clampRgb(f(0) * 255, f(8) * 255, f(4) * 255);
}

function parseColor(value: string): Rgb | undefined {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/u.exec(text)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b] = [...hex].slice(0, 3).map((digit) => Number.parseInt(digit + digit, 16));
      return clampRgb(r!, g!, b!);
    }
    if (hex.length === 6 || hex.length === 8) {
      const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
      return clampRgb(r!, g!, b!);
    }
    return undefined;
  }
  const fn = /^(rgba?|hsla?|oklch)\(([^()]*)\)$/u.exec(text);
  if (!fn) return undefined;
  const kind = fn[1]!;
  const parts = fn[2]!.split("/")[0]!.trim().split(/[\s,]+/u).filter(Boolean);
  if (parts.length < 3) return undefined;
  const [first, second, third] = parts as [string, string, string];
  if (kind.startsWith("rgb")) return clampRgb(number(first, 255), number(second, 255), number(third, 255));
  if (kind.startsWith("hsl")) {
    const s = second.endsWith("%") ? Number.parseFloat(second) / 100 : Number.parseFloat(second);
    const l = third.endsWith("%") ? Number.parseFloat(third) / 100 : Number.parseFloat(third);
    const h = Number.parseFloat(first);
    return [h, s, l].every(Number.isFinite) ? hslToRgb(((h % 360) + 360) % 360, s, l) : undefined;
  }
  const l = number(first, 1);
  const c = number(second, 0.4);
  const h = Number.parseFloat(third);
  if (![l, c].every(Number.isFinite)) return undefined;
  return fromOklch({ l, c, h: Number.isFinite(h) ? h : 0 });
}

function mixRgb(color: Rgb, under: Rgb, amount: number): Rgb {
  const blend = (top: number, bottom: number) => Math.round(top * amount + bottom * (1 - amount));
  return { r: blend(color.r, under.r), g: blend(color.g, under.g), b: blend(color.b, under.b) };
}

function worstContrast(color: Rgb, surfaces: readonly Rgb[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

function searchLightness(source: Oklch, from: number, to: number, surfaces: readonly Rgb[], ratio: number): Rgb | undefined {
  const at = (l: number) => fromOklch({ l, c: Math.min(source.c, maxChroma(l, source.h)), h: source.h });
  if (worstContrast(at(to), surfaces) < ratio) return undefined;

  let fail = from;
  let pass = to;
  for (let step = 0; step < 24; step += 1) {
    const mid = (fail + pass) / 2;
    if (worstContrast(at(mid), surfaces) >= ratio) pass = mid;
    else fail = mid;
  }
  return at(pass);
}

function readableOn(source: Rgb, surfaces: readonly Rgb[], ratio: number): Rgb {
  if (surfaces.length === 0 || worstContrast(source, surfaces) >= ratio) return source;
  const color = toOklch(source);
  const lighterFirst = worstContrast(WHITE, surfaces) >= worstContrast(BLACK, surfaces);
  const targets = lighterFirst ? [1, 0] : [0, 1];
  for (const to of targets) {
    const found = searchLightness(color, color.l, to, surfaces, ratio);
    if (found) return found;
  }
  return lighterFirst ? WHITE : BLACK;
}

type ThemeBlock = Record<string, string>;

export type ShadcnTheme = {
  name?: unknown;
  light?: unknown;
  dark?: unknown;
  cssVars?: { light?: unknown; dark?: unknown; theme?: unknown };
};

const THEME_COLOR_TOKENS = [
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

type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
type ThemeTokens = Record<ThemeColorToken, string>;

type MappedTheme = {
  tokens: ThemeTokens;

  variant: ThemeVariant;

  modes: { light?: ThemeTokens; dark?: ThemeTokens };
};

const CONTRAST_RULES: readonly { token: ThemeColorToken; on: readonly ThemeColorToken[]; ratio: number }[] = [
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

const FOLLOWERS: Partial<Record<ThemeColorToken, readonly ThemeColorToken[]>> = {
  "--text": ["--text-strong", "--chat-text"],
  "--muted": ["--muted-foreground"],
  "--accent": ["--accent-muted"],
  "--primary": ["--accent-2"],
  "--destructive": ["--danger"],
};

const SAFE_COLOR =
  /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([a-z0-9+\-.,/%\s]+\)|transparent|currentcolor|[a-z]{3,20})$/i;

function mix(color: string, percent: number, into: string): string {
  return `color-mix(in srgb, ${color} ${percent}%, ${into})`;
}

function pick(block: ThemeBlock, key: string): string | undefined {
  const value = block[key]?.trim();
  return value && SAFE_COLOR.test(value) ? value : undefined;
}

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

function themeColor(value: string | undefined): Rgb | undefined {
  if (!value) return undefined;
  const direct = parseColor(value);
  if (direct) return direct;
  const mixed = OWN_MIX.exec(value.trim());
  if (!mixed) return undefined;
  const top = parseColor(mixed[1]!);
  const bottom = parseColor(mixed[3]!);
  return top && bottom ? mixRgb(top, bottom, Number(mixed[2]) / 100) : undefined;
}

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

function modeTokens(theme: ShadcnTheme, mode: "light" | "dark"): ThemeTokens | undefined {
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
