/** Server-local VS Code routes, provider order, actions and safe workbench theme normalization. */
import type { VscodeAction, VscodeProviderKind, VscodeTheme } from "../api/vscode.ts";

export const VSCODE_BASE_PATH = "/__hui/vscode";
/** A frame's first load: trades a one-use ticket for the proxy's cookie, then redirects to the folder. */
export const VSCODE_ENTER_PATH = `${VSCODE_BASE_PATH}/enter`;
/** HUI's own guarded JSON route: the status (GET) and the actions in `VscodeAction` (POST `{ action }`). */
export const VSCODE_STATUS_ROUTE = "/__hui/vscode-server";

export const VSCODE_PROVIDER_ORDER: readonly VscodeProviderKind[] = ["configured", "desktop", "managed", "path"];

export const VSCODE_ACTIONS: readonly VscodeAction[] = ["stop", "accept-license", "revoke-license", "install", "cancel-install", "uninstall"];

const THEME_KEYS = ["background", "panel", "elevated", "text", "border", "accent"] as const;
const HEX = /^#[0-9a-f]{6}$/iu;

/** WCAG relative luminance of #rrggbb. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two #rrggbb colors, 1 to 21. */
export function vscodeContrast(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Below this, text on the theme's background or panels is not readable (WCAG's floor for large text). */
export const VSCODE_THEME_MIN_CONTRAST = 3;

/** Only #rrggbb values pass: anything else could reach VS Code's settings. The four base colors are required, and a
 * theme whose text cannot be read on its background or panels is refused: VS Code then keeps its own theme instead
 * of painting an unreadable workbench (a client that could not read HUI's colors once sent black for all of them). */
export function normalizeVscodeTheme(value: unknown): VscodeTheme | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const colors: Partial<Record<(typeof THEME_KEYS)[number], string>> = {};
  for (const key of THEME_KEYS) {
    const color = source[key];
    if (typeof color === "string" && HEX.test(color.trim())) colors[key] = color.trim().toLowerCase();
  }
  const { background, panel, elevated, text } = colors;
  if (!background || !panel || !elevated || !text) return undefined;
  if ([background, panel, elevated].some((surface) => vscodeContrast(text, surface) < VSCODE_THEME_MIN_CONTRAST)) return undefined;
  return {
    background, panel, elevated, text,
    ...(colors.border ? { border: colors.border } : {}),
    ...(colors.accent ? { accent: colors.accent } : {}),
  };
}

