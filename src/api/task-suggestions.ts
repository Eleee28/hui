/** Browser client for task suggestions recorded in a session: dismissing one and starting it as a new session,
 * worktree or follow-up. The gateway creates the sessions. */
import type { TaskSuggestion, TaskSuggestionStartMode, TaskSuggestionsResponse, TaskSuggestionStartResponse } from "./schema/task-suggestions.ts";
import type { SessionView } from "./sessions.ts";
import { fetchJson } from "./request.ts";

function suggestionUrl(sessionId: string, suggestionId: string): string {
  return `/__hui/sessions/${encodeURIComponent(sessionId)}/suggestions/${encodeURIComponent(suggestionId)}`;
}

export async function dismissTaskSuggestion(sessionId: string, suggestionId: string): Promise<TaskSuggestion[]> {
  return (await fetchJson<TaskSuggestionsResponse>(suggestionUrl(sessionId, suggestionId), { method: "DELETE" })).suggestions;
}

/** The server creates the session (and worktree) and waits for its runtime
 * to accept the problem/fix prompt, so this can take as long as a cold PI
 * boot plus a checkout. `current` returns the recording session itself. */
export async function startTaskSuggestion(sessionId: string, suggestionId: string, mode: TaskSuggestionStartMode = "session"): Promise<SessionView> {
  return (await fetchJson<TaskSuggestionStartResponse>(`${suggestionUrl(sessionId, suggestionId)}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
    signal: AbortSignal.timeout(mode === "worktree" ? 10 * 60_000 : 60_000),
  })).session;
}
