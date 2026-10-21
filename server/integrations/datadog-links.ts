/** Parses Datadog links and normalizes sites for the gateway's orgs and previews. */

/** Like GitHub's, at most this many Datadog cards per message. */
export const MAX_DATADOG_EMBEDS = 3;

/** Domains Datadog serves its app from. A host is Datadog's when it is one of these or ends in `.<domain>`. */
export const DATADOG_DOMAINS = ["datadoghq.com", "datadoghq.eu", "datad0g.com", "ddog-gov.com"] as const;

/** The public Datadog app hosts. Share pages are read from these, or from a configured org's own site. */
export const DATADOG_APP_HOSTS = [
  "app.datadoghq.com", "app.datadoghq.eu", "us3.datadoghq.com", "us5.datadoghq.com", "ap1.datadoghq.com",
  "ap2.datadoghq.com", "app.ddog-gov.com", "us2.ddog-gov.com", "app.datad0g.com", "dd.datad0g.com",
] as const;

export const DEFAULT_DATADOG_SITE = "app.datadoghq.com";

export type DatadogRef =
  /** `/s/<a>/<b>`: a share link, public. */
  | { kind: "share"; url: string; host: string }
  /** `/dashboard/<id>`, focused on one widget when the link has `tile_focus` or `fullscreen_widget`. */
  | { kind: "dashboard"; url: string; host: string; dashboardId: string; widgetId?: string };

export const DATADOG_CLI_REQUIRED = "The Datadog CLI (pup) is required. Install it on the machine that runs HUI and make sure `pup` is on the gateway's PATH.";

const SHARE_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/u;
const DASHBOARD_ID = /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/u;
/** Digits only; `parseDatadogUrl` also drops ids past `Number.MAX_SAFE_INTEGER`, which lose precision once pup's JSON
 * is parsed and so could never match a widget. */
const WIDGET_ID = /^\d+$/u;

export function isDatadogHost(host: string): boolean {
  const name = host.toLowerCase();
  return DATADOG_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** The site `pup` expects for a Datadog host: `app.<site>` drops `app.`; other hosts (us3…, vanity hosts) stay. */
export function pupSite(host: string): string {
  return host.startsWith("app.") ? host.slice(4) : host;
}

/** A host or URL typed for an org, as the lowercase Datadog host its links use; `undefined` when it is not one.
 * Empty means the default site; a bare domain (`datadoghq.com`) means its `app.` host. */
export function normalizeDatadogSite(raw: unknown): string | undefined {
  if (raw !== undefined && raw !== null && typeof raw !== "string") return undefined;
  const text = raw?.trim() ?? "";
  if (!text) return DEFAULT_DATADOG_SITE;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(text) ? text : `https://${text}`); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const host = url.hostname.toLowerCase();
  if (!isDatadogHost(host)) return undefined;
  return (DATADOG_DOMAINS as readonly string[]).includes(host) ? `app.${host}` : host;
}

/** Parses a Datadog share link or dashboard link. Other Datadog pages and other hosts return undefined. */
export function parseDatadogUrl(raw: string): DatadogRef | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const host = url.hostname.toLowerCase();
  if (!isDatadogHost(host)) return undefined;
  const [section, first = "", second = "", ...rest] = url.pathname.split("/").filter(Boolean);
  if (section === "s" && !rest.length && SHARE_SEGMENT.test(first) && SHARE_SEGMENT.test(second)) {
    return { kind: "share", url: raw, host };
  }
  if (section === "dashboard" && DASHBOARD_ID.test(first)) {
    const widgetId = url.searchParams.get("tile_focus") ?? url.searchParams.get("fullscreen_widget") ?? "";
    const usable = WIDGET_ID.test(widgetId) && Number.isSafeInteger(Number(widgetId));
    return { kind: "dashboard", url: raw, host, dashboardId: first, ...(usable ? { widgetId } : {}) };
  }
  return undefined;
}
