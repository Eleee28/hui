import assert from "node:assert/strict";
import { test } from "vitest";

import { contrastRatio, fromOklch, maxChroma, parseColor, readableOn, toHex, toOklch, worstContrast } from "./color-contrast.ts";

const white = { r: 255, g: 255, b: 255 };
const black = { r: 0, g: 0, b: 0 };

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

test("parses the concrete color syntaxes theme files use", () => {
  assert.deepEqual(parseColor("#fff"), white);
  assert.deepEqual(parseColor("#FF5C5C"), { r: 255, g: 92, b: 92 });
  assert.deepEqual(parseColor("#ff5c5c80"), { r: 255, g: 92, b: 92 });
  assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3 });
  assert.deepEqual(parseColor("rgba(235, 188, 186, 0.12)"), { r: 235, g: 188, b: 186 });
  assert.deepEqual(parseColor("hsl(0 100% 50%)"), { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseColor("oklch(1.0000 0 0)"), white);
  assert.deepEqual(parseColor("oklch(0% 0 0)"), black);
  assert.equal(toHex(parseColor("oklch(0.6280 0.2577 29.2339)")!), "#ff0000");
  for (const value of ["var(--bg)", "light-dark(#fff, #000)", "color-mix(in srgb, red 50%, blue)", "red", "#12"]) {
    assert.equal(parseColor(value), undefined, value);
  }
});

test("WCAG contrast spans 1:1 to 21:1", () => {
  assert.equal(contrastRatio(white, black), 21);
  assert.equal(contrastRatio(white, white), 1);
  assert.equal(contrastRatio(black, white), contrastRatio(white, black));
});

test("OKLCH round-trips sRGB and clamps chroma, never lightness, to the gamut", () => {
  for (const hex of ["#ff5c5c", "#0969da", "#f0c674", "#1d1f21", "#808080"]) {
    assert.equal(toHex(fromOklch(toOklch(parseColor(hex)!))), hex);
  }
  // A blue this light cannot be very colorful; asking for more keeps the lightness and gives the most sRGB has.
  const pale = fromOklch({ l: 0.9, c: 0.3, h: 264 });
  assert.ok(Math.abs(toOklch(pale).l - 0.9) < 0.01);
  assert.ok(toOklch(pale).c <= maxChroma(0.9, 264) + 0.002);
  assert.ok(maxChroma(0.9, 100) > maxChroma(0.9, 264), "yellow holds more chroma than blue near white");
});

test("a color that already reads is returned exactly as chosen", () => {
  const ink = parseColor("#24292f")!;
  assert.equal(readableOn(ink, [white], 4.5), ink);
  assert.equal(readableOn(ink, [], 4.5), ink);
});

test("a failing color keeps its hue and moves only as far as the contrast needs", () => {
  for (const hex of ["#ff5c5c", "#f5b942", "#52c99a", "#35b9b0", "#5b9cf6", "#a78bfa", "#f472b6", "#8795a8"]) {
    const source = parseColor(hex)!;
    const solved = readableOn(source, [white], 4.5);
    const ratio = contrastRatio(solved, white);
    assert.ok(ratio >= 4.5, `${hex} reads on white (${ratio.toFixed(2)})`);
    assert.ok(ratio < 4.75, `${hex} moves no further than it needs (${ratio.toFixed(2)})`);
    assert.ok(toOklch(solved).l < toOklch(source).l, `${hex} darkens on a light page`);
    assert.ok(hueDistance(toOklch(solved).h, toOklch(source).h) < 6, `${hex} keeps its hue`);
  }
});

test("a moved color never turns more colorful than its source", () => {
  // Catppuccin Frappé's pink: 84% of the little chroma a screen has at its lightness, which a plain OKHSL
  // saturation hold would double once darkened (earendil-works/pi#10255).
  const pink = parseColor("#f4b8e4")!;
  const solved = readableOn(pink, [parseColor("#eff1f5")!], 4.5);
  assert.ok(contrastRatio(solved, parseColor("#eff1f5")!) >= 4.5);
  assert.ok(toOklch(solved).c <= toOklch(pink).c + 0.002);
});

test("every surface counts, and the dark side is searched when lighter cannot reach", () => {
  const surfaces = [parseColor("#1e1e2e")!, parseColor("#45475a")!];
  const solved = readableOn(parseColor("#6272a4")!, surfaces, 4.5);
  assert.ok(worstContrast(solved, surfaces) >= 4.5);
  assert.ok(toOklch(solved).l > toOklch(parseColor("#6272a4")!).l);

  const gray = parseColor("#808080")!;
  const onGray = readableOn(parseColor("#cc6666")!, [gray], 4.5);
  assert.ok(contrastRatio(onGray, gray) >= 4.5, "mid-gray is only readable from the dark side");
  assert.deepEqual(readableOn(parseColor("#cc6666")!, [gray], 21), black, "an unreachable ratio takes the closer extreme");
});
