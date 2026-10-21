/** Public automation schedules, tasks, runs and scheduler route payloads. */
import { Type, type Static } from "typebox";

export const AutomationSchedule = Type.Union([
  Type.Object({ kind: Type.Literal("at"), at: Type.String() }),
  Type.Object({ kind: Type.Literal("every"), everyMs: Type.Number() }),
  Type.Object({ kind: Type.Literal("cron"), expression: Type.String(), timezone: Type.String() }),
], { $id: "AutomationSchedule" });
export type AutomationSchedule = Static<typeof AutomationSchedule>;

export const AutomationRunStatus = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("skipped"), Type.Literal("cancelled"),
], { $id: "AutomationRunStatus" });
export type AutomationRunStatus = Static<typeof AutomationRunStatus>;

export const AutomationCreator = Type.Union([
  Type.Object({ kind: Type.Literal("operator") }),
  Type.Object({ kind: Type.Literal("bot"), botId: Type.String(), handle: Type.String() }),
], { $id: "AutomationCreator" });
export type AutomationCreator = Static<typeof AutomationCreator>;

export const AutomationTask = Type.Object({
  id: Type.String(), name: Type.String(), description: Type.String(), sessionId: Type.String(), prompt: Type.String(),
  schedule: AutomationSchedule, enabled: Type.Boolean(), timeoutSeconds: Type.Number(), createdAt: Type.String(), updatedAt: Type.String(),
  nextRunAt: Type.Union([Type.String(), Type.Null()]), createdBy: Type.Optional(AutomationCreator), until: Type.Optional(Type.String()), runsLeft: Type.Optional(Type.Number()),
}, { $id: "AutomationTask" });
export type AutomationTask = Static<typeof AutomationTask>;

export const AutomationFailureKind = Type.Union([
  Type.Literal("connection"), Type.Literal("rate-limit"), Type.Literal("configuration"), Type.Literal("transient"), Type.Literal("interrupted"), Type.Literal("timeout"), Type.Literal("unknown"),
], { $id: "AutomationFailureKind" });
export type AutomationFailureKind = Static<typeof AutomationFailureKind>;

export const AutomationRun = Type.Object({
  id: Type.String(), taskId: Type.String(), taskName: Type.String(), sessionId: Type.String(), source: Type.Union([Type.Literal("manual"), Type.Literal("scheduled")]),
  status: AutomationRunStatus, createdAt: Type.String(), startedAt: Type.Optional(Type.String()), finishedAt: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()), error: Type.Optional(Type.String()), attempt: Type.Optional(Type.Number()), retryAt: Type.Optional(Type.String()), deadlineAt: Type.Optional(Type.String()),
  delivery: Type.Optional(Type.Object({ text: Type.String(), before: Type.Number(), requestId: Type.Optional(Type.String()) })),
  failure: Type.Optional(Type.Object({ kind: AutomationFailureKind, needsAttention: Type.Boolean() })),
}, { $id: "AutomationRun" });
export type AutomationRun = Static<typeof AutomationRun>;

export const AutomationSnapshot = Type.Object({
  scheduler: Type.Object({ enabled: Type.Literal(true), activeRuns: Type.Number(), nextWakeAt: Type.Union([Type.String(), Type.Null()]) }),
  tasks: Type.Array(AutomationTask), runs: Type.Array(AutomationRun),
}, { $id: "AutomationSnapshot" });
export type AutomationSnapshot = Static<typeof AutomationSnapshot>;

export const AutomationTaskInput = Type.Object({
  name: Type.String(), description: Type.Optional(Type.String()), sessionId: Type.String(), prompt: Type.String(), schedule: AutomationSchedule,
  enabled: Type.Optional(Type.Boolean()), timeoutSeconds: Type.Optional(Type.Number()), until: Type.Optional(Type.Union([Type.String(), Type.Null()])), runs: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
}, { $id: "AutomationTaskInput" });
export type AutomationTaskInput = Static<typeof AutomationTaskInput>;

export const AutomationCreateResponse = Type.Object({ task: AutomationTask, snapshot: AutomationSnapshot }, { $id: "AutomationCreateResponse" });
export const AutomationMutationResponse = Type.Object({ snapshot: AutomationSnapshot }, { $id: "AutomationMutationResponse" });
export const AutomationRunResponse = Type.Object({ run: AutomationRun }, { $id: "AutomationRunResponse" });
export const AutomationCancelResponse = Type.Object({ ok: Type.Literal(true) }, { $id: "AutomationCancelResponse" });
export const AutomationError = Type.Object({ error: Type.String() }, { $id: "AutomationError" });

export const routeSchemas = [
  { method: "GET", path: "/__hui/automation", response: AutomationSnapshot },
  { method: "POST", path: "/__hui/automation/tasks", request: AutomationTaskInput, response: AutomationCreateResponse },
  { method: "PUT", path: "/__hui/automation/tasks/:id", request: AutomationTaskInput, response: AutomationMutationResponse },
  { method: "DELETE", path: "/__hui/automation/tasks/:id", response: AutomationMutationResponse },
  { method: "POST", path: "/__hui/automation/tasks/:id/run", response: AutomationRunResponse },
  { method: "POST", path: "/__hui/automation/runs/:id/cancel", response: AutomationCancelResponse },
];
