/**
 * Shape, defaults and normalisation of HUI's user settings. Every value passes through here on the way in and
 * out, so a stale or hand-edited file degrades to defaults instead of reaching CSS or the gateway. Loading
 * and saving them through the gateway is `settings/settings-store.ts`'s job.
 */
import { DEFAULT_GPT_LIVE_VOICE, gptLiveVoice } from "../voice/calls.ts";
import { normalizeAppearance, DEFAULT_APPEARANCE } from "../theme/appearance.ts";
import { DEFAULT_TERMINAL_FONT, normalizeTerminalFont } from "../terminal/font.ts";
import { normalizeThemeMode } from "../theme/theme.ts";
import type { Settings, BrowserSettings, VscodeSettings, VscodeProviderPreference } from "../../api/schema/settings.ts";

export type { Settings, BrowserSettings, VscodeSettings, VscodeProviderPreference } from "../../api/schema/settings.ts";

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
    // VoiceStudio's `voice` (its voice-notes switch) is not read either: the next save leaves it out.
    models: normalizeModels(source["models"]),
    calls: normalizeCalls(source["calls"]),
    disabledSkills: normalizeDisabledSkills(source["disabledSkills"]),
    disabledPlugins: normalizeDisabledPlugins(source["disabledPlugins"]),
    labs: normalizeLabs(source["labs"]),
  };
}

/** An unknown voice is GPT-Live's default. A file saved while VoiceStudio could run calls also holds an `engine` here:
 * it is not read, so the next save leaves it out. */
export function normalizeCalls(value: unknown): Settings["calls"] {
  const source = isRecord(value) ? value : {};
  return { voice: gptLiveVoice(source["voice"]) ?? DEFAULT_GPT_LIVE_VOICE };
}

/** Both switches are opt-out: only an explicit false changes the default. The
 * path is kept as typed (bounded, no control characters); the gateway validates
 * and reports it rather than guessing. */
export function normalizeBrowserSettings(value: unknown): BrowserSettings {
  const source = isRecord(value) ? value : {};
  const path = typeof source["executablePath"] === "string" ? source["executablePath"].trim() : "";
  return {
    enabled: source["enabled"] !== false,
    headless: source["headless"] !== false,
    executablePath: path.length <= 4_096 && !/[\p{Cc}]/u.test(path) ? path : "",
  };
}

/** Opt-in: only an explicit true turns the VS Code view on. The path is kept as typed, like the browser's; the gateway
 * validates it and reports what it found. */
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

/** Opt-out: only an explicit false lets the Mac idle-sleep. */
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
    // Opt-out: only an explicit false disables previews.
    githubEmbeds: source["githubEmbeds"] !== false,
    datadogEmbeds: source["datadogEmbeds"] !== false,
  };
}

/** Keep the configurable part a Git-ref prefix rather than accepting arbitrary
 * command/path syntax. The complete branch still passes git check-ref-format. */
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

/** Every Labs flag is opt-in: only an explicit true turns one on. */
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
