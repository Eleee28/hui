/**
 * The single route from HUI tool code to the gateway's agent-tool handler. A tool running inside the gateway
 * uses the caller-bound invoker directly; a PI child process uses the authenticated loopback bridge. Either way
 * the caller's identity comes from the runtime, never from tool parameters.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { request } from "node:http";
import { text } from "node:stream/consumers";

/**
 * In-process runtimes run these tools inside the gateway and supply the
 * caller-bound invoker for the duration of one call; PI children use the
 * loopback bridge below.
 */
export const directHuiBridge = new AsyncLocalStorage();

/**
 * PI-side client of HUI's private agent bridge (server/agent-tools/bridge.ts).
 * The URL, bearer token and caller identity come from the environment HUI
 * gives each PI child; tool parameters can never choose another caller.
 * Plain node:http, not fetch: fetch gives up on a reply after five minutes,
 * and `secret_request` waits for the operator longer than that.
 */
export async function invokeHuiBridge(action, params, { timeoutMs = 160_000, signal } = {}) {
  const direct = directHuiBridge.getStore();
  if (direct) return direct(action, params, signal);
  const bridgeUrl = process.env.HUI_AGENT_BRIDGE_URL;
  const bridgeToken = process.env.HUI_AGENT_BRIDGE_TOKEN;
  const callerSessionId = process.env.HUI_AGENT_SESSION_ID;
  if (!bridgeUrl || !bridgeToken || !callerSessionId) {
    throw new Error("HUI agent tools are unavailable in this runtime.");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await new Promise((resolve, reject) => {
    const call = request(`${bridgeUrl}/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        "content-type": "application/json",
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }, resolve);
    call.on("error", reject);
    call.end(JSON.stringify({ callerSessionId, action, params }));
  });
  const body = JSON.parse(await text(response));
  if (response.statusCode !== 200 || body?.ok !== true) {
    throw new Error(body?.error || `HUI agent tool failed with HTTP ${response.statusCode}.`);
  }
  return body.result;
}
