/**
 * The `/__hui/` HTTP entry: `middleware` hands every `/__hui/` request to the dispatch, which tries each route
 * module (`server/routes/`) in a fixed order and answers 404 when none claims the path. Order is behavior and
 * `routes/order.test.ts` pins it: the routes a browser cannot send `x-hui` to (widget sandbox, presented media,
 * attachments, a bot's memory page, VS Code entry and proxy, trigger hooks) come before the `x-hui` gate; terminals,
 * files, diff, VS Code tickets and browser connect run before the diagnostics hook and are never recorded; every other
 * route is. Also owns the streams no route module writes yet (session events, session statuses, bots), theme file
 * reads and the upgrade handlers in `attachLiveStreams`. Services come from `services.ts`.
 */
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";

import type { Connect } from "vite";
import { WORKERS_ROUTE } from "./routes/workers.ts";
import { BOT_MEMORY_PAGE, BOTS_EVENTS_ROUTE, BOTS_ROUTE } from "./routes/bots.ts";
import { BOT_TRIGGERS_ROUTE } from "./routes/bot-triggers.ts";
import { isHookPath } from "./bots/triggers-listener.ts";
import { CLIENT_HEADER, responseFailures, routeRequest, sendFile, sendJson, type RouteRequest, type RouteResult } from "./http/route.ts";
import { HEARTBEAT_MS, watchSessionEvents, writeEvent } from "./http/events.ts";
import { CALLS_ROUTE } from "./routes/calls.ts";
import type { BotsUpdate } from "./bots-format.ts";

import { attachVscodeTransport, isVscodeProxyPath, proxyVscodeHttp, serveVscodeEnter } from "./vscode/proxy.ts";
import { VSCODE_ENTER_PATH } from "./vscode/contract.ts";
import { attachBrowserTransport } from "./browser/transport.ts";
import type { EventEmitter } from "node:events";
import { liveSessions } from "./sessions/live-sessions.ts";
import { diagnosticPath, recordDiagnosticEvent } from "./observability.ts";
import { servePresentedMedia } from "./agent-tools/presented-media.ts";
import { serveWidgetSandbox } from "./agent-tools/widget-sandbox.ts";
import { WIDGET_SANDBOX_PATH } from "./agent-tools/widget-sandbox.ts";
import { attachSessionTransport } from "./sessions/transport.ts";
import { FILES_ROUTE } from "./routes/files.ts";
import { DIFF_ROUTE } from "./routes/diff.ts";
import { ATTACHMENT_ROUTE } from "./routes/attachments.ts";
import { THEMES_ROUTE } from "./routes/themes.ts";
import { AUTOMATION_ROUTE } from "./routes/automation.ts";
import { handleApiSchemaRoute } from "./routes/api-schema.ts";
import { DIAGNOSTICS_EXPORT_ROUTE, HEALTH_ROUTE, OBSERVABILITY_ROUTE, UI_ERRORS_ROUTE } from "./routes/diagnostics.ts";
import { listThemes, THEME_FILE_ROUTE } from "./themes.ts";
import { readRegistry, type SessionRecord } from "./sessions/sessions.ts";
import { pendingSessions, pendingStatus, pendingStatusSubscribers, type PendingStatusUpdate } from "./sessions/views.ts";
import {
  attachmentRoutes,
  automationRoutes,
  backlogRoutes,
  botList,
  botRoutes,
  botTemplateRoutes,
  browserRoutes,
  callRoutes,
  datadogRoutes,
  diagnosticsRoutes,
  diffRoutes,
  fileRoutes,
  githubRoutes,
  jiraRoutes,
  localPathRoutes,
  managedBrowser,
  piRoutes,
  powerRoutes,
  providerRoutes,
  sessionActionRoutes,
  sessionList,
  sessionRoutes,
  settingsRoutes,
  taskSuggestionRoutes,
  terminalRoutes,
  themeRoutes,
  triggers,
  updateRoutes,
  vscode,
  vscodeRoutes,
  watcherRoutes,
  workerRoutes,
  worktreeRoutes,
} from "./services.ts";

const PREFIX = "/__hui/";
const SESSIONS_ROUTE = `${PREFIX}sessions`;
const SESSION_STATUSES_ROUTE = `${SESSIONS_ROUTE}/events`;
const PRESENTED_MEDIA_ROUTE = /^\/__hui\/media\/([0-9a-f-]+)\/([^/]+)$/u;

