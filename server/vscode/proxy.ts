/**
 * Carries the VS Code view's browser traffic to the gateway's VS Code server under /__hui/vscode/: plain HTTP,
 * the workbench page, and the WebSocket its remote connection needs. Both providers sit behind it: openvscode-server
 * (and compatible servers) and `code serve-web`, whose page and cookies differ slightly (see patchWorkbenchHtml and
 * downstreamHeaders).
 *
 * A frame cannot send x-hui, so access is a capability: a guarded POST mints a one-use ticket, /__hui/vscode/enter
 * trades it for an HttpOnly, SameSite=Strict cookie scoped to /__hui/vscode bound to a random server-side secret, and
 * every proxied request must carry that cookie. The proxy adds the connection token upstream and strips VS Code's own
 * token cookie from responses. The token still reaches the workbench page's configuration, because VS Code's
 * WebSocket handshake carries it inside its own protocol; that page is served only behind the cookie. A workbench page
 * the token cannot be put in is refused with a notice and logged, never served as it is: that workbench would never
 * connect and never say why. Refused WebSockets are logged too. The x-hui guard of every other route is untouched.
 * Theme defaults are adapted from AgentsInTheCloud (MIT, see THIRD_PARTY_NOTICES.md).
 */
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import type { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { VSCODE_BASE_PATH, VSCODE_ENTER_PATH } from "./contract.ts";
import type { VscodeTheme } from "../api/vscode.ts";
import { recordDiagnosticEvent } from "../observability.ts";
import { validTerminalOrigin } from "../terminals/transport.ts";
import { vscodeAgent, type VscodeService } from "./vscode.ts";

export const VSCODE_COOKIE = "hui-vscode";
const TOKEN_COOKIE = "vscode-tkn";
const MAX_WORKBENCH_BYTES = 8 * 1024 * 1024;
const MAX_SOCKETS = 64;

/** Where HUI's frame opens the workbench (`/__hui/vscode/?folder=…`, after the enter route's redirect). */
export function isWorkbenchPath(pathname: string): boolean {
  return pathname === VSCODE_BASE_PATH || pathname === `${VSCODE_BASE_PATH}/`;
}

/** Everything under the base path but HUI's own enter route. */
export function isVscodeProxyPath(pathname: string): boolean {
  return (pathname === VSCODE_BASE_PATH || pathname.startsWith(`${VSCODE_BASE_PATH}/`)) && pathname !== VSCODE_ENTER_PATH;
}

function cookiePairs(header: string | undefined): Array<[string, string]> {
  return (header ?? "").split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index <= 0) return [];
    return [[part.slice(0, index).trim(), part.slice(index + 1).trim()] as [string, string]];
  });
}

/** Every value of HUI's cookie: a frame of another conversation may have set a newer one beside it. */
export function vscodeCookieSessionIds(header: string | undefined): string[] {
  return cookiePairs(header).filter(([name]) => name === VSCODE_COOKIE).map(([, value]) => value).filter(Boolean);
}

/** Never forwarded: hop-by-hop headers, and forwarding headers a client could use to steer VS Code's own URLs. */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-forwarded-prefix", "x-original-host",
  "x-hui", "cookie",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "trailer", "upgrade"]);

/** The browser's headers as VS Code should see them: same Host (VS Code derives its remote authority from it), HUI's
 * cookie removed, and VS Code's token cookie replaced by the real one. */
export function upstreamHeaders(headers: IncomingHttpHeaders, token: string, mode: { upgrade?: boolean; identity?: boolean } = {}): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    if (mode.identity && name === "accept-encoding") continue;
    result[name] = value;
  }
  const cookies = cookiePairs(headers.cookie).filter(([name]) => name !== VSCODE_COOKIE && name !== TOKEN_COOKIE);
  result["cookie"] = [...cookies.map(([name, value]) => `${name}=${value}`), `${TOKEN_COOKIE}=${token}`].join("; ");
  if (mode.upgrade) {
    result["connection"] = "Upgrade";
    result["upgrade"] = headers.upgrade ?? "websocket";
  }
  return result;
}

/** A cookie VS Code sets keeps to the base path: serve-web sets its secret-storage cookies on `Path=/`, which would
 * put them on every HUI route. */
