/** Public gateway health, redacted diagnostics and browser error report payloads. */
import { Type, type Static } from "typebox";
import { SessionStatus } from "./sessions.ts";

export const GatewayHealth = Type.Object({
  status: Type.Literal("online"), transport: Type.Literal("HTTP + SSE"), uptimeSeconds: Type.Number(), access: Type.Literal("Full Access"),
  sessions: Type.Record(Type.Union([SessionStatus, Type.Literal("registered"), Type.Literal("processes")]), Type.Number()),
}, { $id: "GatewayHealth" });
export type GatewayHealth = Static<typeof GatewayHealth>;

export const DiagnosticLevel = Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")], { $id: "DiagnosticLevel" });
export type DiagnosticLevel = Static<typeof DiagnosticLevel>;

export const DiagnosticArea = Type.Union([
  Type.Literal("gateway"), Type.Literal("session"), Type.Literal("runtime"), Type.Literal("automation"), Type.Literal("ui"),
], { $id: "DiagnosticArea" });
export type DiagnosticArea = Static<typeof DiagnosticArea>;

export const DiagnosticEvent = Type.Object({
  id: Type.Number(), timestamp: Type.String(), area: DiagnosticArea, level: DiagnosticLevel,
  action: Type.String(), summary: Type.String(), detail: Type.Optional(Type.String()), sessionId: Type.Optional(Type.String()),
}, { $id: "DiagnosticEvent" });
export type DiagnosticEvent = Static<typeof DiagnosticEvent>;

export const UsageTotals = Type.Object({
  sessions: Type.Number(), filesRead: Type.Number(), records: Type.Number(), inputTokens: Type.Number(), outputTokens: Type.Number(),
  cacheReadTokens: Type.Number(), cacheWriteTokens: Type.Number(), totalTokens: Type.Number(), costUsd: Type.Union([Type.Number(), Type.Null()]),
  models: Type.Immutable(Type.Array(Type.Object({ model: Type.String(), tokens: Type.Number() }))),
  unavailable: Type.Immutable(Type.Array(Type.String())),
}, { $id: "UsageTotals" });
export type UsageTotals = Static<typeof UsageTotals>;

export const ObservabilitySnapshot = Type.Object({
  generatedAt: Type.String(), retention: Type.Object({ kind: Type.Literal("memory"), maximum: Type.Number(), since: Type.String() }),
  activity: Type.Immutable(Type.Array(DiagnosticEvent)), logs: Type.Immutable(Type.Array(DiagnosticEvent)), usage: UsageTotals,
  debug: Type.Object({
    node: Type.String(), platform: Type.String(), uptimeSeconds: Type.Number(),
    memory: Type.Object({ rssBytes: Type.Number(), heapUsedBytes: Type.Number(), heapTotalBytes: Type.Number() }), eventCount: Type.Number(),
  }),
}, { $id: "ObservabilitySnapshot" });
export type ObservabilitySnapshot = Static<typeof ObservabilitySnapshot>;

export const UiErrorKind = Type.Union([
  Type.Literal("uncaught_error"), Type.Literal("unhandled_rejection"), Type.Literal("request_failed"),
], { $id: "UiErrorKind" });
export type UiErrorKind = Static<typeof UiErrorKind>;

export const UiErrorReport = Type.Object({
  kind: UiErrorKind, message: Type.String(), count: Type.Number(),
  firstAt: Type.Optional(Type.String()), lastAt: Type.Optional(Type.String()), location: Type.Optional(Type.String()), page: Type.Optional(Type.String()),
  request: Type.Optional(Type.Object({ method: Type.String(), path: Type.String() })),
}, { $id: "UiErrorReport" });
export type UiErrorReport = Static<typeof UiErrorReport>;

export const UiErrorBatch = Type.Object({ reports: Type.Array(UiErrorReport), suppressed: Type.Number() }, { $id: "UiErrorBatch" });
export type UiErrorBatch = Static<typeof UiErrorBatch>;

export const UiErrorBatchRequest = Type.Object({
  reports: Type.Array(Type.Object({ ...UiErrorReport.properties, count: Type.Optional(Type.Number()) })),
  suppressed: Type.Optional(Type.Number()),
}, { $id: "UiErrorBatchRequest" });
export type UiErrorBatchRequest = Static<typeof UiErrorBatchRequest>;

export const UiErrorReceipt = Type.Object({ recorded: Type.Number(), dropped: Type.Number() }, { $id: "UiErrorReceipt" });
export type UiErrorReceipt = Static<typeof UiErrorReceipt>;

export const DiagnosticsError = Type.Object({ error: Type.String() }, { $id: "DiagnosticsError" });
export type DiagnosticsError = Static<typeof DiagnosticsError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/health", response: GatewayHealth },
  { method: "GET", path: "/__hui/observability", response: ObservabilitySnapshot },
  { method: "GET", path: "/__hui/diagnostics/export", response: ObservabilitySnapshot },
  { method: "POST", path: "/__hui/diagnostics/ui-errors", request: UiErrorBatchRequest, response: UiErrorReceipt },
];
