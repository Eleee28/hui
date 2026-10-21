/** Owns the one in-memory session list every screen shares. While anyone
 * listens it is recomputed on an interval and only changes are broadcast, as
 * revisioned update frames (`SessionListUpdate`) this module encodes.
 * ponytail: timer-driven; hook registry/runtime events if 1 s lag matters. */
type SessionListGroup<S> = { label: string; cwd?: string; workspaceMode?: "branch" | "worktree"; baseRef?: string; sessions: S[] };
type Layout = (Omit<SessionListGroup<never>, "sessions"> & { ids: string[] })[];
/** `groups` (order and membership) is present only when it changed; `upserts`
 * holds every session whose view changed. */
type SessionListUpdate<S> = { revision: number; groups?: Layout; upserts: S[] };
type Groups<S> = SessionListGroup<S>[];

function sessionListLayout<S extends { id: string }>(groups: readonly SessionListGroup<S>[]): Layout {
  return groups.map(({ sessions, ...meta }) => ({ ...meta, ids: sessions.map(({ id }) => id) }));
}

function diffSessionList<S extends { id: string }>(
  previous: readonly SessionListGroup<S>[],
  next: readonly SessionListGroup<S>[],
): Omit<SessionListUpdate<S>, "revision"> | undefined {
  const layout = sessionListLayout(next);
  const layoutChanged = JSON.stringify(layout) !== JSON.stringify(sessionListLayout(previous));
  const before = new Map(previous.flatMap((group) => group.sessions).map((session) => [session.id, JSON.stringify(session)]));
  const upserts = next.flatMap((group) => group.sessions).filter((session) => before.get(session.id) !== JSON.stringify(session));
  if (!layoutChanged && !upserts.length) return undefined;
  return { ...(layoutChanged ? { groups: layout } : {}), upserts };
}

export function createSessionListHub<S extends { id: string }>(load: () => Promise<Groups<S>>, intervalMs = 1_000) {
  // Clock-seeded so revisions keep rising across gateway restarts.
  let current = { revision: Date.now(), groups: [] as Groups<S> };
  let loaded = false;
  const listeners = new Set<(update: SessionListUpdate<S>) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  /** Serialized so revisions and diffs always advance in order. */
  function refresh(): Promise<{ revision: number; groups: Groups<S> }> {
    const run = queue.then(async () => {
      const next = await load();
      const update = diffSessionList(current.groups, next);
      if (update || !loaded) {
        loaded = true;
        current = { revision: current.revision + 1, groups: next };
        if (update) for (const listener of listeners) listener({ ...update, revision: current.revision });
      }
      return current;
    });
    queue = run.catch(() => {});
    return run;
  }

  function tick() {
    if (ticking) return;
    ticking = true;
    // A failed read keeps the last list; the next tick retries.
    void refresh().catch(() => {}).finally(() => { ticking = false; });
  }

  return {
    refresh,
    subscribe(listener: (update: SessionListUpdate<S>) => void): () => void {
      listeners.add(listener);
      if (loaded) listener({
        revision: current.revision,
        groups: sessionListLayout(current.groups),
        upserts: current.groups.flatMap((group) => group.sessions),
      });
      if (!timer) {
        tick();
        timer = setInterval(tick, intervalMs);
        timer.unref();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size || !timer) return;
        clearInterval(timer);
        timer = undefined;
      };
    },
  };
}