export function scopeVscodeCookie(cookie: string): string {
  const parts = cookie.split(";");
  let scoped = false;
  const rewritten = parts.map((part, index) => {
    if (index === 0) return part;
    const match = /^\s*path\s*=\s*(.*)$/iu.exec(part);
    if (!match) return part;
    scoped = true;
    const path = (match[1] ?? "").trim();
    return path === VSCODE_BASE_PATH || path.startsWith(`${VSCODE_BASE_PATH}/`) ? part : ` Path=${VSCODE_BASE_PATH}`;
  });
  return scoped ? rewritten.join(";") : `${cookie}; Path=${VSCODE_BASE_PATH}`;
}

export function downstreamHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
    if (name === "set-cookie") {
      const kept = (Array.isArray(value) ? value : [value]).filter((cookie) => !cookie.trimStart().startsWith(`${TOKEN_COOKIE}=`)).map(scopeVscodeCookie);
      if (kept.length > 0) result[name] = kept;
      continue;
    }
    result[name] = value;
  }
  return result;
}

type ThemeDefaults = { colorTheme: string; colorCustomizations: Record<string, string> };

function luminance(hex: string): number {
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** HUI's palette on VS Code's chrome, so the frame reads as part of HUI. Mapping adapted from AgentsInTheCloud's
 * packages/vscode/src/server/proxy.ts (MIT). */
export function vscodeThemeDefaults(theme: VscodeTheme): ThemeDefaults {
  const { background: bg, panel, elevated: elev, text } = theme;
  const line = theme.border ?? elev;
  const colorCustomizations: Record<string, string> = {
    "activityBar.background": panel,
    "activityBar.foreground": text,
    "editor.background": bg,
    "editor.foreground": text,
    "editorGroup.border": line,
    "editorGroupHeader.tabsBackground": panel,
    "editorGroupHeader.tabsBorder": line,
    "tab.activeBackground": bg,
    "tab.activeForeground": text,
    "tab.border": line,
    "tab.hoverBackground": elev,
    "tab.inactiveBackground": panel,
    "tab.inactiveForeground": text,
    "tab.unfocusedActiveBackground": bg,
    "tab.unfocusedActiveForeground": text,
    "tab.unfocusedInactiveBackground": panel,
    "tab.unfocusedInactiveForeground": text,
    "sideBar.background": panel,
    "sideBar.foreground": text,
    "sideBarSectionHeader.background": elev,
    "sideBarSectionHeader.border": line,
    "sideBarSectionHeader.foreground": text,
    "sideBarTitle.foreground": text,
    "list.activeSelectionBackground": elev,
    "list.activeSelectionForeground": text,
    "list.hoverBackground": elev,
    "list.hoverForeground": text,
    "list.inactiveSelectionBackground": elev,
    "list.inactiveSelectionForeground": text,
    "statusBar.background": elev,
    "statusBar.foreground": text,
    "titleBar.activeBackground": panel,
    "titleBar.activeForeground": text,
    "titleBar.inactiveBackground": panel,
    "titleBar.inactiveForeground": text,
    "panel.background": bg,
    "terminal.background": bg,
  };
  if (theme.border) Object.assign(colorCustomizations, { "panel.border": theme.border, "sideBar.border": theme.border, "titleBar.border": theme.border, "activityBar.border": theme.border, "statusBar.border": theme.border });
  if (theme.accent) Object.assign(colorCustomizations, { "focusBorder": theme.accent, "button.background": theme.accent, "activityBarBadge.background": theme.accent, "progressBar.background": theme.accent });
  return { colorTheme: luminance(bg) > 0.55 ? "Default Light Modern" : "Default Dark Modern", colorCustomizations };
}

/** The id of the meta tag whose `data-settings` attribute holds the workbench's configuration as JSON. */
export const WORKBENCH_CONFIG_ID = "vscode-workbench-web-configuration";
/** A meta tag, whose quoted attribute values may hold a raw `>`. */
const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu;
const CONFIG_ID = new RegExp(`\\bid\\s*=\\s*(["']?)${WORKBENCH_CONFIG_ID}\\1(?=[\\s/>])`, "iu");
const SETTINGS_ATTRIBUTE = /(\sdata-settings\s*=\s*)(?:"([^"]*)"|'([^']*)')/iu;

function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(quot|amp|apos|lt|gt));/giu, (entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return ({ quot: '"', amp: "&", apos: "'", lt: "<", gt: ">" } as Record<string, string>)[(name ?? "").toLowerCase()] ?? entity;
  });
}

/** Whether a page is (or claims to be) VS Code's workbench: it names the configuration tag. */
export function looksLikeWorkbench(html: string): boolean {
  return html.includes(WORKBENCH_CONFIG_ID);
}

