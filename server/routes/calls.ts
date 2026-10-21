/**
 * GPT-Live call routes (HUI-18); see docs/api.md#calls. `:id` is a bot's id or
 * handle; `:callId` is HUI's id for the call (never the provider's). The
 * gateway sets each call up with the bot's identity and memory, keeps the
 * ChatGPT credential to itself, writes what is said into the bot's chat and
 * runs the tasks GPT-Live delegates as ordinary turns of the bot.
 *
 *   GET    /__hui/calls                                  CallsStatus: the ChatGPT login and the account calls use
 *   POST   /__hui/bots/:id/calls                         { sdp } → 201 CallStarted
 *   POST   /__hui/bots/:id/calls/:callId/lines           { lines: [{ role, text, at? }] } → { kept }: into the call's record
 *   POST   /__hui/bots/:id/calls/:callId/delegations     { id, request } → CallDelegationResult (the helper's answer or a hand-off)
 *   POST   /__hui/bots/:id/calls/:callId/tasks/:task     CallTaskResult, once the task handed to the bot's chat ends
 *   POST   /__hui/bots/:id/calls/:callId/heartbeat       { ok: true }; a call quiet for 90 s ends and is recorded
 *   DELETE /__hui/bots/:id/calls/:callId                 { ended }; the call's record goes to the bot's chat
 */
import { CALL_LIMITS, GPT_LIVE_MODEL, GPT_LIVE_VOICES, type CallRecordLine } from "../calls-format.ts";
import type { Settings } from "../hui-settings.ts";
import { BotMemoryUnavailableError } from "../bots/memory.ts";
import type { BotRecord } from "../bots-format.ts";
import type { BotService } from "../bots/service.ts";
import { BotConflictError, BotInputError, BotNotFoundError } from "../bots/bots.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import { CallDelegationResult, CallEnded, CallHeartbeat, CallLinesKept, CallsStatus, CallStarted, CallTaskResult, routeSchemas as callRouteSchemas } from "../api/calls.ts";
import {
  buildCallInstructions, buildCallSession, CallInputError, CallLimitError, CallNotFoundError, CallUnavailableError, CallUpstreamError,
  checkOffer, checkRequest, sessionVoice, taskResult, type ActiveCall, type CallBroker,
} from "../bots/calls.ts";

export const routeSchemas: RouteSchema[] = callRouteSchemas;

export const CALLS_ROUTE = "/__hui/calls";
const BOT_CALL_ROUTE = /^\/__hui\/bots\/([A-Za-z0-9_-]{1,100})\/calls(?:\/([A-Za-z0-9-]{1,64})(?:\/(lines|delegations|heartbeat|tasks\/[A-Za-z0-9-]{1,64}))?)?$/u;
/** The offer and its JSON. */
const OFFER_BODY_BYTES = CALL_LIMITS.sdp + 4 * 1024;
/** Forty lines of 4,000 characters, up to four bytes each, and their JSON. */
const LINES_BODY_BYTES = CALL_LIMITS.lines * CALL_LIMITS.line * 4 + 16 * 1024;
const DELEGATION_BODY_BYTES = CALL_LIMITS.request * 4 + 4 * 1024;
const DELEGATION_ID = /^[\w-]{1,200}$/u;

/**
 * The one seam where a question GPT-Live delegates is answered: for a bot, its call and the request GPT-Live wrote, it
 * resolves with what to tell GPT-Live. Today it is the bot's quick helper on its utility model, which hands real work
 * to the bot's chat (`call-helper.ts`); the target and its model change here without touching the call.
 */
export type CallDelegate = (input: { bot: BotRecord; call: ActiveCall; request: string }, signal?: AbortSignal) => Promise<CallDelegationResult>;

export type CallRouteDeps = {
  broker: CallBroker;
  bots: Pick<BotService, "callContext" | "resolve">;
  delegate: CallDelegate;
  settings(): Promise<Settings>;
  /** The gateway's time zone, for the date a call's instructions give. */
  timeZone?: () => string | undefined;
  now?: () => number;
};

/** 400 input, 404 no such bot or call, 409 a state that refuses it, 429 the call limit, 502 ChatGPT
 * refused or failed. */
export function callErrorStatus(error: unknown): number {
  if (error instanceof CallInputError || error instanceof BotInputError || error instanceof SyntaxError) return 400;
  if (error instanceof BotNotFoundError || error instanceof CallNotFoundError) return 404;
  if (error instanceof BotConflictError || error instanceof CallUnavailableError) return 409;
  if (error instanceof CallLimitError) return 429;
  if (error instanceof CallUpstreamError) return 502;
  if (error instanceof BotMemoryUnavailableError) return 503;
  return 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fields(body: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!isRecord(body)) throw new CallInputError(`${what} must be an object.`);
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new CallInputError(`Unknown ${what.toLowerCase()} field: ${unknown.join(", ")}.`);
  return body;
}

