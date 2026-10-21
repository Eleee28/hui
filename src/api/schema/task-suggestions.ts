/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */
import type { SessionView } from "./sessions.ts";

export type TaskSuggestion = { "id": string; "title": string; "problem": string; "fix": string; "cwd": string; "worker"?: string; "createdAt": string; };

export type TaskSuggestionBacklogResponse = { "taskId": string; "suggestions": Array<TaskSuggestion>; };

export type TaskSuggestionError = { "error": string; };

export type TaskSuggestionStartMode = ("session") | ("worktree") | ("current");

export type TaskSuggestionStartRequest = { "mode"?: TaskSuggestionStartMode; };

export type TaskSuggestionStartResponse = { "session": SessionView; "suggestions": Array<TaskSuggestion>; };

export type TaskSuggestionsResponse = { "suggestions": Array<TaskSuggestion>; };
