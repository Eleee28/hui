/**
 * Follow-up suggestions recorded by the `suggest_task` agent tool.
 *
 * Deliberately gateway-memory only, like OpenClaw's suggestion cards: the
 * registry format is unchanged and a restart drops pending cards. Recording a
 * suggestion never starts work; the operator starts, files or dismisses it.
 * Also holds the suggestion limits, start modes and the prompt text sent to sessions and Jira.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import type { TaskSuggestion, TaskSuggestionStartMode } from "../api/task-suggestions.ts";
export type { TaskSuggestionStartMode } from "../api/task-suggestions.ts";

export const TASK_SUGGESTION_START_MODES: readonly TaskSuggestionStartMode[] = ["session", "worktree", "current"];

export const TASK_SUGGESTION_LIMITS = {
  title: 120,
  problem: 12_000,
  fix: 8_000,
  cwd: 4_096,
  perSession: 20,
} as const;

export function taskSuggestionJiraDescription(suggestion: Pick<TaskSuggestion, "problem" | "fix">): string {
  return [
    "## Problem", suggestion.problem,
    ...(suggestion.fix ? ["## Proposed fix", suggestion.fix] : []),
  ].join("\n\n");
}

/** First turn of a session started from the card. Without a known fix the
 * session is asked to find the cause before changing code. */
export function taskSuggestionPrompt(suggestion: Pick<TaskSuggestion, "title" | "problem" | "fix">): string {
  return [
    `# ${suggestion.title}`,
    "## Problem", suggestion.problem,
    "## Proposed fix",
    suggestion.fix || "Not known yet. Investigate and confirm the root cause before changing code.",
  ].join("\n\n");
}

export class TaskSuggestionInputError extends Error {
  override name = "TaskSuggestionInputError";
}

export class TaskSuggestionNotFoundError extends Error {
  override name = "TaskSuggestionNotFoundError";
}

function field(params: Record<string, unknown>, key: string, maximum: number, optional = false): string {
  const raw = params[key];
  if (raw === undefined && optional) return "";
  if (typeof raw !== "string") throw new TaskSuggestionInputError(`${key} must be text.`);
  const value = raw.trim();
  if (!value && !optional) throw new TaskSuggestionInputError(`${key} must not be empty.`);
  if (value.length > maximum) throw new TaskSuggestionInputError(`${key} must be at most ${maximum} characters.`);
  return value;
}

export class TaskSuggestionStore {
  #bySession = new Map<string, TaskSuggestion[]>();
  #onChange: (sessionId: string) => void;
  #uuid: () => string;
  #now: () => Date;

  constructor(options: { onChange?: (sessionId: string) => void; uuid?: () => string; now?: () => Date } = {}) {
    this.#onChange = options.onChange ?? (() => {});
    this.#uuid = options.uuid ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  setChangeListener(listener: (sessionId: string) => void): void {
    this.#onChange = listener;
  }

  /** Newest first, so the latest flagged follow-up is the one shown. */
  list(sessionId: string): TaskSuggestion[] {
    return [...(this.#bySession.get(sessionId) ?? [])];
  }

  get(sessionId: string, id: string): TaskSuggestion {
    const found = this.#bySession.get(sessionId)?.find((suggestion) => suggestion.id === id);
    if (!found) throw new TaskSuggestionNotFoundError(`No pending suggestion ${id}; it may already have been started or dismissed.`);
    return found;
  }

  /** Validates agent input. `defaultCwd` is the calling session's directory;
   * on a remote `worker` it is a path there, checked when a session starts. */
  async suggest(sessionId: string, params: Record<string, unknown>, defaultCwd: string, worker?: string): Promise<TaskSuggestion> {
    const title = field(params, "title", TASK_SUGGESTION_LIMITS.title);
    const problem = field(params, "problem", TASK_SUGGESTION_LIMITS.problem);
    const fix = field(params, "fix", TASK_SUGGESTION_LIMITS.fix, true);
    const requestedCwd = field(params, "cwd", TASK_SUGGESTION_LIMITS.cwd, true);
    if (requestedCwd && !isAbsolute(requestedCwd)) throw new TaskSuggestionInputError("cwd must be an absolute path.");
    const cwd = normalize(requestedCwd || defaultCwd);
    const info = worker ? undefined : await stat(cwd).catch(() => undefined);
    if (!worker && !info?.isDirectory()) throw new TaskSuggestionInputError(`cwd is not a directory: ${cwd}`);
    const current = this.#bySession.get(sessionId) ?? [];
    if (current.length >= TASK_SUGGESTION_LIMITS.perSession) {
      throw new TaskSuggestionInputError(`This session already has ${TASK_SUGGESTION_LIMITS.perSession} pending suggestions. Dismiss stale ones first.`);
    }
    const suggestion: TaskSuggestion = { id: this.#uuid(), title, problem, fix, cwd, ...(worker ? { worker } : {}), createdAt: this.#now().toISOString() };
    this.#bySession.set(sessionId, [suggestion, ...current]);
    this.#onChange(sessionId);
    return suggestion;
  }

  #claims = new Set<string>();

  /** Reserves a card while its session starts, so a double click cannot start
   * the same follow-up twice. Pair with `release` on failure or `remove`. */
  claim(sessionId: string, id: string): TaskSuggestion {
    const found = this.get(sessionId, id);
    if (this.#claims.has(id)) throw new TaskSuggestionInputError("That suggestion is already starting.");
    this.#claims.add(id);
    return found;
  }

  release(id: string): void {
    this.#claims.delete(id);
  }

  /** Removes one pending card. Used for agent/operator dismissal and once a
   * start or Jira filing has succeeded. */
  remove(sessionId: string, id: string): TaskSuggestion {
    const current = this.#bySession.get(sessionId) ?? [];
    const found = current.find((suggestion) => suggestion.id === id);
    if (!found) throw new TaskSuggestionNotFoundError(`No pending suggestion ${id}; it may already have been started or dismissed.`);
    this.#claims.delete(id);
    const next = current.filter((suggestion) => suggestion.id !== id);
    if (next.length) this.#bySession.set(sessionId, next);
    else this.#bySession.delete(sessionId);
    this.#onChange(sessionId);
    return found;
  }

  /** Deleted sessions take their cards with them. */
  forget(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) this.#bySession.delete(id);
  }

  /** The bridge-facing tool contract: `suggest_task` and `dismiss_task`. */
  async tool(sessionId: string, action: string, params: Record<string, unknown>, defaultCwd: string, worker?: string): Promise<unknown> {
    if (action === "suggest_task") {
      const suggestion = await this.suggest(sessionId, params, defaultCwd, worker);
      return { taskId: suggestion.id, title: suggestion.title, cwd: suggestion.cwd, status: "pending" };
    }
    if (action === "dismiss_task") {
      const id = field(params, "task_id", 100);
      // Existence in the caller's session first, so another session's claim never leaks.
      this.get(sessionId, id);
      if (this.#claims.has(id)) throw new TaskSuggestionInputError("The operator is already starting that suggestion.");
      this.remove(sessionId, id);
      return { taskId: id, status: "dismissed" };
    }
    throw new TaskSuggestionInputError(`Unknown task suggestion action: ${action}`);
  }
}
