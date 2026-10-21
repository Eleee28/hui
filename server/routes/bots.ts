/**
 * `/__hui/bots` routes (HUI-18); see docs/api.md#bots. `:id` is a bot's id or
 * handle. The chat itself (transcript, live stream, prompt, steer, follow-up,
 * questions) is the session API on `bot.sessionId`; these routes do not
 * duplicate it.
 *
 *   GET    /__hui/bots[?archived=1]          list ({ bots })
 *   POST   /__hui/bots                       create (201 { bot })
 *   GET    /__hui/bots/:id                   { bot }
 *   PATCH  /__hui/bots/:id                   edit ({ bot })
 *   DELETE /__hui/bots/:id                   archive ({ bot }); nothing is deleted
 *   DELETE /__hui/bots/:id?permanent=1       delete a bot for good, active or archived ({ ok: true }; queued: true
 *                                            while its worker is offline: what it left there goes at its next connection)
 *   POST   /__hui/bots/:id/restore           { bot }
 *   POST   /__hui/bots/:id/messages          prompt or follow-up; 202 { status } or, with wait, 200 { status, reply?, … }
 *   POST   /__hui/bots/:id/stop              stop the current turn ({ bot })
 *   GET    /__hui/bots/:id/memory            { status, view }
 *   GET    /__hui/bots/:id/memory/zoom?id=&n= { text }
 *   GET    /__hui/bots/:id/memory/html       the OptChat browse page (text/html); also a same-origin link's page load
 *   GET    /__hui/bots/:id/catalog           BotCatalog: the tools and skills the operator can turn off, what is off,
 *                                            and a pending access request
 *   GET    /__hui/bots/:id/soul              { soul } (SOUL.md's text, null while the bot has none)
 *   PUT    /__hui/bots/:id/soul              { soul } replaces SOUL.md atomically; "" removes it (the first conversation again)
 *
 * `GET /__hui/bots/events` streams the list and is served by `hui.ts`.
 */
import { parseClearCommand, parseCompactCommand, parseReloadCommand, parseUpdateCommand } from "../sessions/slash-commands.ts";
import { BotMemoryUnavailableError } from "../bots/memory.ts";
import type { BotService } from "../bots/service.ts";
import { BotConflictError, BotInputError, BotNotFoundError, BotWorkerOfflineError } from "../bots/bots.ts";
import { reply, type RouteRequest, type RouteResult } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import {
  BotCatalog, BotDeleted, BotFactsResponse, BotMemoryResponse, BotMemoryZoom, BotMessageResult, BotResponse, BotSoul, BotsResponse,
  routeSchemas as botRouteSchemas,
} from "../api/bots.ts";
import { SessionBusyError } from "../sessions/live-sessions.ts";
import type { PromptAttachment } from "../runtimes/types.ts";

export const routeSchemas: RouteSchema[] = botRouteSchemas;

export const BOTS_ROUTE = "/__hui/bots";
export const BOTS_EVENTS_ROUTE = "/__hui/bots/events";
/** The memory page, which a link opens: `hui.ts` also accepts a same-origin page load there (docs/api.md#bots). */
export const BOT_MEMORY_PAGE = /^\/__hui\/bots\/[A-Za-z0-9_-]{1,100}\/memory\/html$/u;
const FACTS_ROUTE = /^\/__hui\/bots\/([A-Za-z0-9_-]{1,100})\/facts(?:\/([A-Za-z0-9_-]{1,100}))?$/u;
const ROUTE = /^\/__hui\/bots(?:\/([A-Za-z0-9_-]{1,100})(?:\/(restore|messages|stop|memory|memory\/zoom|memory\/html|soul|catalog))?)?$/u;
/** SOUL.md reaches 20,000 characters, up to four bytes each, and JSON may escape them. */
const BOT_BODY_BYTES = 256 * 1024;
/** Messages may carry attachments, like prompts. */
const MESSAGE_BODY_BYTES = 24 * 1024 * 1024;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 3_600;

