/** Optional transcript measurements, never inferred from neighbouring messages: sanitizing and runtime timings. */
import type { TranscriptMetrics } from "../api/sessions.ts";

export type { TranscriptMetrics };

export function validMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function sanitizeMetrics(value: unknown): TranscriptMetrics {
  if (!value || typeof value !== "object") return {};
  const result: TranscriptMetrics = {};
  for (const key of ["timestamp", "completedAt", "durationMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    const number = validMetric((value as Record<string, unknown>)[key]);
    if (number !== undefined && (!(key === "timestamp" || key === "completedAt") || number <= 8.64e15)) result[key] = number;
  }
  return result;
}

/** Measurements survive browser reconnects, but not a runtime restart. PI owns persistence. */
export class RuntimeTimings {
  private messageTimestamp: number | undefined;
  private starts = new Map<string, number>();
  private completed = new Map<string, TranscriptMetrics>();
  observe(raw: Record<string, unknown>, now = Date.now()): void {
    const message = raw.message as Record<string, unknown> | undefined;
    const type = raw.type;
    if (type === "message_start" && message?.role === "assistant") this.messageTimestamp = validMetric(message.timestamp);
    const isMessage = type === "message_start" || type === "message_end";
    if (isMessage && message?.role !== "assistant") return;
    const id = isMessage ? validMetric(message?.timestamp) : raw.toolCallId;
    if (id === undefined || (typeof id !== "number" && typeof id !== "string")) return;
    const key = isMessage ? `message:${id}` : `tool:${this.messageTimestamp}:${id}`;
    if (type === "message_start" || type === "tool_execution_start") this.starts.set(key, now);
    if (type === "message_end" || type === "tool_execution_end") {
      const start = this.starts.get(key);
      this.completed.set(key, { completedAt: now, ...(start !== undefined && now >= start ? { durationMs: now - start } : {}) });
      this.starts.delete(key);
    }
  }
  get(kind: "message" | "tool", id: unknown, messageTimestamp?: unknown): TranscriptMetrics {
    const key = kind === "message" ? `message:${id}` : `tool:${messageTimestamp}:${id}`;
    return this.completed.get(key) ?? {};
  }
}
