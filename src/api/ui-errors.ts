/**
 * Browser-side failures never reach the gateway by themselves: an uncaught
 * error, an unhandled promise rejection or a request that could not connect
 * (`Failed to fetch`, reported by `trackedFetch` in `request.ts`). They are batched, deduplicated, to
 * `POST /__hui/diagnostics/ui-errors` so Logs and gateway.log show them. While
 * the gateway is unreachable, reports wait in memory (bounded) and are sent once
 * a HUI request succeeds again; a page reload discards them.
 */

import type { UiErrorReport as WireUiErrorReport } from "./schema/diagnostics.ts";
export type { UiErrorKind } from "./schema/diagnostics.ts";

export type UiErrorReport = WireUiErrorReport & Required<Pick<WireUiErrorReport, "firstAt" | "lastAt">>;

export type NewUiErrorReport = Omit<UiErrorReport, "count" | "firstAt" | "lastAt">;
export type SendOutcome = "sent" | "retry" | "drop";
export type SendUiErrorReports = (reports: UiErrorReport[], suppressed: number, keepalive: boolean) => Promise<SendOutcome>;

export type ReporterTimers = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const REPORT_URL = "/__hui/diagnostics/ui-errors";
const REPORT_HEADERS = { "x-hui": "1", "content-type": "application/json" } as const;
const MAX_PENDING = 20;
const MAX_MESSAGE = 500;
const MAX_FIELD = 300;
const FLUSH_DELAY_MS = 2_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const FRAME = /(https?:\/\/[^\s()]+?):(\d+):(\d+)/u;

const systemTimers: ReporterTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function clip(value: string, maximum: number): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

/** Deduplicates reports and sends them in batches, retrying with backoff. */
export class UiErrorReporter {
  readonly #send: SendUiErrorReports;
  readonly #timers: ReporterTimers;
  #pending = new Map<string, UiErrorReport>();
  #suppressed = 0;
  #timer: unknown;
  #retryMs = 0;
  #sending = false;

  constructor(send: SendUiErrorReports, timers: ReporterTimers = systemTimers) {
    this.#send = send;
    this.#timers = timers;
  }