type Deps = {
  service: BotService;
  /** The prompt route's attachment rules; rejects with `BotInputError`. */
  readAttachments(sessionId: string, raw: unknown): Promise<{ attachments: PromptAttachment[]; cleanupRejected(): Promise<void> }>;
};

/** 400 for input, 404/409 for a bot's state, 503 when the chat's memory cannot be
 * read or its worker is offline, 500 for storage. */
export function botErrorStatus(error: unknown): number {
  if (error instanceof BotInputError || error instanceof SyntaxError) return 400;
  if (error instanceof BotNotFoundError) return 404;
  if (error instanceof BotConflictError || error instanceof SessionBusyError) return 409;
  if (error instanceof BotMemoryUnavailableError || error instanceof BotWorkerOfflineError) return 503;
  // Durable and runtime refusals (an unknown model, say) are the caller's to fix; storage failures are not.
  return error instanceof Error && !/Store|Registry/u.test(error.name) ? 400 : 500;
}

export function createBotRoutes(deps: Deps) {
  const { service } = deps;

  async function json(request: RouteRequest, maxBytes: number): Promise<unknown> {
    try {
      return await request.json(maxBytes);
    } catch (error) {
      throw new BotInputError(error instanceof SyntaxError ? "The request body must be JSON." : "The request body is too large.");
    }
  }

  async function message(id: string, request: RouteRequest): Promise<RouteResult> {
    const body = await json(request, MESSAGE_BODY_BYTES);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BotInputError("A message must be an object.");
    const input = body as Record<string, unknown>;
    const unknown = Object.keys(input).filter((key) => !["text", "attachments", "wait", "timeoutSeconds"].includes(key));
    if (unknown.length) throw new BotInputError(`Unknown message field: ${unknown.join(", ")}.`);
    if (input["text"] !== undefined && typeof input["text"] !== "string") throw new BotInputError("text must be text.");
    const text = typeof input["text"] === "string" ? input["text"] : "";
    if (input["wait"] !== undefined && typeof input["wait"] !== "boolean") throw new BotInputError("wait must be a boolean.");
    const timeout = input["timeoutSeconds"];
    if (timeout !== undefined && (input["wait"] !== true || !Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > MAX_WAIT_SECONDS)) {
      throw new BotInputError(`timeoutSeconds needs wait and must be 1-${MAX_WAIT_SECONDS}.`);
    }
    // Commands HUI owns never reach the model, as on the prompt route; a forever chat has no /clear or /compact at all.
    for (const [parse, name] of [[parseUpdateCommand, "/update"], [parseClearCommand, "/clear"], [parseReloadCommand, "/reload"], [parseCompactCommand, "/compact"]] as const) {
      if (parse(text)) throw new BotInputError(`${name} is a HUI command, not a message.`);
    }
    const bot = await service.resolve(id);
    const prepared = await deps.readAttachments(bot.sessionId, input["attachments"]);
    try {
      // An image alone is a message; a file needs words saying what to do with it.
      if (!text.trim() && !prepared.attachments.some((item) => item.kind === "image")) throw new BotInputError("A message is required.");
      const wait = input["wait"] === true
        ? { timeoutMs: ((timeout as number | undefined) ?? DEFAULT_WAIT_SECONDS) * 1000, signal: request.signal }
        : undefined;
      const result = await service.send(bot.id, { text, attachments: prepared.attachments }, wait);
      return reply(BotMessageResult, result, wait ? 200 : 202);
    } catch (error) {
      // Files of a message that never reached the chat go; an accepted one keeps them.
      if (!(error instanceof DOMException && error.name === "AbortError")) await prepared.cleanupRejected();
      throw error;
    }
  }

  async function handle(request: RouteRequest): Promise<RouteResult | undefined> {
    const match = ROUTE.exec(request.path);
    const factMatch = FACTS_ROUTE.exec(request.path);
    if (factMatch) {
      const [, botId, factId] = factMatch;
      try {
        let facts;
        if (!factId && request.method === "GET") facts = await service.facts(botId!);
        else if (!factId && request.method === "POST") facts = await service.facts(botId!, "create", await json(request, BOT_BODY_BYTES));
        else if (factId && request.method === "PATCH") facts = await service.facts(botId!, "update", await json(request, BOT_BODY_BYTES), factId);
        else if (factId && request.method === "DELETE") facts = await service.facts(botId!, "delete", undefined, factId, Number(request.query.get("revision")));
        else return { status: 405, body: { error: "method not allowed" } };
        return reply(BotFactsResponse, { facts }, request.method === "POST" ? 201 : 200);
      } catch (error) {
        return { status: botErrorStatus(error), body: { error: error instanceof Error ? error.message : "The memory request failed." } };
      }
    }
    if (!match) return undefined;
    const [, id, action] = match;
    const { method } = request;
    const notAllowed = { status: 405, body: { error: "method not allowed" } };
    try {
      if (!id) {
        if (method === "GET") {
          const archived = request.query.get("archived");
          return reply(BotsResponse, { bots: await service.list({ archived: archived === "1" || archived === "true" }) });
        }
        if (method === "POST") return reply(BotResponse, { bot: await service.create(await json(request, BOT_BODY_BYTES)) }, 201);
        return notAllowed;
      }
      if (!action) {
        if (method === "GET") return reply(BotResponse, { bot: await service.get(id) });
        if (method === "PATCH") return reply(BotResponse, { bot: await service.update(id, await json(request, BOT_BODY_BYTES)) });
        if (method === "DELETE") {
          // Without permanent=1 a DELETE archives, the step that can be undone.
          const permanent = request.query.get("permanent");
          if (permanent === "1" || permanent === "true") {
            // A bot on an offline worker goes at once; what it left there goes at the worker's next connection.
            const { queued } = await service.delete(id);
            return reply(BotDeleted, { ok: true, ...(queued ? { queued: true } : {}) });
          }
          return reply(BotResponse, { bot: await service.archive(id) });
        }
        return notAllowed;
      }
      if (action === "catalog") {
        if (method !== "GET") return notAllowed;
        return reply(BotCatalog, await service.catalog(id));
      }
      if (action === "soul") {
        if (method === "GET") return reply(BotSoul, { soul: await service.soul(id) });
        if (method !== "PUT") return notAllowed;
        const body = await json(request, BOT_BODY_BYTES);
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BotInputError("A soul must be an object: { soul }.");
        const unknown = Object.keys(body).filter((key) => key !== "soul");
        if (unknown.length) throw new BotInputError(`Unknown soul field: ${unknown.join(", ")}.`);
        if (!("soul" in body)) throw new BotInputError("soul is required: SOUL.md's text, or \"\" to remove it.");
        return reply(BotSoul, { soul: await service.setSoul(id, (body as { soul: unknown }).soul) });
      }
      if (action === "restore" || action === "stop" || action === "messages") {
        if (method !== "POST") return notAllowed;
        if (action === "messages") return await message(id, request);
        return reply(BotResponse, { bot: action === "restore" ? await service.restore(id) : await service.stop(id) });
      }
      if (method !== "GET") return notAllowed;
      if (action === "memory") return reply(BotMemoryResponse, await service.memory(id));
      if (action === "memory/html") return { status: 200, html: await service.memoryHtml(id) };
      const zoomId = request.query.get("id") ?? "";
      const span = request.query.get("n") ?? "";
      if (!/^\d{1,15}$/u.test(zoomId) || !/^\d{1,15}$/u.test(span)) throw new BotInputError("Zoom needs id and n as whole numbers, as in id=12&n=4.");
      return reply(BotMemoryZoom, { text: await service.zoom(id, Number(zoomId), Number(span)) });
    } catch (error) {
      return { status: botErrorStatus(error), body: { error: error instanceof Error ? error.message : "The bot request failed." } };
    }
  }

  return { handle };
}
