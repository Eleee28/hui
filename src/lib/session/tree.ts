/** The selected session and all descendants, across groups and archive states. */
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
