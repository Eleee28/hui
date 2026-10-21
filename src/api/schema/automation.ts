/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type AutomationCancelResponse = { "ok": true; };

export type AutomationCreateResponse = { "task": AutomationTask; "snapshot": AutomationSnapshot; };

export type AutomationCreator = ({ "kind": "operator"; }) | ({ "kind": "bot"; "botId": string; "handle": string; });

export type AutomationError = { "error": string; };

export type AutomationFailureKind = ("connection") | ("rate-limit") | ("configuration") | ("transient") | ("interrupted") | ("timeout") | ("unknown");

export type AutomationMutationResponse = { "snapshot": AutomationSnapshot; };

export type AutomationRun = { "id": string; "taskId": string; "taskName": string; "sessionId": string; "source": ("manual") | ("scheduled"); "status": AutomationRunStatus; "createdAt": string; "startedAt"?: string; "finishedAt"?: string; "summary"?: string; "error"?: string; "attempt"?: number; "retryAt"?: string; "deadlineAt"?: string; "delivery"?: { "text": string; "before": number; "requestId"?: string; }; "failure"?: { "kind": AutomationFailureKind; "needsAttention": boolean; }; };

export type AutomationRunResponse = { "run": AutomationRun; };

export type AutomationRunStatus = ("queued") | ("running") | ("completed") | ("failed") | ("skipped") | ("cancelled");

export type AutomationSchedule = ({ "kind": "at"; "at": string; }) | ({ "kind": "every"; "everyMs": number; }) | ({ "kind": "cron"; "expression": string; "timezone": string; });

export type AutomationSnapshot = { "scheduler": { "enabled": true; "activeRuns": number; "nextWakeAt": (string) | (null); }; "tasks": Array<AutomationTask>; "runs": Array<AutomationRun>; };

export type AutomationTask = { "id": string; "name": string; "description": string; "sessionId": string; "prompt": string; "schedule": AutomationSchedule; "enabled": boolean; "timeoutSeconds": number; "createdAt": string; "updatedAt": string; "nextRunAt": (string) | (null); "createdBy"?: AutomationCreator; "until"?: string; "runsLeft"?: number; };

export type AutomationTaskInput = { "name": string; "description"?: string; "sessionId": string; "prompt": string; "schedule": AutomationSchedule; "enabled"?: boolean; "timeoutSeconds"?: number; "until"?: (string) | (null); "runs"?: (number) | (null); };
