/** Rebuilds the latest progress card from a session transcript for gateway snapshots. */
import type { ProgressCard, ProgressStep } from "../api/sessions.ts";
type ProgressStepStatus = ProgressStep["status"];

const STATUSES = new Set<ProgressStepStatus>(["pending", "in_progress", "completed"]);

function parseProgressCard(value: unknown): ProgressCard | undefined {
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
