/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { AutomationSchedule } from "./automation.ts";
import type { BotTriggerFilter } from "./bot-triggers.ts";
import type { BotFaceEars, BotFaceShape, BotView, BotVoice } from "./bots.ts";

export type BotExportAddition = { "quote": string; "group": "remove" | "ask" | "confirm"; "becomes"?: string; };

export type BotExportAvatar = { "emoji"?: string; "shape"?: BotFaceShape; "ears"?: BotFaceEars; "color"?: string; };

export type BotExportChange = { "id": string; "part": string; "quote": string; "group": BotExportGroup; "reason": string; "replacement": string; "label": string; "question": string; };

export type BotExportCleanup = { "part": string; "field": string; "kind": string; "sample": string; "count": number; };

export type BotExportField = { "key": string; "text": string; };

export type BotExportFileChange = { "id": string; "part": string; "group": "keep" | "remove" | "confirm"; "reasons": Array<string>; "question": string; };

export type BotExportGroup = "keep" | "remove" | "ask" | "confirm";

export type BotExportMeta = { "avatar"?: BotExportAvatar; "model"?: string; "thinking"?: string; "memoryModel"?: string; "memoryThinking"?: string; "voice"?: BotVoice; "tagging"?: "mention" | "nobody"; "routines": Array<{ "schedule": BotExportSchedule; }>; "triggers": Array<{ "filter": BotTriggerFilter; "delivery"?: ("followUp") | ("steer"); "cooldownSeconds": number; }>; "disabledTools": Array<string>; "disabledSkills": Array<string>; "skills": Array<string>; };

export type BotExportPart = { "id": string; "label": string; "kind": "text" | "script"; "fields": Array<BotExportField>; "read": boolean; "unread"?: string; };

export type BotExportReview = { "id": string; "botId": string; "name": string; "model"?: string; "warning"?: string; "parts": Array<BotExportPart>; "cleanup": Array<BotExportCleanup>; "changes": Array<BotExportChange>; "files": Array<BotExportFileChange>; "needs": Array<{ "id": string; "text": string; }>; "leftOut": Array<string>; "meta": BotExportMeta; };

export type BotExportSchedule = ({ "kind": "every"; "everyMs": number; }) | ({ "kind": "cron"; "expression": string; });

export type BotImportPreview = { "template": BotTemplate; "candidates"?: Array<{ "key": string; "name": string; "title"?: string; }>; "pick"?: string; "bot": { "name": string; "handle": string; "title"?: string; "description"?: string; "emoji"?: string; "avatar"?: { "shape"?: BotFaceShape; "ears"?: BotFaceEars; "color"?: string; }; "worker"?: { "id": string; "name": string; }; }; "soul": string; "opener"?: string; "model"?: string; "thinking"?: string; "utilityModel"?: string; "memories": { "included": number; "total": number; }; "skills": Array<{ "name": string; "description": string; "content": string; "files"?: Array<BotTemplateSkillFile>; "original": string; }>; "routines": Array<BotImportRoutine>; "integrations": Array<{ "name": string; "description"?: string; "tool"?: { "name": string; "label": string; }; }>; "disabledTools": Array<string>; "disabledSkills": Array<string>; "open": Array<BotOpenPoint>; "needs": Array<string>; "triggers": Array<BotTemplateTrigger>; "dropped": Array<string>; "notes": Array<string>; };

export type BotImportPreviewRequest = { "source": BotImportSource; "pick"?: string; "worker"?: string; };

export type BotImportRequest = { "template": BotTemplate; "worker"?: string; };

export type BotImportResult = { "bot": BotView; "skills": Array<string>; "routines": number; "opener": boolean; "warnings": Array<string>; };

export type BotImportRoutine = { "name": string; "prompt": string; "schedule": AutomationSchedule; "scheduleText"?: string; "guessed": boolean; };

export type BotImportSource = ({ "kind": "file"; "name": string; "data": string; }) | ({ "kind": "files"; "files": Array<{ "path": string; "data": string; }>; }) | ({ "kind": "url"; "url": string; }) | ({ "kind": "text"; "text": string; });

export type BotOpenPoint = { "kind": "ask" | "confirm"; "where": string; "question": string; "excerpt"?: string; "operator"?: true; };

export type BotTemplate = { "format": BotTemplateFormat; "origin"?: string; "author"?: string; "name": string; "title"?: string; "description"?: string; "emoji"?: string; "avatar"?: { "shape"?: BotFaceShape; "ears"?: BotFaceEars; "color"?: string; }; "soul": string; "opener"?: string; "memories": Array<BotTemplateMemory>; "skills": Array<BotTemplateSkill>; "routines": Array<BotTemplateRoutine>; "integrations": Array<BotTemplateIntegration>; "model"?: string; "tools"?: Array<string>; "hui"?: { "handle"?: string; "thinking"?: string; "memoryModel"?: string; "memoryThinking"?: string; "voice"?: BotVoice; "tagging"?: "mention" | "nobody"; "disabledTools"?: Array<string>; "disabledSkills"?: Array<string>; }; "open"?: Array<BotOpenPoint>; "needs"?: Array<string>; "triggers"?: Array<BotTemplateTrigger>; "dropped": Array<string>; "notes": Array<string>; };

export type BotTemplateFormat = "grok" | "openclaw" | "claude-code" | "letta" | "character-card" | "crewai" | "hui" | "text";

export type BotTemplateIntegration = { "name": string; "description"?: string; };

export type BotTemplateMemory = { "name"?: string; "text": string; };

export type BotTemplateRoutine = { "name": string; "prompt": string; "schedule"?: string; "automation"?: AutomationSchedule; "description"?: string; };

export type BotTemplateSkill = { "name": string; "description": string; "content": string; "files"?: Array<BotTemplateSkillFile>; };

export type BotTemplateSkillFile = { "path": string; "text": string; };

export type BotTemplateTrigger = { "name": string; "filter": BotTriggerFilter; "prompt"?: string; "delivery"?: ("followUp") | ("steer"); "cooldownSeconds": number; };
