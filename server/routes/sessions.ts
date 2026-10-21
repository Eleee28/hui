/**
 * The session list and its groups: `/__hui/session-groups` (create, reorder) and `/__hui/session-groups/:label`
 * (rename or change defaults, delete), `GET/POST /__hui/sessions` (the list, a new session or a worktree launch),
 * `GET /__hui/sessions/search` (transcript search) and `PATCH/DELETE /__hui/sessions/:id` (change or remove one
 * session), over `sessions.ts`, `sessions/lifecycle.ts` and `sessions/search.ts`.
 * `hui.ts` applies the `x-hui` guard before dispatching here and keeps the `/__hui/sessions/events` stream.
 */
import { stat } from "node:fs/promises";
import type { BotService } from "../bots/service.ts";
import { reply, type JsonResult, type RouteRequest } from "../http/route.ts";
import type { RouteSchema } from "../api/index.ts";
import { SessionError, SessionList, SessionOk, SessionResponse, SessionSearchResult, sessionRouteSchemas } from "../api/sessions.ts";
import { liveSessions } from "../sessions/live-sessions.ts";
import { searchSessions } from "../sessions/search.ts";
import {
  createSessionGroup,
  deleteSessionGroup,
  readRegistry,
  reorderSessionGroups,
  SessionNotFoundError,
  SessionRegistryError,
  updateSessionGroup,
} from "../sessions/sessions.ts";
import { type createSessionLifecycle, SESSION_GROUP_MAX, SESSION_TITLE_MAX, sessionText } from "../sessions/lifecycle.ts";
import { type createSessionViews, pendingSessions } from "../sessions/views.ts";
import { resolveWorkingDirectory } from "../git/working-directories.ts";

export const routeSchemas: RouteSchema[] = sessionRouteSchemas;

const SESSIONS_ROUTE = "/__hui/sessions";
const SESSIONS_SEARCH_ROUTE = "/__hui/sessions/search";
const SEARCH_QUERY_MAX = 200;
const SESSION_GROUPS_ROUTE = "/__hui/session-groups";
const SESSION_GROUP_ONE = /^\/__hui\/session-groups\/([^/]+)$/;
const SESSION_GROUP_ORDER_MAX = 1_000;
/** The session itself, for changing it rather than acting on it. */
const SESSION_ONE = /^\/__hui\/sessions\/([^/]+)$/;

/** Prompts may carry images inline, so they get their own, larger ceiling. */
export const MAX_PROMPT_BYTES = 24 * 1024 * 1024;

/** Why a bot's chat refuses an operation that would end, shorten or fork it (409). Without a handle (an unreadable
 * bot registry), the record's `bot` field alone refuses. */
export function foreverChatRefusal(handle: string | undefined, operation: "clear" | "compact" | "rewind" | "fork" | "delete"): string {
  const chat = handle ? `@${handle}'s` : "a bot's";
  return {
    clear: `This is ${chat} forever chat: it cannot be cleared. Its memory keeps everything; archive the bot when you are done with it.`,
    compact: `This is ${chat} forever chat: its memory condenses it by itself, so it is not compacted by hand.`,
    rewind: `This is ${chat} forever chat: it cannot be rewound or forked.`,
    fork: `This is ${chat} forever chat: it cannot be rewound or forked.`,
    delete: `This is ${chat} forever chat: archive the bot instead${handle ? ` (hui bot remove ${handle})` : ""}, which keeps its chat and memory, or delete the bot${handle ? ` (hui bot delete ${handle})` : ""} with its chat, memory and folder.`,
  }[operation];
}

function sessionGroupName(body: Record<string, unknown>, key = "name"): string {
  if (typeof body[key] !== "string") throw new Error("A group name is required.");
  const value = body[key].trim();
  if (!value || value.length > SESSION_GROUP_MAX) {
    throw new Error(`A group name must be 1-${SESSION_GROUP_MAX} characters.`);
  }
  if (value.toLocaleLowerCase() === "ungrouped") {
    throw new Error('"ungrouped" is reserved for sessions without a group.');
  }
  return value;
}

