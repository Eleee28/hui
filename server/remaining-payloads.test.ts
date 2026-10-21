import { expectTypeOf, test } from "vitest";
import type * as Diagnostics from "./api/diagnostics.ts";
import type * as Paths from "./api/local-paths.ts";
import type * as Themes from "./api/themes.ts";
import type { SessionStatus } from "./api/sessions.ts";

type UiErrorKind = "uncaught_error" | "unhandled_rejection" | "request_failed";

type DiagnosticLevel = "info" | "warning" | "error";
type DiagnosticArea = "gateway" | "session" | "runtime" | "automation" | "ui";

type DiagnosticEvent = {
  id: number;
  timestamp: string;
  area: DiagnosticArea;
  level: DiagnosticLevel;
  action: string;
  summary: string;
  detail?: string;
  sessionId?: string;
};

type UsageTotals = {
  sessions: number;
  filesRead: number;
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  models: readonly { model: string; tokens: number }[];
  unavailable: readonly string[];
};

type ObservabilitySnapshot = {
  generatedAt: string;
  retention: { kind: "memory"; maximum: number; since: string };
  activity: readonly DiagnosticEvent[];
  logs: readonly DiagnosticEvent[];
  usage: UsageTotals;
  debug: {
    node: string;
    platform: string;
    uptimeSeconds: number;
    memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
    eventCount: number;
  };
};

type UiErrorReport = {
  kind: UiErrorKind;
  message: string;
  count: number;
  firstAt?: string;
  lastAt?: string;
  location?: string;
  page?: string;
  request?: { method: string; path: string };
};

type UiErrorBatch = { reports: UiErrorReport[]; suppressed: number };

type GatewayHealth = {
  status: "online"; transport: "HTTP + SSE"; uptimeSeconds: number; access: "Full Access";
  sessions: Record<SessionStatus | "registered" | "processes", number>;
};
type LocalPathSuggestion = { path: string; kind: "directory" | "file" };
type GitCheckoutInfo = {
  available: boolean; headBranch: string; defaultBranch: string; branches: readonly string[]; branchesUnavailable?: boolean;
};
type ThemeRef = { id: string; name: string; url: string };

test("the remaining schemas preserve the existing public payload types", () => {
  expectTypeOf<GatewayHealth>().toEqualTypeOf<Diagnostics.GatewayHealth>();
  expectTypeOf<DiagnosticLevel>().toEqualTypeOf<Diagnostics.DiagnosticLevel>();
  expectTypeOf<DiagnosticArea>().toEqualTypeOf<Diagnostics.DiagnosticArea>();
  expectTypeOf<DiagnosticEvent>().toEqualTypeOf<Diagnostics.DiagnosticEvent>();
  expectTypeOf<UsageTotals>().toEqualTypeOf<Diagnostics.UsageTotals>();
  expectTypeOf<ObservabilitySnapshot>().toEqualTypeOf<Diagnostics.ObservabilitySnapshot>();
  expectTypeOf<UiErrorKind>().toEqualTypeOf<Diagnostics.UiErrorKind>();
  expectTypeOf<UiErrorReport>().toEqualTypeOf<Diagnostics.UiErrorReport>();
  expectTypeOf<UiErrorBatch>().toEqualTypeOf<Diagnostics.UiErrorBatch>();
  expectTypeOf<LocalPathSuggestion>().toEqualTypeOf<Paths.LocalPathSuggestion>();
  expectTypeOf<GitCheckoutInfo>().toEqualTypeOf<Paths.GitCheckoutInfo>();
  expectTypeOf<ThemeRef>().toEqualTypeOf<Themes.ThemeRef>();
});
