/** Public HUI settings payloads, including browser and VS Code preferences. */
import { Type, type Static } from "typebox";

export const VscodeProviderPreference = Type.Union([
  Type.Literal("auto"), Type.Literal("configured"), Type.Literal("desktop"), Type.Literal("managed"), Type.Literal("path"),
], { $id: "VscodeProviderPreference" });
export type VscodeProviderPreference = Static<typeof VscodeProviderPreference>;

export const BrowserSettings = Type.Object({
  enabled: Type.Boolean(), headless: Type.Boolean(), executablePath: Type.String(),
}, { $id: "BrowserSettings" });
export type BrowserSettings = Static<typeof BrowserSettings>;

export const VscodeSettings = Type.Object({
  enabled: Type.Boolean(), executable: Type.String(), provider: VscodeProviderPreference, licenseAcceptedAt: Type.String(),
}, { $id: "VscodeSettings" });
export type VscodeSettings = Static<typeof VscodeSettings>;

const TypefaceId = Type.Union([
  Type.Literal("instrument-sans"), Type.Literal("geist"), Type.Literal("dm-sans"), Type.Literal("ibm-plex-sans"),
  Type.Literal("space-grotesk"), Type.Literal("atkinson-hyperlegible"), Type.Literal("fraunces"), Type.Literal("lora"),
  Type.Literal("jetbrains-mono"), Type.Literal("system"),
]);

export const Settings = Type.Object({
  theme: Type.String(),
  themeMode: Type.Union([Type.Literal("system"), Type.Literal("light"), Type.Literal("dark")]),
  accent: Type.String(), fontUi: TypefaceId, fontChat: TypefaceId, fontTerminal: Type.String(),
  textScale: Type.Union([Type.Literal(90), Type.Literal(100), Type.Literal(110), Type.Literal(125), Type.Literal(140)]),
  chat: Type.Object({
    messageWidth: Type.Union([Type.Literal("compact"), Type.Literal("comfortable"), Type.Literal("wide")]),
    collapseTaskProgress: Type.Boolean(), sendShortcut: Type.Union([Type.Literal("enter"), Type.Literal("modifierEnter")]),
    githubEmbeds: Type.Boolean(), datadogEmbeds: Type.Boolean(),
  }),
  profileName: Type.String(), profileHandle: Type.String(), branchPrefix: Type.String(),
  browser: BrowserSettings, codemode: Type.Object({ enabled: Type.Boolean() }), questions: Type.Object({ timeoutMinutes: Type.Number() }),
  vscode: VscodeSettings, power: Type.Object({ keepAwake: Type.Boolean() }),
  models: Type.Object({ primary: Type.String(), fallback: Type.String(), utility: Type.String() }),
  calls: Type.Object({ voice: Type.Union([
    Type.Literal("cove"), Type.Literal("arbor"), Type.Literal("breeze"), Type.Literal("ember"), Type.Literal("juniper"),
    Type.Literal("maple"), Type.Literal("sol"), Type.Literal("spruce"), Type.Literal("vale"),
  ]) }),
  disabledSkills: Type.Immutable(Type.Array(Type.Object({ name: Type.String(), path: Type.String() }))),
  disabledPlugins: Type.Immutable(Type.Array(Type.Object({
    id: Type.String(), name: Type.String(), kind: Type.Union([Type.Literal("package"), Type.Literal("extension")]),
  }))),
  labs: Type.Object({ denseObservability: Type.Boolean(), detailedDebug: Type.Boolean() }),
}, { $id: "Settings" });
export type Settings = Static<typeof Settings>;

export const SettingsRequest = Type.Unknown({ $id: "SettingsRequest" });
export type SettingsRequest = Static<typeof SettingsRequest>;

export const SettingsError = Type.Object({ error: Type.String() }, { $id: "SettingsError" });
export type SettingsError = Static<typeof SettingsError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/settings", response: Settings },
  { method: "PUT", path: "/__hui/settings", request: SettingsRequest, response: Settings },
];
