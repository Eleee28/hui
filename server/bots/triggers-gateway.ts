/**
 * Triggers in the gateway (HUI-18): the service and the route its listeners report to, wired to the gateway's bots
 * and the GitHub CLI that reads the pull requests a delivery links to. `services.ts` makes one of these,
 * `backend.ts` starts and stops it, and `hui.ts` routes `/__hui/bots/:id/triggers…` and `POST /__hui/hooks/<token>` to it.
 */
import type { IncomingMessage } from "node:http";

import type { BotRecord } from "../bots-format.ts";
import { createBotTriggerRoutes } from "../routes/bot-triggers.ts";
import { BotTriggerService } from "./triggers.ts";
import { HOOK_ROUTE, isTailnetOrLoopback, readHookBody } from "./triggers-listener.ts";
import { ghRaw, pullRequestReader, type GhRaw } from "./triggers-prs.ts";
import { triggerStore } from "./triggers-store.ts";

export type GatewayTriggerDeps = {
  /** The bot message path (`BotService.send`). */
  send(botId: string, message: { text: string; whenBusy?: "followUp" | "steer" }): Promise<unknown>;
  listBots(): Promise<readonly BotRecord[]>;
  /** The GitHub CLI the gateway runs (`HUI_GITHUB_CLI` points tests at a fake). */
  ghCommand: string;
  report(event: { level: "info" | "warning" | "error"; action: string; summary: string; detail?: string }): void;
  /** Overrides for tests: the store file and gh. */
  triggersFile?: string;
  ghRaw?: GhRaw;
};

export function createGatewayTriggers(deps: GatewayTriggerDeps) {
  const report = (level: "info" | "warning" | "error", action: string, summary: string, detail?: string) =>
    deps.report({ level, action, summary, ...(detail ? { detail } : {}) });
  const store = triggerStore(deps.triggersFile, (count) => report("warning", "triggers_invalid_records",
    `bot-triggers.json holds ${count} trigger record${count === 1 ? "" : "s"} HUI can't run (one of a source HUI no longer has among them); HUI keeps them in the file. hui doctor reports them.`));
  const readPullRequests = pullRequestReader(deps.ghRaw ?? ghRaw(deps.ghCommand));
  const service = new BotTriggerService({
    store,
    bots: { list: deps.listBots, deliver: (botId, text, delivery) => deps.send(botId, { text, whenBusy: delivery }) },
    pullRequests: (urls, diffBudget) => readPullRequests(urls, diffBudget),
    report,
  });
  return {
    service,
    routes: createBotTriggerRoutes({ service }),
    start: () => service.start(),
    stop: () => service.stop(),
    /** `POST /__hui/hooks/<token>`: only from this machine or the tailnet (403 otherwise), POST only (405). */
    async hook(request: IncomingMessage, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
      if (!isTailnetOrLoopback(request.socket.remoteAddress)) return { status: 403, body: { error: "Trigger URLs answer only callers on this machine or its tailnet." } };
      if (request.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
      const token = HOOK_ROUTE.exec(path)?.[1];
      if (!token) return { status: 404, body: { error: "No trigger has this URL." } };
      return service.hook(token, () => readHookBody(request));
    },
  };
}

export type GatewayTriggers = ReturnType<typeof createGatewayTriggers>;
