/**
 * Browser-side failures never reach the gateway by themselves: an uncaught
 * error, an unhandled promise rejection or a request that could not connect.
 * The UI batches them to `POST /__hui/diagnostics/ui-errors`; this validates a
 * batch and records it as `ui` diagnostics, rate-limited because gateway.log
 * does not rotate.
 */
import { diagnosticPath, recordDiagnosticEvent, type DiagnosticEvent } from "./observability.ts";
import type { UiErrorBatch, UiErrorKind, UiErrorReport } from "./api/diagnostics.ts";
export type { UiErrorBatch, UiErrorKind, UiErrorReport } from "./api/diagnostics.ts";

export const UI_ERROR_KINDS = ["uncaught_error", "unhandled_rejection", "request_failed"] as const;

export const UI_ERROR_BODY_LIMIT = 64 * 1024;
const MAX_REPORTS = 20;
const MAX_MESSAGE = 2_000;
const MAX_FIELD = 300;
const MAX_COUNT = 1_000_000;
const LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

const SUMMARIES: Record<UiErrorKind, string> = {
  uncaught_error: "Uncaught error in the UI",
  unhandled_rejection: "Unhandled promise rejection in the UI",
  request_failed: "UI request could not reach the gateway",
};

export class UiErrorReportError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= MAX_COUNT;
}

function optionalText(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new UiErrorReportError(`${field} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function optionalTime(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new UiErrorReportError(`${field} must be an ISO timestamp.`);
  }
  return value;
}

function parseRequest(value: unknown, field: string): UiErrorReport["request"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new UiErrorReportError(`${field} must be an object.`);
  const method = value["method"];
  const path = value["path"];
  if (typeof method !== "string" || !/^[A-Z]{3,7}$/u.test(method)) throw new UiErrorReportError(`${field}.method is invalid.`);
  if (typeof path !== "string" || path.length > MAX_FIELD || !path.startsWith("/__hui/")) {
    throw new UiErrorReportError(`${field}.path must be a /__hui/ path.`);
  }
  return { method, path };
}

function parseReport(value: unknown, index: number): UiErrorReport {
  const field = `reports[${index}]`;
  if (!isRecord(value)) throw new UiErrorReportError(`${field} must be an object.`);
  const kind = value["kind"];
  if (!UI_ERROR_KINDS.includes(kind as UiErrorKind)) throw new UiErrorReportError(`${field}.kind is not supported.`);
  const message = optionalText(value["message"], `${field}.message`, MAX_MESSAGE);
  if (!message) throw new UiErrorReportError(`${field}.message is required.`);
  const count = value["count"] ?? 1;
  if (!isCount(count, 1)) throw new UiErrorReportError(`${field}.count must be a positive integer.`);
  const firstAt = optionalTime(value["firstAt"], `${field}.firstAt`);
  const lastAt = optionalTime(value["lastAt"], `${field}.lastAt`);
  const location = optionalText(value["location"], `${field}.location`, MAX_FIELD);
  const page = optionalText(value["page"], `${field}.page`, MAX_FIELD);
  if (page !== undefined && !page.startsWith("/")) throw new UiErrorReportError(`${field}.page must be a path.`);
  const request = parseRequest(value["request"], `${field}.request`);
  if (kind === "request_failed" && !request) throw new UiErrorReportError(`${field}.request is required for request_failed.`);
  return {
    kind: kind as UiErrorKind, message, count,
    ...(firstAt ? { firstAt } : {}), ...(lastAt ? { lastAt } : {}),
    ...(location ? { location } : {}), ...(page ? { page } : {}), ...(request ? { request } : {}),
  };
}

/** Validates a browser batch; unknown fields are ignored. */
export function parseUiErrorBatch(value: unknown): UiErrorBatch {
  if (!isRecord(value)) throw new UiErrorReportError("A UI error report must be an object.");
  const reports = value["reports"];
  if (!Array.isArray(reports) || reports.length === 0 || reports.length > MAX_REPORTS) {
    throw new UiErrorReportError(`reports must hold 1 to ${MAX_REPORTS} entries.`);
  }
  const suppressed = value["suppressed"] ?? 0;
  if (!isCount(suppressed, 0)) throw new UiErrorReportError("suppressed must be a non-negative integer.");
  return { reports: reports.map(parseReport), suppressed };
}

function sessionOf(report: UiErrorReport): string | undefined {
  const match = /\/sessions\/([A-Za-z0-9_-]{8,128})(?:[/?#]|$)/u.exec(report.request?.path ?? report.page ?? "");
  return match?.[1];
}

function eventFor(report: UiErrorReport): Omit<DiagnosticEvent, "id" | "timestamp"> {
  const cause = report.request
    ? `${report.request.method} ${diagnosticPath(report.request.path)}: ${report.message}`
    : `${report.message}${report.location ? ` at ${report.location}` : ""}`;
  const page = report.page ? ` on ${diagnosticPath(report.page)}` : "";
  const when = report.count > 1 && report.firstAt && report.lastAt
    ? ` · first ${report.firstAt}, last ${report.lastAt}`
    : report.firstAt ? ` · at ${report.firstAt}` : "";
  const session = sessionOf(report);
  return {
    area: "ui",
    level: report.kind === "request_failed" ? "warning" : "error",
    action: report.kind,
    summary: `${SUMMARIES[report.kind]}${report.count > 1 ? ` (${report.count}×)` : ""}`,
    detail: `${cause}${page}${when}`,
    ...(session ? { sessionId: session } : {}),
  };
}

/** Records validated batches, at most `LIMIT_PER_MINUTE` events a minute. */
export class UiErrorLog {
  #windowStart = Number.NEGATIVE_INFINITY;
  #windowCount = 0;

  record(batch: UiErrorBatch, now = Date.now()): { recorded: number; dropped: number } {
    if (now - this.#windowStart >= WINDOW_MS) {
      this.#windowStart = now;
      this.#windowCount = 0;
    }
    const events = batch.reports.map(eventFor);
    if (batch.suppressed > 0) {
      events.push({
        area: "ui", level: "warning", action: "reports_suppressed",
        summary: `${batch.suppressed} more UI error${batch.suppressed === 1 ? " was" : "s were"} not reported`,
        detail: "The browser's report queue was full.",
      });
    }
    let recorded = 0;
    let dropped = 0;
    for (const event of events) {
      if (this.#windowCount < LIMIT_PER_MINUTE) {
        recordDiagnosticEvent(event);
        this.#windowCount += 1;
        recorded += 1;
        continue;
      }
      if (this.#windowCount === LIMIT_PER_MINUTE) {
        recordDiagnosticEvent({
          area: "ui", level: "warning", action: "reports_rate_limited",
          summary: "UI error reports are rate-limited",
          detail: `More than ${LIMIT_PER_MINUTE} reports in a minute; the rest of this minute is dropped.`,
        });
        this.#windowCount += 1;
      }
      dropped += 1;
    }
    return { recorded, dropped };
  }
}

export const uiErrorLog = new UiErrorLog();
