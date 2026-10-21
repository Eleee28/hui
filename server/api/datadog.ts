/** Public Datadog org, sign-in and preview payloads, without pup credentials. */
import { Type, type Static } from "typebox";

export const DatadogOrg = Type.Object({ name: Type.String(), site: Type.String() }, { $id: "DatadogOrg" });
export type DatadogOrg = Static<typeof DatadogOrg>;

export const DatadogOrgStatus = Type.Object({
  name: Type.String(), site: Type.String(),
  status: Type.Union([Type.Literal("connected"), Type.Literal("signed_out"), Type.Literal("unknown")]),
}, { $id: "DatadogOrgStatus" });
export type DatadogOrgStatus = Static<typeof DatadogOrgStatus>;

export const DatadogLoginState = Type.Union([
  Type.Object({ phase: Type.Literal("idle") }),
  Type.Object({ phase: Type.Literal("pending"), org: DatadogOrg, url: Type.Optional(Type.String()), expiresAt: Type.Number() }),
  Type.Object({ phase: Type.Literal("failed"), org: DatadogOrg, message: Type.String() }),
], { $id: "DatadogLoginState" });
export type DatadogLoginState = Static<typeof DatadogLoginState>;

export const DatadogConnection = Type.Object({
  cli: Type.Union([Type.Object({ installed: Type.Literal(false) }), Type.Object({ installed: Type.Literal(true), version: Type.String() })]),
  orgs: Type.Array(DatadogOrgStatus), pupOrgs: Type.Array(DatadogOrg), login: DatadogLoginState,
}, { $id: "DatadogConnection" });
export type DatadogConnection = Static<typeof DatadogConnection>;

export const DatadogPreview = Type.Object({
  kind: Type.Union([Type.Literal("share"), Type.Literal("widget"), Type.Literal("dashboard")]),
  url: Type.String(), title: Type.String(), detail: Type.Optional(Type.String()), org: Type.Optional(Type.String()),
  from: Type.Optional(Type.Number()), to: Type.Optional(Type.Number()), relative: Type.Optional(Type.Boolean()), image: Type.Optional(Type.String()),
}, { $id: "DatadogPreview" });
export type DatadogPreview = Static<typeof DatadogPreview>;

export const DatadogPreviewError = Type.Union([
  Type.Literal("not_found"), Type.Literal("signed_out"), Type.Literal("no_org"), Type.Literal("cli_missing"), Type.Literal("unavailable"),
], { $id: "DatadogPreviewError" });
export type DatadogPreviewError = Static<typeof DatadogPreviewError>;

export const DatadogPreviewResult = Type.Object({
  url: Type.String(), preview: Type.Optional(DatadogPreview), error: Type.Optional(DatadogPreviewError), signIn: Type.Optional(DatadogOrg),
}, { $id: "DatadogPreviewResult" });
export type DatadogPreviewResult = Static<typeof DatadogPreviewResult>;

export const DatadogOrgRequest = Type.Object({
  name: Type.Optional(Type.String()), site: Type.Optional(Type.String()),
}, { $id: "DatadogOrgRequest" });
export type DatadogOrgRequest = Static<typeof DatadogOrgRequest>;

export const DatadogPreviewsResponse = Type.Object({ previews: Type.Array(DatadogPreviewResult) }, { $id: "DatadogPreviewsResponse" });
export type DatadogPreviewsResponse = Static<typeof DatadogPreviewsResponse>;

export const DatadogError = Type.Object({ error: Type.String() }, { $id: "DatadogError" });
export type DatadogError = Static<typeof DatadogError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/datadog", response: DatadogConnection },
  { method: "POST", path: "/__hui/datadog/orgs", request: DatadogOrgRequest, response: DatadogConnection },
  { method: "DELETE", path: "/__hui/datadog/orgs", response: DatadogConnection },
  { method: "POST", path: "/__hui/datadog/login", request: DatadogOrg, response: DatadogConnection },
  { method: "DELETE", path: "/__hui/datadog/login", response: DatadogConnection },
  { method: "GET", path: "/__hui/datadog/previews", response: DatadogPreviewsResponse },
];
