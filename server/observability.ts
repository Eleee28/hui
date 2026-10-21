/**
 * The gateway's diagnostics: an in-memory ring of recent events, redacted and bounded before they are kept,
 * with warnings, errors and gateway lifecycle mirrored to the gateway log; and token and cost totals read from
 * PI transcripts and the Durable store. Nothing here is persisted, so the event history starts over with each
 * gateway process.
 */
import { readFile, stat } from "node:fs/promises";
import { platform, release } from "node:os";

import type { SessionRecord } from "./sessions/sessions.ts";
import type { DiagnosticEvent, ObservabilitySnapshot, UsageTotals } from "./api/diagnostics.ts";
export type { DiagnosticArea, DiagnosticEvent, DiagnosticLevel, ObservabilitySnapshot, UsageTotals } from "./api/diagnostics.ts";

const MAX_EVENTS = 300;
const MAX_SUMMARY_CHARS = 240;
const MAX_DETAIL_CHARS = 600;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

let nextId = 1;
const startedAt = new Date().toISOString();
const events: DiagnosticEvent[] = [];
let logSink: ((line: string) => void) | undefined;
let loggedThrough = 0;

/**
 * Replaces credential- and secret-shaped values before any text is retained.
 * Bearer values go first so `Authorization: Bearer …` loses its token, not
 * only the scheme name.
 */
function redactSecrets(value: string): string {
  return value
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password|authorization|cookie)(["']?\s*[:=]\s*["']?)[^\s"',;&)\]}]+/giu, "$1$2[redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/gu, "[redacted]")
    .replace(/\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/gu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/gu, "[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/([?&](?:key|sig|signature|credential|code|auth)=)[^\s&#"']+/giu, "$1[redacted]");
}

/** A route or page path fit for diagnostics: ids replaced, never a query.
 * `/sessions/events` and `/sessions/import` are routes, not session ids. */
