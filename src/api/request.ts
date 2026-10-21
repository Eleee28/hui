/**
 * The request helper for HUI's own gateway: the `x-hui` header, `fetchJson`, and `trackedFetch`, which reports a
 * request that cannot connect. The response deadline bounds how long the gateway may take to *start* answering,
 * not how long the answer takes to arrive: the gateway replies in milliseconds, but over mobile data a long
 * session's transcript can need many seconds to download, and cutting that short only threw the transfer away and
 * showed an empty conversation.
 */
import { reportReachable, reportRequestFailure } from "./ui-errors.ts";

/** The backend refuses requests without this, which no cross-origin page can
 * set without a preflight. */
export const CLIENT_HEADERS = { "x-hui": "1" } as const;

/** Long enough for a phone to wake its Tailscale connection, short enough to report a dead one. */
export const RESPONSE_TIMEOUT_MS = 20_000;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Messages worth showing for the two ways a request never got an answer. */
export function gatewayRequestError(error: unknown, timeoutMs?: number): unknown {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    const deadline = timeoutMs === undefined ? "in time" : `within ${Math.max(1, Math.round(timeoutMs / 1000))} s`;
    return new Error(`HUI did not answer ${deadline}. Check the connection and try again.`, { cause: error });
  }
  if (error instanceof TypeError) {
    return new Error("Could not reach HUI. Check the connection and try again.", { cause: error });
  }
  return error;
}

/**
 * `fetch` with that deadline. A caller's own signal replaces it: that caller
 * decided how long the whole request, body included, may take.
 */
export async function fetchWithResponseDeadline(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<Response> {
  if (init.signal) {
    try {
      return await fetcher(input, init);
    } catch (error) {
      throw gatewayRequestError(error);
    }
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("The gateway did not answer in time.", "TimeoutError")), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: deadline.signal });
  } catch (error) {
    throw gatewayRequestError(error, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

function huiRequest(input: RequestInfo | URL, init?: RequestInit): { method: string; path: string } | undefined {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input), typeof location === "undefined" ? "http://localhost/" : location.href);
  } catch {
    return undefined;
  }
  if (typeof location !== "undefined" && url.origin !== location.origin) return undefined;
  if (!url.pathname.startsWith("/__hui/")) return undefined;
  return { method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), path: url.pathname };
}

/** fetch rejects with a TypeError when it cannot connect and a TimeoutError
 * when its signal expires; an AbortError is a deliberate cancellation. */
function isConnectionFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError");
}

/** `fetch` for HUI's own API. A request that cannot reach the gateway is
 * reported once a later request succeeds; otherwise it is plain fetch. */
export async function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = huiRequest(input, init);
  try {
    const response = await fetch(input, init);
    if (target) reportReachable();
    return response;
  } catch (error) {
    if (target && isConnectionFailure(error)) reportRequestFailure(error, target);
    throw error;
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithResponseDeadline(trackedFetch, url, {
    ...init,
    headers: { ...CLIENT_HEADERS, ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    // The backend explains its refusals in the body, and that message is worth
    // more to the user than the status code. The import path relies on this.
    const detail = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(detail?.error ?? `${url} returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
