import assert from "node:assert/strict";
import { expectTypeOf, test } from "vitest";
import { BrowserSettings, Settings, SettingsError, VscodeSettings, type VscodeProviderPreference } from "../api/settings.ts";
import { DEFAULT_SETTINGS, normalizeSettings } from "../hui-settings.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { createSettingsRoutes } from "./settings.ts";
import type { RouteRequest } from "../http/route.ts";

type OriginalVscodeProviderPreference = "auto" | "configured" | "desktop" | "managed" | "path";
type GptLiveVoice = "cove" | "arbor" | "breeze" | "ember" | "juniper" | "maple" | "sol" | "spruce" | "vale";
type TypefaceId = "instrument-sans" | "geist" | "dm-sans" | "ibm-plex-sans" | "space-grotesk" | "atkinson-hyperlegible" | "fraunces" | "lora" | "jetbrains-mono" | "system";
type Appearance = { fontUi: TypefaceId; fontChat: TypefaceId; textScale: 90 | 100 | 110 | 125 | 140 };
type ThemeMode = "system" | "light" | "dark";

type OriginalSettings = {

  theme: string;
  themeMode: ThemeMode;

  accent: string;
  fontUi: Appearance["fontUi"];
  fontChat: Appearance["fontChat"];
  fontTerminal: string;
  textScale: Appearance["textScale"];
  chat: {
    messageWidth: "compact" | "comfortable" | "wide";
    collapseTaskProgress: boolean;
    sendShortcut: "enter" | "modifierEnter";

    githubEmbeds: boolean;

    datadogEmbeds: boolean;
  };
  profileName: string;
  profileHandle: string;

  branchPrefix: string;

  browser: OriginalBrowserSettings;

  codemode: { enabled: boolean };
  questions: { timeoutMinutes: number };

  vscode: OriginalVscodeSettings;

  power: {

    keepAwake: boolean;
  };

  models: {
    primary: string;
    fallback: string;
    utility: string;
  };

  calls: { voice: GptLiveVoice };

  disabledSkills: readonly { name: string; path: string }[];

  disabledPlugins: readonly { id: string; name: string; kind: "package" | "extension" }[];
  labs: {
    denseObservability: boolean;
    detailedDebug: boolean;
  };
};

type OriginalBrowserSettings = {

  enabled: boolean;

  headless: boolean;

  executablePath: string;
};

type OriginalVscodeSettings = {

  enabled: boolean;

  executable: string;
  provider: OriginalVscodeProviderPreference;

  licenseAcceptedAt: string;
};


expectTypeOf<VscodeProviderPreference>().toEqualTypeOf<OriginalVscodeProviderPreference>();
expectTypeOf<Settings>().toEqualTypeOf<OriginalSettings>();
expectTypeOf<BrowserSettings>().toEqualTypeOf<OriginalBrowserSettings>();
expectTypeOf<VscodeSettings>().toEqualTypeOf<OriginalVscodeSettings>();

test("settings routes describe normalized saved settings without validating the raw input", async () => {
  const writes: unknown[] = [];
  const routes = createSettingsRoutes({ writeSettings: async (raw) => {
    writes.push(raw);
    return normalizeSettings(raw);
  } });
  const request: RouteRequest = {
    method: "PUT", path: "/__hui/settings", query: new URLSearchParams(), headers: {}, signal: new AbortController().signal,
    json: async () => ({ browser: { headless: false }, disabledPlugins: [{ id: "a".repeat(24), name: "plugin", kind: "extension" }] }),
    bytes: async () => Buffer.alloc(0),
  };
  const saved = await routes.handle(request);
  assert.equal(saved?.status, 200);
  expectSchema(Settings, saved?.body);
  assert.deepEqual(saved?.body, normalizeSettings(writes[0]));
  assert.equal(writes.length, 1);
  expectSchema(Settings, DEFAULT_SETTINGS);
  const malformed = await routes.handle({ ...request, json: async () => null });
  assert.deepEqual(malformed?.body, DEFAULT_SETTINGS);
  const refused = await routes.handle({ ...request, method: "DELETE" });
  assert.equal(refused?.status, 405);
  expectSchema(SettingsError, refused?.body);
  assert.equal(await routes.handle({ ...request, path: "/elsewhere" }), undefined);
});