  record(report: NewUiErrorReport): void {
    const at = new Date(this.#timers.now()).toISOString();
    const entry: UiErrorReport = {
      kind: report.kind,
      message: clip(report.message.trim() || "Unknown error", MAX_MESSAGE),
      count: 1, firstAt: at, lastAt: at,
      ...(report.location ? { location: clip(report.location, MAX_FIELD) } : {}),
      ...(report.page ? { page: clip(report.page, MAX_FIELD) } : {}),
      ...(report.request ? { request: { method: report.request.method, path: clip(report.request.path, MAX_FIELD) } } : {}),
    };
    const key = JSON.stringify([entry.kind, entry.message, entry.location, entry.request?.method, entry.request?.path]);
    this.#merge(key, entry);
    // A pending timer (flush or retry) already covers this report; rescheduling
    // on every error would starve the flush under a steady stream of them.
    if (this.#timer === undefined && !this.#sending) this.#schedule(FLUSH_DELAY_MS);
  }

  /** A HUI request just succeeded: send reports waiting on a retry now. */
  reachable(): void {
    if (this.#retryMs > 0 && !this.#sending && (this.#pending.size > 0 || this.#suppressed > 0)) {
      this.#retryMs = 0;
      this.#schedule(0);
    }
  }

  async flush(keepalive = false): Promise<void> {
    if (this.#sending || (this.#pending.size === 0 && this.#suppressed === 0)) return;
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const batch = [...this.#pending];
    const suppressed = this.#suppressed;
    this.#pending = new Map();
    this.#suppressed = 0;
    this.#sending = true;
    let outcome: SendOutcome;
    try {
      outcome = await this.#send(batch.map(([, report]) => report), suppressed, keepalive);
    } catch {
      outcome = "retry";
    }
    this.#sending = false;
    if (outcome === "retry") {
      for (const [key, report] of batch) this.#merge(key, report);
      this.#suppressed += suppressed;
      this.#retryMs = Math.min(Math.max(this.#retryMs * 2, RETRY_MIN_MS), RETRY_MAX_MS);
      this.#schedule(this.#retryMs);
      return;
    }
    this.#retryMs = 0;
    if (this.#pending.size > 0 || this.#suppressed > 0) this.#schedule(FLUSH_DELAY_MS);
  }

  #merge(key: string, report: UiErrorReport): void {
    const existing = this.#pending.get(key);
    if (existing) {
      existing.count += report.count;
      if (report.firstAt < existing.firstAt) existing.firstAt = report.firstAt;
      if (report.lastAt > existing.lastAt) existing.lastAt = report.lastAt;
    } else if (this.#pending.size < MAX_PENDING) {
      this.#pending.set(key, { ...report });
    } else {
      this.#suppressed += report.count;
    }
  }

  #schedule(ms: number): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, ms);
  }
}

/** Posts one batch. It uses plain fetch: a report that cannot be delivered is
 * retried by the reporter, never reported again. */
export async function sendUiErrorReports(reports: UiErrorReport[], suppressed: number, keepalive: boolean): Promise<SendOutcome> {
  let response: Response;
  try {
    response = await fetch(REPORT_URL, {
      method: "POST",
      headers: REPORT_HEADERS,
      body: JSON.stringify({ reports, suppressed }),
      cache: "no-store",
      keepalive,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return "retry";
  }
  if (response.ok) return "sent";
  // A starting or stopping gateway answers 503; a malformed batch is dropped.
  return response.status >= 500 || response.status === 429 ? "retry" : "drop";
}

let reporter: UiErrorReporter | undefined;
const reportedFailures = new WeakSet<object>();

function currentPage(): { page?: string } {
  return typeof location === "undefined" ? {} : { page: location.pathname };
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    return typeof location !== "undefined" && url.origin === location.origin ? url.pathname : `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function sourceLocation(file?: string, line?: number, column?: number, stack?: string): string | undefined {
  if (file) return `${shortUrl(file)}:${line ?? 0}:${column ?? 0}`;
  for (const frame of stack?.split("\n") ?? []) {
    const match = FRAME.exec(frame);
    if (match) return `${shortUrl(match[1]!)}:${match[2]}:${match[3]}`;
  }
  return undefined;
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message ? `${value.name}: ${value.message}` : value.name;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A HUI request just succeeded. */
export function reportReachable(): void {
  reporter?.reachable();
}

/** A HUI request could not reach the gateway. */
export function reportRequestFailure(error: unknown, request: { method: string; path: string }): void {
  if (!reporter) return;
  if (typeof error === "object" && error !== null) reportedFailures.add(error);
  reporter.record({
    kind: "request_failed",
    message: error instanceof Error ? error.message || error.name : String(error),
    request,
    ...currentPage(),
  });
}

/** Installs the page-wide handlers once and returns the active reporter. */
export function installUiErrorReporting(
  target: Pick<EventTarget, "addEventListener"> = window,
  send: SendUiErrorReports = sendUiErrorReports,
  timers: ReporterTimers = systemTimers,
): UiErrorReporter {
  if (reporter) return reporter;
  const active = new UiErrorReporter(send, timers);
  reporter = active;
  target.addEventListener("error", (event) => {
    const failure = event as ErrorEvent;
    const message = failure.error !== undefined && failure.error !== null ? describe(failure.error) : failure.message;
    // Cross-origin scripts only say "Script error." and ResizeObserver's loop
    // notice is benign; neither is actionable.
    if (!message || (message === "Script error." && !failure.filename) || /^ResizeObserver loop/u.test(message)) return;
    const location = sourceLocation(failure.filename || undefined, failure.lineno, failure.colno, (failure.error as Error | undefined)?.stack);
    active.record({ kind: "uncaught_error", message, ...(location ? { location } : {}), ...currentPage() });
  });
  target.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason as unknown;
    if (reason instanceof DOMException && reason.name === "AbortError") return;
    // A request failure is already reported as request_failed.
    if (typeof reason === "object" && reason !== null && reportedFailures.has(reason)) return;
    const location = sourceLocation(undefined, undefined, undefined, reason instanceof Error ? reason.stack : undefined);
    active.record({ kind: "unhandled_rejection", message: describe(reason), ...(location ? { location } : {}), ...currentPage() });
  });
  target.addEventListener("online", () => active.reachable());
  target.addEventListener("pagehide", () => {
    void active.flush(true);
  });
  return active;
}

/** Test seam: forget the installed reporter. */
export function resetUiErrorReporting(): void {
  reporter = undefined;
}