const BOT_CALLS = /^\/__hui\/bots\/[^/]+\/calls(?:\/|$)/u;

/* ── routes ──────────────────────────────────────────────────────────────── */

/** A page HUI renders itself (a bot's memory). Its text comes from a chat, so it may run nothing, load nothing but its
 * inline styles, submit nothing, and be framed by no page, HUI's own included. */
const BOT_PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendHtml(response: ServerResponse, status: number, html: string): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", BOT_PAGE_POLICY);
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.end(html);
}

/** A route module's answer, or its 404 when no route of the module matched. */
function sendRouteResult(response: ServerResponse, path: string, result: RouteResult | undefined): void {
  if (!result) sendJson(response, 404, { error: `unknown route: ${path}` });
  else if ("file" in result) sendFile(response, result.status, result.file);
  else if ("html" in result) sendHtml(response, result.status, result.html);
  else {
    if (result.etag) response.setHeader("etag", `"${result.etag}"`);
    sendJson(response, result.status, result.body);
  }
}

function answered(response: ServerResponse, path: string, result: RouteResult | undefined): boolean {
  if (result) sendRouteResult(response, path, result);
  return Boolean(result);
}

/** The SSE form of a session's events, for scripts and other HTTP clients.
 * The heartbeat keeps a proxy from dropping an idle stream, and is unref'd so
 * it never keeps the process alive by itself. */
export function streamSession(
  response: ServerResponse,
  record: SessionRecord,
  sessions: Pick<
    typeof liveSessions,
    "ensure" | "watch"
  > = liveSessions,
): void {
  if (!sessions.ensure(record)) {
    sendJson(response, 404, { error: `unknown session: ${record.id}` });
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();

  const unsubscribe = watchSessionEvents(record.id, (event, data) => {
    writeEvent(response, event, data);
    if (event === "closed") response.end();
  }, sessions);

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": heartbeat\n\n");
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  response.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/** Multiplexes the small lifecycle surface for every live session over one
 * browser connection. Transcript and model traffic remains scoped to the
 * selected session's detailed stream. */
export function streamSessionStatuses(
  response: ServerResponse,
  sessions: Pick<typeof liveSessions, "watchStatuses"> = liveSessions,
  list: Pick<typeof sessionList, "subscribe"> = sessionList,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();

  const write = (update: PendingStatusUpdate) => writeEvent(response, "status", update);
  const watched = sessions.watchStatuses(write);
  pendingStatusSubscribers.add(write);
  writeEvent(response, "snapshot", { statuses: [...watched.statuses, ...[...pendingSessions.values()].map(pendingStatus)] });
  const unlist = list.subscribe((update) => writeEvent(response, "sessions", update));

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  response.on("close", () => {
    clearInterval(heartbeat);
    watched.unsubscribe();
    pendingStatusSubscribers.delete(write);
    unlist();
  });
}

/** `GET /__hui/bots/events`: the complete bot list first, then only the bots whose views changed. */
export function streamBots(response: ServerResponse, list: Pick<typeof botList, "subscribe"> = botList): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const unlist = list.subscribe((update) => writeEvent(response, "bots", {
    revision: update.revision,
    ...(update.groups ? { ids: update.groups.flatMap((group) => group.ids) } : {}),
    upserts: update.upserts,
  } satisfies BotsUpdate));
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();
  response.on("close", () => {
    clearInterval(heartbeat);
    unlist();
  });
}

/** `/__hui/calls` and `/__hui/bots/:id/calls…` (`routes/calls.ts`). */
async function serveCallRoute(response: ServerResponse, routed: RouteRequest): Promise<void> {
  sendRouteResult(response, routed.path, await callRoutes.handle(routed));
}

/** `/__hui/bots` and everything under it but the events stream (`routes/bots.ts`). */
async function serveBotRoute(response: ServerResponse, routed: RouteRequest): Promise<void> {
  // Importing and exporting first: `import` is a reserved handle, and `export` no bot route's action.
  sendRouteResult(response, routed.path, await botTemplateRoutes.handle(routed) ?? await botRoutes.handle(routed));
}

/** `/__hui/bots/:id/triggers…` (`routes/bot-triggers.ts`). */
async function serveTriggerRoute(response: ServerResponse, routed: RouteRequest): Promise<void> {
  sendRouteResult(response, routed.path, await triggers.routes.handle(routed));
}

