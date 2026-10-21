/**
 * Triggers' one source (HUI-18): a program the operator runs outside HUI, a listener, watches something HUI doesn't
 * read itself (a work Slack through its MCP server, a Jira board, a repo) and, after every check, reports what it found
 * to its trigger's URL, `POST /__hui/hooks/<token>`:
 *
 *   { "events": [{ "id", "summary", "details"?, "at"?, "links"?, "fields"?, "bot"?, "external"? }], "error"?, "catchUp"? }
 *
 * Each trigger has its own random token, shown once when it is made (or replaced) and stored only as its SHA-256. The
 * route takes no `x-hui` header, since its callers are other programs; the token is the credential. The gateway stays
 * on the tailnet: the route answers only callers on this machine (loopback, which is also how `tailscale serve` reaches
 * a loopback gateway) or on Tailscale's own addresses, and the gateway's Host check applies as on every route.
 * Exposing it to the internet (Tailscale Funnel) is the operator's choice, never HUI's.
 *
 * An empty `events` is a check-in: no delivery, no turn. The service wakes the bot once per event id (it remembers the
 * ids with the delivery it decides), never for an event older than the trigger, and only for what the trigger's filter
 * passes; the GitHub pull requests an event links to are read as its delivery goes out. The listener keeps its own
 * place in what it watches: a report HUI refuses (409) is its cue to send those events again later.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIPv4, isIPv6 } from "node:net";

import { BOT_TRIGGER_HOOK_PREFIX, BOT_TRIGGER_LIMITS, type BotTriggerFilter, type TriggerMatch } from "./triggers-format.ts";
import { parseGitHubUrl } from "../integrations/github-links.ts";
import { refuseUnknown, TriggerInputError } from "./triggers-input.ts";

/* ── the URL ────────────────────────────────────────────────────────── */

/** `/__hui/hooks/<token>`: base64url, as `newHookToken` makes them (43 characters), within bounds for older ones. */
export const HOOK_ROUTE = /^\/__hui\/hooks\/([A-Za-z0-9_-]{20,128})$/u;
/** Anything under the prefix, so a malformed token is a 404 of this route, not of the API's guard. */
export const isHookPath = (path: string): boolean => path.startsWith(BOT_TRIGGER_HOOK_PREFIX);

export type HookToken = { token: string; hash: string; hint: string };

/** 32 random bytes, base64url: the token, its SHA-256 (what is stored) and its first four characters (what is shown). */
export function newHookToken(): HookToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashHookToken(token), hint: token.slice(0, 4) };
}

export function hashHookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two SHA-256 hex digests. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

/** Loopback (127.0.0.0/8, ::1) or Tailscale's addresses (100.64.0.0/10, fd7a:115c:a1e0::/48). */
export function isTailnetOrLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/u, "");
  if (isIPv4(value)) {
    const [a, b] = value.split(".").map(Number) as [number, number];
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIPv6(value)) return value === "::1" || value.startsWith("fd7a:115c:a1e0:");
  return false;
}

/** A body the route refuses: too large (413) or unreadable (400). */
export class HookBodyError extends Error {
  readonly status: 400 | 413;
  constructor(message: string, status: 400 | 413) {
    super(message);
    this.name = "HookBodyError";
    this.status = status;
  }
}

/** A report's body, at most `maxBytes`, parsed: a listener sends JSON (`application/json`, `…+json`). */
export async function readHookBody(request: IncomingMessage, maxBytes: number = BOT_TRIGGER_LIMITS.body): Promise<unknown> {
  const type = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json" && !type.endsWith("+json")) {
    throw new HookBodyError("A listener reports JSON (Content-Type: application/json): { \"events\": [...] }, the list empty when nothing happened.", 400);
  }
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HookBodyError(`The body is larger than ${maxBytes / 1024} KiB.`, 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new HookBodyError(`The body is larger than ${maxBytes / 1024} KiB.`, 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HookBodyError("The body says it is JSON but isn't.", 400);
  }
}

/** The value at a dot path (`fields.channel`, `links.0`); undefined when the path leads nowhere. */
function fieldAt(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/u.test(key)) current = current[Number(key)];
    else if (typeof current === "object" && current !== null && !Array.isArray(current) && Object.hasOwn(current, key)) current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return current;
}

const scalar = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : value === null ? "null" : undefined;

/** Whether a value passes a match: what is at `field` (`""`, the whole value) equals `value`, or contains it. */
function matchesJson(match: TriggerMatch, value: unknown): boolean {
  const target = match.field ? fieldAt(value, match.field) : value;
  if (target === undefined) return false;
  if (match.op === "equals") return scalar(target) === match.value;
  if (typeof target === "string") return target.includes(match.value);
  if (Array.isArray(target)) return target.some((item) => scalar(item) === match.value);
  return !match.field && JSON.stringify(target).includes(match.value);
}

