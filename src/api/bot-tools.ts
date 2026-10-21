/** Browser client for a bot's Tools & skills catalog (`GET /__hui/bots/:id/catalog`), narrowed on the way in. */
import type { BotCatalog } from "./schema/bots.ts";
import { parseBotCatalog } from "../lib/bots/tools.ts";
import { fetchJson } from "./request.ts";

/** Reading the catalog may start the bot's chat first. */
const CATALOG_TIMEOUT_MS = 30_000;

export async function loadBotCatalog(id: string): Promise<BotCatalog> {
  return parseBotCatalog(await fetchJson<unknown>(`/__hui/bots/${encodeURIComponent(id)}/catalog`, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) }));
}
