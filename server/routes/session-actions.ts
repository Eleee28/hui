/**
 * One session's actions: `/__hui/sessions/:id/(open|prompt|steer|follow-up|queue|continue|clear|compact|reload|btw|
 * tools|models|commands|model|abort|rewind|fork|resume|thinking|fast|question|connect)`, with the guards they share
 * (an unknown or still-creating session, a bot's forever chat) and the request ids
 * that keep a resent prompt from running twice. `hui.ts` applies the `x-hui` guard before dispatching here and
 * writes the `…/events` stream for the record this module answers with `{ stream }`.
 */
import { homedir } from "node:os";
import type { BotService } from "../bots/service.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import { SessionTools, ToolsError, routeSchemas as toolsRouteSchemas } from "../api/tools.ts";
import { SessionConnectResponse, SessionError, SessionFastResponse, SessionOk, SessionPromptResponse, SessionResponse, sessionActionRouteSchemas } from "../api/sessions.ts";
import { SessionClearResponse, SessionCommandsResponse, SessionModelResponse, SessionModelsResponse, SessionOpenResponse, SessionThinkingResponse, SideQuestionResult, routeSchemas as sessionEventRouteSchemas } from "../api/session-events.ts";

import { readHuiSettings } from "../hui-settings.ts";
import { liveSessions, SessionBusyError } from "../sessions/live-sessions.ts";
import { answerSideQuestion } from "../pi/model-routing.ts";
import { recordDiagnosticEvent } from "../observability.ts";
import type { Questionnaires } from "../agent-tools/questionnaires.ts";
import { REQUEST_ID, RecentRequests } from "../sessions/recent-requests.ts";
import type { SecretRequests } from "../agent-tools/secret-requests.ts";
import { sessionStreamTicket } from "../sessions/transport.ts";
import { readRegistry, SessionNotFoundError, SessionRegistryError, type SessionRecord } from "../sessions/sessions.ts";
import { AttachmentInputError, readAttachments, type PreparedAttachments } from "../sessions/attachments.ts";
import type { createSessionLifecycle } from "../sessions/lifecycle.ts";
import { type createSessionViews, pendingSessions } from "../sessions/views.ts";
import type { SubagentService } from "../agent-tools/subagents.ts";
import { foreverChatRefusal, MAX_PROMPT_BYTES, sessionMutationErrorStatus } from "./sessions.ts";
import { isThinkingLevel } from "../sessions/thinking.ts";
import { parseClearCommand, parseCompactCommand, parseReloadCommand, parseUpdateCommand } from "../sessions/slash-commands.ts";

export const routeSchemas: RouteSchema[] = [
  ...sessionActionRouteSchemas,
  ...sessionEventRouteSchemas,
  ...toolsRouteSchemas.filter((route) => route.path === "/__hui/sessions/:id/tools"),
];

/** Session actions and live catalogs, all addressed by HUI's own session id. */
const SESSION_ACTION =
  /^\/__hui\/sessions\/([^/]+)\/(open|prompt|continue|resume|steer|follow-up|btw|queue|events|connect|models|commands|tools|model|thinking|fast|question|abort|clear|reload|compact|rewind|fork)$/;

