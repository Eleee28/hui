import { expectTypeOf, test } from "vitest";
import type * as Api from "./api/automation.ts";

type LegacyAutomationSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; expression: string; timezone: string };

type LegacyAutomationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";

type LegacyAutomationCreator = { kind: "operator" } | { kind: "bot"; botId: string; handle: string };

type LegacyAutomationTask = {
  id: string;
  name: string;
  description: string;
  sessionId: string;
  prompt: string;
  schedule: LegacyAutomationSchedule;
  enabled: boolean;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  createdBy?: LegacyAutomationCreator;
  until?: string;
  runsLeft?: number;
};

type LegacyAutomationRun = {
  id: string;
  taskId: string;
  taskName: string;
  sessionId: string;
  source: "manual" | "scheduled";
  status: LegacyAutomationRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  attempt?: number;
  retryAt?: string;
  deadlineAt?: string;
  delivery?: { text: string; before: number; requestId?: string };
  failure?: { kind: LegacyAutomationFailureKind; needsAttention: boolean };
};

type LegacyAutomationFailureKind = "connection" | "rate-limit" | "configuration" | "transient" | "interrupted" | "timeout" | "unknown";

type LegacyAutomationSnapshot = {
  scheduler: { enabled: true; activeRuns: number; nextWakeAt: string | null };
  tasks: LegacyAutomationTask[];
  runs: LegacyAutomationRun[];
};

type LegacyAutomationTaskInput = {
  name: string;
  description?: string;
  sessionId: string;
  prompt: string;
  schedule: LegacyAutomationSchedule;
  enabled?: boolean;
  timeoutSeconds?: number;
  until?: string | null;
  runs?: number | null;
};

test("automation schemas preserve the existing payload types", () => {
  expectTypeOf<LegacyAutomationSchedule>().toMatchTypeOf<Api.AutomationSchedule>();
  expectTypeOf<Api.AutomationSchedule>().toMatchTypeOf<LegacyAutomationSchedule>();
  expectTypeOf<LegacyAutomationRunStatus>().toMatchTypeOf<Api.AutomationRunStatus>();
  expectTypeOf<Api.AutomationRunStatus>().toMatchTypeOf<LegacyAutomationRunStatus>();
  expectTypeOf<LegacyAutomationCreator>().toMatchTypeOf<Api.AutomationCreator>();
  expectTypeOf<Api.AutomationCreator>().toMatchTypeOf<LegacyAutomationCreator>();
  expectTypeOf<LegacyAutomationTask>().toMatchTypeOf<Api.AutomationTask>();
  expectTypeOf<Api.AutomationTask>().toMatchTypeOf<LegacyAutomationTask>();
  expectTypeOf<LegacyAutomationRun>().toMatchTypeOf<Api.AutomationRun>();
  expectTypeOf<Api.AutomationRun>().toMatchTypeOf<LegacyAutomationRun>();
  expectTypeOf<LegacyAutomationFailureKind>().toMatchTypeOf<Api.AutomationFailureKind>();
  expectTypeOf<Api.AutomationFailureKind>().toMatchTypeOf<LegacyAutomationFailureKind>();
  expectTypeOf<LegacyAutomationSnapshot>().toMatchTypeOf<Api.AutomationSnapshot>();
  expectTypeOf<Api.AutomationSnapshot>().toMatchTypeOf<LegacyAutomationSnapshot>();
  expectTypeOf<LegacyAutomationTaskInput>().toMatchTypeOf<Api.AutomationTaskInput>();
  expectTypeOf<Api.AutomationTaskInput>().toMatchTypeOf<LegacyAutomationTaskInput>();
});
