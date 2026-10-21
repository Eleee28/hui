/** Public task suggestion cards and dismiss, start and save-to-backlog payloads. */
import { Type, type Static } from "typebox";
import { SessionView } from "./sessions.ts";

export const TaskSuggestion = Type.Object({
  id: Type.String(), title: Type.String(), problem: Type.String(), fix: Type.String(), cwd: Type.String(),
  worker: Type.Optional(Type.String()), createdAt: Type.String(),
}, { $id: "TaskSuggestion" });
export type TaskSuggestion = Static<typeof TaskSuggestion>;

export const TaskSuggestionStartMode = Type.Union([
  Type.Literal("session"), Type.Literal("worktree"), Type.Literal("current"),
], { $id: "TaskSuggestionStartMode" });
export type TaskSuggestionStartMode = Static<typeof TaskSuggestionStartMode>;

export const TaskSuggestionStartRequest = Type.Object({ mode: Type.Optional(TaskSuggestionStartMode) }, { $id: "TaskSuggestionStartRequest" });
export type TaskSuggestionStartRequest = Static<typeof TaskSuggestionStartRequest>;

export const TaskSuggestionsResponse = Type.Object({ suggestions: Type.Array(TaskSuggestion) }, { $id: "TaskSuggestionsResponse" });
export type TaskSuggestionsResponse = Static<typeof TaskSuggestionsResponse>;

export const TaskSuggestionStartResponse = Type.Object({
  session: SessionView, suggestions: Type.Array(TaskSuggestion),
}, { $id: "TaskSuggestionStartResponse" });
export type TaskSuggestionStartResponse = Static<typeof TaskSuggestionStartResponse>;

export const TaskSuggestionBacklogResponse = Type.Object({
  taskId: Type.String(), suggestions: Type.Array(TaskSuggestion),
}, { $id: "TaskSuggestionBacklogResponse" });
export type TaskSuggestionBacklogResponse = Static<typeof TaskSuggestionBacklogResponse>;

export const TaskSuggestionError = Type.Object({ error: Type.String() }, { $id: "TaskSuggestionError" });
export type TaskSuggestionError = Static<typeof TaskSuggestionError>;

export const routeSchemas = [
  { method: "DELETE", path: "/__hui/sessions/:id/suggestions/:sid", response: TaskSuggestionsResponse },
  { method: "POST", path: "/__hui/sessions/:id/suggestions/:sid/start", request: TaskSuggestionStartRequest, response: TaskSuggestionStartResponse },
  { method: "POST", path: "/__hui/sessions/:id/suggestions/:sid/backlog", response: TaskSuggestionBacklogResponse },
];
