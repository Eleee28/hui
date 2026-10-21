/**
 * Host side of the inline widgets shown by `show_widget`: what a call renders, the theme tokens passed into
 * the sandbox, validation of messages coming back from it, and the limits on size and links. The widget
 * code itself runs only inside the sandboxed frame. The fragment contract, theme tokens, base stylesheet and
 * helper classes are ported from OpenClaw 2026.9.6 (MIT, see THIRD_PARTY_NOTICES.md). Frame messages use
 * MCP Apps (SEP-1865) JSON-RPC method names where one exists.
 */
/** UTF-8 bytes of `widget_code` (OpenClaw allows 262,144 characters). */
export const WIDGET_CODE_MAX_BYTES = 256 * 1024;
export const WIDGET_TITLE_MAX_LENGTH = 120;
/** The chat fits the frame to the reported content height within these bounds. */
export const WIDGET_MIN_HEIGHT = 48;
export const WIDGET_MAX_HEIGHT = 8_000;
/** The static page that hosts every widget; see server/agent-tools/widget-sandbox.ts. */
export const WIDGET_SANDBOX_PATH = "/__hui/widget-sandbox";
/** Messages only the sandbox page sends or receives; it drops them from widget code. */
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

/** A leading doctype, `<html>`, `<head>` or `<body>` makes a document the tool refuses. */
export function isCompleteHtmlDocument(code: string): boolean {
  return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/iu.test(code.trimStart());
}

/** Code starting with `<svg` is centred as a drawing, as in OpenClaw. */
export function widgetMode(code: string): "html" | "svg" {
  return /^<svg\b/iu.test(code.trimStart()) ? "svg" : "html";
}

/** Widget token → the HUI (OpenClaw design system) variable it reads. Names
 * and sources match OpenClaw's widget theme bridge. */
export const WIDGET_THEME_TOKENS = {
  surface: "--bg",
  card: "--card",
  elevated: "--bg-elevated",
  text: "--text",
  "text-strong": "--text-strong",
  muted: "--muted",
  border: "--border",
  "border-strong": "--border-strong",
  accent: "--accent",
  "accent-fill": "--primary",
  "accent-fg": "--primary-foreground",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  info: "--info",
  radius: "--radius",
  "radius-full": "--radius-full",
  "scrollbar-size": "--scrollbar-size",
  "scrollbar-thumb-inset": "--scrollbar-thumb-inset",
  "scrollbar-thumb": "--scrollbar-thumb",
  "scrollbar-thumb-hover": "--scrollbar-thumb-hover",
  "font-body": "--font-body",
  "font-mono": "--mono",
} as const;

export type WidgetToken = keyof typeof WIDGET_THEME_TOKENS;
export const WIDGET_TOKENS = Object.keys(WIDGET_THEME_TOKENS) as WidgetToken[];
export type WidgetTheme = { mode: "light" | "dark"; tokens: Partial<Record<WidgetToken, string>> };

const MAX_TOKEN_LENGTH = 256;

/** Token values a document may take: bounded strings that cannot leave the
 * declaration they are written into. */
export function widgetTokenValue(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value && value.length <= MAX_TOKEN_LENGTH && !/[;{}<>\\]/u.test(value) ? value : undefined;
}

/** OpenClaw's baked palettes keep a document readable for any token the host
 * does not send. */
const DEFAULT_TOKENS: Record<WidgetTheme["mode"], Partial<Record<WidgetToken, string>>> = {
  light: {
    surface: "#faf9f7", card: "#ffffff", elevated: "#ffffff", text: "#403c35", "text-strong": "#211e1a", muted: "#6e6960",
    border: "#e8e4dc", "border-strong": "#d6d0c5", accent: "#bd4531", "accent-fill": "#bd4531", "accent-fg": "#ffffff",
    ok: "#15803d", warn: "#b45309", danger: "#dc2626", info: "#2563eb",
  },
  dark: {
    surface: "#0e1015", card: "#161920", elevated: "#191c24", text: "#d4d4d8", "text-strong": "#f4f4f5", muted: "#8b8b94",
    border: "#1e2028", "border-strong": "#2e3040", accent: "#ff5c5c", "accent-fill": "#d13c3c", "accent-fg": "#ffffff",
    ok: "#22c55e", warn: "#f59e0b", danger: "#ef4444", info: "#3b82f6",
  },
};
const SHARED_TOKENS: Partial<Record<WidgetToken, string>> = {
  radius: "10px",
  "radius-full": "9999px",
  "scrollbar-size": "12px",
  "scrollbar-thumb-inset": "3px",
  "scrollbar-thumb": "color-mix(in srgb,var(--muted) 32%,transparent)",
  "scrollbar-thumb-hover": "color-mix(in srgb,var(--muted) 64%,transparent)",
  "font-body": "-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif",
  "font-mono": "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
};

