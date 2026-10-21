/**
 * Appearance preferences that are not themes: independent interface/chat
 * typefaces and the shared type scale. The font catalogue and stacks mirror
 * OpenClaw 2026.9.5; settings.ts owns persistence.
 */

const FALLBACK_STACKS = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
} as const;

export const TYPEFACES = [
  {
    id: "instrument-sans",
    label: "Instrument Sans",
    note: "Contemporary and crisp",
    kind: "sans",
    stack: `"Instrument Sans", ${FALLBACK_STACKS.sans}`,
  },
  {
    id: "geist",
    label: "Geist",
    note: "Clean and precise",
    kind: "sans",
    stack: `"Geist", ${FALLBACK_STACKS.sans}`,
  },
  {
    id: "dm-sans",
    label: "DM Sans",
    note: "Warm and versatile",
    kind: "sans",
    stack: `"DM Sans", ${FALLBACK_STACKS.sans}`,
  },
  {
    id: "ibm-plex-sans",
    label: "IBM Plex Sans",
    note: "Engineered and humanist",
    kind: "sans",
    stack: `"IBM Plex Sans", ${FALLBACK_STACKS.sans}`,
  },
  {
    id: "space-grotesk",
    label: "Space Grotesk",
    note: "Geometric with character",
    kind: "sans",
    stack: `"Space Grotesk", ${FALLBACK_STACKS.sans}`,
  },
  {
    id: "atkinson-hyperlegible",
    label: "Atkinson Hyperlegible",
    note: "Distinct shapes for easy reading",
    kind: "sans",
    stack: `"Atkinson Hyperlegible Next", ${FALLBACK_STACKS.sans}`,
  },
  {
    id: "fraunces",
    label: "Fraunces",
    note: "Expressive reading serif",
    kind: "serif",
    stack: `"Fraunces", ${FALLBACK_STACKS.serif}`,
  },
  {
    id: "lora",
    label: "Lora",
    note: "Calm, literary serif",
    kind: "serif",
    stack: `"Lora", ${FALLBACK_STACKS.serif}`,
  },
  {
    id: "jetbrains-mono",
    label: "JetBrains Mono",
    note: "Clear, evenly spaced letters",
    kind: "mono",
    stack: `"JetBrains Mono", ${FALLBACK_STACKS.mono}`,
  },
  {
    id: "system",
    label: "System",
    note: "No webfont",
    kind: "sans",
    stack: FALLBACK_STACKS.sans,
  },
] as const;

export type TypefaceId = (typeof TYPEFACES)[number]["id"];

/** Percentages. Same stops OpenClaw uses, so the two feel alike. */
export const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;

export type TextScaleStop = (typeof TEXT_SCALE_STOPS)[number];

export type Appearance = {
  fontUi: TypefaceId;
  fontChat: TypefaceId;
  textScale: TextScaleStop;
};

export const DEFAULT_APPEARANCE: Appearance = {
  fontUi: "instrument-sans",
  fontChat: "instrument-sans",
  textScale: 100,
};

function normalizeTypeface(value: unknown): TypefaceId {
  const candidate = typeof value === "string" ? value : "";
  return TYPEFACES.find((face) => face.id === candidate)?.id ?? DEFAULT_APPEARANCE.fontUi;
}

/**
 * Inputs come from a hand-editable config file. A missing chat preference
 * inherits the interface preference so the former single-font setting migrates
 * without changing how an existing installation looks.
 */
export function normalizeAppearance(fontUi: unknown, fontChat: unknown, textScale: unknown): Appearance {
  const normalizedUi = normalizeTypeface(fontUi);
  const scale = Number(textScale);
  return {
    fontUi: normalizedUi,
    fontChat: fontChat === undefined ? normalizedUi : normalizeTypeface(fontChat),
    textScale: TEXT_SCALE_STOPS.find((stop) => stop === scale) ?? DEFAULT_APPEARANCE.textScale,
  };
}

function typeface(id: TypefaceId): (typeof TYPEFACES)[number] {
  return TYPEFACES.find((face) => face.id === id) ?? TYPEFACES[0];
}

export function applyAppearance(value: Appearance): void {
  const style = document.documentElement.style;
  const ui = typeface(value.fontUi);
  const chat = typeface(value.fontChat);
  style.setProperty("--font-sans", ui.stack);
  style.setProperty("--font-body", ui.stack);
  style.setProperty("--font-display", ui.stack);
  style.setProperty("--font-chat", chat.stack);
  if (chat.kind === "serif") style.setProperty("--chat-font-smoothing", "auto");
  else style.removeProperty("--chat-font-smoothing");
  style.setProperty("--text-scale", String(value.textScale / 100));
  style.setProperty("--control-ui-text-scale", String(value.textScale / 100));
}
