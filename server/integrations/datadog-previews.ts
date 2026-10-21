/** Datadog previews for chat cards.
 *
 * Share links are public pages: the gateway reads their Open Graph title and image directly, from the public
 * Datadog app hosts or a configured org's own site only. Dashboard links go through the operator's pup sessions
 * (`datadog.ts`): the orgs configured for the link's host are tried in order until one can read the dashboard, and
 * a widget link then asks Datadog for a graph snapshot of that widget with the link's time range and template
 * variables, and waits for the image. Images reach the browser as data URLs; snapshot URLs and pup output never
 * do. Results are cached in gateway memory with result-dependent lifetimes; concurrent requests for one link share
 * a lookup, and a lookup never rejects. `HUI_DATADOG_TEST_ORIGIN` admits one exact extra origin, so E2E and the demo
 * videos can serve pages and graphs from a local fixture (as `HUI_JIRA_TEST_ORIGIN` does for Jira).
 */
import { DATADOG_APP_HOSTS, isDatadogHost, parseDatadogUrl } from "./datadog-links.ts";
import type { DatadogOrg, DatadogPreview, DatadogPreviewError, DatadogPreviewResult } from "../api/datadog.ts";
import type { DatadogRef } from "./datadog-links.ts";
import { PupError, type DatadogOrgs } from "./datadog.ts";

const HOUR = 3_600_000;
const PAGE_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const MAX_TITLE = 300;
const MAX_DETAIL = 400;
/** Snapshot polling: how often, and how long before the card goes without image. */
const POLL_MS = 500;
const POLL_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
const MAX_ENTRIES = 100;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** Widgets that are not graphs; the snapshot API has nothing to draw for them. */
const NO_GRAPH = new Set(["note", "free_text", "image", "iframe", "group", "powerpack"]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PreviewOrgs = Pick<DatadogOrgs, "orgsFor" | "run" | "refresh" | "signedOut">;
export type PreviewFetch = (url: string, init: RequestInit) => Promise<Response>;

export type DatadogPreviewOptions = {
  fetch?: PreviewFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** A whole lookup's budget; the browser waits 40 s for the batch. */
  deadlineMs?: number;
  /** One exact origin fetched besides Datadog's HTTPS hosts, for local fixtures. */
  testOrigin?: string;
};

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown, limit = MAX_TITLE) => typeof value === "string" ? value.trim().slice(0, limit) : "";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/** `og:*` properties of an HTML page, in either attribute order. */
export function openGraph(html: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const [tag] of html.slice(0, PAGE_LIMIT).matchAll(/<meta\b[^>]*>/giu)) {
    const attribute = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "iu").exec(tag);
    const property = attribute("property");
    const content = attribute("content");
    const key = (property?.[2] ?? property?.[3] ?? "").toLowerCase();
    if (key.startsWith("og:") && content && !(key in properties)) properties[key] = decodeEntities(content[2] ?? content[3] ?? "").trim();
  }
  return properties;
}

/** The MIME type an image's first bytes prove, so a page cannot pass SVG or HTML off as a picture. */
export function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(PNG)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export type TemplateVariable = { name: string; prefix: string; values: string[] };

/** A dashboard's template variables with their values: the link's `tpl_var_<name>` / `tpl_var_<name>[i]`, else the
 * dashboard's `defaults`, else its legacy `default`. */
export function templateVariables(raw: unknown, params: URLSearchParams): TemplateVariable[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const item = record(entry);
    const name = str(item["name"], 100);
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) return [];
    const linked = [...params.entries()]
      .filter(([key]) => key === `tpl_var_${name}` || (key.startsWith(`tpl_var_${name}[`) && /^\[\d+\]$/u.test(key.slice(`tpl_var_${name}`.length))))
      .map(([, value]) => value.trim());
    const listed = Array.isArray(item["defaults"]) ? item["defaults"].filter((value): value is string => typeof value === "string") : [];
    const defaults = listed.length ? listed : typeof item["default"] === "string" ? [item["default"]] : [];
    return [{ name, prefix: str(item["prefix"], 200), values: (linked.length ? linked : defaults).map((value) => value.trim()).filter(Boolean) }];
  });
}

