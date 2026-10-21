/** The explicit-memory page's state, the actions its view calls and the kinds and limits it shows;
 * `controllers/bot-facts-controller.ts` keeps the state as the server confirms it. */
import type { BotFact, BotFactInput, BotFactKind } from "../../api/schema/bots.ts";

export const BOT_FACT_KINDS: readonly BotFactKind[] = ["fact", "preference", "decision"];
/** The gateway's limits (`server/bots/facts.ts` enforces them). */
export const BOT_FACT_LIMITS = { count: 40, text: 500, source: 200 } as const;
export type BotFactsState = { botId: string; facts: BotFact[]; loading: boolean; loaded: boolean; pending: boolean; error: string; editing?: BotFact; removing?: BotFact };
export type BotFactsActions = {
  load(botId: string, force?: boolean): Promise<void>;
  edit(fact?: BotFact): void;
  remove(fact?: BotFact): void;
  save(input: BotFactInput): Promise<boolean>;
  pin(fact: BotFact): Promise<boolean>;
  confirmDelete(): Promise<boolean>;
};
