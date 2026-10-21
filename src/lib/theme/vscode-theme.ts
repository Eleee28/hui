/**
 * HUI's colors for the VS Code view, read from the document's tokens as #rrggbb so the gateway can hand them to the
 * workbench (server/vscode/proxy.ts). A token can be an expression only an element can resolve: themes imported
 * from tweakcn (and the built-in Catppuccin, Dracula and HUI) pair every color as `light-dark(…)`, which a canvas
 * cannot parse. Each token is therefore resolved by a probe element first, then converted by a 1×1 canvas, which
 * also composites a translucent color over the background. A token that still cannot be read is left out, never
 * guessed: without the four base colors there is no theme, and VS Code keeps its own.
 */
import type { VscodeTheme } from "../../api/schema/vscode.ts";

/** The part of a 2D context the conversion uses, so it can be checked without a browser. */
export type ColorCanvas = Pick<CanvasRenderingContext2D, "fillStyle" | "fillRect" | "clearRect" | "getImageData">;

/** A color the canvas cannot parse leaves `fillStyle` as it was; starting from two different values tells. */
function parses(context: ColorCanvas, color: string): boolean {
  context.fillStyle = "#000000";
  context.fillStyle = color;
  const fromBlack = context.fillStyle;
  context.fillStyle = "#ffffff";
  context.fillStyle = color;
  return context.fillStyle === fromBlack;
}

/** `color` as #rrggbb, painted over `over` when given; undefined when the canvas cannot read it. */
export function canvasColorHex(context: ColorCanvas, color: string, over?: string): string | undefined {
  if (!color || !parses(context, color)) return undefined;
  context.clearRect(0, 0, 1, 1);
  if (over) { context.fillStyle = over; context.fillRect(0, 0, 1, 1); }
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** The theme from a token reader: (token, color to composite over) → #rrggbb or undefined. */
export function vscodeThemeFrom(read: (token: string, over?: string) => string | undefined): VscodeTheme | undefined {
  const background = read("--bg");
  if (!background) return undefined;
  const panel = read("--panel", background) ?? background;
  const elevated = read("--bg-elevated", background) ?? panel;
  const text = read("--text", background);
  if (!text) return undefined;
  const border = read("--border", background);
  const accent = read("--accent", background);
  return { background, panel, elevated, text, ...(border ? { border } : {}), ...(accent ? { accent } : {}) };
}

/** HUI's tokens on `root` as the VS Code view's theme, or undefined when they cannot be read. */
export function readVscodeTheme(root: HTMLElement = document.documentElement): VscodeTheme | undefined {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  const tokens = getComputedStyle(root);
  // Inherits the root's color-scheme, which is what `light-dark()` resolves against.
  const probe = document.createElement("span");
  probe.hidden = true;
  root.append(probe);
  try {
    return vscodeThemeFrom((token, over) => {
      if (!tokens.getPropertyValue(token).trim()) return undefined;
      probe.style.color = "";
      probe.style.color = `var(${token})`;
      return canvasColorHex(context, getComputedStyle(probe).color, over);
    });
  } finally {
    probe.remove();
  }
}