/** Template variables replaced in every string of a widget definition (never in raw JSON text). `$name` becomes
 * `prefix:value`, `(prefix:a OR prefix:b)` or `*`; `$name.value` the first value or `*`. Longer names win, and a
 * name ends at a character that cannot continue it, so `$env` never eats `$environment`. */
export function substituteTemplateVariables<T>(value: T, variables: readonly TemplateVariable[]): T {
  if (!variables.length) return value;
  const byName = new Map(variables.map((variable) => [variable.name, variable]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\-]/gu, "\\$&"));
  const pattern = new RegExp(`\\$(${names.join("|")})(\\.value)?(?![A-Za-z0-9_-])`, "gu");
  const replace = (text: string) => text.replace(pattern, (_match, name: string, dotValue: string | undefined) => {
    const variable = byName.get(name)!;
    if (!variable.values.length || variable.values.includes("*")) return "*";
    if (dotValue) return variable.values[0]!;
    const terms = variable.values.map((item) => variable.prefix ? `${variable.prefix}:${item}` : item);
    return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
  });
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return replace(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    return node;
  };
  return walk(value) as T;
}

/** A widget link's time range in epoch milliseconds: the full-screen range for full-screen links, else the
 * dashboard's, used as-is so the card shows what the sender saw; the past hour when the link has none. */
export function timeRange(url: URL, now: number): { from: number; to: number; relative: boolean } {
  const read = (name: string) => {
    const value = Number(url.searchParams.get(name) ?? "");
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const fullscreen = url.searchParams.has("fullscreen_widget");
  const from = (fullscreen ? read("fullscreen_start_ts") : undefined) ?? read("from_ts");
  const to = (fullscreen ? read("fullscreen_end_ts") : undefined) ?? read("to_ts");
  return from !== undefined && to !== undefined && to > from ? { from, to, relative: false } : { from: now - HOUR, to: now, relative: true };
}

/** The widget with `id`, looking inside groups. */
export function findWidget(widgets: unknown, id: string): Record<string, unknown> | undefined {
  if (!Array.isArray(widgets)) return undefined;
  for (const entry of widgets) {
    const widget = record(entry);
    if (String(widget["id"]) === id) return widget;
    const nested = findWidget(record(widget["definition"])["widgets"], id);
    if (nested) return nested;
  }
  return undefined;
}

/** Lifetime of a result: fixed snapshots slowly, the moving past hour sooner, failures by how soon a retry helps. */
export function previewTtlMs(result: DatadogPreviewResult): number {
  if (!result.preview) {
    if (result.error === "not_found") return 5 * 60_000;
    if (result.error === "unavailable") return 60_000;
    return 15_000; // signed_out, no_org and cli_missing clear soon after the operator fixes them
  }
  // A widget Datadog did not draw may draw later (a rate limit, a slow render), so it is asked again sooner.
  if (result.preview.relative || (result.preview.kind === "widget" && !result.preview.image)) return 5 * 60_000;
  return HOUR;
}

type CacheEntry = { expires: number; bytes: number; result: Promise<DatadogPreviewResult> };
type Fetched = { status: number; body: Buffer };

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Datadog answered with more data than HUI accepts.");
    }
    chunks.push(value);
  }
}

export class DatadogPreviews {
  readonly #orgs: PreviewOrgs;
  readonly #fetch: PreviewFetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #deadlineMs: number;
  readonly #testOrigin: string | undefined;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #waiting: (() => void)[] = [];
  #running = 0;

  constructor(orgs: PreviewOrgs, options: DatadogPreviewOptions = {}) {
    this.#orgs = orgs;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#deadlineMs = options.deadlineMs ?? 25_000;
    const testOrigin = options.testOrigin ?? process.env["HUI_DATADOG_TEST_ORIGIN"];
    this.#testOrigin = testOrigin ? new URL(testOrigin).origin : undefined;
  }

