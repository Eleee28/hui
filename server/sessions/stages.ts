/** The Kanban stage a session's own agent sets with `set_stage`, behind any operator placement. */
import type { SessionStage } from "../api/sessions.ts";
import { isSessionStage, SESSION_STAGE_LABELS, SESSION_STAGES } from "./session-stages.ts";
import { liveSessions } from "./live-sessions.ts";
import { pullRequestsFromTranscript } from "../integrations/pull-requests.ts";
import { SessionNotFoundError, updateRegistry } from "./sessions.ts";

export function knownPullRequestUrls(sessionId: string): string[] {
  return pullRequestsFromTranscript(liveSessions.transcript(sessionId)).map((ref) => ref.url.toLowerCase()).slice(-20);
}

/** `set_stage` from a session's own agent. An operator placement wins, so the
 * tool reports it instead of silently overriding the board. */
export async function setAgentStage(
  sessionId: string,
  params: Record<string, unknown>,
  registryUpdater: typeof updateRegistry = updateRegistry,
  knownPullRequests: (id: string) => string[] = knownPullRequestUrls,
): Promise<{ stage: SessionStage; applied: boolean; message: string }> {
  const stage = params["stage"];
  if (!isSessionStage(stage)) {
    throw new Error(`stage must be one of: ${SESSION_STAGES.join(", ")}. Backlog holds backlog items, not conversations.`);
  }
  let result: { stage: SessionStage; applied: boolean; message: string } | undefined;
  await registryUpdater((records) => {
    if (!records.some((record) => record.id === sessionId)) {
      throw new SessionNotFoundError("Conversation no longer exists.");
    }
    return records.map((record) => {
      if (record.id !== sessionId) return record;
      if (record.stageSource === "operator" && record.stage) {
        result = {
          stage: record.stage,
          applied: false,
          message: `The operator placed this session in ${SESSION_STAGE_LABELS[record.stage]}; their placement wins until they reset it.`,
        };
        return record;
      }
      result = { stage, applied: true, message: `Stage set to ${SESSION_STAGE_LABELS[stage]}.` };
      const stagePullRequests = knownPullRequests(sessionId);
      return { ...record, stage, stageSource: "agent", stagePullRequests: stagePullRequests.length ? stagePullRequests : undefined };
    });
  });
  if (!result) throw new SessionNotFoundError("Conversation no longer exists.");
  return result;
}
