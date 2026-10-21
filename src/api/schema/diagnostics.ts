/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type DiagnosticArea = ("gateway") | ("session") | ("runtime") | ("automation") | ("ui");

export type DiagnosticEvent = { "id": number; "timestamp": string; "area": DiagnosticArea; "level": DiagnosticLevel; "action": string; "summary": string; "detail"?: string; "sessionId"?: string; };

export type DiagnosticLevel = ("info") | ("warning") | ("error");

export type DiagnosticsError = { "error": string; };

export type GatewayHealth = { "status": "online"; "transport": "HTTP + SSE"; "uptimeSeconds": number; "access": "Full Access"; "sessions": { "idle": number; "running": number; "waiting": number; "starting": number; "error": number; "reconnecting": number; "disconnected": number; "registered": number; "processes": number; }; };

export type ObservabilitySnapshot = { "generatedAt": string; "retention": { "kind": "memory"; "maximum": number; "since": string; }; "activity": Array<DiagnosticEvent>; "logs": Array<DiagnosticEvent>; "usage": UsageTotals; "debug": { "node": string; "platform": string; "uptimeSeconds": number; "memory": { "rssBytes": number; "heapUsedBytes": number; "heapTotalBytes": number; }; "eventCount": number; }; };

export type UiErrorBatch = { "reports": Array<UiErrorReport>; "suppressed": number; };

export type UiErrorBatchRequest = { "reports": Array<{ "kind": UiErrorKind; "message": string; "count"?: number; "firstAt"?: string; "lastAt"?: string; "location"?: string; "page"?: string; "request"?: { "method": string; "path": string; }; }>; "suppressed"?: number; };

export type UiErrorKind = ("uncaught_error") | ("unhandled_rejection") | ("request_failed");

export type UiErrorReceipt = { "recorded": number; "dropped": number; };

export type UiErrorReport = { "kind": UiErrorKind; "message": string; "count": number; "firstAt"?: string; "lastAt"?: string; "location"?: string; "page"?: string; "request"?: { "method": string; "path": string; }; };

export type UsageTotals = { "sessions": number; "filesRead": number; "records": number; "inputTokens": number; "outputTokens": number; "cacheReadTokens": number; "cacheWriteTokens": number; "totalTokens": number; "costUsd": (number) | (null); "models": Array<{ "model": string; "tokens": number; }>; "unavailable": Array<string>; };
