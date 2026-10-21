/** Public VS Code provider, status, theme and connection payloads and their routes. */
import { Type, type Static } from "typebox";
import { VscodeProviderPreference as VscodeProviderPreferenceSchema } from "./settings.ts";

export const VscodeProviderKind = Type.Union([
  Type.Literal("configured"), Type.Literal("desktop"), Type.Literal("managed"), Type.Literal("path"),
], { $id: "VscodeProviderKind" });
export type VscodeProviderKind = Static<typeof VscodeProviderKind>;

export type VscodeProviderPreference = Static<typeof VscodeProviderPreferenceSchema>;

export const VscodeFlavor = Type.Union([Type.Literal("server"), Type.Literal("serve-web")], { $id: "VscodeFlavor" });
export type VscodeFlavor = Static<typeof VscodeFlavor>;

export const VscodeProvider = Type.Object({
  kind: VscodeProviderKind, flavor: VscodeFlavor, path: Type.String(), name: Type.String(),
  version: Type.String(), commit: Type.Optional(Type.String()),
}, { $id: "VscodeProvider" });
export type VscodeProvider = Static<typeof VscodeProvider>;

export const VscodeState = Type.Union([
  Type.Literal("setup"), Type.Literal("stopped"), Type.Literal("starting"), Type.Literal("running"), Type.Literal("failed"),
], { $id: "VscodeState" });
export type VscodeState = Static<typeof VscodeState>;

export const VscodeInstallPhase = Type.Union([
  Type.Literal("downloading"), Type.Literal("verifying"), Type.Literal("extracting"),
], { $id: "VscodeInstallPhase" });
export type VscodeInstallPhase = Static<typeof VscodeInstallPhase>;

export const VscodeInstallStatus = Type.Object({
  supported: Type.Boolean(), reason: Type.String(), version: Type.String(), arch: Type.String(), size: Type.Number(), dir: Type.String(),
  installed: Type.Union([Type.Object({ version: Type.String(), path: Type.String() }), Type.Null()]),
  task: Type.Union([Type.Object({ phase: VscodeInstallPhase, received: Type.Number(), total: Type.Number() }), Type.Null()]),
  error: Type.String(), hint: Type.String(),
}, { $id: "VscodeInstallStatus" });
export type VscodeInstallStatus = Static<typeof VscodeInstallStatus>;

export const VscodeSetup = Type.Object({
  needed: Type.Boolean(), desktop: Type.Union([VscodeProvider, Type.Null()]), install: Type.Boolean(), download: Type.Boolean(),
}, { $id: "VscodeSetup" });
export type VscodeSetup = Static<typeof VscodeSetup>;

export const VscodeStatus = Type.Object({
  platform: Type.String(), enabled: Type.Boolean(), configuredExecutable: Type.String(), preference: VscodeProviderPreferenceSchema,
  providers: Type.Array(VscodeProvider), problems: Type.Array(Type.String()), active: Type.Union([VscodeProvider, Type.Null()]),
  activeError: Type.String(), setup: VscodeSetup, license: Type.Object({ accepted: Type.Boolean(), acceptedAt: Type.String() }),
  install: VscodeInstallStatus, state: VscodeState, running: Type.Union([VscodeProvider, Type.Null()]),
  preparing: Type.Union([Type.Object({ received: Type.Number(), total: Type.Number() }), Type.Null()]),
  instance: Type.Number(), pid: Type.Optional(Type.Number()), startedAt: Type.Optional(Type.String()),
  lastError: Type.String(), connections: Type.Number(), idleMinutes: Type.Number(), dataDir: Type.String(),
}, { $id: "VscodeStatus" });
export type VscodeStatus = Static<typeof VscodeStatus>;

export const VscodeAction = Type.Union([
  Type.Literal("stop"), Type.Literal("accept-license"), Type.Literal("revoke-license"),
  Type.Literal("install"), Type.Literal("cancel-install"), Type.Literal("uninstall"),
], { $id: "VscodeAction" });
export type VscodeAction = Static<typeof VscodeAction>;

export const VscodeErrorCode = Type.Union([
  Type.Literal("setup"), Type.Literal("remote"), Type.Literal("folder"), Type.Literal("failed"), Type.Literal("busy"),
], { $id: "VscodeErrorCode" });
export type VscodeErrorCode = Static<typeof VscodeErrorCode>;

export const VscodeConnection = Type.Object({
  url: Type.String(), folder: Type.String(), label: Type.String(), instance: Type.Number(),
}, { $id: "VscodeConnection" });
export type VscodeConnection = Static<typeof VscodeConnection>;

export const VscodeTheme = Type.Object({
  background: Type.String(), panel: Type.String(), elevated: Type.String(), text: Type.String(),
  border: Type.Optional(Type.String()), accent: Type.Optional(Type.String()),
}, { $id: "VscodeTheme" });
export type VscodeTheme = Static<typeof VscodeTheme>;

export const VscodeActionRequest = Type.Object({ action: VscodeAction }, { $id: "VscodeActionRequest" });
export type VscodeActionRequest = Static<typeof VscodeActionRequest>;

export const VscodeConnectRequest = Type.Object({ theme: Type.Optional(VscodeTheme) }, { $id: "VscodeConnectRequest" });
export type VscodeConnectRequest = Static<typeof VscodeConnectRequest>;

export const VscodePending = Type.Object({ pending: Type.Literal(true), status: VscodeStatus }, { $id: "VscodePending" });
export type VscodePending = Static<typeof VscodePending>;

export const VscodeConnectResponse = Type.Union([VscodeConnection, VscodePending], { $id: "VscodeConnectResponse" });
export type VscodeConnectResponse = Static<typeof VscodeConnectResponse>;

export const VscodeFailure = Type.Object({ error: Type.String(), code: VscodeErrorCode }, { $id: "VscodeFailure" });
export type VscodeFailure = Static<typeof VscodeFailure>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/vscode-server", response: VscodeStatus },
  { method: "POST", path: "/__hui/vscode-server", request: VscodeActionRequest, response: VscodeStatus },
  { method: "POST", path: "/__hui/sessions/:id/vscode/connect", request: VscodeConnectRequest, response: VscodeConnectResponse },
];
