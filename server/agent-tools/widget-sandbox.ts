/**
 * The trusted outer page of HUI's two-frame widget sandbox, after OpenClaw's
 * MCP App sandbox host (2026.9.6, MIT) and the MCP Apps sandbox-proxy messages.
 *
 * It is static and identical for every widget, so it holds no data and needs
 * no x-hui header (an iframe navigation cannot send one). Its response policy
 * forces an opaque origin (`sandbox`), lets only HUI embed it
 * (`frame-ancestors 'self'`) and is inherited by the inner srcdoc frame that
 * holds the widget, which this page sandboxes again. The page
 *
 * - runs only framed, in an opaque origin, for the HUI page that framed it (its
 *   referrer origin), and then posts `ui/notifications/sandbox-proxy-ready`;
 * - builds a fresh inner frame for each `…-sandbox-resource-ready` document and
 *   reports `…-sandbox-resource-loaded`, or `…-sandbox-resource-navigated` (and
 *   removes the frame) when the widget leaves the document it was given;
 * - relays every other message both ways, drops the reserved
 *   `ui/notifications/sandbox-` methods coming from the widget, and forwards a
 *   link request only while the widget holds focus right after a user gesture.
 *
 * Also owns the sandbox path, the reserved message prefix and the widget content security policy.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const WIDGET_SANDBOX_PATH = "/__hui/widget-sandbox";
export const WIDGET_SANDBOX_METHOD_PREFIX = "ui/notifications/sandbox-";

/** Public CDNs a widget may load scripts from. Pinned here and never a
 * `connect-src`: a widget can load these libraries but cannot fetch data. */
export const WIDGET_SCRIPT_ORIGINS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://unpkg.com",
] as const;
export const WIDGET_STYLE_ORIGINS = [...WIDGET_SCRIPT_ORIGINS, "https://fonts.googleapis.com", "https://fonts.bunny.net"] as const;
export const WIDGET_FONT_ORIGINS = [...WIDGET_SCRIPT_ORIGINS, "https://fonts.gstatic.com", "https://fonts.bunny.net"] as const;

/**
 * The policy every widget document runs under. The sandbox page sends it as a
 * header (`frame: true`), which also names HUI as the only embedder and
 * forces an opaque origin; the widget document repeats it in a meta tag.
 * Images and media come only from `data:` and `blob:`; no connection is allowed.
 */
export function widgetContentSecurityPolicy(options: { frame?: boolean } = {}): string {
  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${WIDGET_SCRIPT_ORIGINS.join(" ")}`,
    `style-src 'unsafe-inline' ${WIDGET_STYLE_ORIGINS.join(" ")}`,
    `font-src data: ${WIDGET_FONT_ORIGINS.join(" ")}`,
    "img-src data: blob:",
    "media-src data: blob:",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (options.frame) directives.push("frame-ancestors 'self'", "sandbox allow-scripts allow-forms");
  return directives.join("; ");
}

const PROXY_SCRIPT = `(() => {
  "use strict";
  if (window.top === window) return;
  let host;
  try {
    const referrer = new URL(document.referrer);
    if (referrer.protocol !== "http:" && referrer.protocol !== "https:") return;
    host = referrer.origin;
  } catch {
    return;
  }
  try {
    void window.parent.document;
    return;
  } catch {
    // Expected: an opaque origin cannot read the page that framed it.
  }
  const PREFIX = ${JSON.stringify(WIDGET_SANDBOX_METHOD_PREFIX)};
  const root = document.documentElement;
  let inner;
  const scheme = (value) => {
    if (value !== "light" && value !== "dark") return;
    root.style.colorScheme = value;
    if (inner) inner.style.colorScheme = value;
  };
  const initial = /(?:^#|&)scheme=(light|dark)(?:&|$)/u.exec(location.hash);
  if (initial) scheme(initial[1]);
  const toHost = (message) => window.parent.postMessage(message, host);
  const reserved = (data) => typeof data?.method === "string" && data.method.startsWith(PREFIX);
  const activated = () => navigator.userActivation?.isActive === true;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === window.parent) {
      if (event.origin !== host) return;
      if (data?.method === PREFIX + "resource-ready") {
        const params = data.params ?? {};
        if (typeof params.html !== "string" || typeof params.renderId !== "string") return;
        const next = document.createElement("iframe");
        next.setAttribute("sandbox", "allow-scripts allow-forms");
        next.setAttribute("title", typeof params.title === "string" ? params.title.slice(0, 120) : "Widget");
        if (root.style.colorScheme) next.style.colorScheme = root.style.colorScheme;
        let loads = 0;
        next.addEventListener("load", () => {
          if (inner !== next) return;
          loads += 1;
          if (loads === 1) {
            toHost({ jsonrpc: "2.0", method: PREFIX + "resource-loaded", params: { renderId: params.renderId } });
            return;
          }
          next.remove();
          inner = undefined;
          toHost({ jsonrpc: "2.0", method: PREFIX + "resource-navigated", params: { renderId: params.renderId } });
        });
        next.srcdoc = params.html;
        if (inner) inner.replaceWith(next);
        else document.body.append(next);
        inner = next;
        return;
      }
      if (reserved(data)) return;
      if (data?.method === "ui/notifications/host-context-changed") scheme(data.params?.theme);
      inner?.contentWindow?.postMessage(data, "*");
      return;
    }
    if (!inner || event.source !== inner.contentWindow || reserved(data)) return;
    if (data?.method === "ui/open-link" && (document.activeElement !== inner || !activated())) return;
    toHost(data);
  });
  toHost({ jsonrpc: "2.0", method: PREFIX + "proxy-ready", params: {} });
})();`;

export const WIDGET_SANDBOX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HUI widget sandbox</title>
<style>html,body{height:100%;margin:0;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0;background:transparent}</style>
</head><body><script>${PROXY_SCRIPT}</script></body></html>
`;

/** Response headers of the sandbox page. Its policy is the widget policy plus
 * the embedder and opaque-origin directives only a header can carry. */
export function widgetSandboxHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": widgetContentSecurityPolicy({ frame: true }),
    "permissions-policy": "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), hid=()",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
}

export function serveWidgetSandbox(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed.");
    return;
  }
  const body = Buffer.from(WIDGET_SANDBOX_HTML, "utf8");
  response.writeHead(200, { ...widgetSandboxHeaders(), "content-length": String(body.length) });
  response.end(request.method === "HEAD" ? undefined : body);
}
