/**
 * Resent sends, recognised. A prompt, steer or follow-up may carry the client's `requestId`; this remembers what the
 * gateway did with each one for a while, so a resend (the browser gave up waiting, the operator pressed send again)
 * gets the first send's outcome instead of running the work twice. A send that failed is forgotten, so its resend runs
 * again. Memory only: the ids last ten minutes and do not survive a gateway restart.
 */

/** A request id the client may send: short, and no characters that could mean anything elsewhere. */
export const REQUEST_ID = /^[\w.:-]{1,100}$/u;

type Seen = { done: Promise<unknown>; settledAt?: number };

export class RecentRequests {
  readonly #seen = new Map<string, Seen>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60_000;
    this.#max = options.max ?? 2_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs `send` unless `requestId` was seen for this session: then waits for that send instead and reports a
   * duplicate. Without an id, every call runs.
   */
  async run<T>(sessionId: string, requestId: string | undefined, send: () => Promise<T>): Promise<{ value: T; duplicate: boolean }> {
    if (requestId === undefined) return { value: await send(), duplicate: false };
    this.#expire();
    const key = `${sessionId}\0${requestId}`;
    const earlier = this.#seen.get(key);
    if (earlier) return { value: await earlier.done as T, duplicate: true };
    this.#makeRoom();
    const seen: Seen = { done: send() };
    this.#seen.set(key, seen);
    try {
      const value = await seen.done as T;
      seen.settledAt = this.#now();
      return { value, duplicate: false };
    } catch (error) {
      // Nothing was sent, so a resend must run.
      if (this.#seen.get(key) === seen) this.#seen.delete(key);
      throw error;
    }
  }

  /** Drops settled ids past their time. */
  #expire(): void {
    const expired = this.#now() - this.#ttlMs;
    for (const [key, seen] of this.#seen) if (seen.settledAt !== undefined && seen.settledAt < expired) this.#seen.delete(key);
  }

  /** Before a new id: drops the oldest settled ones beyond the cap. Sends still on their way are never dropped. */
  #makeRoom(): void {
    for (const [key, seen] of this.#seen) {
      if (this.#seen.size < this.#max) break;
      if (seen.settledAt !== undefined) this.#seen.delete(key);
    }
  }
}