/** Lines in the order they were said; `at` (ms) falls back to now when it is missing or implausible. */
export function checkLines(raw: unknown, now: number): CallRecordLine[] {
  if (!Array.isArray(raw) || !raw.length) throw new CallInputError("lines must be a non-empty list.");
  if (raw.length > CALL_LIMITS.lines) throw new CallInputError(`At most ${CALL_LIMITS.lines} lines per request.`);
  return raw.map((item) => {
    const line = fields(item, ["role", "text", "at"], "A line");
    if (line["role"] !== "user" && line["role"] !== "assistant") throw new CallInputError("A line's role must be user or assistant.");
    const text = typeof line["text"] === "string" ? line["text"].trim() : "";
    if (!text) throw new CallInputError("A line needs its text.");
    if (text.length > CALL_LIMITS.line) throw new CallInputError(`A line must be at most ${CALL_LIMITS.line} characters.`);
    const at = line["at"];
    const plausible = typeof at === "number" && Number.isFinite(at) && at > now - 6 * 3_600_000 && at < now + 60_000;
    return { role: line["role"], text, at: plausible ? Math.round(at) : now };
  });
}

export function createCallRoutes(deps: CallRouteDeps) {
  const { broker, bots } = deps;
  const now = () => (deps.now ?? Date.now)();

  async function json(request: RouteRequest, maxBytes: number): Promise<unknown> {
    try {
      return await request.json(maxBytes);
    } catch (error) {
      throw new CallInputError(error instanceof SyntaxError ? "The request body must be JSON." : "The request body is too large.");
    }
  }

  async function status(): Promise<CallsStatus> {
    return { model: GPT_LIVE_MODEL, voices: GPT_LIVE_VOICES, chatgpt: await broker.status(), active: broker.active, limit: broker.limit };
  }

  async function start(id: string, request: RouteRequest): Promise<JsonResult> {
    const body = fields(await json(request, OFFER_BODY_BYTES), ["sdp"], "A call");
    const settings = await deps.settings();
    const sdp = checkOffer(body["sdp"]);
    const { bot, view, soul } = await bots.callContext(id);
    const timeZone = deps.timeZone?.();
    const { instructions, memoryBytes } = buildCallInstructions({ bot, operator: settings.profileName, ...(soul ? { soul } : {}), ...(view ? { view } : {}), ...(timeZone ? { timeZone } : {}) });
    const voice = sessionVoice(bot, settings.calls.voice);
    const started = await broker.start({ botId: bot.id, sdp, session: buildCallSession(instructions, voice), signal: request.signal });
    return reply(CallStarted, {
      callId: started.id, answer: started.answer, model: GPT_LIVE_MODEL, voice, account: { name: started.accountName },
      instructionsBytes: Buffer.byteLength(instructions, "utf8"), memoryBytes,
    }, 201);
  }

  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method } = request;
    const notAllowed = { status: 405, body: { error: "method not allowed" } };
    try {
      if (request.path === CALLS_ROUTE) return method === "GET" ? reply(CallsStatus, await status()) : notAllowed;
      const match = BOT_CALL_ROUTE.exec(request.path);
      if (!match) return undefined;
      const [, target, callId, action] = match;
      if (!callId) return method === "POST" ? await start(target!, request) : notAllowed;
      const bot = await bots.resolve(target!);
      if (!action) {
        if (method !== "DELETE") return notAllowed;
        return reply(CallEnded, { ended: broker.end(bot.id, callId) });
      }
      if (method !== "POST") return notAllowed;
      if (action === "heartbeat") {
        broker.touch(bot.id, callId);
        return reply(CallHeartbeat, { ok: true });
      }
      if (action === "lines") {
        const body = fields(await json(request, LINES_BODY_BYTES), ["lines"], "A transcript");
        const lines = checkLines(body["lines"], now());
        broker.addLines(bot.id, callId, lines);
        return reply(CallLinesKept, { kept: lines.length });
      }
      if (action.startsWith("tasks/")) {
        const call = broker.touch(bot.id, callId);
        const task = call.tasks.get(action.slice("tasks/".length));
        if (!task) throw new CallNotFoundError("No such task on this call.");
        const gone = new Promise<never>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new DOMException("The wait was cancelled.", "AbortError")), { once: true });
        });
        gone.catch(() => {});
        const result = await Promise.race([task, gone]).catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          return { status: "failed" as const, error: error instanceof Error ? error.message : "The task failed." };
        });
        return reply(CallTaskResult, taskResult(result, bot.name));
      }
      const body = fields(await json(request, DELEGATION_BODY_BYTES), ["id", "request"], "A delegation");
      if (typeof body["id"] !== "string" || !DELEGATION_ID.test(body["id"])) throw new CallInputError("A delegation needs its id.");
      const text = checkRequest(body["request"]);
      const call = broker.touch(bot.id, callId);
      return reply(CallDelegationResult, await deps.delegate({ bot, call, request: text }, request.signal));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return { status: 499, body: { error: "The client went away." } };
      const status = callErrorStatus(error);
      // Only messages written for the browser leave the gateway; anything else stays in diagnostics.
      const message = status === 500 ? "The call request failed. Check the gateway's diagnostics." : error instanceof Error ? error.message : "The call request failed.";
      return { status, body: { error: message, ...(error instanceof CallUpstreamError ? { upstreamStatus: error.status } : {}) } };
    }
  }

  return { handle };
}