/** OpenClaw's classless base stylesheet and helper classes; only the variables
 * block before it differs. */
const BASE_STYLES = `--accent-subtle:color-mix(in srgb,var(--accent) 10%,transparent);
--ok-subtle:color-mix(in srgb,var(--ok) 10%,transparent);
--warn-subtle:color-mix(in srgb,var(--warn) 12%,transparent);
--danger-subtle:color-mix(in srgb,var(--danger) 10%,transparent);
--info-subtle:color-mix(in srgb,var(--info) 10%,transparent)}
*{box-sizing:border-box}@supports not selector(::-webkit-scrollbar-thumb){*{scrollbar-color:var(--scrollbar-thumb) transparent;scrollbar-width:thin}}html,body{margin:0;background:transparent}::-webkit-scrollbar{width:var(--scrollbar-size);height:var(--scrollbar-size);background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-button{display:none}::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb);background-clip:content-box;border:var(--scrollbar-thumb-inset) solid transparent;border-radius:var(--radius-full)}::-webkit-scrollbar-thumb:hover{background:var(--scrollbar-thumb-hover);background-clip:content-box}
body{font:14px/1.5 var(--font-body);color:var(--text)}
h1,h2,h3{margin:0 0 8px;color:var(--text-strong);font-weight:600}
h1{font-size:18px}h2{font-size:16px}h3{font-size:14px}
p{margin:0 0 8px}
a{color:var(--accent)}
button{font:13px var(--font-body);color:var(--text);background:var(--card);border:1px solid var(--border-strong);border-radius:var(--radius);padding:6px 14px;cursor:pointer}
button:hover{border-color:var(--muted)}
button.primary{background:var(--accent-fill);color:var(--accent-fg);border-color:transparent}
input,select,textarea{font:13px var(--font-body);color:var(--text);background:var(--elevated);border:1px solid var(--border-strong);border-radius:var(--radius);padding:6px 10px}
input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);font-size:12px;padding:4px 8px}
td{padding:6px 8px;border-top:1px solid var(--border)}
code,pre{font-family:var(--font-mono);font-size:12px;background:var(--card);border-radius:4px}
code{padding:1px 5px}pre{padding:10px;overflow-x:auto}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.badge{display:inline-block;font-size:12px;padding:2px 10px;border-radius:999px;background:var(--accent-subtle);color:var(--accent)}
.badge.ok{background:var(--ok-subtle);color:var(--ok)}
.badge.warn{background:var(--warn-subtle);color:var(--warn)}
.badge.danger{background:var(--danger-subtle);color:var(--danger)}
.badge.info{background:var(--info-subtle);color:var(--info)}
.metric{font-size:24px;font-weight:600;color:var(--text-strong)}
.muted{color:var(--muted)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.svg-widget{display:grid;place-items:center}.svg-widget>svg{max-width:100%}`;

/**
 * Host bridges, run before any widget code. They are conveniences, not a
 * security boundary: the chat validates and bounds everything they send.
 *
 * - size: the body's content height (`ui/notifications/size-changed`);
 * - theme: tokens, color scheme and display mode from the chat
 *   (`ui/notifications/host-context-changed`);
 * - errors: up to three distinct uncaught errors, rejections and policy
 *   violations (`notifications/message`, level `error`);
 * - links: a click on an http(s) link asks the chat to open it in a new tab
 *   (`ui/open-link`), so the frame itself never navigates or opens a popup;
 * - Escape in the expanded view asks to return inline (`ui/request-display-mode`).
 */
