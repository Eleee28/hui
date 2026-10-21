import assert from "node:assert/strict";
import { test } from "vitest";
import { fetchWithResponseDeadline, gatewayRequestError } from "./request.ts";

/** Answers after `headersMs`; its body then streams for `bodyMs` more. */
function slowGateway(headersMs: number, bodyMs: number) {
  const seen: (AbortSignal | undefined)[] = [];
  const fetcher = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    seen.push(signal);
    const fail = () => reject(signal!.reason);
    signal?.addEventListener("abort", fail, { once: true });
    setTimeout(() => {
      signal?.removeEventListener("abort", fail);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const abort = () => controller.error(signal!.reason);
          signal?.addEventListener("abort", abort, { once: true });
          setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            if (signal?.aborted) return;
            controller.enqueue(new TextEncoder().encode('{"ok":true}'));
            controller.close();
          }, bodyMs);
        },
      });
      resolve(new Response(body, { headers: { "content-type": "application/json" } }));
    }, headersMs);
  });
  return { fetcher, seen };
}

test("a slow body is read to the end once the gateway has answered", async () => {
  const { fetcher, seen } = slowGateway(5, 120);
  const response = await fetchWithResponseDeadline(fetcher, "/__hui/sessions/a/open", {}, 40);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(seen[0]?.aborted, false);
});

test("a gateway that does not start answering in time fails with a message worth showing", async () => {
  const { fetcher } = slowGateway(200, 0);
  await assert.rejects(fetchWithResponseDeadline(fetcher, "/__hui/sessions", {}, 30), (error: Error) => {
    assert.equal(error.message, "HUI did not answer within 1 s. Check the connection and try again.");
    assert.equal((error.cause as DOMException).name, "TimeoutError");
    return true;
  });
});

test("a caller's own signal bounds the whole request instead", async () => {
  const { fetcher, seen } = slowGateway(1, 0);
  const own = new AbortController();
  await fetchWithResponseDeadline(fetcher, "/__hui/update/check", { signal: own.signal }, 30);
  assert.equal(seen[0], own.signal);
});

test("a caller's own deadline is not reported as the default one", async () => {
  const { fetcher } = slowGateway(200, 0);
  await assert.rejects(fetchWithResponseDeadline(fetcher, "/__hui/pi/skills/install", { signal: AbortSignal.timeout(10) }), (error: Error) => {
    assert.equal(error.message, "HUI did not answer in time. Check the connection and try again.");
    return true;
  });
});

test("connection failures read as such; deliberate cancellation passes through", () => {
  assert.equal((gatewayRequestError(new TypeError("Failed to fetch")) as Error).message, "Could not reach HUI. Check the connection and try again.");
  assert.equal((gatewayRequestError(new DOMException("x", "TimeoutError"), 20_000) as Error).message, "HUI did not answer within 20 s. Check the connection and try again.");
  const cancelled = new DOMException("cancelled", "AbortError");
  assert.equal(gatewayRequestError(cancelled), cancelled);
});
