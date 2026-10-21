/** Public model-provider configuration, account quota and redacted sign-in progress payloads. */
import { Type, type Static } from "typebox";

export const ProviderModel = Type.Object({
  id: Type.String(), name: Type.String(), contextWindow: Type.Optional(Type.Number()), maxTokens: Type.Optional(Type.Number()),
}, { $id: "ProviderModel" });
export type ProviderModel = Static<typeof ProviderModel>;

export const ProviderSummary = Type.Object({
  id: Type.String(), name: Type.String(),
  methods: Type.Array(Type.Object({ id: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]), label: Type.String() })),
  accounts: Type.Optional(Type.Array(Type.Object({
    id: Type.String(), name: Type.String(), email: Type.Optional(Type.String()), authenticated: Type.Boolean(), cooldownUntil: Type.Optional(Type.Number()),
  }))),
  configured: Type.Boolean(), authenticated: Type.Boolean(), selected: Type.Array(Type.String()), models: Type.Array(ProviderModel),
}, { $id: "ProviderSummary" });
export type ProviderSummary = Static<typeof ProviderSummary>;

export const ProviderLogin = Type.Object({
  id: Type.String(), provider: Type.String(),
  phase: Type.Union([Type.Literal("pending"), Type.Literal("complete"), Type.Literal("failed"), Type.Literal("cancelled")]),
  accountId: Type.Optional(Type.String()), message: Type.Optional(Type.String()), url: Type.Optional(Type.String()), code: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.Object({
    id: Type.String(), type: Type.Union([Type.Literal("text"), Type.Literal("secret"), Type.Literal("select"), Type.Literal("manual_code")]),
    message: Type.String(), options: Type.Optional(Type.Array(Type.Object({ id: Type.String(), label: Type.String() }))),
  })),
}, { $id: "ProviderLogin" });
export type ProviderLogin = Static<typeof ProviderLogin>;

export const ProviderSnapshot = Type.Object({
  providers: Type.Array(ProviderSummary), login: Type.Optional(ProviderLogin),
}, { $id: "ProviderSnapshot" });
export type ProviderSnapshot = Static<typeof ProviderSnapshot>;

export const ProviderQuota = Type.Object({
  status: Type.Union([Type.Literal("available"), Type.Literal("unsupported"), Type.Literal("unavailable")]),
  message: Type.Optional(Type.String()), checkedAt: Type.Number(), plan: Type.Optional(Type.String()), email: Type.Optional(Type.String()),
  access: Type.Optional(Type.Union([Type.Literal("available"), Type.Literal("limited")])),
  windows: Type.Array(Type.Object({
    label: Type.String(), usedPercent: Type.Number(), resetAt: Type.Optional(Type.Number()),
    scope: Type.Union([Type.Literal("account"), Type.Literal("scoped"), Type.Literal("spend")]),
  })),
}, { $id: "ProviderQuota" });
export type ProviderQuota = Static<typeof ProviderQuota>;

export const ProviderLoginRequest = Type.Object({
  method: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")]),
  name: Type.Optional(Type.String()), accountId: Type.Optional(Type.String()),
}, { $id: "ProviderLoginRequest" });
export type ProviderLoginRequest = Static<typeof ProviderLoginRequest>;

export const ProviderAnswerRequest = Type.Object({ promptId: Type.String(), value: Type.String() }, { $id: "ProviderAnswerRequest" });
export type ProviderAnswerRequest = Static<typeof ProviderAnswerRequest>;

export const ProviderModelsRequest = Type.Object({ models: Type.Array(Type.String()) }, { $id: "ProviderModelsRequest" });
export type ProviderModelsRequest = Static<typeof ProviderModelsRequest>;

export const ProviderOrderRequest = Type.Object({ order: Type.Array(Type.String()) }, { $id: "ProviderOrderRequest" });
export type ProviderOrderRequest = Static<typeof ProviderOrderRequest>;

export const ProviderOk = Type.Object({ ok: Type.Literal(true) }, { $id: "ProviderOk" });
export type ProviderOk = Static<typeof ProviderOk>;

export const ProviderError = Type.Object({ error: Type.String() }, { $id: "ProviderError" });
export type ProviderError = Static<typeof ProviderError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/providers", response: ProviderSnapshot },
  { method: "POST", path: "/__hui/providers/:provider/login", request: ProviderLoginRequest, response: ProviderLogin },
  { method: "POST", path: "/__hui/providers/login/:id", request: ProviderAnswerRequest, response: ProviderOk },
  { method: "DELETE", path: "/__hui/providers/login/:id", response: ProviderOk },
  { method: "PUT", path: "/__hui/providers/:provider", request: ProviderModelsRequest, response: ProviderOk },
  { method: "DELETE", path: "/__hui/providers/:provider", response: ProviderOk },
  { method: "PUT", path: "/__hui/providers/:provider/accounts", request: ProviderOrderRequest, response: ProviderOk },
  { method: "DELETE", path: "/__hui/providers/:provider/accounts/:account", response: ProviderOk },
  { method: "GET", path: "/__hui/providers/:provider/accounts/:account/quota", response: ProviderQuota },
  { method: "GET", path: "/__hui/providers/:provider/quota", response: ProviderQuota },
];
