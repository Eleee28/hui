import assert from "node:assert/strict";
import { test } from "vitest";
import { canvasColorHex, vscodeThemeFrom, type ColorCanvas } from "./vscode-theme.ts";

/** A canvas that, like a browser's, ignores a fillStyle it cannot parse: `light-dark()` and `var()` among them. */
function fakeCanvas(): ColorCanvas {
  let style = "#000000";
  let pixel = [0, 0, 0, 0];
  const parse = (value: string): number[] | undefined => {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(value);
    if (hex) return [1, 2, 3].map((index) => Number.parseInt(hex[index] ?? "0", 16)).concat(1);
    const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u.exec(value);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
    return undefined;
  };
  return {
    get fillStyle() { return style; },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      if (typeof value === "string" && parse(value)) style = value.startsWith("#") ? value.toLowerCase() : value;
    },
    clearRect() { pixel = [0, 0, 0, 0]; },
    fillRect() {
      const [r = 0, g = 0, b = 0, a = 1] = parse(style) ?? [];
      pixel = [r, g, b].map((channel, index) => Math.round(channel * a + (pixel[index] ?? 0) * (1 - a))).concat(255);
    },
    getImageData() { return { data: Uint8ClampedArray.from(pixel) } as unknown as ImageData; },
  } as ColorCanvas;
}

test("a color the canvas cannot parse is unreadable, not black", () => {
  const canvas = fakeCanvas();
  // Imported and built-in custom themes pair every token like this; the old reader painted them all #000000.
  assert.equal(canvasColorHex(canvas, "light-dark(#eff1f5, #1e1e2e)"), undefined);
  assert.equal(canvasColorHex(canvas, "var(--bg)"), undefined);
  assert.equal(canvasColorHex(canvas, ""), undefined);
  assert.equal(canvasColorHex(canvas, "rgb(239, 241, 245)"), "#eff1f5", "what a probe element resolves it to");
  assert.equal(canvasColorHex(canvas, "#000000"), "#000000", "black itself still reads");
  assert.equal(canvasColorHex(canvas, "rgba(0, 0, 0, 0.5)", "#ffffff"), "#808080", "translucent colors land on the background");
});

test("the theme needs a background and text; the other surfaces fall back", () => {
  const tokens: Record<string, string> = { "--bg": "#eff1f5", "--text": "#4c4f69", "--accent": "#8839ef" };
  assert.deepEqual(vscodeThemeFrom((token) => tokens[token]), {
    background: "#eff1f5", panel: "#eff1f5", elevated: "#eff1f5", text: "#4c4f69", accent: "#8839ef",
  });
  assert.equal(vscodeThemeFrom((token) => (token === "--bg" ? undefined : tokens[token])), undefined);
  assert.equal(vscodeThemeFrom((token) => (token === "--text" ? undefined : tokens[token])), undefined);
  const overs: Array<string | undefined> = [];
  vscodeThemeFrom((token, over) => { overs.push(over); return tokens[token]; });
  assert.deepEqual(overs, [undefined, "#eff1f5", "#eff1f5", "#eff1f5", "#eff1f5", "#eff1f5"], "each token composites over the background");
});
