/**
 * Small text formatters around chat messages: elapsed and relative times, token counts, a run's metric
 * summary and the quoted reply draft. Presentation only; the metrics themselves come from the gateway.
 */
import type { TranscriptMetrics } from "../api/schema/sessions.ts";

export function elapsedLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// `toLocaleString("en-US")` builds a new formatter on every call (~7 µs), and
// every render of a long transcript formats thousands of token counts.
const countFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return countFormat.format(value);
}

export function metricSummary(metrics?: TranscriptMetrics): string {
  if (!metrics) return "";
  return [metrics.durationMs !== undefined ? `Completed in ${elapsedLabel(metrics.durationMs)}` : "",
    metrics.outputTokens !== undefined ? `${formatCount(metrics.outputTokens)} output ${metrics.outputTokens === 1 ? "token" : "tokens"}` : ""].filter(Boolean).join(" · ");
}

/** Plain Markdown quote: persists with the existing draft/prompt format. */
export function replyDraft(draft: string, text: string): string {
  const quote = text.split(/\r?\n/).map(line => `> ${line}`).join("\n");
  return `${draft}${draft ? "\n\n" : ""}${quote}\n\n`;
}