export function createSessionActionRoutes(deps: {
  lifecycle: Pick<ReturnType<typeof createSessionLifecycle>, "updateSession" | "forkRequest" | "forkFromSession">;
  views: Pick<ReturnType<typeof createSessionViews>, "toView">;
  bots: Pick<BotService, "botForSession">;
  subagents: Pick<SubagentService, "cancelCollected">;
  secretRequests: Pick<SecretRequests, "answer">;
  questionnaires: Pick<Questionnaires, "answer">;
}) {
  /** Prompts, steers and follow-ups by their client request id, so a resend never runs twice. */
  const recentRequests = new RecentRequests();

  async function handle(request: RouteRequest): Promise<JsonResult | { stream: SessionRecord } | undefined> {
    const { method, path } = request;
    const { bots, subagents, secretRequests, questionnaires } = deps;
    const { updateSession, forkRequest, forkFromSession } = deps.lifecycle;
    const { toView } = deps.views;

    const action = path.match(SESSION_ACTION);
    if (action) {
      const id = decodeURIComponent(action[1] ?? "");
      const record = (await readRegistry()).find((session) => session.id === id);
      if (!record) {
        const pending = pendingSessions.get(id);
        return reply(SessionError, {
          error: pending ? pending.error ?? "The Git worktree is still being created." : `unknown session: ${id}`,
        }, pending ? 409 : 404);
      }
      // A bot's chat never ends: what would reset, shorten or fork it is refused here; the model stays switchable.
      if (record.bot && method === "POST" && (action[2] === "clear" || action[2] === "compact" || action[2] === "rewind" || action[2] === "fork")) {
        // The bot registry decides; one that cannot be read refuses rather than risk the chat.
        const owner = await bots.botForSession(record.id).then((bot) => bot ? { handle: bot.handle } : undefined, () => ({ handle: undefined }));
        if (owner) {
          return reply(SessionError, { error: foreverChatRefusal(owner.handle, action[2]) }, 409);
        }
      }
      if (action[2] === "open" && method === "POST") {
        if (!liveSessions.ensure(record)) {
          return reply(SessionError, { error: `unknown session: ${id}` }, 404);
        }
        const openedRecord = await liveSessions.markRead(id);
        return reply(SessionOpenResponse, {
          session: toView(openedRecord, liveSessions.status(id)),
          transcript: liveSessions.transcript(id),
          snapshot: liveSessions.snapshot(id),
        });
      }
      if (
        (action[2] === "prompt" || action[2] === "steer" || action[2] === "follow-up") &&
        method === "POST"
      ) {
        let body: Record<string, unknown>;
        try {
          body = (await request.json(MAX_PROMPT_BYTES)) as Record<string, unknown>;
        } catch (error) {
          return reply(SessionError, { error: error instanceof Error ? error.message : "Invalid prompt body." }, 400);
        }
        const text = typeof body["text"] === "string" ? body["text"] : "";
        const requestId = body["requestId"];
        if (requestId !== undefined && (typeof requestId !== "string" || !REQUEST_ID.test(requestId))) {
          return reply(SessionError, { error: "A request id is 1 to 100 letters, digits or . : _ -" }, 400);
        }
        if (parseUpdateCommand(text)) {
          return reply(SessionError, { error: "/update is a HUI command. Use the update dialog, not the model prompt or queue." }, 400);
        }
        if (parseClearCommand(text)) {
          return reply(SessionError, { error: "/clear is a HUI command. Use the clear endpoint, not the model prompt or queue." }, 400);
        }
        if (parseReloadCommand(text)) {
          return reply(SessionError, { error: "/reload is a HUI command. Use the reload endpoint, not the model prompt or queue." }, 400);
        }
        if (parseCompactCommand(text)) {
          return reply(SessionError, { error: "/compact is a HUI command. Use the compact endpoint, not the model prompt or queue." }, 400);
        }
        const send = async () => {
          let prepared: PreparedAttachments | undefined;
          try {
            prepared = await readAttachments(id, body["attachments"]);
            const attachments = prepared.attachments;
            // An image on its own is a valid prompt; a file on its own is not,
            // because the agent needs to be told what to do with it.
            if (!text.trim() && !attachments.some((item) => item.kind === "image")) {
              throw new AttachmentInputError("A prompt is required.");
            }
            if (!liveSessions.ensure(record)) throw new SessionNotFoundError(`unknown session: ${id}`);
            if (action[2] === "prompt") await liveSessions.prompt(id, text, attachments);
            else if (action[2] === "steer") await liveSessions.steer(id, text, attachments);
            else await liveSessions.followUp(id, text, attachments);
          } catch (error) {
            await prepared?.cleanupRejected();
            throw error;
          }
          // Writing to an archived conversation restores it, subagents included. A bot's chat is restored with its bot.
          if (record.archived && !record.bot) {
            // The message is in: a failed restore must not report it refused, or its resend would run it twice.
            await updateSession(id, { archived: false }).catch((error: unknown) => recordDiagnosticEvent({
              area: "session",
              level: "error",
              action: "restore_on_send_failed",
              sessionId: id,
              summary: error instanceof Error ? error.message : "Could not restore an archived conversation.",
            }));
          }
        };
        try {
          // A resend of a send the gateway already took (the browser stopped waiting) answers with its outcome,
          // whichever of the three routes it comes back through, and the composer drops its copy.
          const { duplicate } = await recentRequests.run(id, typeof requestId === "string" ? requestId : undefined, send);
          return reply(SessionPromptResponse, { ok: true, ...(duplicate ? { duplicate: true as const } : {}) });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "pi refused the message.",
          }, error instanceof SessionNotFoundError ? 404 : error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "continue" && method === "POST") {
        try {
          if (!liveSessions.ensure(record)) {
            return reply(SessionError, { error: `unknown session: ${id}` }, 404);
          }
          await liveSessions.continueInterrupted(id);
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not continue that run.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "clear" && method === "POST") {
        try {
          if (!liveSessions.ensure(record)) {
            return reply(SessionError, { error: `unknown session: ${id}` }, 404);
          }
          const snapshot = await liveSessions.clear(id);
          return reply(SessionClearResponse, { snapshot });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not clear that session.",
          }, error instanceof SessionBusyError ? 409 : error instanceof SessionRegistryError ? 500 : 400);
        }
      }
      if (action[2] === "compact" && method === "POST") {
        try {
          if (!liveSessions.ensure(record)) {
            return reply(SessionError, { error: `unknown session: ${id}` }, 404);
          }
          const body = (await request.json()) as Record<string, unknown> | null;
          const raw = body?.["instructions"];
          if (raw !== undefined && typeof raw !== "string") throw new Error("Compaction focus must be text.");
          const instructions = raw?.trim();
          if (instructions && instructions.length > 2_000) throw new Error("Keep the compaction focus under 2,000 characters.");
          await liveSessions.compact(id, instructions || undefined);
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not compact that session.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "compact" && method === "DELETE") {
        try {
          if (!liveSessions.ensure(record)) {
            return reply(SessionError, { error: `unknown session: ${id}` }, 404);
          }
          await liveSessions.cancelCompaction(id);
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not cancel that compaction.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "reload" && method === "POST") {
        try {
          if (!liveSessions.ensure(record)) {
            return reply(SessionError, { error: `unknown session: ${id}` }, 404);
          }
          await liveSessions.reload(id);
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not reload that session.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "btw" && method === "POST") {
        try {
          const body = (await request.json(MAX_PROMPT_BYTES)) as Record<string, unknown>;
          const question = typeof body["question"] === "string" ? body["question"].trim() : "";
          if (!question) throw new Error("A side question is required.");
          const result = await answerSideQuestion({
            cwd: record.worker ? homedir() : record.cwd,
            question,
            transcript: liveSessions.transcript(id),
            settings: await readHuiSettings(),
          });
          return reply(SideQuestionResult, { question, ...result });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "The side question failed.",
          }, 502);
        }
      }
      if (action[2] === "queue" && method === "POST") {
        try {
          const body = (await request.json(MAX_PROMPT_BYTES)) as Record<string, unknown>;
          const itemId = typeof body["itemId"] === "string" ? body["itemId"] : "";
          if (!itemId) throw new Error("A queued message id is required.");
          if (body["operation"] === "edit") {
            const text = typeof body["text"] === "string" ? body["text"].trim() : "";
            if (!text) throw new Error("A queued message cannot be empty.");
            liveSessions.editFollowUp(id, itemId, text);
          } else if (body["operation"] === "remove") {
            liveSessions.removeFollowUp(id, itemId);
          } else if (body["operation"] === "move") {
            if (!Number.isInteger(body["toIndex"])) throw new Error("A queue position is required.");
            liveSessions.moveFollowUp(id, itemId, Number(body["toIndex"]));
          } else if (body["operation"] === "steer") {
            await liveSessions.steerFollowUp(id, itemId);
          } else {
            throw new Error("Unknown queue operation.");
          }
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not update the queue.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "tools" && method === "GET") {
        try {
          return reply(SessionTools, await liveSessions.inspect(id));
        } catch (error) {
          return reply(ToolsError, { error: error instanceof Error ? error.message : "Runtime inspection failed." }, 502);
        }
      }
      if ((action[2] === "models" || action[2] === "commands") && method === "GET") {
        try {
          if (!liveSessions.ensure(record)) {
            return reply(SessionError, { error: `unknown session: ${id}` }, 404);
          }
          return action[2] === "commands"
            ? reply(SessionCommandsResponse, { commands: await liveSessions.commands(id) })
            : reply(SessionModelsResponse, { models: await liveSessions.models(id) });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : `The runtime could not list its ${action[2]}.`,
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "model" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        const provider = typeof body["provider"] === "string" ? body["provider"] : "";
        const modelId = typeof body["modelId"] === "string" ? body["modelId"] : "";
        if (!modelId) {
          return reply(SessionError, { error: "A model id is required." }, 400);
        }
        try {
          const model = await liveSessions.setModel(id, provider, modelId);
          return reply(SessionModelResponse, { model: model ?? null });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "pi refused that model.",
          }, error instanceof SessionBusyError ? 409 : sessionMutationErrorStatus(error));
        }
      }
      if (action[2] === "abort" && method === "POST") {
        try {
          // Stop also stops the helpers this conversation collects (Swarm), even when the turn itself refuses to stop.
          const helpers = subagents.cancelCollected(id).catch((error: unknown) => recordDiagnosticEvent({
            area: "session", level: "warning", action: "subagent_cancel_failed", sessionId: id,
            summary: error instanceof Error ? error.message : "Could not stop this conversation's collected subagents.",
          }));
          await liveSessions.abort(id);
          await helpers;
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "pi refused to stop.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "rewind" && method === "POST") {
        try {
          const body = (await request.json()) as Record<string, unknown>;
          const entryId = typeof body["entryId"] === "string" ? body["entryId"].trim() : "";
          const userFromEnd = body["userFromEnd"];
          const excludeUserMessage = body["excludeUserMessage"] === true;
          const target = entryId || (Number.isSafeInteger(userFromEnd) && (userFromEnd as number) >= 0 ? { userFromEnd: userFromEnd as number } : undefined);
          if (!target) throw new Error("A rewind point is required.");
          await liveSessions.rewind(id, target, { excludeUserMessage });
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "PI could not rewind that session.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "fork" && method === "POST") {
        try {
          const fork = forkRequest((await request.json()) as Record<string, unknown>);
          if (!liveSessions.ensure(record)) {
            return reply(SessionError, { error: `unknown session: ${id}` }, 404);
          }
          await liveSessions.booted(id);
          const forked = await forkFromSession(record, fork, (entryId, options) => liveSessions.fork(id, entryId, options));
          return reply(SessionResponse, { session: toView(forked, liveSessions.status(forked.id)) }, 201);
        } catch (error) {
          return reply(SessionError, { error: error instanceof Error ? error.message : "Could not fork that session." }, 400);
        }
      }
      if (action[2] === "resume" && method === "POST") {
        try {
          await liveSessions.continueRun(id);
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "PI could not continue that session.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "thinking" && method === "GET") {
        return reply(SessionThinkingResponse, { level: liveSessions.currentThinking(id) ?? null });
      }
      if (action[2] === "thinking" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        const level = typeof body["level"] === "string" ? body["level"].trim() : "";
        if (!isThinkingLevel(level)) {
          return reply(SessionError, { error: "Unknown thinking level." }, 400);
        }
        try {
          await liveSessions.setThinking(id, level);
          return reply(SessionThinkingResponse, { level: liveSessions.currentThinking(id) ?? level });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "pi refused that thinking level.",
          }, error instanceof SessionBusyError ? 409 : sessionMutationErrorStatus(error));
        }
      }
      if (action[2] === "fast" && method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        if (typeof body["fast"] !== "boolean") {
          return reply(SessionError, { error: "Fast mode must be true or false." }, 400);
        }
        try {
          return reply(SessionFastResponse, { fast: await liveSessions.setFast(id, body["fast"]) });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not change the speed.",
          }, sessionMutationErrorStatus(error));
        }
      }
      if (action[2] === "question" && method === "POST") {
        let body: Record<string, unknown>;
        // A parse error quotes the body, which may hold a secret; keep it out of diagnostics.
        try { body = (await request.json()) as Record<string, unknown>; }
        catch { return reply(SessionError, { error: "Invalid question response." }, 400); }
        const questionId = typeof body?.["id"] === "string" ? body["id"].trim() : "";
        if (!questionId) {
          return reply(SessionError, { error: "A question id is required." }, 400);
        }
        try {
          // A secret goes to the gateway's own request, never to the runtime.
          if (secretRequests.answer(id, questionId, body) || questionnaires.answer(id, questionId, body)) {
            return reply(SessionOk, { ok: true });
          }
          if (body["cancelled"] === true) {
            await liveSessions.cancelQuestion(id, questionId);
          } else if (typeof body["value"] === "string") {
            await liveSessions.respondQuestion(id, questionId, { value: body["value"] });
          } else if (typeof body["confirmed"] === "boolean") {
            await liveSessions.respondQuestion(id, questionId, { confirmed: body["confirmed"] });
          } else {
            return reply(SessionError, { error: "A question response or cancellation is required." }, 400);
          }
          return reply(SessionOk, { ok: true });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "pi refused that question response.",
          }, error instanceof SessionBusyError ? 409 : 400);
        }
      }
      if (action[2] === "events" && method === "GET") {
        return { stream: record };
      }
      if (action[2] === "connect" && method === "POST") {
        const url = sessionStreamTicket(id);
        return url ? reply(SessionConnectResponse, { url }) : reply(SessionError, { error: "Too many pending session connections." }, 429);
      }
      return reply(SessionError, { error: "method not allowed" }, 405);
    }
    return undefined;
  }

  return { handle };
}
