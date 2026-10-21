/** Browser client for a bot's explicit memories (`/__hui/bots/:id/facts`): list, add, edit and delete, each answered
 * with the bot's whole list. */
import type { BotFact, BotFactInput, BotFactPatch } from "../api/schema/bots.ts";
import { fetchJson } from "./request.ts";

export type BotFactsApi = (botId: string, method?: string, id?: string, value?: BotFactInput | BotFactPatch | number) => Promise<BotFact[]>;
export const botFactsApi: BotFactsApi = async (botId, method = "GET", id = "", value) => {
  const url = `/__hui/bots/${encodeURIComponent(botId)}/facts${id ? `/${encodeURIComponent(id)}` : ""}${method === "DELETE" ? `?revision=${value}` : ""}`;
  const result = await fetchJson<{ facts: BotFact[] }>(url, { method, ...(value !== undefined && method !== "DELETE" ? { body: JSON.stringify(value), headers: { "content-type": "application/json" } } : {}) });
  if (!Array.isArray(result.facts)) throw new Error("The bot's memories did not come back.");
  return result.facts;
};
