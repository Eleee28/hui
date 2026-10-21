/**
 * A page-wide signal that a conversation's agent turn has settled. The chat (`hui-app.ts`) announces it from the
 * session stream's `settled` event; views that show what the agent may have changed, like the Files view, refresh
 * on it without holding a session stream of their own.
 */
export const TURN_END_EVENT = "hui-session-turn-end";

export type TurnEndDetail = { sessionId: string };

export function announceTurnEnd(sessionId: string, target: EventTarget | undefined = globalThis.window): void {
  target?.dispatchEvent(new CustomEvent<TurnEndDetail>(TURN_END_EVENT, { detail: { sessionId } }));
}

/** Calls `listener` whenever `sessionId`'s turn ends; returns the unsubscribe. */
export function onTurnEnd(sessionId: string, listener: () => void, target: EventTarget | undefined = globalThis.window): () => void {
  if (!target) return () => {};
  const handle = (event: Event) => {
    if ((event as CustomEvent<TurnEndDetail>).detail?.sessionId === sessionId) listener();
  };
  target.addEventListener(TURN_END_EVENT, handle);
  return () => target.removeEventListener(TURN_END_EVENT, handle);
}
