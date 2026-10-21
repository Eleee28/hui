import assert from "node:assert/strict";
import { test } from "vitest";
import { contrastRatio, parseColor, toOklch } from "../theme/color-contrast.ts";
import { ANSI_NAMES, luminance, parseRgb, terminalTheme } from "./theme.ts";

const white = { r: 255, g: 255, b: 255 };
const ink = { r: 30, g: 30, b: 30 };
const accent = { r: 0, g: 100, b: 255 };

/** Gespenst's own default palette, which a dark theme starts from. */
const GESPENST = {
  black: "#1d1f21", red: "#cc6666", green: "#b5bd68", yellow: "#f0c674", blue: "#81a2be", magenta: "#b294bb", cyan: "#8abeb7", white: "#c5c8c6",
  brightBlack: "#666666", brightRed: "#d57878", brightGreen: "#c3ca7c", brightYellow: "#f9d78e", brightBlue: "#95b6d2", brightMagenta: "#c6a8cf", brightCyan: "#9ed2cb", brightWhite: "#ffffff",
};

const hexContrast = (hex: string, background: { r: number; g: number; b: number }) => contrastRatio(parseColor(hex)!, background);

test("a dark theme uses the accent for cursor and selection", () => {
  const theme = terminalTheme({ background: ink, foreground: white, accent });
  assert.equal(theme.appearance, "dark");
  assert.deepEqual(theme.background, ink);
  assert.deepEqual(theme.foreground, white);
  assert.deepEqual(theme.cursor, accent);
  assert.deepEqual(theme.cursorAccent, ink);
  assert.ok(luminance(theme.selectionBackground) > luminance(ink));
});

test("on Gespenst's own background the palette is Gespenst's, moved only where it falls short", () => {
  const background = parseColor("#1d1f21")!;
  const theme = terminalTheme({ background, foreground: white, accent });
  for (const name of ANSI_NAMES) {
    if (name === "red" || name === "brightBlack") continue;
    assert.equal(theme[name], GESPENST[name], name);
  }
  // Tomorrow Night's red is 4.4:1 and its bright black 2.9:1 on its own background; both just reach their level.
  assert.ok(hexContrast(theme.red, background) >= 4.5 && hexContrast(theme.red, background) < 4.6);
  assert.ok(hexContrast(theme.brightBlack, background) >= 3 && hexContrast(theme.brightBlack, background) < 3.1);
});

test("every theme background gets ANSI colors that read on it, hues kept", () => {
  // Dark and light pages from the bundled themes, plus the mid-tone ones a binary dark/light palette used to miss.
  for (const hex of ["#0e1015", "#191724", "#282a36", "#303446", "#3b3b4f", "#4c4f69", "#eff1f5", "#f7f3f6", "#faf4ed", "#ffffff"]) {
    const background = parseColor(hex)!;
    const theme = terminalTheme({ background, foreground: white, accent });
    const light = theme.appearance === "light";
    for (const name of ANSI_NAMES) {
      const blend = light ? "brightWhite" : "black";
      const dim = light ? "white" : "brightBlack";
      if (name === blend) continue;
      const needed = name === dim ? 3 : 4.5;
      assert.ok(hexContrast(theme[name], background) >= needed, `${name} ${theme[name]} reads on ${hex}`);
    }
    const reference = light ? terminalTheme({ background: white, foreground: ink, accent }) : GESPENST;
    for (const name of ["red", "green", "blue", "magenta"] as const) {
      const source = toOklch(parseColor(reference[name])!).h;
      const hue = toOklch(parseColor(theme[name])!).h;
      const distance = Math.min(Math.abs(source - hue), 360 - Math.abs(source - hue));
      assert.ok(distance < 8, `${name} keeps its hue on ${hex}`);
    }
  }
});

test("a light theme gets a palette whose normal colors stay legible on its background", () => {
  const theme = terminalTheme({ background: white, foreground: ink, accent });
  assert.equal(theme.appearance, "light");
  for (const name of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const) {
    assert.ok(hexContrast(theme[name], white) >= 4.5, `${name} reads on white`);
  }
});

test("computed sRGB colors parse; other syntaxes are rejected", () => {
  assert.deepEqual(parseRgb("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3 });
  assert.deepEqual(parseRgb("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30 });
  assert.deepEqual(parseRgb("rgb(255 128.4 0)"), { r: 255, g: 128, b: 0 });
  assert.equal(parseRgb("oklch(0.5 0.1 200)"), undefined);
});
