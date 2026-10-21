/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type BotTrigger = { "id": string; "botId": string; "name": string; "source": BotTriggerSource; "filter": BotTriggerFilter; "prompt"?: string; "delivery"?: ("followUp") | ("steer"); "enabled": boolean; "cooldownSeconds": number; "createdBy": ("operator") | ("bot"); "createdAt": string; "updatedAt": string; "lastFiredAt"?: string; "tokenHint"?: string; "pending"?: { "events": number; "until": string; }; "watch"?: { "polledAt"?: string; "error"?: string; }; };

export type BotTriggerCreated = { "trigger": BotTrigger; "hook": { "token": string; "path": string; }; };

export type BotTriggerDeleted = { "ok": true; };

export type BotTriggerFilter = { "match"?: TriggerMatch; "prLinks"?: true; "bots"?: true; "external"?: true; };

export type BotTriggerInput = { "name": string; "source": BotTriggerSource; "filter": BotTriggerFilter; "prompt"?: string; "delivery"?: ("followUp") | ("steer"); "enabled"?: boolean; "cooldownSeconds"?: number; };

export type BotTriggerPatch = { "name"?: string; "prompt"?: string; "delivery"?: ("followUp") | ("steer"); "enabled"?: boolean; "cooldownSeconds"?: number; "filter"?: Record<string, unknown>; };

export type BotTriggerResponse = { "trigger": BotTrigger; };

export type BotTriggerRun = { "id": string; "triggerId": string; "triggerName": string; "at": string; "status": BotTriggerRunStatus; "events": number; "summary": string; "reason"?: string; "test"?: true; "catchUp"?: true; };

export type BotTriggerRunResponse = { "run": BotTriggerRun; };

export type BotTriggerRunStatus = ("fired") | ("coalesced") | ("skipped") | ("failed");

export type BotTriggerSource = "listener";

export type BotTriggersList = { "triggers": Array<BotTrigger>; "runs": Array<BotTriggerRun>; "deliveries": { "lastHour": number; "perHour": number; }; };

export type TriggerMatch = { "field": string; "op": ("equals") | ("contains"); "value": string; };
