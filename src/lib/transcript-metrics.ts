/** The browser's copy of the gateway's transcript-metric sanitizer, run on streamed transcript entries. */
import type { TranscriptMetrics } from "../api/schema/sessions.ts";

function validMetric(value: unknown): number | undefined {
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
