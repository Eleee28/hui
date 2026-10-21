/**
 * Development stage of a session, shown as the Kanban column. HUI owns the
 * stage; PI never sees it. The board's first column, Backlog, holds backlog
 * items (Jira work items and local tasks, see `backlog.ts`), never sessions:
 * a session always sits in one of the work stages, Investigation first.
 *
 * The operator, the session's own agent (through the `set_stage` tool) and the
 * session's pull requests can each move it, with a fixed precedence: an operator placement wins until the operator clears it,
 * and pull-request evidence only ever advances an agent-reported stage.
 */
import type { SessionPullRequest } from "../api/github.ts";
import type { SessionStage, SessionStageOrigin, SessionStageSource } from "../api/sessions.ts";

/** Stages a session can be in: every column except Backlog. */
export const SESSION_STAGES = ["investigation", "implementation", "testing", "done"] as const;
/** Where a session without a stored stage (or a legacy stored `backlog`) sits. */
export const DEFAULT_SESSION_STAGE: SessionStage = "investigation";

export const SESSION_STAGE_LABELS: Readonly<Record<SessionStage, string>> = {
  investigation: "Investigation",
  implementation: "Implementation",
  testing: "Testing",
  done: "Done",
};

export function isSessionStage(value: unknown): value is SessionStage {
  return typeof value === "string" && (SESSION_STAGES as readonly string[]).includes(value);
}

export function isSessionStageSource(value: unknown): value is SessionStageSource {
  return value === "operator" || value === "agent" || value === "pullRequest";
}

export function stageRank(stage: SessionStage): number {
  return SESSION_STAGES.indexOf(stage);
}

/** Stage the pull requests prove on their own: any open or draft PR means the
 * change is under test/review; only merged PRs (closed-unmerged ones are
 * ignored) mean it shipped. Unconfirmed GitHub state proves nothing. */
export function pullRequestStage(pullRequests: readonly Pick<SessionPullRequest, "state">[]): SessionStage | undefined {
  if (pullRequests.some((pr) => pr.state === "open" || pr.state === "draft")) return "testing";
  if (pullRequests.some((pr) => pr.state === "merged")) return "done";
  return undefined;
}

export type EffectiveStage = { stage: SessionStage; stageOrigin: SessionStageOrigin };

/** `stagePullRequests` lists the pull requests (lower-case URLs) that already
 * existed when the stage was last placed explicitly. They are old news: a PR
 * merged in an earlier iteration must not drag a new task back to Done. */
export function effectiveSessionStage(
  stored: { stage?: SessionStage; stageSource?: SessionStageSource; stagePullRequests?: readonly string[] },
  pullRequests: readonly Pick<SessionPullRequest, "state" | "url">[] = [],
): EffectiveStage {
  const base: EffectiveStage = stored.stage
    ? { stage: stored.stage, stageOrigin: stored.stageSource ?? "agent" }
    : { stage: DEFAULT_SESSION_STAGE, stageOrigin: "default" };
  if (base.stageOrigin === "operator") return base;
  const known = new Set(stored.stagePullRequests ?? []);
  const inferred = pullRequestStage(pullRequests.filter((pr) => !known.has(pr.url.toLowerCase())));
  return inferred && stageRank(inferred) > stageRank(base.stage)
    ? { stage: inferred, stageOrigin: "pullRequest" }
    : base;
}
