/** Browser client for a bot's triggers (`/__hui/bots/:id/triggers`): list, add, switch, test, delete and new URL,
 * each answer narrowed on the way in. */
import type { BotTriggerInput, BotTriggerPatch } from "../api/schema/bot-triggers.ts";
import { isRecord } from "../lib/bots/bots.ts";
import { parseCreated, parseRun, parseTrigger, parseTriggersList } from "../lib/bots/triggers.ts";
import { fetchJson } from "./request.ts";

const JSON_HEADERS = { "content-type": "application/json" } as const;

const triggersUrl = (botId: string, trigger?: string, action?: string) =>
  `/__hui/bots/${encodeURIComponent(botId)}/triggers${trigger ? `/${encodeURIComponent(trigger)}` : ""}${action ? `/${action}` : ""}`;

export const botTriggersApi = {
  list: async (botId: string) => parseTriggersList(await fetchJson<unknown>(triggersUrl(botId))),
  create: async (botId: string, input: BotTriggerInput) => parseCreated(await fetchJson<unknown>(triggersUrl(botId), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) })),
  update: async (botId: string, triggerId: string, patch: BotTriggerPatch) => {
    const body = await fetchJson<unknown>(triggersUrl(botId, triggerId), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(patch), signal: AbortSignal.timeout(30_000) });
    const trigger = isRecord(body) ? parseTrigger(body["trigger"]) : undefined;
    if (!trigger) throw new Error("The trigger did not come back.");
    return trigger;
  },
  remove: async (botId: string, triggerId: string) => {
    await fetchJson<unknown>(triggersUrl(botId, triggerId), { method: "DELETE", signal: AbortSignal.timeout(30_000) });
  },
  test: async (botId: string, triggerId: string) => {
    const body = await fetchJson<unknown>(triggersUrl(botId, triggerId, "test"), { method: "POST", headers: JSON_HEADERS, body: "{}", signal: AbortSignal.timeout(90_000) });
    const run = isRecord(body) ? parseRun(body["run"]) : undefined;
    if (!run) throw new Error("The test's run did not come back.");
    return run;
  },
  rotate: async (botId: string, triggerId: string) => parseCreated(await fetchJson<unknown>(triggersUrl(botId, triggerId, "token"), { method: "POST", headers: JSON_HEADERS, body: "{}", signal: AbortSignal.timeout(30_000) })),
};
