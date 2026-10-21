/** The session tree: which session a subagent's tree starts at, and the error bad session-tool input raises. */
import type { SessionRecord } from "./sessions.ts";

export class AgentToolInputError extends Error {
  override name = "AgentToolInputError";
}

/** The session a subagent's tree starts at: `sessionId`'s parent's parent…, itself without a parent. */
export function rootSessionId(records: readonly SessionRecord[], sessionId: string): string {
  const byId = new Map(records.map((record) => [record.id, record]));
  let current = byId.get(sessionId);
  if (!current) throw new AgentToolInputError(`Unknown session: ${sessionId}`);
  const seen = new Set<string>();
  while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentId)!;
  }
  return current.id;
}

export function sessionTreeIds(
  sessions: readonly { id: string; parentId?: string }[],
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentId) continue;
    const siblings = children.get(session.parentId) ?? [];
    siblings.push(session.id);
    children.set(session.parentId, siblings);
  }
  const ids = new Set([rootId]);
  for (const id of ids) {
    for (const child of children.get(id) ?? []) ids.add(child);
  }
  return ids;
}