/** The workbench page's configuration gains the connection token (its WebSocket handshake carries it: VS Code reads it
 * from the configuration or from the `vscode-tkn` cookie, which never reaches the browser), HUI's theme and the quiet
 * defaults AgentsInTheCloud ships: no workspace-trust prompt (HUI already runs agents with full access in this
 * folder), no start page, no AI chat. They are defaults; the operator's own VS Code settings still win. serve-web
 * builds its web-extension URLs as `http://<host>`, which a page served over TLS cannot load, so they follow the
 * page's scheme.
 *
 * The tag is found by its id whatever its attribute order, quoting or entity encoding, so a VS Code release that
 * writes the page differently still gets its token. Undefined when the page holds no such configuration: without
 * the token the workbench would sit unconnected, so the caller must not serve the page as it is. */
export function patchWorkbenchHtml(html: string, options: { token: string; theme?: VscodeTheme; secure?: boolean }): string | undefined {
  for (const tag of html.matchAll(META_TAG)) {
    const meta = tag[0];
    if (!CONFIG_ID.test(meta)) continue;
    const attribute = SETTINGS_ATTRIBUTE.exec(meta);
    if (!attribute) return undefined;
    const settings = workbenchSettings(decodeAttribute(attribute[2] ?? attribute[3] ?? ""), options);
    if (!settings) return undefined;
    const encoded = settings.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    const patched = `${meta.slice(0, attribute.index)}${attribute[1]}"${encoded}"${meta.slice(attribute.index + attribute[0].length)}`;
    const at = tag.index;
    return `${html.slice(0, at)}${patched}${html.slice(at + meta.length)}`;
  }
  return undefined;
}

