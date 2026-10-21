/** Public read-only PI configuration, model catalog, resource documents and mutation results. */
import { Type, type Static } from "typebox";

export const PiTool = Type.Object({
  name: Type.String(), kind: Type.Union([Type.Literal("builtin"), Type.Literal("hui")]), source: Type.Optional(Type.String()),
}, { $id: "PiTool" });
export type PiTool = Static<typeof PiTool>;

export const PiSkill = Type.Object({
  id: Type.String(), name: Type.String(), description: Type.String(), path: Type.String(), root: Type.String(),
  origin: Type.Optional(Type.Literal("hui")), tags: Type.Optional(Type.Immutable(Type.Array(Type.String()))), preferencePath: Type.Optional(Type.String()),
}, { $id: "PiSkill" });
export type PiSkill = Static<typeof PiSkill>;

export const PiModelCatalogEntry = Type.Object({
  provider: Type.String(), id: Type.String(), name: Type.String(), contextWindow: Type.Optional(Type.Number()), maxTokens: Type.Optional(Type.Number()),
  thinkingLevels: Type.Optional(Type.Immutable(Type.Array(Type.String()))), fast: Type.Optional(Type.Literal(true)),
}, { $id: "PiModelCatalogEntry" });
export type PiModelCatalogEntry = Static<typeof PiModelCatalogEntry>;

export const PiModel = Type.Object({
  defaultProvider: Type.String(), defaultModel: Type.String(), thinking: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Immutable(Type.Array(Type.String())), authenticated: Type.Immutable(Type.Array(Type.String())),
  catalog: Type.Immutable(Type.Array(PiModelCatalogEntry)),
}, { $id: "PiModel" });
export type PiModel = Static<typeof PiModel>;

export const PiConfiguredResource = Type.Object({
  id: Type.String(), label: Type.String(), kind: Type.Union([Type.Literal("package"), Type.Literal("extension")]),
}, { $id: "PiConfiguredResource" });
export type PiConfiguredResource = Static<typeof PiConfiguredResource>;

export const PiSettingsSummary = Type.Object({
  path: Type.String(), exists: Type.Boolean(), packages: Type.Immutable(Type.Array(Type.String())), extensions: Type.Immutable(Type.Array(Type.String())),
  resources: Type.Immutable(Type.Array(PiConfiguredResource)), skillRoots: Type.Immutable(Type.Array(Type.String())),
}, { $id: "PiSettingsSummary" });
export type PiSettingsSummary = Static<typeof PiSettingsSummary>;

export const PiSnapshot = Type.Object({
  agentDir: Type.String(), settings: PiSettingsSummary, skills: Type.Immutable(Type.Array(PiSkill)), tools: Type.Immutable(Type.Array(PiTool)),
  model: PiModel, diagnostics: Type.Immutable(Type.Array(Type.String())),
}, { $id: "PiSnapshot" });
export type PiSnapshot = Static<typeof PiSnapshot>;

export const PiResourceDocument = Type.Object({
  id: Type.String(), kind: Type.Union([Type.Literal("skill"), Type.Literal("package"), Type.Literal("extension")]),
  title: Type.String(), fileName: Type.String(), format: Type.Union([Type.Literal("markdown"), Type.Literal("code"), Type.Literal("json")]),
  content: Type.String(), truncated: Type.Boolean(),
}, { $id: "PiResourceDocument" });
export type PiResourceDocument = Static<typeof PiResourceDocument>;

export const PiMutationKind = Type.Union([
  Type.Literal("package-install"), Type.Literal("package-remove"), Type.Literal("skill-install"),
], { $id: "PiMutationKind" });
export type PiMutationKind = Static<typeof PiMutationKind>;

export const PiMutationResult = Type.Object({
  kind: PiMutationKind, target: Type.String(), message: Type.String(), snapshot: PiSnapshot,
}, { $id: "PiMutationResult" });
export type PiMutationResult = Static<typeof PiMutationResult>;

export const PiInstallRequest = Type.Object({ url: Type.String() }, { $id: "PiInstallRequest" });
export type PiInstallRequest = Static<typeof PiInstallRequest>;

export const PiRemoveRequest = Type.Object({ source: Type.String() }, { $id: "PiRemoveRequest" });
export type PiRemoveRequest = Static<typeof PiRemoveRequest>;

export const PiError = Type.Object({ error: Type.String() }, { $id: "PiError" });
export type PiError = Static<typeof PiError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/pi", response: PiSnapshot },
  { method: "GET", path: "/__hui/pi/resources/:kind/:id", response: PiResourceDocument },
  { method: "POST", path: "/__hui/pi/packages/install", request: PiInstallRequest, response: PiMutationResult },
  { method: "POST", path: "/__hui/pi/packages/remove", request: PiRemoveRequest, response: PiMutationResult },
  { method: "POST", path: "/__hui/pi/skills/install", request: PiInstallRequest, response: PiMutationResult },
];
