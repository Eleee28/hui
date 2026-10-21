/**
 * User-facing state for automation runs shared by Automations and bot routines.
 * Recovery decisions belong to the scheduler; this only explains its recorded
 * retry or intervention state without guessing from an error message.
 */
import type { AutomationRun } from "../api/schema/automation.ts";

const STATUS_LABELS: Record<AutomationRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** A retry timestamp is a promise only while the run is still queued. */
function retryScheduled(run: AutomationRun): boolean {
  return run.status === "queued" && Boolean(run.retryAt);
}

export function automationRunLabel(run: AutomationRun): string {
  if (retryScheduled(run)) return "Retry scheduled";
  if (run.status === "failed" && run.failure?.needsAttention) return "Needs attention";
  return STATUS_LABELS[run.status];
}

const FAILURE_GUIDANCE: Record<NonNullable<AutomationRun["failure"]>["kind"], string> = {
  connection: "Reconnect the target machine or session, then run again.",
  "rate-limit": "Check the provider's quota or billing, then run again when it is available.",
  configuration: "Check the target session, model and credentials, then run again.",
  transient: "Check that the service is available, then run again.",
  interrupted: "Check the chat for actions already taken before running again.",
  timeout: "Check the chat for actions already taken, then adjust the task or timeout before running again.",
  unknown: "Check the error and chat before running again.",
};

/** Keep the recorded error alongside this explanation; it is never replaced. */
export function automationRunRecoveryDetail(run: AutomationRun, formatTime: (value: string) => string): string {
  const details: string[] = [];
  if (retryScheduled(run) || (run.attempt ?? 1) > 1) details.push(`Attempt ${run.attempt ?? 1}/3`);
  if (retryScheduled(run)) details.push(`Next retry ${formatTime(run.retryAt!)}`);
  if (run.status === "failed" && run.failure?.needsAttention) details.push(FAILURE_GUIDANCE[run.failure.kind]);
  return details.join(" · ");
}
