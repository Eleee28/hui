/** Applies the gateway's revisioned session-list update frames to the browser's copy of the grouped list. */
import type { SessionListLayoutGroup } from "./schema/sessions.ts";

type SessionListGroup<S> = Omit<SessionListLayoutGroup, "ids"> & { sessions: S[] };

export function applySessionListUpdate<S extends { id: string }>(
  groups: readonly SessionListGroup<S>[],
  update: { groups?: SessionListLayoutGroup[]; upserts: readonly S[] },
): SessionListGroup<S>[] {
  const byId = new Map(groups.flatMap((group) => group.sessions).map((session) => [session.id, session]));
  for (const session of update.upserts) byId.set(session.id, session);
  const layout = update.groups ?? groups.map(({ sessions, ...meta }) => ({ ...meta, ids: sessions.map(({ id }) => id) }));
  return layout.map(({ ids, ...meta }) => ({
    ...meta,
    sessions: ids.flatMap((id) => byId.get(id) ?? []),
  }));
}
