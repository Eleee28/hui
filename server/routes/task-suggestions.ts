/**
 * `/__hui/sessions/:id/suggestions/:sid…`: dismiss, start or save a session's pending task suggestion to the
 * backlog. `hui.ts` supplies the lifecycle and applies the `x-hui` guard before dispatching here.
 */
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import { TaskSuggestionBacklogResponse, TaskSuggestionError, TaskSuggestionStartResponse, TaskSuggestionsResponse } from "../api/task-suggestions.ts";
export { routeSchemas } from "../api/task-suggestions.ts";
import type { createBacklogLifecycle } from "../backlog.ts";
import { SessionBusyError } from "../sessions/live-sessions.ts";
import type { readRegistry } from "../sessions/sessions.ts";
import { TASK_SUGGESTION_START_MODES, TaskSuggestionInputError, TaskSuggestionNotFoundError, type TaskSuggestionStartMode, type TaskSuggestionStore } from "../agent-tools/task-suggestions.ts";
import { backlogErrorStatus } from "./backlog.ts";

const SESSION_SUGGESTION = /^\/__hui\/sessions\/([^/]+)\/suggestions\/([^/]+?)(?:\/(start|backlog))?$/;

type SuggestionLifecycle = Pick<ReturnType<typeof createBacklogLifecycle>, "startTaskSuggestion" | "saveSuggestionToBacklog">;
type TaskSuggestionRouteDeps = SuggestionLifecycle & {
  taskSuggestions: TaskSuggestionStore;
  readRegistry: typeof readRegistry;
  sessionMutationErrorStatus(error: unknown): 400 | 500;
};

export function createTaskSuggestionRoutes(deps: TaskSuggestionRouteDeps) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { path } = request;
    const { taskSuggestions, readRegistry, startTaskSuggestion, saveSuggestionToBacklog, sessionMutationErrorStatus } = deps;
    const suggestionRoute = path.match(SESSION_SUGGESTION);
    if (suggestionRoute) {
      const starting = suggestionRoute[3] === "start";
      const saving = suggestionRoute[3] === "backlog";
      if (request.method !== (starting || saving ? "POST" : "DELETE")) {
        return reply(TaskSuggestionError, { error: "method not allowed" }, 405);
      }
      const id = decodeURIComponent(suggestionRoute[1] ?? "");
      const suggestionId = decodeURIComponent(suggestionRoute[2] ?? "");
      const source = (await readRegistry()).find((session) => session.id === id);
      if (!source) {
        return reply(TaskSuggestionError, { error: `unknown session: ${id}` }, 404);
      }
      if (saving) {
        try {
          const task = await saveSuggestionToBacklog(id, suggestionId);
          return reply(TaskSuggestionBacklogResponse, { taskId: `local:${task.id}`, suggestions: taskSuggestions.list(id) });
        } catch (error) {
          return reply(TaskSuggestionError, {
            error: error instanceof Error ? error.message : "Could not add that suggestion to the backlog.",
          }, backlogErrorStatus(error));
        }
      }
      if (starting) {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const mode = body["mode"] ?? "session";
          if (typeof mode !== "string" || !TASK_SUGGESTION_START_MODES.includes(mode as TaskSuggestionStartMode)) {
            throw new TaskSuggestionInputError("mode must be session, worktree or current.");
          }
          const session = await startTaskSuggestion(source, suggestionId, mode as TaskSuggestionStartMode);
          return reply(TaskSuggestionStartResponse, { session, suggestions: taskSuggestions.list(id) });
        } catch (error) {
          return reply(TaskSuggestionError, {
            error: error instanceof Error ? error.message : "Could not start that suggestion.",
          }, error instanceof TaskSuggestionNotFoundError ? 404 : error instanceof SessionBusyError ? 409 : sessionMutationErrorStatus(error));
        }
      }
      try {
        taskSuggestions.remove(id, suggestionId);
        return reply(TaskSuggestionsResponse, { suggestions: taskSuggestions.list(id) });
      } catch (error) {
        return reply(TaskSuggestionError, {
          error: error instanceof Error ? error.message : "Could not dismiss that suggestion.",
        }, error instanceof TaskSuggestionNotFoundError ? 404 : 400);
      }
    }
    return undefined;
  }

  return { handle };
}
