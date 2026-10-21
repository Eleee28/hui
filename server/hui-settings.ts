/**
 * HUI's own settings file in its config directory: reading and writing it, always normalized.
 * A missing or malformed file reads as the defaults instead of an error.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CONFIG_DIR } from "./paths.ts";
import type { Settings, BrowserSettings, VscodeSettings, VscodeProviderPreference } from "./api/settings.ts";
export type { Settings, BrowserSettings, VscodeSettings, VscodeProviderPreference } from "./api/settings.ts";

const GPT_LIVE_VOICES = ["cove", "arbor", "breeze", "ember", "juniper", "maple", "sol", "spruce", "vale"] as const;
type GptLiveVoice = (typeof GPT_LIVE_VOICES)[number];
const DEFAULT_GPT_LIVE_VOICE: GptLiveVoice = "cove";

function gptLiveVoice(value: unknown): GptLiveVoice | undefined {
  if (typeof value !== "string") return undefined;
  const voice = value.trim().toLowerCase();
  return GPT_LIVE_VOICES.find((candidate) => candidate === voice);
}

export const HUI_SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

export async function readHuiSettingsAt(path: string): Promise<Settings> {
  try {
    return normalizeSettings(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return normalizeSettings(undefined);
  }
}

export function readHuiSettings(): Promise<Settings> {
  return readHuiSettingsAt(HUI_SETTINGS_FILE);
}

export async function writeHuiSettings(raw: unknown): Promise<Settings> {
  const settings = normalizeSettings(raw);
  await writeFile(HUI_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

type TypefaceId = "instrument-sans" | "geist" | "dm-sans" | "ibm-plex-sans" | "space-grotesk" | "atkinson-hyperlegible" | "fraunces" | "lora" | "jetbrains-mono" | "system";
type Appearance = { fontUi: TypefaceId; fontChat: TypefaceId; textScale: 90 | 100 | 110 | 125 | 140 };
type ThemeMode = "system" | "light" | "dark";
const TYPEFACES: readonly TypefaceId[] = ["instrument-sans", "geist", "dm-sans", "ibm-plex-sans", "space-grotesk", "atkinson-hyperlegible", "fraunces", "lora", "jetbrains-mono", "system"];
const DEFAULT_APPEARANCE: Appearance = { fontUi: "instrument-sans", fontChat: "instrument-sans", textScale: 100 };
const TEXT_SCALE_STOPS = [90, 100, 110, 125, 140] as const;
const THEME_MODES = ["system", "light", "dark"] as const;
const DEFAULT_TERMINAL_FONT = "JetBrains Mono";
function normalizeTypeface(value: unknown): TypefaceId {
  const candidate = typeof value === "string" ? value : "";
  return TYPEFACES.find((id) => id === candidate) ?? DEFAULT_APPEARANCE.fontUi;
}
function normalizeAppearance(fontUi: unknown, fontChat: unknown, textScale: unknown): Appearance {
  const normalizedUi = normalizeTypeface(fontUi);
  const scale = Number(textScale);
  return {
    fontUi: normalizedUi,
    fontChat: fontChat === undefined ? normalizedUi : normalizeTypeface(fontChat),
    textScale: TEXT_SCALE_STOPS.find((stop) => stop === scale) ?? DEFAULT_APPEARANCE.textScale,
  };
}
function normalizeTerminalFont(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_FONT;
  const name = value.trim();
  return name.length > 0 && name.length <= 128 && !/[\p{Cc}"'\\;,{}<>]/u.test(name)
    ? name : DEFAULT_TERMINAL_FONT;
}
function normalizeThemeMode(value: unknown): ThemeMode {
  return THEME_MODES.find((mode) => mode === value) ?? "system";
}

export const QUESTION_TIMEOUTS = [0, 5, 10, 15, 30, 60] as const;

export const DEFAULT_BRANCH_PREFIX = "feature/";
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { enabled: true, headless: true, executablePath: "" };
export const DEFAULT_VSCODE_SETTINGS: VscodeSettings = { enabled: false, executable: "", provider: "auto", licenseAcceptedAt: "" };
const VSCODE_PROVIDERS: readonly VscodeProviderPreference[] = ["auto", "configured", "desktop", "managed", "path"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "claw",
  themeMode: "system",
  accent: "",
  fontUi: DEFAULT_APPEARANCE.fontUi,
  fontChat: DEFAULT_APPEARANCE.fontChat,
  fontTerminal: DEFAULT_TERMINAL_FONT,
  textScale: DEFAULT_APPEARANCE.textScale,
  chat: {
    messageWidth: "comfortable",
    collapseTaskProgress: false,
    sendShortcut: "enter",
    githubEmbeds: true,
    datadogEmbeds: true,
  },
  profileName: "HUI Operator",
  profileHandle: "",
  branchPrefix: DEFAULT_BRANCH_PREFIX,
  browser: DEFAULT_BROWSER_SETTINGS,
  codemode: { enabled: true },
  questions: { timeoutMinutes: 0 },
  vscode: DEFAULT_VSCODE_SETTINGS,
  power: { keepAwake: true },
  models: { primary: "", fallback: "", utility: "" },
  calls: { voice: DEFAULT_GPT_LIVE_VOICE },
  disabledSkills: [],
  disabledPlugins: [],
  labs: { denseObservability: false, detailedDebug: false },
};

export function normalizeSettings(raw: unknown): Settings {
  const source = isRecord(raw) ? raw : {};
  const appearance = normalizeAppearance(source["fontUi"], source["fontChat"], source["textScale"]);
  const theme = source["theme"];
  const normalizedTheme = typeof theme === "string" ? theme.trim() : "";
  return {
    theme: normalizedTheme || DEFAULT_SETTINGS.theme,
    themeMode: normalizeThemeMode(source["themeMode"]),
    accent: normalizeAccent(source["accent"]),
    fontUi: appearance.fontUi,
    fontChat: appearance.fontChat,
    fontTerminal: normalizeTerminalFont(source["fontTerminal"]),
    textScale: appearance.textScale,
    chat: normalizeChat(source["chat"]),
    profileName: boundedText(source["profileName"], DEFAULT_SETTINGS.profileName, 80),
    profileHandle: boundedText(source["profileHandle"], "", 80),
    branchPrefix: normalizeBranchPrefix(source["branchPrefix"]),
    browser: normalizeBrowserSettings(source["browser"]),
    codemode: { enabled: !isRecord(source["codemode"]) || source["codemode"]["enabled"] !== false },
    questions: { timeoutMinutes: QUESTION_TIMEOUTS.find((minutes) => isRecord(source["questions"]) && source["questions"]["timeoutMinutes"] === minutes) ?? 0 },
    vscode: normalizeVscodeSettings(source["vscode"]),
    power: normalizePower(source["power"]),

    models: normalizeModels(source["models"]),
    calls: normalizeCalls(source["calls"]),
    disabledSkills: normalizeDisabledSkills(source["disabledSkills"]),
    disabledPlugins: normalizeDisabledPlugins(source["disabledPlugins"]),
    labs: normalizeLabs(source["labs"]),
  };
}

export function normalizeCalls(value: unknown): Settings["calls"] {
  const source = isRecord(value) ? value : {};
  return { voice: gptLiveVoice(source["voice"]) ?? DEFAULT_GPT_LIVE_VOICE };
}

export function normalizeBrowserSettings(value: unknown): BrowserSettings {
  const source = isRecord(value) ? value : {};
  const path = typeof source["executablePath"] === "string" ? source["executablePath"].trim() : "";
  return {
    enabled: source["enabled"] !== false,
    headless: source["headless"] !== false,
    executablePath: path.length <= 4_096 && !/[\p{Cc}]/u.test(path) ? path : "",
  };
}

export function normalizeVscodeSettings(value: unknown): VscodeSettings {
  const source = isRecord(value) ? value : {};
  const path = typeof source["executable"] === "string" ? source["executable"].trim() : "";
  const provider = VSCODE_PROVIDERS.find((value) => value === source["provider"]) ?? "auto";
  const accepted = typeof source["licenseAcceptedAt"] === "string" ? source["licenseAcceptedAt"].trim() : "";
  return {
    enabled: source["enabled"] === true,
    executable: path.length <= 4_096 && !/[\p{Cc}]/u.test(path) ? path : "",
    provider,
    licenseAcceptedAt: accepted.length <= 64 && !Number.isNaN(Date.parse(accepted)) ? accepted : "",
  };
}

function normalizePower(value: unknown): Settings["power"] {
  return { keepAwake: !(isRecord(value) && value["keepAwake"] === false) };
}

function normalizeModelRef(value: unknown): string {
  if (typeof value !== "string") return "";
  const ref = value.trim();
  return ref.length <= 200 && /^[^/\s]+\/\S+$/u.test(ref) ? ref : "";
}

function normalizeModels(value: unknown): Settings["models"] {
  const source = isRecord(value) ? value : {};
  return {
    primary: normalizeModelRef(source["primary"]),
    fallback: normalizeModelRef(source["fallback"]),
    utility: normalizeModelRef(source["utility"]),
  };
}

function normalizeDisabledPlugins(value: unknown): Settings["disabledPlugins"] {
  if (!Array.isArray(value)) return [];
  const plugins = new Map<string, Settings["disabledPlugins"][number]>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = boundedText(item["id"], "", 64);
    const name = boundedText(item["name"], "", 200);
    const kind = item["kind"];
    if (!/^[a-f0-9]{24}$/u.test(id) || !name || (kind !== "package" && kind !== "extension")) continue;
    if (!plugins.has(id)) plugins.set(id, { id, name, kind });
    if (plugins.size >= 1_000) break;
  }
  return [...plugins.values()];
}

function normalizeDisabledSkills(value: unknown): Settings["disabledSkills"] {
  if (!Array.isArray(value)) return [];
  const skills = new Map<string, { name: string; path: string }>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = boundedText(item["name"], "", 64);
    const path = boundedText(item["path"], "", 4_096);
    if (!name || !path || /[\p{Cc}]/u.test(path)) continue;
    if (!skills.has(path)) skills.set(path, { name, path });
    if (skills.size >= 1_000) break;
  }
  return [...skills.values()];
}

function normalizeChat(value: unknown): Settings["chat"] {
  const source = isRecord(value) ? value : {};
  const width = source["messageWidth"];
  const shortcut = source["sendShortcut"];
  return {
    messageWidth: width === "compact" || width === "wide" ? width : "comfortable",
    collapseTaskProgress: source["collapseTaskProgress"] === true,
    sendShortcut: shortcut === "modifierEnter" ? shortcut : "enter",

    githubEmbeds: source["githubEmbeds"] !== false,
    datadogEmbeds: source["datadogEmbeds"] !== false,
  };
}

export function normalizeBranchPrefix(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BRANCH_PREFIX;
  const raw = value.trim();
  if (!raw) return DEFAULT_BRANCH_PREFIX;
  const prefix = raw.endsWith("/") ? raw : `${raw}/`;
  if (
    prefix.length > 80 ||
    prefix.startsWith("/") ||
    prefix.includes("//") ||
    prefix.includes("..") ||
    prefix.includes("@{") ||
    /[\\\s~^:?*[\]]/u.test(prefix)
  ) return DEFAULT_BRANCH_PREFIX;
  const parts = prefix.slice(0, -1).split("/");
  if (parts.some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) {
    return DEFAULT_BRANCH_PREFIX;
  }
  return prefix;
}

function normalizeAccent(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : "";
}

function boundedText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maximum);
}

function normalizeLabs(value: unknown): Settings["labs"] {
  const source = isRecord(value) ? value : {};
  return {
    denseObservability: source["denseObservability"] === true,
    detailedDebug: source["detailedDebug"] === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