async function handleRequest(
  request: Connect.IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  // An iframe navigation cannot send x-hui. The page is static and holds no
  // data; its own policy keeps it opaque and embeddable only by HUI.
  if (path === WIDGET_SANDBOX_PATH) {
    serveWidgetSandbox(request, response);
    return;
  }
  const presentedMedia = path.match(PRESENTED_MEDIA_ROUTE);
  // Native img/audio/video elements cannot set x-hui. Their opaque random id is
  // the read capability, and CORP prevents embedding it from another origin.
  if (presentedMedia) {
    if (!await servePresentedMedia(request, response, presentedMedia[1] ?? "", presentedMedia[2] ?? "")) {
      sendJson(response, 404, { error: "media not found" });
    }
    return;
  }
  // <img> cannot send x-hui; the route accepts it or a browser-attested same-origin fetch (`routes/attachments.ts`).
  if (ATTACHMENT_ROUTE.test(path)) {
    sendRouteResult(response, path, await attachmentRoutes.handle(routeRequest(request, response, path)));
    return;
  }

  if (BOT_MEMORY_PAGE.test(path)) {
    // A link (a bot's memory in a new tab) cannot send x-hui either: like an
    // attachment, accept it or a browser-attested same-origin load, and refuse
    // everything cross-site.
    if (request.headers[CLIENT_HEADER] !== "1" && request.headers["sec-fetch-site"] !== "same-origin") {
      sendJson(response, 403, { error: `missing ${CLIENT_HEADER} header` });
      return;
    }
    await serveBotRoute(response, routeRequest(request, response, path));
    return;
  }

  // A VS Code frame cannot send x-hui either. Its one-use ticket (minted below, behind x-hui) becomes a cookie scoped
  // to /__hui/vscode, which only the proxy accepts; no other route reads it (`vscode-proxy.ts`).
  if (path === VSCODE_ENTER_PATH) {
    serveVscodeEnter(request, response, vscode);
    return;
  }
  if (isVscodeProxyPath(path)) {
    proxyVscodeHttp(request, response, vscode);
    return;
  }

  // A trigger's listener is another program: its token is the credential, not x-hui (`bot-triggers-listener.ts`).
  if (isHookPath(path)) {
    const result = await triggers.hook(request, path);
    sendJson(response, result.status, result.body);
    return;
  }

  if (request.method === "OPTIONS") {
    sendJson(response, 403, { error: "cross-origin requests are not accepted" });
    return;
  }
  if (request.headers[CLIENT_HEADER] !== "1") {
    sendJson(response, 403, { error: `missing ${CLIENT_HEADER} header` });
    return;
  }

  const routed = routeRequest(request, response, path);

  if (answered(response, path, await terminalRoutes.handle(routed))) return;

  // The Files view: the conversation's working directory, never another path (`routes/files.ts`).
  if (FILES_ROUTE.test(path)) {
    sendRouteResult(response, path, await fileRoutes.handle(routed));
    return;
  }

  // The Diff view: Git comparisons of the conversation's working directory, read-only (`routes/diff.ts`).
  if (DIFF_ROUTE.test(path)) {
    sendRouteResult(response, path, await diffRoutes.handle(routed));
    return;
  }

  if (answered(response, path, await vscodeRoutes.handle(routed))) return;

  if (answered(response, path, await browserRoutes.connect(routed))) return;

  const started = performance.now();
  response.once("finish", () => {
    if (path === OBSERVABILITY_ROUTE || path === DIAGNOSTICS_EXPORT_ROUTE || path === HEALTH_ROUTE) return;
    // An accepted UI error report is already its own diagnostic.
    if (path === UI_ERRORS_ROUTE && response.statusCode < 400) return;
    if (request.method === "GET" && response.statusCode < 400) return;
    const safePath = diagnosticPath(path);
    recordDiagnosticEvent({
      area: path.startsWith(AUTOMATION_ROUTE) ? "automation" : path.startsWith(SESSIONS_ROUTE) ? "session" : "gateway",
      level: response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warning" : "info",
      action: `${request.method ?? "GET"} ${safePath}`,
      summary: `HTTP ${response.statusCode} in ${Math.max(0, Math.round(performance.now() - started))} ms`,
      detail: responseFailures.get(response),
    });
  });

  if (answered(response, path, await updateRoutes.handle(routed))) return;

  if (answered(response, path, await localPathRoutes.handle(routed))) return;

  if (answered(response, path, await browserRoutes.handle(routed))) return;

  if (answered(response, path, await settingsRoutes.handle(routed))) return;

  if (answered(response, path, await piRoutes.handle(routed))) return;

  if (path === WORKERS_ROUTE || path.startsWith(`${WORKERS_ROUTE}/`)) {
    const result = await workerRoutes.handle(routed);
    if (result) sendRouteResult(response, path, result);
    else sendJson(response, 404, { error: "not found" });
    return;
  }

  if (path === BOTS_EVENTS_ROUTE) {
    if (request.method !== "GET") sendJson(response, 405, { error: "method not allowed" });
    else streamBots(response);
    return;
  }

  if (path === CALLS_ROUTE || BOT_CALLS.test(path)) {
    await serveCallRoute(response, routed);
    return;
  }

  if (path === BOTS_ROUTE || path.startsWith(`${BOTS_ROUTE}/`)) {
    await (BOT_TRIGGERS_ROUTE.test(path) ? serveTriggerRoute(response, routed) : serveBotRoute(response, routed));
    return;
  }

  if (answered(response, path, await providerRoutes.handle(routed))) return;

  if (answered(response, path, await powerRoutes.handle(routed))) return;
  if (answered(response, path, await handleApiSchemaRoute(routed))) return;

  if (answered(response, path, await diagnosticsRoutes.handle(routed, response))) return;

  if (answered(response, path, await worktreeRoutes.handle(routed))) return;

  if (answered(response, path, await automationRoutes.handle(routed))) return;

  if (path.startsWith(THEMES_ROUTE)) {
    const result = await themeRoutes.handle(routed);
    if (result) {
      sendRouteResult(response, path, result);
      return;
    }
  }

  if (answered(response, path, await githubRoutes.handle(routed))) return;

  if (answered(response, path, await datadogRoutes.handle(routed))) return;

  if (answered(response, path, await jiraRoutes.handle(routed))) return;

  if (path === SESSION_STATUSES_ROUTE) {
    if (request.method === "GET") {
      streamSessionStatuses(response);
    } else {
      sendJson(response, 405, { error: "method not allowed" });
    }
    return;
  }

  if (answered(response, path, await sessionRoutes.handle(routed))) return;

  if (answered(response, path, await backlogRoutes.handle(routed))) return;

  if (answered(response, path, await taskSuggestionRoutes.handle(routed))) return;

  if (answered(response, path, await watcherRoutes.handle(routed))) return;

  const sessionAction = await sessionActionRoutes.handle(routed);
  if (sessionAction && "stream" in sessionAction) {
    streamSession(response, sessionAction.stream);
    return;
  }
  if (answered(response, path, sessionAction)) return;

  if (path.startsWith(THEME_FILE_ROUTE) && request.method === "GET") {
    const key = decodeURIComponent(path.slice(THEME_FILE_ROUTE.length));
    const file = (await listThemes()).files.get(key);
    if (!file) {
      sendJson(response, 404, { error: `unknown theme file: ${key}` });
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(await readFile(file));
    return;
  }

  sendJson(response, 404, { error: `unknown route: ${path}` });
}

export const middleware: Connect.NextHandleFunction = (request, response, next) => {
  if (!request.url?.startsWith(PREFIX)) {
    next();
    return;
  }
  handleRequest(request, response).catch((error: unknown) => {
    // The browser gets a generic message; the request's diagnostic keeps the cause.
    if (error instanceof Error && error.message) responseFailures.set(response, error.message);
    sendJson(response, 500, { error: "config backend failed" });
  });
};

/** Upgrade handlers for browser panes and session views; the gateway and Vite
 * servers attach them next to terminals. */
export function attachLiveStreams(server: EventEmitter, allowedHosts?: ReadonlySet<string>): () => void {
  const detachBrowser = attachBrowserTransport(server, managedBrowser, allowedHosts);
  const detachVscode = attachVscodeTransport(server, vscode, allowedHosts);
  const detachSessions = attachSessionTransport(server, async (id, send) => {
    const record = (await readRegistry()).find((session) => session.id === id);
    if (!record) return undefined;
    return liveSessions.ensure(record) ? watchSessionEvents(id, send) : undefined;
  }, allowedHosts);
  return () => { detachBrowser(); detachVscode(); detachSessions(); };
}