const BRIDGES = `(()=>{"use strict";const parent=window.parent;if(!parent||parent===window)return;
const post=(message)=>{try{parent.postMessage(message,"*")}catch{}};
const listen=EventTarget.prototype.addEventListener;const on=(target,type,handler,options)=>listen.call(target,type,handler,options);
const root=document.documentElement;const rootStyle=root.style;const setProperty=CSSStyleDeclaration.prototype.setProperty;const removeProperty=CSSStyleDeclaration.prototype.removeProperty;
const setAttribute=Element.prototype.setAttribute;const getAttribute=Element.prototype.getAttribute;const composedPath=Event.prototype.composedPath;const preventDefault=Event.prototype.preventDefault;
const ErrorEventType=ErrorEvent;const URLType=URL;const max=Math.max;const ceil=Math.ceil;const text=String;
let sequence=0;const notify=(method,params)=>post({jsonrpc:"2.0",method,params});const request=(method,params)=>post({jsonrpc:"2.0",id:"widget-"+(++sequence),method,params});
let displayMode="inline";let lastHeight=0;
const reportSize=()=>{const body=document.body;if(!body)return;const height=ceil(max(body.scrollHeight,body.getBoundingClientRect().height));if(height>0&&height!==lastHeight){lastHeight=height;notify("ui/notifications/size-changed",{height})}};
const tokens=${JSON.stringify(WIDGET_TOKENS)};
on(window,"message",(event)=>{if(event.source!==parent)return;const data=event.data;if(!data||data.jsonrpc!=="2.0"||data.method!=="ui/notifications/host-context-changed")return;const params=data.params&&typeof data.params==="object"?data.params:{};
const variables=params.styles&&typeof params.styles==="object"&&params.styles.variables&&typeof params.styles.variables==="object"?params.styles.variables:undefined;
if(variables)for(const key of tokens){const raw=variables["--"+key];const value=typeof raw==="string"?raw.trim():"";if(value&&value.length<=256)setProperty.call(rootStyle,"--"+key,value);else removeProperty.call(rootStyle,"--"+key)}
if(params.theme==="light"||params.theme==="dark")setProperty.call(rootStyle,"color-scheme",params.theme);
if(params.displayMode==="inline"||params.displayMode==="fullscreen"){displayMode=params.displayMode;setAttribute.call(root,"data-display-mode",displayMode)}});
const seen=new Set();let reported=0;const report=(data)=>{if(reported>=3||seen.has(data.message))return;seen.add(data.message);reported++;notify("notifications/message",{level:"error",logger:"widget",data})};
const basename=(value)=>text(value).replace(/[?#].*$/,"").replace(/^.*[\\\\/]/,"").slice(0,200);
on(window,"error",(event)=>{if(!(event instanceof ErrorEventType))return;const error=event.error;const message=text(error&&error.message||event.message||"Script error").slice(0,500);const data={kind:"error",message};
if(event.filename)data.source=event.filename==="about:srcdoc"?"widget":basename(event.filename);if(event.lineno>0)data.line=event.lineno;if(event.colno>0)data.column=event.colno;report(data)},true);
on(window,"unhandledrejection",(event)=>{const reason=event.reason;report({kind:"rejection",message:text(reason&&reason.message||reason).slice(0,500)})});
on(document,"securitypolicyviolation",(event)=>{const blocked=text(event.blockedURI||"inline").slice(0,300);report({kind:"blocked",message:("Blocked by the widget policy ("+text(event.effectiveDirective||event.violatedDirective)+"): "+blocked).slice(0,500)})});
const openLink=(event)=>{if(event.isTrusted!==true||event.defaultPrevented)return;const middle=event.type==="auxclick"&&event.button===1;if(!middle&&!(event.type==="click"&&event.button===0))return;
const path=composedPath.call(event);for(let index=0;index<path.length;index++){const node=path[index];const name=node&&typeof node.tagName==="string"?node.tagName.toLowerCase():"";if(name!=="a")continue;
const href=getAttribute.call(node,"href")||getAttribute.call(node,"xlink:href");if(!href||href.charAt(0)==="#")return;let url;try{url=new URLType(href,document.baseURI)}catch{return}
if(url.protocol!=="http:"&&url.protocol!=="https:")return;preventDefault.call(event);request("ui/open-link",{url:url.href});return}};
on(window,"click",openLink);on(window,"auxclick",openLink);
on(window,"keydown",(event)=>{if(event.isTrusted===true&&!event.defaultPrevented&&event.key==="Escape"&&displayMode==="fullscreen")request("ui/request-display-mode",{mode:"inline"})});
on(window,"load",reportSize);if(typeof ResizeObserver==="function")new ResizeObserver(reportSize).observe(document.body);setTimeout(reportSize,50);setTimeout(reportSize,500);reportSize()})();`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function variablesBlock(theme: WidgetTheme): string {
  const values = { ...SHARED_TOKENS, ...DEFAULT_TOKENS[theme.mode] };
  for (const token of WIDGET_TOKENS) {
    const value = widgetTokenValue(theme.tokens[token]);
    if (value) values[token] = value;
  }
  return Object.entries(values).map(([token, value]) => `--${token}:${value};`).join("");
}