/** The complete catalog order; registry validation rejects stale lists. */
function sessionGroupOrder(body: Record<string, unknown>): string[] {
  const order = body["order"];
  if (!Array.isArray(order) || order.length > SESSION_GROUP_ORDER_MAX) {
    throw new Error(`A group order must list at most ${SESSION_GROUP_ORDER_MAX} groups.`);
  }
  return order.map((label) => {
    if (typeof label !== "string" || !label || label.length > SESSION_GROUP_MAX) {
      throw new Error(`Group names must be 1-${SESSION_GROUP_MAX} characters.`);
    }
    return label;
  });
}

export async function sessionGroupPatch(body: Record<string, unknown>): Promise<{
  label?: string;
  cwd?: string;
  workspaceMode?: "branch" | "worktree" | "";
  baseRef?: string;
}> {
  const patch: { label?: string; cwd?: string; workspaceMode?: "branch" | "worktree" | ""; baseRef?: string } = {};
  if ("name" in body) patch.label = sessionGroupName(body);
  if ("cwd" in body) {
    if (typeof body["cwd"] !== "string") throw new Error("Working directory must be text.");
    const entered = body["cwd"].trim();
    const cwd = entered ? resolveWorkingDirectory(entered) : "";
    if (cwd) {
      let info;
      try {
        info = await stat(cwd);
      } catch {
        throw new Error(`No such directory: ${cwd}`);
      }
      if (!info.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    }
    patch.cwd = cwd;
  }
  if ("workspaceMode" in body) {
    const mode = body["workspaceMode"];
    if (mode !== "" && mode !== "branch" && mode !== "worktree") throw new Error("Environment must be branch or worktree.");
    patch.workspaceMode = mode;
  }
  if ("baseRef" in body) patch.baseRef = sessionText(body, "baseRef", SESSION_TITLE_MAX, { optional: false, allowEmpty: true })!;
  if (Object.keys(patch).length === 0) throw new Error("Nothing to change.");
  return patch;
}

/** Input/import-source failures are client-visible 400s; registry integrity or
 * storage failures are backend failures and must never be misreported as bad
 * user input. */
export function sessionMutationErrorStatus(error: unknown): 400 | 500 {
  return error instanceof SessionRegistryError ? 500 : 400;
}

export function createSessionRoutes(deps: {
  sessionList: { refresh(): Promise<SessionList> };
  lifecycle: Pick<ReturnType<typeof createSessionLifecycle>, "createSession" | "startWorktreeSession" | "deleteSession" | "updateSession">;
  views: Pick<ReturnType<typeof createSessionViews>, "toView">;
  bots: Pick<BotService, "botForSession">;
}) {
  async function handle(request: RouteRequest): Promise<JsonResult | undefined> {
    const { method, path } = request;
    const { sessionList, bots } = deps;
    const { createSession, startWorktreeSession, deleteSession, updateSession } = deps.lifecycle;
    const { toView } = deps.views;

    if (path === SESSION_GROUPS_ROUTE && method === "POST") {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        await createSessionGroup(sessionGroupName(body));
        return reply(SessionList, await sessionList.refresh());
      } catch (error) {
        return reply(SessionError, {
          error: error instanceof Error ? error.message : "Could not create that group.",
        }, sessionMutationErrorStatus(error));
      }
    }

    if (path === SESSION_GROUPS_ROUTE && method === "PUT") {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        await reorderSessionGroups(sessionGroupOrder(body));
        return reply(SessionList, await sessionList.refresh());
      } catch (error) {
        return reply(SessionError, {
          error: error instanceof Error ? error.message : "Could not reorder the groups.",
        }, sessionMutationErrorStatus(error));
      }
    }

    const groupOne = path.match(SESSION_GROUP_ONE);
    if (groupOne && (method === "PATCH" || method === "DELETE")) {
      const label = decodeURIComponent(groupOne[1] ?? "");
      try {
        if (method === "DELETE") {
          await deleteSessionGroup(label);
        } else {
          await updateSessionGroup(
            label,
            await sessionGroupPatch((await request.json()) as Record<string, unknown>),
          );
        }
        return reply(SessionList, await sessionList.refresh());
      } catch (error) {
        return reply(SessionError, {
          error: error instanceof Error ? error.message : "Could not update that group.",
        }, sessionMutationErrorStatus(error));
      }
    }

    if (path === SESSIONS_SEARCH_ROUTE && method === "GET") {
      const query = request.query.get("q")?.trim() ?? "";
      if (query.length < 2 || query.length > SEARCH_QUERY_MAX) {
        return reply(SessionError, { error: `Search for 2-${SEARCH_QUERY_MAX} characters.` }, 400);
      }
      return reply(SessionSearchResult, await searchSessions(query, request.signal));
    }

    if (path === SESSIONS_ROUTE) {
      if (method === "GET") {
        return reply(SessionList, await sessionList.refresh());
      }
      if (method === "POST") {
        let body: Record<string, unknown>;
        try {
          // A worktree launch may carry its first prompt's attachments.
          body = (await request.json(MAX_PROMPT_BYTES)) as Record<string, unknown>;
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not read that session request.",
          }, sessionMutationErrorStatus(error));
        }
        if (body["worktree"] === true) {
          try {
            return reply(SessionResponse, { session: await startWorktreeSession(body) });
          } catch (error) {
            return reply(SessionError, {
              error: error instanceof Error ? error.message : "Could not start that session.",
            }, sessionMutationErrorStatus(error));
          }
        }
        try {
          const record = await createSession(body);
          return reply(SessionResponse, { session: toView(record, liveSessions.status(record.id)) });
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not start that session.",
          }, sessionMutationErrorStatus(error));
        }
      }
      return reply(SessionError, { error: "method not allowed" }, 405);
    }

    const one = path.match(SESSION_ONE);
    if (one && (method === "PATCH" || method === "DELETE")) {
      const id = decodeURIComponent(one[1] ?? "");

      const pending = pendingSessions.get(id);
      if (pending) {
        if (method === "DELETE" && pending.error) {
          pendingSessions.delete(id);
          return reply(SessionOk, { ok: true });
        }
        return reply(SessionError, { error: pending.error ?? "The Git worktree is still being created." }, 409);
      }

      const owned = (await readRegistry()).find((session) => session.id === id);

      if (method === "DELETE") {
        // A bot owns its chat: deleting the row would orphan the bot. Archiving keeps both.
        const owner = await bots.botForSession(id).then((bot) => bot ? { handle: bot.handle } : undefined, () => owned?.bot ? { handle: undefined } : undefined);
        if (owner) {
          return reply(SessionError, { error: foreverChatRefusal(owner.handle, "delete") }, 409);
        }
        // Block stale opens first, but keep the runtime and streams alive until
        // registry removal commits. A storage failure rolls the tombstone back.
        try {
          await deleteSession(id);
        } catch (error) {
          return reply(SessionError, {
            error: error instanceof Error ? error.message : "Could not remove that session.",
          }, error instanceof SessionNotFoundError ? 404 : 500);
        }
        // The conversation file under ~/.pi is pi's and is deliberately left
        // alone; losing a transcript because you tidied a list is unforgivable.
        return reply(SessionOk, { ok: true });
      }

      const body = (await request.json()) as Record<string, unknown>;
      try {
        const next = await updateSession(id, body);
        return reply(SessionResponse, { session: toView(next, liveSessions.status(id)) });
      } catch (error) {
        return reply(SessionError, { error: error instanceof Error ? error.message : "Could not update that session." }, error instanceof SessionNotFoundError
          ? 404
          : error instanceof SessionRegistryError
            ? 500
            : 400);
      }
    }

    return undefined;
  }

  return { handle };
}
