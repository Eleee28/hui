/** Browser client for the gateway's GPT-Live call routes: the calls status, starting a call with a bot, and a running
 * call's delegations, tasks, transcript lines, heartbeat and hang-up. The call itself is lib/voice/live-call-platform.ts. */
import type { CallDelegationResult, CallLine, CallStarted, CallsStatus, CallTaskResult } from "./schema/calls.ts";
import { CLIENT_HEADERS, fetchJson, trackedFetch } from "./request.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;
const callsUrl = (botId: string, callId?: string, action?: string) =>
  `/__hui/bots/${encodeURIComponent(botId)}/calls${callId ? `/${encodeURIComponent(callId)}${action ? `/${action}` : ""}` : ""}`;

/** The ChatGPT login and the account calls use, for Settings and for offering Call. */
export function loadCallsStatus(): Promise<CallsStatus> {
  return fetchJson<CallsStatus>("/__hui/calls", { signal: AbortSignal.timeout(15_000) });
}

/** The gateway exchanges the offer with ChatGPT; the answer is all that comes back. */
export function startBotCall(botId: string, sdp: string, signal?: AbortSignal): Promise<CallStarted> {
  return fetchJson<CallStarted>(callsUrl(botId), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sdp }), signal: signal ?? AbortSignal.timeout(45_000) });
}

export function postCallDelegation(botId: string, callId: string, id: string, request: string, signal: AbortSignal): Promise<CallDelegationResult> {
  return fetchJson<CallDelegationResult>(callsUrl(botId, callId, "delegations"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ id, request }), signal });
}

export function postCallTask(botId: string, callId: string, task: string, signal: AbortSignal): Promise<CallTaskResult> {
  return fetchJson<CallTaskResult>(callsUrl(botId, callId, `tasks/${encodeURIComponent(task)}`), { method: "POST", signal });
}

export async function postCallLines(botId: string, callId: string, lines: readonly (CallLine & { at: number })[]): Promise<void> {
  await fetchJson(callsUrl(botId, callId, "lines"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ lines }), signal: AbortSignal.timeout(20_000) });
}

export async function postCallHeartbeat(botId: string, callId: string): Promise<void> {
  await fetchJson(callsUrl(botId, callId, "heartbeat"), { method: "POST", signal: AbortSignal.timeout(10_000) });
}

/** A page going away keeps the request alive past it. */
export async function deleteCall(botId: string, callId: string, leaving?: boolean): Promise<void> {
  await trackedFetch(callsUrl(botId, callId), { method: "DELETE", headers: CLIENT_HEADERS, cache: "no-store", ...(leaving ? { keepalive: true } : { signal: AbortSignal.timeout(10_000) }) });
}