export type WidgetDocument = {
  html: string;
  /** Line of the composed document on which the fragment starts, so errors in
   * inline widget scripts can be reported against the agent's own code. */
  fragmentLine: number;
};

/** Wraps a validated fragment, once, in the canonical document. */
export function buildWidgetDocument(options: { title: string; code: string; theme: WidgetTheme }): WidgetDocument {
  const svg = widgetMode(options.code) === "svg";
  const prefix = `<!doctype html>
<html lang="en" data-display-mode="inline"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(widgetContentSecurityPolicy())}"><title>${escapeHtml(options.title)}</title>
<style>:root{color-scheme:${options.theme.mode};${variablesBlock(options.theme)}
${BASE_STYLES}</style></head><body><script>${BRIDGES}</script>
${svg ? "<div class=\"svg-widget\">" : ""}`;
  const suffix = `${svg ? "</div>" : ""}\n</body></html>`;
  return { html: `${prefix}${options.code}${suffix}`, fragmentLine: prefix.split("\n").length };
}

type ToolCall = { name: string; args?: unknown; details?: unknown; output?: string; status?: "running" | "succeeded" | "failed" };

/** What the chat shows for one `show_widget` call. The code is the call's own
 * argument, rendered only once the gateway accepted it (`details.widget`). */
export type WidgetView =
  | { state: "pending"; title: string }
  | { state: "ready"; title: string; code: string }
  | { state: "failed"; title: string; error: string }
  | { state: "unavailable"; title: string };

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const encoder = new TextEncoder();

function widgetTitle(call: ToolCall): string {
  for (const value of [objectValue(objectValue(call.details)?.["widget"])?.["title"], objectValue(call.args)?.["title"]]) {
    if (typeof value === "string" && value.trim()) return [...value.trim()].slice(0, WIDGET_TITLE_MAX_LENGTH).join("");
  }
  return "Widget";
}

export function widgetView(call: ToolCall): WidgetView | undefined {
  if (call.name !== "show_widget") return undefined;
  const title = widgetTitle(call);
  const status = call.status ?? "running";
  if (status === "running") return { state: "pending", title };
  if (status === "failed") return { state: "failed", title, error: call.output?.trim() || "The widget was rejected." };
  const code = objectValue(call.args)?.["widget_code"];
  const accepted = objectValue(objectValue(call.details)?.["widget"]);
  if (!accepted || typeof code !== "string" || !code.trim() || encoder.encode(code).byteLength > WIDGET_CODE_MAX_BYTES || isCompleteHtmlDocument(code)) {
    return { state: "unavailable", title };
  }
  return { state: "ready", title, code };
}

/** HUI's current theme as widget tokens, read from the document root. */
export function currentWidgetTheme(root: HTMLElement = document.documentElement): WidgetTheme {
  const style = getComputedStyle(root);
  const tokens: WidgetTheme["tokens"] = {};
  for (const token of WIDGET_TOKENS) {
    const value = widgetTokenValue(style.getPropertyValue(WIDGET_THEME_TOKENS[token]));
    if (value) tokens[token] = value;
  }
  return { mode: root.dataset["themeMode"] === "light" ? "light" : "dark", tokens };
}

