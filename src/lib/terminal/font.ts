/**
 * The terminal font preference: a normalized local family name, its stack with the bundled Nerd Font symbols and
 * JetBrains Mono behind it, loading those faces in the document, and finding their @font-face rules so the terminal
 * can load them into Gespenst's worker too.
 */
/** A single local font family, not a CSS declaration or a font stack. */
export const DEFAULT_TERMINAL_FONT = "JetBrains Mono";
export const TERMINAL_FONTS = [DEFAULT_TERMINAL_FONT, "MesloLGS NF", "MesloLGS Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", "Hack Nerd Font Mono", "CaskaydiaCove Nerd Font Mono", "Menlo", "Consolas"] as const;

export function normalizeTerminalFont(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_FONT;
  const name = value.trim();
  return name.length > 0 && name.length <= 128 && !/[\p{Cc}"'\\;,{}<>]/u.test(name)
    ? name : DEFAULT_TERMINAL_FONT;
}

/** Bundled icon face (public/fonts/symbols-nerd-font-mono.css), limited to Nerd Font code points. */
export const NERD_FONT_SYMBOLS = "HUI Nerd Font Symbols";

export function terminalFontStack(value: unknown): string {
  return `"${normalizeTerminalFont(value)}", "${NERD_FONT_SYMBOLS}", "JetBrains Mono", ui-monospace, monospace`;
}

/**
 * Load the faces a terminal canvas draws with before it renders. Canvas text
 * does not trigger or await web-font loads, and a unicode-range face is only
 * fetched for matching text, so a Nerd Font sample is included.
 */
export async function loadTerminalFont(value: unknown, fonts: Pick<FontFaceSet, "load"> = document.fonts): Promise<void> {
  await fonts.load(`13px ${terminalFontStack(value)}`, "M\u{E0B0}\u{F0001}").catch(() => []);
}

/** The parts of a stylesheet and its rules read to find the terminal's bundled faces. */
export type FontSheet = { href: string | null; cssRules: ArrayLike<FontRule> };
export type FontRule = { cssText: string; styleSheet?: FontSheet | null; cssRules?: ArrayLike<FontRule>; style?: { getPropertyValue(name: string): string } };
export type TerminalFontFace = { family: string; source: string; descriptors: FontFaceDescriptors };

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/su, "$2");
}

/**
 * The @font-face rules behind a terminal font stack (the chosen family, the Nerd Font symbols and the bundled
 * JetBrains Mono), with absolute sources. Gespenst draws text in its worker, which does not see the document's web
 * fonts, so each face is loaded there too; locally installed families need nothing.
 */
export function terminalFontFaces(value: unknown, sheets: Iterable<FontSheet>, base: string): TerminalFontFace[] {
  const families = new Set([normalizeTerminalFont(value), NERD_FONT_SYMBOLS, DEFAULT_TERMINAL_FONT]);
  const faces: TerminalFontFace[] = [];
  const seen = new Set<FontSheet>();
  const visit = (sheet: FontSheet, sheetBase: string) => {
    if (seen.has(sheet)) return;
    seen.add(sheet);
    let rules: ArrayLike<FontRule>;
    // A cross-origin sheet's rules are unreadable; it cannot hold HUI's bundled faces.
    try { rules = sheet.cssRules; } catch { return; }
    const href = sheet.href ? new URL(sheet.href, sheetBase).href : sheetBase;
    const walk = (list: ArrayLike<FontRule>) => {
      for (const rule of Array.from(list)) {
        if (rule.styleSheet) visit(rule.styleSheet, href);
        else if (rule.cssText.startsWith("@font-face") && rule.style) {
          const family = unquote(rule.style.getPropertyValue("font-family"));
          const src = rule.style.getPropertyValue("src");
          if (!families.has(family) || !src) continue;
          const source = src.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gu, (_match, _quote, url: string) => `url("${new URL(url, href).href}")`);
          const descriptors: FontFaceDescriptors = {};
          const style = rule.style.getPropertyValue("font-style").trim();
          const weight = rule.style.getPropertyValue("font-weight").trim();
          const unicodeRange = rule.style.getPropertyValue("unicode-range").trim();
          if (style) descriptors.style = style;
          if (weight) descriptors.weight = weight;
          if (unicodeRange) descriptors.unicodeRange = unicodeRange;
          faces.push({ family, source, descriptors });
        } else if (rule.cssRules) walk(rule.cssRules);
      }
    };
    walk(rules);
  };
  for (const sheet of sheets) visit(sheet, base);
  return faces;
}
