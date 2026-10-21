/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type BrowserSettings = { "enabled": boolean; "headless": boolean; "executablePath": string; };

export type Settings = { "theme": string; "themeMode": ("system") | ("light") | ("dark"); "accent": string; "fontUi": ("instrument-sans") | ("geist") | ("dm-sans") | ("ibm-plex-sans") | ("space-grotesk") | ("atkinson-hyperlegible") | ("fraunces") | ("lora") | ("jetbrains-mono") | ("system"); "fontChat": ("instrument-sans") | ("geist") | ("dm-sans") | ("ibm-plex-sans") | ("space-grotesk") | ("atkinson-hyperlegible") | ("fraunces") | ("lora") | ("jetbrains-mono") | ("system"); "fontTerminal": string; "textScale": (90) | (100) | (110) | (125) | (140); "chat": { "messageWidth": ("compact") | ("comfortable") | ("wide"); "collapseTaskProgress": boolean; "sendShortcut": ("enter") | ("modifierEnter"); "githubEmbeds": boolean; "datadogEmbeds": boolean; }; "profileName": string; "profileHandle": string; "branchPrefix": string; "browser": BrowserSettings; "codemode": { "enabled": boolean; }; "questions": { "timeoutMinutes": number; }; "vscode": VscodeSettings; "power": { "keepAwake": boolean; }; "models": { "primary": string; "fallback": string; "utility": string; }; "calls": { "voice": ("cove") | ("arbor") | ("breeze") | ("ember") | ("juniper") | ("maple") | ("sol") | ("spruce") | ("vale"); }; "disabledSkills": Array<{ "name": string; "path": string; }>; "disabledPlugins": Array<{ "id": string; "name": string; "kind": ("package") | ("extension"); }>; "labs": { "denseObservability": boolean; "detailedDebug": boolean; }; };

export type SettingsError = { "error": string; };

export type SettingsRequest = unknown;

export type VscodeProviderPreference = ("auto") | ("configured") | ("desktop") | ("managed") | ("path");

export type VscodeSettings = { "enabled": boolean; "executable": string; "provider": VscodeProviderPreference; "licenseAcceptedAt": string; };
