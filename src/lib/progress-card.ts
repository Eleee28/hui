/** Parses streamed progress cards, selects the latest card and formats its sidebar summary. */
import type { ProgressCard, ProgressStep } from "../api/schema/sessions.ts";
export type { ProgressCard, ProgressStep } from "../api/schema/sessions.ts";
export type ProgressStepStatus = ProgressStep["status"];

const STATUSES = new Set<ProgressStepStatus>(["pending", "in_progress", "completed"]);

export function parseProgressCard(value: unknown): ProgressCard | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const markdown = typeof source["markdown"] === "string" ? source["markdown"].slice(0, 8_192) : "";
  const rawPlan = Array.isArray(source["plan"]) ? source["plan"].slice(0, 50) : [];
  const steps = rawPlan.flatMap((item): ProgressStep[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const step = typeof row["step"] === "string" ? row["step"].trim().slice(0, 500) : "";
    const status = row["status"];
    return step && typeof status === "string" && STATUSES.has(status as ProgressStepStatus)
      ? [{ step, status: status as ProgressStepStatus }]
      : [];
  });
  return markdown || steps.length ? { markdown, steps } : undefined;
}

/** The latest progress_card call is authoritative. An empty call clears it. */
export function progressCardFromTranscript<T extends { kind: string; name?: string; args?: unknown }>(transcript: readonly T[]): ProgressCard | undefined {
  const call = transcript.findLast((item) => item.kind === "tool" && item.name === "progress_card");
  return call?.kind === "tool" ? parseProgressCard(call.args) : undefined;
}

/** Compact sidebar label; only explicit plan state supplies a count. */
export function progressCardSummary(card: ProgressCard): { label: string; count: string } {
  const completed = card.steps.filter((step) => step.status === "completed").length;
  const current = card.steps.find((step) => step.status === "in_progress")
    ?? card.steps.find((step) => step.status === "pending");
  return {
    label: current?.step ?? (card.steps.length ? "Completed" : "Agent notes"),
    count: card.steps.length ? `${completed}/${card.steps.length}` : "",
  };
}
