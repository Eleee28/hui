/**
 * Contrast-driven color math for HUI's themes: parsing concrete CSS colors, WCAG 2 contrast, sRGB ↔ OKLCH, and a
 * solver that keeps a color's hue but moves its lightness until it reads on every surface it is drawn on.
 *
 * The approach follows Pi's system theme (https://earendil.com/posts/system-theme/): the palette chooses hue and
 * colorfulness, contrast chooses lightness, and a moved color never becomes more colorful than its source (it is
 * capped by the source's chroma and by what sRGB can show at the new lightness). A color that already reaches the
 * required contrast is returned unchanged, so a theme author's or user's choice is only touched where it fails.
 * Pure functions, no DOM: every caller hands in colors it has already resolved.
 */

/** sRGB channels, 0–255. */
export type Rgb = { r: number; g: number; b: number };
/** OKLCH: lightness 0–1, chroma ≥ 0, hue in degrees. */
export type Oklch = { l: number; c: number; h: number };

/** WCAG 2 minimums: normal text, and large text or UI components such as focus rings. */
export const TEXT_CONTRAST = 4.5;
export const UI_CONTRAST = 3;

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

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2 contrast ratio, 1 (none) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Linear sRGB → OKLab (Björn Ottosson's matrices). */
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

export function toOklch({ r, g, b }: Rgb): Oklch {
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

/** The most chroma sRGB can show at this OKLCH lightness and hue. */
export function maxChroma(l: number, h: number): number {
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

/** An OKLCH color as sRGB, with chroma reduced (never lightness or hue) until it fits the sRGB gamut. */
export function fromOklch(color: Oklch): Rgb {
  const l = Math.max(0, Math.min(1, color.l));
  const c = Math.min(Math.max(0, color.c), maxChroma(l, color.h));
  const [r, g, b] = oklchToLinear({ l, c, h: color.h }).map((channel) =>
    Math.round(Math.max(0, Math.min(255, fromLinear(Math.max(0, Math.min(1, channel)))))));
  return { r: r!, g: g!, b: b! };
}

export function toHex({ r, g, b }: Rgb): string {
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

/**
 * A concrete CSS color as sRGB: hex, `rgb()`, `hsl()` and `oklch()`, alpha ignored. Anything else (`var()`,
 * `color-mix()`, `light-dark()`, named colors) is undefined: callers that need those resolve them in the page first.
 */
export function parseColor(value: string): Rgb | undefined {
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

/** `color` composited over `under` at `amount` (0–1) of `color`, in sRGB like `color-mix(in srgb, …)`. */
export function mixRgb(color: Rgb, under: Rgb, amount: number): Rgb {
  const blend = (top: number, bottom: number) => Math.round(top * amount + bottom * (1 - amount));
  return { r: blend(color.r, under.r), g: blend(color.g, under.g), b: blend(color.b, under.b) };
}

/** The lowest contrast `color` has against any of the surfaces. */
export function worstContrast(color: Rgb, surfaces: readonly Rgb[]): number {
  return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

/** The first lightness from `from` toward `to` whose color reaches `ratio`, or undefined if even `to` does not. */
function searchLightness(source: Oklch, from: number, to: number, surfaces: readonly Rgb[], ratio: number): Rgb | undefined {
  const at = (l: number) => fromOklch({ l, c: Math.min(source.c, maxChroma(l, source.h)), h: source.h });
  if (worstContrast(at(to), surfaces) < ratio) return undefined;
  // Moving away from the surfaces only raises the contrast, so bisection finds the smallest move that reads.
  let fail = from;
  let pass = to;
  for (let step = 0; step < 24; step += 1) {
    const mid = (fail + pass) / 2;
    if (worstContrast(at(mid), surfaces) >= ratio) pass = mid;
    else fail = mid;
  }
  return at(pass);
}

/**
 * `source` with its hue kept and its lightness moved just far enough to reach `ratio` against every surface. The
 * chroma never exceeds the source's, so a pale color that has to darken does not turn vivid. Unchanged when it
 * already reads; when no lightness reaches the ratio, the extreme that comes closest.
 */
export function readableOn(source: Rgb, surfaces: readonly Rgb[], ratio: number): Rgb {
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