  /** Preview for a Datadog link. Never rejects; a link HUI does not preview is `not_found`. */
  lookup(url: string): Promise<DatadogPreviewResult> {
    const ref = parseDatadogUrl(url);
    if (!ref) return Promise.resolve({ url, error: "not_found" });
    const cached = this.#cache.get(url);
    if (cached && cached.expires > this.#now()) return cached.result;
    const entry: CacheEntry = { expires: Number.POSITIVE_INFINITY, bytes: 0, result: this.#withDeadline(ref) };
    this.#cache.delete(url);
    this.#cache.set(url, entry);
    void entry.result.then((result) => {
      entry.expires = this.#now() + previewTtlMs(result);
      entry.bytes = result.preview?.image?.length ?? 0;
      this.#evict();
    });
    this.#evict();
    return entry.result;
  }

  /** Forgets every result, after a sign-in or an org change: failures may now succeed, and a removed org's
   * previews must not linger. */
  clear(): void {
    this.#cache.clear();
  }

  #evict(): void {
    let bytes = 0;
    for (const entry of this.#cache.values()) bytes += entry.bytes;
    for (const [key, entry] of this.#cache) {
      if (this.#cache.size <= MAX_ENTRIES && bytes <= MAX_CACHE_BYTES) return;
      this.#cache.delete(key);
      bytes -= entry.bytes;
    }
  }

  async #withDeadline(ref: DatadogRef): Promise<DatadogPreviewResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<DatadogPreviewResult>((resolve) => {
      timer = setTimeout(() => resolve({ url: ref.url, error: "unavailable" }), this.#deadlineMs);
    });
    try {
      return await Promise.race([this.#resolve(ref), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #resolve(ref: DatadogRef): Promise<DatadogPreviewResult> {
    try {
      return ref.kind === "share" ? await this.#share(ref) : await this.#dashboard(ref);
    } catch {
      return { url: ref.url, error: "unavailable" };
    }
  }

  async #share(ref: Extract<DatadogRef, { kind: "share" }>): Promise<DatadogPreviewResult> {
    const failed = (error: DatadogPreviewError): DatadogPreviewResult => ({ url: ref.url, error });
    const trusted = new Set<string>([...DATADOG_APP_HOSTS, ...(await this.#orgs.orgsFor(ref.host)).map((org) => org.site)]);
    if (!trusted.has(ref.host)) return failed("no_org");
    const page = new URL(ref.url);
    const response = await this.#get(`https://${ref.host}${page.pathname}`, PAGE_LIMIT, (host) => trusted.has(host));
    if (response.status === 404 || response.status === 410) return failed("not_found");
    if (response.status !== 200) return failed("unavailable");
    const meta = openGraph(response.body.toString("utf8"));
    const title = (meta["og:title"] ?? "").slice(0, MAX_TITLE);
    if (!title) return failed("not_found");
    const image = meta["og:image"] ? await this.#image(meta["og:image"]) : undefined;
    return { url: ref.url, preview: { kind: "share", url: ref.url, title, ...(image ? { image } : {}) } };
  }

  async #dashboard(ref: Extract<DatadogRef, { kind: "dashboard" }>): Promise<DatadogPreviewResult> {
    const candidates = await this.#orgs.orgsFor(ref.host);
    if (!candidates.length) return { url: ref.url, error: "no_org" };
    let signedOut: DatadogOrg | undefined;
    let unavailable = false;
    for (const org of candidates) {
      let dashboard: Record<string, unknown>;
      try {
        dashboard = record(await this.#pup(["dashboards", "get", ref.dashboardId], org));
      } catch (error) {
        const reason = error instanceof PupError ? error.reason : "unavailable";
        if (reason === "cli_missing") return { url: ref.url, error: "cli_missing" };
        if (reason === "signed_out") {
          this.#orgs.signedOut(org, true);
          signedOut ??= org;
        } else if (reason === "unavailable") {
          unavailable = true;
        }
        continue; // not_found and forbidden: the dashboard lives in another org
      }
      this.#orgs.signedOut(org, false);
      return { url: ref.url, preview: await this.#describe(ref, dashboard, org) };
    }
    if (signedOut) return { url: ref.url, error: "signed_out", signIn: signedOut };
    return { url: ref.url, error: unavailable ? "unavailable" : "not_found" };
  }

  async #describe(ref: Extract<DatadogRef, { kind: "dashboard" }>, dashboard: Record<string, unknown>, org: DatadogOrg): Promise<DatadogPreview> {
    const title = str(dashboard["title"]) || ref.dashboardId;
    const widget = ref.widgetId ? findWidget(dashboard["widgets"], ref.widgetId) : undefined;
    if (!widget) {
      const description = str(dashboard["description"], MAX_DETAIL);
      return { kind: "dashboard", url: ref.url, title, org: org.name, ...(description ? { detail: description } : {}) };
    }
    const url = new URL(ref.url);
    const definition = substituteTemplateVariables(record(widget["definition"]), templateVariables(dashboard["template_variables"], url.searchParams));
    const range = timeRange(url, this.#now());
    const image = NO_GRAPH.has(str(definition["type"])) ? undefined : await this.#snapshot(definition, range, org);
    return {
      kind: "widget",
      url: ref.url,
      title: str(definition["title"]) || title,
      detail: title,
      org: org.name,
      from: range.from,
      to: range.to,
      ...(range.relative ? { relative: true } : {}),
      ...(image ? { image } : {}),
    };
  }

  /** A graph snapshot of one widget definition, or undefined when Datadog cannot draw it in time. */
  async #snapshot(definition: Record<string, unknown>, range: { from: number; to: number }, org: DatadogOrg): Promise<string | undefined> {
    let snapshotUrl: string;
    try {
      const answer = record(await this.#pup([
        "api", "v1/graph/snapshot",
        "-f", `graph_def=${JSON.stringify(definition)}`,
        "-F", `start=${Math.floor(range.from / 1000)}`,
        "-F", `end=${Math.ceil(range.to / 1000)}`,
      ], org));
      snapshotUrl = str(answer["snapshot_url"], 2_000);
    } catch {
      return undefined; // a missing scope (403) or a definition the API refuses: the card goes without image
    }
    if (!snapshotUrl) return undefined;
    const deadline = this.#now() + POLL_TIMEOUT_MS;
    for (;;) {
      const response = await this.#get(snapshotUrl, IMAGE_LIMIT, isDatadogHost).catch(() => undefined);
      if (response?.status !== 200) return undefined;
      const type = imageType(response.body);
      if (type) return `data:${type};base64,${response.body.toString("base64")}`;
      let status: unknown;
      try { status = record(record(record(JSON.parse(response.body.toString("utf8")))["data"])["attributes"])["status"]; } catch { status = undefined; }
      if (status !== "pending" || this.#now() >= deadline) return undefined;
      await this.#sleep(POLL_MS);
    }
  }

  async #image(raw: string): Promise<string | undefined> {
    const response = await this.#get(raw, IMAGE_LIMIT, isDatadogHost).catch(() => undefined);
    const type = response?.status === 200 ? imageType(response.body) : undefined;
    return type && response ? `data:${type};base64,${response.body.toString("base64")}` : undefined;
  }

  /** A GET to an allowed HTTPS host, following at most two redirects that stay allowed, reading at most `limit`. */
  async #get(raw: string, limit: number, allowed: (host: string) => boolean): Promise<Fetched> {
    let target = raw;
    for (let hop = 0; hop <= 2; hop += 1) {
      const url = new URL(target);
      const fixture = url.origin === this.#testOrigin;
      if (!fixture && (url.protocol !== "https:" || url.username || url.password || url.port || !allowed(url.hostname.toLowerCase()))) {
        throw new Error("Datadog link points outside Datadog.");
      }
      const response = await this.#fetch(url.href, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("Datadog redirected without a location.");
        target = new URL(location, url).href;
        continue;
      }
      return { status: response.status, body: await readBounded(response, limit) };
    }
    throw new Error("Datadog redirected too often.");
  }

  /** One pup call under the concurrency limit; an expired token gets one `pup auth refresh` and one retry. */
  async #pup(args: string[], org: DatadogOrg): Promise<unknown> {
    try {
      return await this.#call(args, org);
    } catch (error) {
      if (!(error instanceof PupError) || error.reason !== "expired") throw error;
      if (!(await this.#orgs.refresh(org))) throw new PupError("signed_out");
      try {
        return await this.#call(args, org);
      } catch (retry) {
        throw retry instanceof PupError && retry.reason === "expired" ? new PupError("signed_out") : retry;
      }
    }
  }

  async #call(args: string[], org: DatadogOrg): Promise<unknown> {
    // A finished call hands its slot straight to the next waiter, so calls run in arrival order.
    if (this.#running >= CONCURRENCY) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    else this.#running += 1;
    try {
      return await this.#orgs.run(args, org);
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running -= 1;
    }
  }
}
