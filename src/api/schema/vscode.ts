/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { VscodeProviderPreference } from "./settings.ts";

export type VscodeAction = ("stop") | ("accept-license") | ("revoke-license") | ("install") | ("cancel-install") | ("uninstall");

export type VscodeActionRequest = { "action": VscodeAction; };

export type VscodeConnectRequest = { "theme"?: VscodeTheme; };

export type VscodeConnectResponse = (VscodeConnection) | (VscodePending);

export type VscodeConnection = { "url": string; "folder": string; "label": string; "instance": number; };

export type VscodeErrorCode = ("setup") | ("remote") | ("folder") | ("failed") | ("busy");

export type VscodeFailure = { "error": string; "code": VscodeErrorCode; };

export type VscodeFlavor = ("server") | ("serve-web");

export type VscodeInstallPhase = ("downloading") | ("verifying") | ("extracting");

export type VscodeInstallStatus = { "supported": boolean; "reason": string; "version": string; "arch": string; "size": number; "dir": string; "installed": ({ "version": string; "path": string; }) | (null); "task": ({ "phase": VscodeInstallPhase; "received": number; "total": number; }) | (null); "error": string; "hint": string; };

export type VscodePending = { "pending": true; "status": VscodeStatus; };

export type VscodeProvider = { "kind": VscodeProviderKind; "flavor": VscodeFlavor; "path": string; "name": string; "version": string; "commit"?: string; };

export type VscodeProviderKind = ("configured") | ("desktop") | ("managed") | ("path");

export type VscodeSetup = { "needed": boolean; "desktop": (VscodeProvider) | (null); "install": boolean; "download": boolean; };

export type VscodeState = ("setup") | ("stopped") | ("starting") | ("running") | ("failed");

export type VscodeStatus = { "platform": string; "enabled": boolean; "configuredExecutable": string; "preference": VscodeProviderPreference; "providers": Array<VscodeProvider>; "problems": Array<string>; "active": (VscodeProvider) | (null); "activeError": string; "setup": VscodeSetup; "license": { "accepted": boolean; "acceptedAt": string; }; "install": VscodeInstallStatus; "state": VscodeState; "running": (VscodeProvider) | (null); "preparing": ({ "received": number; "total": number; }) | (null); "instance": number; "pid"?: number; "startedAt"?: string; "lastError": string; "connections": number; "idleMinutes": number; "dataDir": string; };

export type VscodeTheme = { "background": string; "panel": string; "elevated": string; "text": string; "border"?: string; "accent"?: string; };
