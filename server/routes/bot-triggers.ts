/**
 * `/__hui/bots/:id/triggers` routes (HUI-18); see docs/api.md#triggers. `:id` is a bot's id or handle, `:trigger` a
 * trigger's id or name (URL-encoded).
 *
 *   GET    /__hui/bots/:id/triggers                  BotTriggersList: the bot's triggers, their latest runs, the cap
 *   POST   /__hui/bots/:id/triggers                  201 BotTriggerCreated (its URL's token, this once)
 *   PATCH  /__hui/bots/:id/triggers/:trigger         { trigger }
 *   DELETE /__hui/bots/:id/triggers/:trigger         { ok: true }
 *   POST   /__hui/bots/:id/triggers/:trigger/test    { run }: a sample event, delivered now
 *   POST   /__hui/bots/:id/triggers/:trigger/token   BotTriggerCreated: a new token for its URL, this once
 *
 * They live under `/__hui/bots`, so the `x-hui` guard applies as to every bot route.
 * The route its listener reports to, `POST /__hui/hooks/<token>`, is `bot-triggers-gateway.ts`'s.
 */
import { BOT_TRIGGER_LIMITS } from "../bots/triggers-format.ts";
import type { BotTriggerService } from "../bots/triggers.ts";
import { TriggerConflictError, TriggerInputError, TriggerNotFoundError } from "../bots/triggers-input.ts";
import { TriggerStoreError } from "../bots/triggers-store.ts";
import { BotConflictError, BotInputError, BotNotFoundError, BotStoreError } from "../bots/bots.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import { BotTriggerCreated, BotTriggerDeleted, BotTriggerResponse, BotTriggerRunResponse, BotTriggersList, routeSchemas as botTriggerRouteSchemas } from "../api/bot-triggers.ts";

export const routeSchemas: RouteSchema[] = botTriggerRouteSchemas;

export const BOT_TRIGGERS_ROUTE = /^\/__hui\/bots\/([A-Za-z0-9_-]{1,100})\/triggers(?:\/([^/]{1,400})(?:\/(test|token))?)?$/u;
const BODY_BYTES = 64 * 1024;

/** 400 for input, 404 for an unknown bot or trigger, 409 for a state that refuses it, 500 for storage. */
export function triggerErrorStatus(error: unknown): number {
  if (error instanceof TriggerInputError || error instanceof BotInputError || error instanceof SyntaxError) return 400;
  if (error instanceof TriggerNotFoundError || error instanceof BotNotFoundError) return 404;
  if (error instanceof TriggerConflictError || error instanceof BotConflictError) return 409;
  if (error instanceof TriggerStoreError || error instanceof BotStoreError) return 500;
  return 500;
}

export function createBotTriggerRoutes(deps: { service: Pick<BotTriggerService, "list" | "create" | "update" | "remove" | "test" | "rotate"> }) {
  const { service } = deps;

  async function json(request: RouteRequest): Promise<unknown> {
    try {
      return await request.json(BODY_BYTES);
    } catch (error) {
      throw new TriggerInputError(error instanceof SyntaxError ? "The request body must be JSON." : `The request body is larger than ${BODY_BYTES / 1024} KiB.`);
    }
  }

  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const match = BOT_TRIGGERS_ROUTE.exec(request.path);
    if (!match) return undefined;
    const [, bot, encoded, action] = match;
    const notAllowed = { status: 405, body: { error: "method not allowed" } };
    try {
      if (!encoded) {
        if (request.method === "GET") return reply(BotTriggersList, await service.list(bot!));
        if (request.method === "POST") return reply(BotTriggerCreated, await service.create(bot!, await json(request)), 201);
        return notAllowed;
      }
      let trigger: string;
      try {
        trigger = decodeURIComponent(encoded);
      } catch {
        throw new TriggerInputError("The trigger in the path is not valid URL encoding.");
      }
      if (!trigger.trim() || trigger.length > Math.max(100, BOT_TRIGGER_LIMITS.name)) throw new TriggerInputError("Name the trigger by its id or name.");
      if (action) {
        if (request.method !== "POST") return notAllowed;
        return action === "test"
          ? reply(BotTriggerRunResponse, { run: await service.test(bot!, trigger) })
          : reply(BotTriggerCreated, await service.rotate(bot!, trigger));
      }
      if (request.method === "PATCH") return reply(BotTriggerResponse, { trigger: await service.update(bot!, trigger, await json(request)) });
      if (request.method === "DELETE") {
        await service.remove(bot!, trigger);
        return reply(BotTriggerDeleted, { ok: true });
      }
      return notAllowed;
    } catch (error) {
      const status = triggerErrorStatus(error);
      return { status, body: { error: status === 500 && !(error instanceof TriggerStoreError || error instanceof BotStoreError) ? "The trigger request failed." : error instanceof Error ? error.message : "The trigger request failed." } };
    }
  }

  return { handle };
}