export function diagnosticPath(path: string): string {
  return path
    .replace(/[?#].*$/u, "")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, ":id")
    .replace(/\/sessions\/(?!(?:events|import)(?:\/|$))[^/]+/gu, "/sessions/:id")
    .replace(/\/automation\/(tasks|runs)\/[^/]+/gu, "/automation/$1/:id");
}

function bounded(value: string, maximum: number): string {
  const text = redactSecrets(value).replace(/\s+/gu, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

/** The Logs subset: every warning and error, plus gateway lifecycle. */
function isLogEntry(entry: DiagnosticEvent): boolean {
  return entry.level !== "info" || entry.area === "gateway";
}

function formatLogLine(entry: DiagnosticEvent): string {
  const session = entry.sessionId ? ` session=${entry.sessionId}` : "";
  const detail = entry.detail ? `: ${entry.detail}` : "";
  return `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.area}/${entry.action}${session} ${entry.summary}${detail}\n`;
}

function writeLogLine(entry: DiagnosticEvent): void {
  loggedThrough = Math.max(loggedThrough, entry.id);
  try {
    logSink?.(formatLogLine(entry));
  } catch {
    // Logging is best effort; it must never fail the operation being logged.
  }
}

/**
 * Also writes the Logs subset to a line sink. The gateway passes stderr, which
 * `hui gateway start` appends to `gateway.log`, so failures outlive this
 * process's in-memory buffer. Retained entries not written yet are flushed
 * first, oldest first; attaching again never repeats a line.
 */
export function mirrorDiagnosticLogs(sink: ((line: string) => void) | undefined): void {
  logSink = sink;
  if (!sink) return;
  for (const entry of events.toReversed()) {
    if (entry.id > loggedThrough && isLogEntry(entry)) writeLogLine(entry);
  }
}

export function recordDiagnosticEvent(input: Omit<DiagnosticEvent, "id" | "timestamp">): void {
  const detail = input.level !== "info" && input.detail ? bounded(input.detail, MAX_DETAIL_CHARS) : "";
  const entry: DiagnosticEvent = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    area: input.area,
    level: input.level,
    action: input.action,
    summary: bounded(input.summary, MAX_SUMMARY_CHARS),
    ...(detail ? { detail } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  events.unshift(entry);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  if (logSink && isLogEntry(entry)) writeLogLine(entry);
}

function numberAt(value: unknown, ...keys: string[]): number {
  if (typeof value !== "object" || value === null) return 0;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return 0;
}

function usageObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record["usage"];
  if (typeof direct === "object" && direct !== null) return direct as Record<string, unknown>;
  const message = record["message"];
  if (typeof message === "object" && message !== null) {
    const nested = (message as Record<string, unknown>)["usage"];
    if (typeof nested === "object" && nested !== null) return nested as Record<string, unknown>;
  }
  return undefined;
}

function modelOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const message = typeof record["message"] === "object" && record["message"] !== null
    ? record["message"] as Record<string, unknown>
    : undefined;
  const model = message?.["model"] ?? record["model"];
  return typeof model === "string" && model.trim() ? model.trim().slice(0, 160) : undefined;
}

/** Token and cost counters of one PI transcript record, as HUI totals them; undefined without a usage object. */
export function transcriptUsage(record: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number } | undefined {
  const usage = usageObject(record);
  if (!usage) return undefined;
  const input = numberAt(usage, "input", "inputTokens", "input_tokens");
  const output = numberAt(usage, "output", "outputTokens", "output_tokens");
  const cacheRead = numberAt(usage, "cacheRead", "cacheReadTokens", "cache_read_input_tokens");
  const cacheWrite = numberAt(usage, "cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens");
  const totalTokens = numberAt(usage, "total", "totalTokens", "total_tokens") || input + output + cacheRead + cacheWrite;
  const rawCost = usage["cost"];
  const cost = typeof rawCost === "object" && rawCost !== null
    ? numberAt(rawCost, "total", "usd", "totalCost")
    : numberAt(usage, "cost", "totalCost", "costUsd", "cost_usd");
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

type DurableUsage = (conversationId: number) => Promise<{ models?: Record<string, Record<string, unknown>> } | undefined>;

export async function aggregateUsage(sessions: readonly SessionRecord[], durableUsage?: DurableUsage): Promise<UsageTotals> {
  const totals: UsageTotals = {
    sessions: sessions.length, filesRead: 0, records: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: null, models: [], unavailable: [],
  };
  const models = new Map<string, number>();
  let knownCost = 0;
  let hasCost = false;
  for (const session of sessions) {
    const path = session.piSessionFile;
    // Remote transcripts and stores live on their worker.
    if (!path || session.worker) continue;
    const durable = /^durable:(\d+)$/u.exec(path);
    if (durable) {
      // Durable keeps spend per conversation and model, including prompt-cache
      // refreshes and nested tool calls, outside the transcript.
      const usage = await durableUsage?.(Number(durable[1])).catch(() => undefined);
      if (!usage) {
        totals.unavailable = [...totals.unavailable, `${session.id}: Durable store unavailable`];
        continue;
      }
      totals.filesRead += 1;
      for (const [model, entry] of Object.entries(usage.models ?? {})) {
        totals.records += 1;
        const input = numberAt(entry, "input");
        const output = numberAt(entry, "output");
        const cacheRead = numberAt(entry, "cacheRead");
        const cacheWrite = numberAt(entry, "cacheWrite");
        const total = numberAt(entry, "totalTokens") || input + output + cacheRead + cacheWrite;
        totals.inputTokens += input;
        totals.outputTokens += output;
        totals.cacheReadTokens += cacheRead;
        totals.cacheWriteTokens += cacheWrite;
        totals.totalTokens += total;
        const rawCost = entry["cost"];
        const cost = typeof rawCost === "object" && rawCost !== null ? numberAt(rawCost, "total") : 0;
        if (cost > 0) { knownCost += cost; hasCost = true; }
        if (total > 0) models.set(model, (models.get(model) ?? 0) + total);
      }
      continue;
    }
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) {
        totals.unavailable = [...totals.unavailable, `${session.id}: transcript too large or unavailable`];
        continue;
      }
      const source = await readFile(path, "utf8");
      totals.filesRead += 1;
      for (const line of source.split("\n")) {
        if (!line.trim()) continue;
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        totals.records += 1;
        const usage = transcriptUsage(record);
        if (!usage) continue;
        const { input, output, cacheRead, cacheWrite, totalTokens: total, cost } = usage;
        totals.inputTokens += input;
        totals.outputTokens += output;
        totals.cacheReadTokens += cacheRead;
        totals.cacheWriteTokens += cacheWrite;
        totals.totalTokens += total;
        if (cost > 0) { knownCost += cost; hasCost = true; }
        const model = modelOf(record);
        if (model && total > 0) models.set(model, (models.get(model) ?? 0) + total);
      }
    } catch {
      totals.unavailable = [...totals.unavailable, `${session.id}: transcript unavailable`];
    }
  }
  totals.costUsd = hasCost ? knownCost : null;
  totals.models = [...models.entries()]
    .map(([model, tokens]) => ({ model, tokens }))
    .toSorted((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  return totals;
}

export async function readObservability(sessions: readonly SessionRecord[], durableUsage?: DurableUsage): Promise<ObservabilitySnapshot> {
  const memory = process.memoryUsage();
  const activity = [...events];
  return {
    generatedAt: new Date().toISOString(),
    retention: { kind: "memory", maximum: MAX_EVENTS, since: startedAt },
    activity,
    logs: activity.filter(isLogEntry),
    usage: await aggregateUsage(sessions, durableUsage),
    debug: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal },
      eventCount: activity.length,
    },
  };
}

recordDiagnosticEvent({ area: "gateway", level: "info", action: "start", summary: "HUI gateway started" });