/** MCP Apps' `ui/notifications/host-context-changed` with HUI's tokens. */
export function widgetHostContext(theme: WidgetTheme, displayMode: "inline" | "fullscreen") {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: {
      theme: theme.mode,
      displayMode,
      styles: { variables: Object.fromEntries(Object.entries(theme.tokens).map(([token, value]) => [`--${token}`, value])) },
    },
  } as const;
}

export type WidgetError = { message: string; source?: string; line?: number; column?: number };

export type WidgetFrameMessage =
  | { kind: "proxy-ready" }
  | { kind: "loaded"; renderId: string }
  | { kind: "navigated"; renderId: string }
  | { kind: "size"; height: number }
  | ({ kind: "error" } & WidgetError)
  | { kind: "open-link"; id?: string | number; url: string }
  | { kind: "display-mode"; id?: string | number; mode: "inline" | "fullscreen" };

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < 10_000_000 ? value : undefined;

/** Validates one message from a widget's sandbox page. Anything else is ignored. */
export function parseWidgetFrameMessage(data: unknown): WidgetFrameMessage | undefined {
  const message = objectValue(data);
  if (!message || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") return undefined;
  const params = objectValue(message["params"]) ?? {};
  const rawId = message["id"];
  const id = (typeof rawId === "string" && rawId.length <= 100) || (typeof rawId === "number" && Number.isFinite(rawId)) ? { id: rawId } : {};
  const renderId = typeof params["renderId"] === "string" ? params["renderId"] : undefined;
  switch (message["method"]) {
    case `${WIDGET_SANDBOX_METHOD_PREFIX}proxy-ready`:
      return { kind: "proxy-ready" };
    case `${WIDGET_SANDBOX_METHOD_PREFIX}resource-loaded`:
      return renderId ? { kind: "loaded", renderId } : undefined;
    case `${WIDGET_SANDBOX_METHOD_PREFIX}resource-navigated`:
      return renderId ? { kind: "navigated", renderId } : undefined;
    case "ui/notifications/size-changed": {
      const height = params["height"];
      return typeof height === "number" && Number.isFinite(height) && height > 0 ? { kind: "size", height } : undefined;
    }
    case "notifications/message": {
      const detail = objectValue(params["data"]) ?? {};
      const text = typeof detail["message"] === "string" ? detail["message"].replace(/\s+/gu, " ").trim().slice(0, 500) : "";
      if (params["level"] !== "error" || !text) return undefined;
      const source = typeof detail["source"] === "string" && detail["source"] ? detail["source"].slice(0, 200) : undefined;
      const line = positiveInteger(detail["line"]);
      const column = positiveInteger(detail["column"]);
      return { kind: "error", message: text, ...(source ? { source } : {}), ...(line ? { line } : {}), ...(column ? { column } : {}) };
    }
    case "ui/open-link":
      return typeof params["url"] === "string" ? { kind: "open-link", ...id, url: params["url"] } : undefined;
    case "ui/request-display-mode":
      return params["mode"] === "inline" || params["mode"] === "fullscreen" ? { kind: "display-mode", ...id, mode: params["mode"] } : undefined;
    default:
      return undefined;
  }
}

export const clampWidgetHeight = (height: number): number =>
  Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, Math.ceil(height)));

/** An http(s) URL, without credentials, that a widget may ask to open in a new tab. */
export function openableWidgetUrl(raw: string): string | undefined {
  if (raw.length > 2_048) return undefined;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A notice line. Inline-script lines count from the agent's own fragment,
 * which starts on `fragmentLine` of the composed document. */
export function widgetErrorText(error: WidgetError, fragmentLine: number): string {
  const inline = error.source === "widget";
  const line = error.line === undefined ? undefined : inline ? error.line - fragmentLine + 1 : error.line;
  const place = [
    ...(error.source && !inline ? [error.source] : []),
    ...(line !== undefined && line > 0 ? [`line ${line}`] : []),
    ...(line !== undefined && line > 0 && error.column ? [`column ${error.column}`] : []),
  ];
  return place.length ? `${error.message} (${place.join(", ")})` : error.message;
}
