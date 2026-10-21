/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { SessionPullRequest } from "./github.ts";

export type JiraStatusCategory = ("new") | ("indeterminate") | ("done");

export type ProgressCard = { "markdown": string; "steps": Array<ProgressStep>; };

export type ProgressStep = { "step": string; "status": ("pending") | ("in_progress") | ("completed"); };

export type QuestionnaireAnswer = { "header": string; "question": string; "selected": Array<string>; "preview"?: string; };

export type QuestionnaireOption = { "label": string; "description": string; "preview"?: string; };

export type QuestionnaireQuestion = { "header": string; "question": string; "multiSelect": boolean; "options": Array<QuestionnaireOption>; };

export type QuestionnaireResult = { "cancelled": boolean; "answers": Array<QuestionnaireAnswer>; "timedOut"?: true; "timeoutMinutes"?: number; };

export type SessionConnectResponse = { "url": string; };

export type SessionError = { "error": string; };

export type SessionFastResponse = { "fast": boolean; };

export type SessionGroup = { "label": string; "cwd"?: string; "workspaceMode"?: ("branch") | ("worktree"); "baseRef"?: string; "sessions": Array<SessionView>; };

export type SessionJiraIssue = { "key": string; "url": string; "summary"?: string; "status"?: string; "statusCategory"?: JiraStatusCategory; "issueType"?: string; "description"?: string; };

export type SessionList = { "revision": number; "groups": Array<SessionGroup>; };

export type SessionListLayoutGroup = { "label": string; "cwd"?: string; "workspaceMode"?: ("branch") | ("worktree"); "baseRef"?: string; "ids": Array<string>; };

export type SessionListUpdate = { "revision": number; "groups"?: Array<SessionListLayoutGroup>; "upserts": Array<SessionView>; };

export type SessionOk = { "ok": true; };

export type SessionPromptResponse = { "ok": true; "duplicate"?: true; };

export type SessionQueueRequest = ({ "operation": "edit"; "itemId": string; "text": string; }) | ({ "operation": "remove"; "itemId": string; }) | ({ "operation": "move"; "itemId": string; "toIndex": number; }) | ({ "operation": "steer"; "itemId": string; });

export type SessionResponse = { "session": SessionView; };

export type SessionSearchResult = { "hits": Array<{ "id": string; "snippet": string; "matches": number; }>; "unsearched": Array<{ "worker": string; "error": string; }>; };

export type SessionStage = ("investigation") | ("implementation") | ("testing") | ("done");

export type SessionStageOrigin = (SessionStageSource) | ("default");

export type SessionStageSource = ("operator") | ("agent") | ("pullRequest");

export type SessionStatus = ("idle") | ("running") | ("waiting") | ("starting") | ("error") | ("reconnecting") | ("disconnected");

export type SessionStatusStreamFrame = ({ "event": "snapshot"; "data": { "statuses": Array<SessionStatusUpdate>; }; }) | ({ "event": "status"; "data": SessionStatusUpdate; }) | ({ "event": "sessions"; "data": SessionListUpdate; });

export type SessionStatusUpdate = { "id": string; "status": SessionStatus; "unread"?: boolean; "creating"?: WorktreeProgress; "creationError"?: string; "title"?: string; };

export type SessionSubagent = { "taskId": string; "task": string; "label"?: string; "status": SubagentStatus; "startedAt": string; "updatedAt": string; "endedAt"?: string; "summary"?: string; "error"?: string; "completionDelivery"?: ("pending") | ("delivered"); "collect"?: true; };

export type SessionView = { "progress"?: ProgressCard; "pullRequests"?: Array<SessionPullRequest>; "jiraIssues"?: Array<SessionJiraIssue>; "id": string; "title": string; "group": string; "cwd": string; "displayCwd": string; "worker"?: { "id": string; "name": string; }; "tool": string; "status": SessionStatus; "creating"?: WorktreeProgress; "creationError"?: string; "initialPrompt"?: string; "runtime"?: { "active": true; "memoryBytes"?: number; "bootDurationMs"?: number; }; "interrupted"?: true; "background"?: true; "model"?: string; "thinking"?: string; "pinned"?: true; "archived"?: true; "unread"?: true; "icon"?: string; "parentId"?: string; "subagent"?: SessionSubagent; "bot"?: { "id": string; "handle": string; "name": string; }; "stage": SessionStage; "stageOrigin": SessionStageOrigin; "createdAt": string; "updatedAt": string; };

export type SubagentStatus = ("starting") | ("running") | ("completed") | ("failed") | ("cancelled") | ("timed_out") | ("interrupted");

export type ThinkingLevel = ("off") | ("minimal") | ("low") | ("medium") | ("high") | ("xhigh") | ("max") | ("ultra");

export type TranscriptMetrics = { "timestamp"?: number; "completedAt"?: number; "durationMs"?: number; "inputTokens"?: number; "outputTokens"?: number; "cacheReadTokens"?: number; "cacheWriteTokens"?: number; "costUsd"?: number; };

export type WorktreeProgress = { "phase": ("naming") | ("preparing") | ("checkout") | ("filtering") | ("finalizing"); "percent"?: number; "completed"?: number; "total"?: number; };