/** Whitespace runs as one space, cut to `max` characters with an ellipsis. */
export const oneLine = (value: string, max: number) => {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

/* ── the report ─────────────────────────────────────────────────────── */

/** A listener that hasn't reported for this long is said to be silent, on its trigger. */
export const LISTENER_SILENT_MS = 5 * 60_000;

/** One event as HUI keeps it: what it matches a filter against and delivers. */
export type ListenerEvent = {
  id: string;
  /** One line. */
  summary: string;
  details: string;
  at: string;
  /** The GitHub pull requests among its links, canonical, each once, `BOT_TRIGGER_LIMITS.links` at most. */
  links: string[];
  fields: Record<string, unknown>;
  bot: boolean;
  external: boolean;
};

export type ListenerReport = { events: ListenerEvent[]; error?: string; catchUp: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const CONTROL = /\p{Cc}/u;
const FIELD_NAME = /^[A-Za-z0-9_$-]{1,64}$/u;
const refused = (message: string) => new TriggerInputError(message);
/** Control characters (a terminal's escapes among them) and bidirectional overrides, which only disguise text: what a
 * listener relays reaches the bot's chat, the UI and `hui bot trigger list`. Lines and tabs stay in details. */
const plain = (value: string, keepLines = false) => value
  .replace(keepLines ? /[^\P{Cc}\n\t]/gu : /\p{Cc}/gu, keepLines ? "" : " ")
  .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
/** A value a field may hold: text a match can compare, a number, a boolean or null. */
const fieldValue = (value: unknown) => value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= BOT_TRIGGER_LIMITS.match);

/** The GitHub pull requests among an event's links. */
function pullRequests(links: readonly string[]): string[] {
  const found: string[] = [];
  for (const link of links) {
    const ref = parseGitHubUrl(link.trim());
    if (ref?.kind === "pull" && !found.includes(ref.url)) found.push(ref.url);
  }
  return found.slice(0, BOT_TRIGGER_LIMITS.links);
}

function eventOf(raw: unknown, where: string, now: number): ListenerEvent {
  if (!isRecord(raw)) throw refused(`${where} must be an object: { id, summary, details?, at?, links?, fields?, bot?, external? }.`);
  refuseUnknown(raw, ["id", "summary", "details", "at", "links", "fields", "bot", "external"], where);
  const id = raw["id"];
  if (typeof id !== "string" || !id.trim() || id.length > 200 || CONTROL.test(id)) {
    throw refused(`${where}.id must be 1-200 characters on one line: the event's own id, so a report sent again never wakes the bot twice.`);
  }
  const summary = typeof raw["summary"] === "string" ? oneLine(plain(raw["summary"]), 160) : "";
  if (!summary) throw refused(`${where}.summary must be text: one line that says what happened.`);
  if (raw["details"] !== undefined && typeof raw["details"] !== "string") throw refused(`${where}.details must be text.`);
  const details = plain((raw["details"] ?? "").replace(/\r\n?/gu, "\n"), true).trim();
  const time = raw["at"] === undefined ? now : typeof raw["at"] === "string" ? Date.parse(raw["at"]) : Number.NaN;
  if (!Number.isFinite(time)) throw refused(`${where}.at must be an ISO 8601 time, such as 2026-10-08T09:30:00Z.`);
  const links = raw["links"] ?? [];
  if (!Array.isArray(links) || links.length > BOT_TRIGGER_LIMITS.values || !links.every((link) => typeof link === "string" && link.length <= 2_000)) {
    throw refused(`${where}.links must be a list of at most ${BOT_TRIGGER_LIMITS.values} URLs.`);
  }
  const fields = raw["fields"] ?? {};
  if (!isRecord(fields) || Object.keys(fields).length > BOT_TRIGGER_LIMITS.values) throw refused(`${where}.fields must be an object of at most ${BOT_TRIGGER_LIMITS.values} fields.`);
  for (const [name, value] of Object.entries(fields)) {
    if (!FIELD_NAME.test(name) || !(fieldValue(value) || (Array.isArray(value) && value.length <= BOT_TRIGGER_LIMITS.values && value.every(fieldValue)))) {
      throw refused(`${where}.fields.${name.slice(0, 64)} must be text (${BOT_TRIGGER_LIMITS.match} characters at most), a number, true, false or null, or a list of at most ${BOT_TRIGGER_LIMITS.values} of them.`);
    }
  }
  for (const flag of ["bot", "external"]) if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") throw refused(`${where}.${flag} must be true or false.`);
  return {
    id, summary,
    details: details.length > BOT_TRIGGER_LIMITS.details ? `${details.slice(0, BOT_TRIGGER_LIMITS.details - 2).trimEnd()}\n…` : details,
    at: new Date(time).toISOString(),
    links: pullRequests(links), fields,
    bot: raw["bot"] === true, external: raw["external"] === true,
  };
}

/** A listener's report, checked; what to fix when it isn't one (`TriggerInputError`, a 400). An id the report repeats
 * counts once. */
export function parseListenerReport(value: unknown, now: number): ListenerReport {
  if (!isRecord(value)) throw refused("A report is { \"events\": [...] }, the list empty when nothing happened.");
  refuseUnknown(value, ["events", "error", "catchUp"], "report");
  const raw = value["events"];
  if (!Array.isArray(raw) || raw.length > BOT_TRIGGER_LIMITS.events) {
    throw refused(`events must be a list of at most ${BOT_TRIGGER_LIMITS.events} events, empty when nothing happened; send more in several reports.`);
  }
  if (value["error"] !== undefined && typeof value["error"] !== "string") throw refused("error must be text: the listener's own problem, which its trigger shows.");
  if (value["catchUp"] !== undefined && typeof value["catchUp"] !== "boolean") throw refused("catchUp must be true or false.");
  const events: ListenerEvent[] = [];
  raw.forEach((item, index) => {
    const event = eventOf(item, `events[${index}]`, now);
    if (!events.some((each) => each.id === event.id)) events.push(event);
  });
  const error = oneLine(plain(value["error"] ?? ""), 300);
  return { events, ...(error ? { error } : {}), catchUp: value["catchUp"] === true };
}

/** Whether an event passes a listener trigger's filter and is no older than the trigger (`since`). */
export function listenerMatches(filter: BotTriggerFilter, event: ListenerEvent, since?: string): boolean {
  if (since && Date.parse(event.at) < Date.parse(since)) return false;
  if (event.bot && !filter.bots) return false;
  if (event.external && !filter.external) return false;
  if (filter.prLinks && !event.links.length) return false;
  return !filter.match || matchesJson(filter.match, event);
}