function workbenchSettings(raw: string, options: { token: string; theme?: VscodeTheme; secure?: boolean }): string | undefined {
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    settings = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  settings["connectionToken"] = options.token;
  settings["enableWorkspaceTrust"] = false;
  const gallery = (settings["productConfiguration"] as { extensionsGallery?: Record<string, unknown> } | undefined)?.extensionsGallery;
  const authority = typeof settings["remoteAuthority"] === "string" ? settings["remoteAuthority"] : "";
  if (options.secure && gallery && authority && typeof gallery["resourceUrlTemplate"] === "string" && gallery["resourceUrlTemplate"].startsWith(`http://${authority}/`)) {
    gallery["resourceUrlTemplate"] = `https://${gallery["resourceUrlTemplate"].slice("http://".length)}`;
  }
  const existing = settings["configurationDefaults"];
  const defaults: Record<string, unknown> = typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {};
  Object.assign(defaults, {
    "security.workspace.trust.enabled": false,
    "security.workspace.trust.startupPrompt": "never",
    "security.workspace.trust.banner": "never",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.startupEditor": "none",
    "chat.disableAIFeatures": true,
  });
  if (options.theme) {
    const theme = vscodeThemeDefaults(options.theme);
    defaults["workbench.colorTheme"] = theme.colorTheme;
    defaults["workbench.colorCustomizations"] = theme.colorCustomizations;
  }
  settings["configurationDefaults"] = defaults;
  return JSON.stringify(settings);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** What a frame (or a new tab) shows when the proxy refuses: plain, readable in light and dark, and machine-readable
 * through its meta tag so the HUI view can replace it with its own error state. */
export function vscodeNoticePage(code: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="hui-vscode-error" content="${escapeHtml(code)}" data-message="${escapeHtml(message)}"><meta name="color-scheme" content="light dark"><title>VS Code · HUI</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;color:CanvasText;background:Canvas}main{max-width:420px;padding:24px}h1{font-size:15px;margin:0 0 6px}p{margin:0;opacity:.75}</style></head><body><main><h1>VS Code is not available here</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function sendNotice(response: ServerResponse, status: number, code: string, message: string) {
  if (response.headersSent) { response.destroy(); return; }
  const body = vscodeNoticePage(code, message);
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

/** A document's body as sent, decoded; undefined for an encoding it cannot undo. */
function decodeBody(body: Buffer, encoding: string): Buffer | undefined {
  const name = encoding.trim().toLowerCase();
  const limit = { maxOutputLength: MAX_WORKBENCH_BYTES };
  try {
    if (!name || name === "identity") return body;
    if (name === "gzip" || name === "x-gzip") return gunzipSync(body, limit);
    if (name === "deflate") return inflateSync(body, limit);
    if (name === "br") return brotliDecompressSync(body, limit);
  } catch { /* not what it claimed */ }
  return undefined;
}

/** A refused page's visible text for the log, without the connection token. */
function pageText(html: string, token: string): string {
  const text = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, " ").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
  return (token ? text.replaceAll(token, "…") : text).slice(0, 160) || "(empty)";
}

function crossSite(request: IncomingMessage): boolean {
  return request.headers["sec-fetch-site"] === "cross-site";
}

function secureRequest(request: IncomingMessage): boolean {
  const socket = request.socket as { encrypted?: boolean };
  return socket.encrypted === true || String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https";
}

/** GET /__hui/vscode/enter?ticket=…: one use, then a cookie and a redirect to the folder. */
export function serveVscodeEnter(request: IncomingMessage, response: ServerResponse, service: VscodeService): void {
  if (request.method !== "GET" && request.method !== "HEAD") { sendNotice(response, 405, "method", "Open VS Code from HUI."); return; }
  if (crossSite(request)) { sendNotice(response, 403, "cross-site", "Open VS Code from HUI."); return; }
  const ticket = new URL(request.url ?? "/", "http://localhost").searchParams.get("ticket") ?? "";
  const entry = service.enter(ticket);
  if (!entry) { sendNotice(response, 403, "expired", "This VS Code link has expired or was already used. Open VS Code again from HUI."); return; }
  const cookie = [`${VSCODE_COOKIE}=${entry.sessionId}`, `Path=${VSCODE_BASE_PATH}`, "HttpOnly", "SameSite=Strict", ...(secureRequest(request) ? ["Secure"] : [])].join("; ");
  response.writeHead(303, {
    location: `${VSCODE_BASE_PATH}/?folder=${encodeURIComponent(entry.folder)}`,
    "set-cookie": cookie,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end();
}

function authorize(request: IncomingMessage, service: VscodeService) {
  return crossSite(request) ? undefined : service.session(vscodeCookieSessionIds(request.headers.cookie));
}

function wantsDocument(request: IncomingMessage): boolean {
  return request.method === "GET" && String(request.headers["accept"] ?? "").includes("text/html");
}

/** Any other /__hui/vscode/… request: authorized by the cookie, then streamed to and from VS Code. */
export function proxyVscodeHttp(request: IncomingMessage, response: ServerResponse, service: VscodeService): void {
  const session = authorize(request, service);
  if (!session) { sendNotice(response, 403, "unauthorized", "Open VS Code from a conversation's Work pane in HUI."); return; }
  // Only an open from HUI starts VS Code: a stopped or crashed server stays stopped for its reconnecting frames.
  const server = service.current();
  if (!server) { sendNotice(response, 503, "stopped", "VS Code is not running. Open it again from HUI."); return; }
  const release = service.acquire();
  const document = wantsDocument(request);
  let finished = false;
  const upstream = httpRequest({
    host: "127.0.0.1", port: server.port, method: request.method, path: request.url,
    headers: upstreamHeaders(request.headers, server.token, { identity: document }), agent: vscodeAgent,
  }, (incoming) => {
    const headers = downstreamHeaders(incoming.headers);
    const status = incoming.statusCode ?? 502;
    const html = document && status === 200 && String(incoming.headers["content-type"] ?? "").startsWith("text/html");
    if (!html) {
      response.writeHead(status, incoming.statusMessage, headers);
      incoming.pipe(response);
      incoming.once("end", () => { finished = true; });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_WORKBENCH_BYTES) { incoming.destroy(); sendNotice(response, 502, "failed", "VS Code's page was too large."); return; }
      chunks.push(chunk);
    });
    incoming.once("end", () => {
      finished = true;
      if (response.headersSent) return;
      const raw = Buffer.concat(chunks);
      const encoding = String(incoming.headers["content-encoding"] ?? "");
      const page = decodeBody(raw, encoding)?.toString("utf8");
      if (!isWorkbenchPath(new URL(request.url ?? "/", "http://localhost").pathname) && !(page !== undefined && looksLikeWorkbench(page))) {
        // Another document under the base path (a webview's page): exactly as VS Code sent it.
        response.writeHead(status, incoming.statusMessage, headers);
        response.end(raw);
        return;
      }
      const patched = page === undefined ? undefined : patchWorkbenchHtml(page, {
        token: server.token, secure: secureRequest(request), ...(session.theme ? { theme: session.theme } : {}),
      });
      if (patched === undefined) {
        // Served as it is, the page would load a workbench without its token that never connects and says nothing.
        const reason = page === undefined ? `it arrived ${encoding}-encoded and could not be read`
          : looksLikeWorkbench(page) ? "its workbench configuration could not be read" : "it has no workbench configuration";
        recordDiagnosticEvent({
          area: "gateway", level: "error", action: "vscode-workbench",
          summary: `${server.label}'s workbench page could not be prepared, so HUI refused it`,
          detail: `${reason}; page starts: ${pageText(page ?? "", server.token)}`,
        });
        sendNotice(response, 502, "incompatible", `${server.label} served a workbench page HUI could not prepare (${reason}), so it could not connect. Update HUI, or choose another VS Code in Settings → Tools → VS Code.`);
        return;
      }
      const body = Buffer.from(patched);
      delete headers["content-length"];
      delete headers["content-encoding"];
      response.writeHead(status, incoming.statusMessage, { ...headers, "content-length": body.length, "cache-control": "no-store" });
      response.end(body);
    });
  });
  upstream.once("error", () => sendNotice(response, 502, "failed", "VS Code did not answer. It may have stopped; open it again from HUI."));
  response.once("close", () => {
    release();
    if (!finished) upstream.destroy();
  });
  request.pipe(upstream);
}

/** The upstream 101's headers for the browser: serve-web sets its cookies on the upgrade too, so they get the same
 * treatment as on any response (no token cookie, the rest kept to the base path). */
export function upgradeResponseHeaders(rawHeaders: readonly string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? "";
    const value = rawHeaders[index + 1] ?? "";
    if (name.toLowerCase() === "set-cookie") {
      if (value.trimStart().startsWith(`${TOKEN_COOKIE}=`)) continue;
      lines.push(`${name}: ${scopeVscodeCookie(value)}`);
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  return lines;
}

/** How often one kind of refused WebSocket is written to the gateway's log: a workbench retries its connection. */
const UPGRADE_LOG_MS = 60_000;

/** WebSocket upgrades under /__hui/vscode/: same-origin, allowed Host, the cookie, then a byte pipe to VS Code. A
 * refused or failed upgrade leaves a workbench that never connects, so each cause is logged (once a minute). */
export function attachVscodeTransport(server: EventEmitter, service: VscodeService, allowedHosts?: ReadonlySet<string>): () => void {
  const sockets = new Set<Duplex>();
  const logged = new Map<string, number>();
  const note = (cause: string, detail: string) => {
    const now = Date.now();
    if ((logged.get(cause) ?? -Infinity) > now - UPGRADE_LOG_MS) return;
    logged.set(cause, now);
    recordDiagnosticEvent({ area: "gateway", level: "warning", action: "vscode-socket", summary: `VS Code's WebSocket was refused: ${cause}`, detail });
  };
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isVscodeProxyPath(url.pathname)) return;
    socket.on("error", () => socket.destroy());
    const reject = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (!validTerminalOrigin(request, allowedHosts)) {
      note("its origin is not this gateway's", `Origin ${String(request.headers.origin ?? "(none)")}, Host ${String(request.headers.host ?? "(none)")}`);
      reject("403 Forbidden");
      return;
    }
    if (!authorize(request, service)) { note("the frame's HUI cookie is missing or expired", "Reopen VS Code from the Work pane."); reject("403 Forbidden"); return; }
    if (sockets.size >= MAX_SOCKETS) { reject("503 Service Unavailable"); return; }
    const running = service.current();
    if (!running) { reject("503 Service Unavailable"); return; }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    {
      const release = service.acquire();
      const upstream = httpRequest({
        host: "127.0.0.1", port: running.port, method: "GET", path: request.url,
        headers: upstreamHeaders(request.headers, running.token, { upgrade: true }), agent: false,
      });
      upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
        const lines = ["HTTP/1.1 101 Switching Protocols", ...upgradeResponseHeaders(response.rawHeaders)];
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        if (head.length > 0) upstreamSocket.write(head);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          socket.destroy();
          upstreamSocket.destroy();
          release();
        };
        upstreamSocket.on("error", close);
        upstreamSocket.once("close", close);
        socket.once("close", close);
        socket.on("error", close);
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
      upstream.once("response", (response) => {
        response.resume();
        release();
        note(`${running.label} answered HTTP ${response.statusCode ?? 0}`, url.pathname);
        reject(`${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}`);
      });
      upstream.once("error", (error) => { release(); note(`${running.label} could not be reached`, error.message); reject("502 Bad Gateway"); });
      upstream.end();
    }
  };
  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
