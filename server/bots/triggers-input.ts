/**
 * Triggers' input and stored shape (HUI-18): what `POST`/`PATCH /__hui/bots/:id/triggers` and `bot-triggers.json` may
 * hold, checked at the gateway's boundary. Input that does not validate is refused with what to fix (400); a stored
 * record that does not validate (one of a source HUI no longer has among them, which `hui doctor` reports) is kept
 * aside in the file, untouched, and not used.
 */
import {
  BOT_TRIGGER_LIMITS, BOT_TRIGGER_SOURCES,
  type BotTriggerFilter, type BotTriggerInput, type BotTriggerPatch, type BotTriggerRecord, type BotTriggerSource, type TriggerMatch,
} from "./triggers-format.ts";

/** Rejected input (400), with what to fix. */
export class TriggerInputError extends Error {
  override name = "TriggerInputError";
}

/** No such trigger for that bot (404). */
export class TriggerNotFoundError extends Error {
  override name = "TriggerNotFoundError";
}

/** Valid, but refused now (409): a name taken, the per-bot cap, a bot that is archived. */
export class TriggerConflictError extends Error {
  override name = "TriggerConflictError";
}

const ID = /^[A-Za-z0-9_-]{1,100}$/u;
/** A dot path into an event: names of letters, digits, `_`, `-` and `$`, or list indexes. */
const FIELD = /^[A-Za-z0-9_$-]{1,64}(?:\.[A-Za-z0-9_$-]{1,64}){0,15}$/u;
const CONTROL = /\p{Cc}/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FILTER_KEYS = ["match", "prLinks", "bots", "external"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function refuseUnknown(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new TriggerInputError(`Unknown ${what} field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

/** A trigger's name: 1–60 characters on one line, without `[`, `]` or `·`, which mark its deliveries. */
export function triggerName(raw: unknown): string {
  if (typeof raw !== "string") throw new TriggerInputError("A trigger's name must be text.");
  const name = raw.replace(/\s+/gu, " ").trim();
  if (!name || name.length > BOT_TRIGGER_LIMITS.name) throw new TriggerInputError(`A trigger's name must be 1-${BOT_TRIGGER_LIMITS.name} characters.`);
  if (CONTROL.test(name) || /[[\]·]/u.test(name)) throw new TriggerInputError("A trigger's name can't hold [, ] or ·: they mark its messages in the bot's chat.");
  return name;
}

function promptField(raw: unknown): string {
  if (typeof raw !== "string") throw new TriggerInputError("A trigger's prompt must be text.");
  const prompt = raw.replace(/\r\n?/gu, "\n").trim();
  if (prompt.length > BOT_TRIGGER_LIMITS.prompt) throw new TriggerInputError(`A trigger's prompt must be at most ${BOT_TRIGGER_LIMITS.prompt} characters.`);
  if (prompt.includes("\0")) throw new TriggerInputError("A trigger's prompt must be text.");
  return prompt;
}

function deliveryField(raw: unknown): "followUp" | "steer" {
  if (raw !== "followUp" && raw !== "steer") throw new TriggerInputError("delivery must be followUp or steer.");
  return raw;
}

function cooldownField(raw: unknown): number {
  if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > BOT_TRIGGER_LIMITS.cooldownMax) {
    throw new TriggerInputError(`cooldownSeconds must be a whole number of seconds, 0-${BOT_TRIGGER_LIMITS.cooldownMax}.`);
  }
  return raw as number;
}

export function triggerMatch(raw: unknown): TriggerMatch {
  if (!isRecord(raw)) throw new TriggerInputError("match must be { field, op, value }.");
  refuseUnknown(raw, ["field", "op", "value"], "match");
  const field = typeof raw["field"] === "string" ? raw["field"].trim() : undefined;
  if (field === undefined || (field !== "" && (field.length > BOT_TRIGGER_LIMITS.field || !FIELD.test(field)))) {
    throw new TriggerInputError("match.field must be a dot path into the event, such as fields.channel or summary (\"\" is the whole event).");
  }
  if (raw["op"] !== "equals" && raw["op"] !== "contains") throw new TriggerInputError("match.op must be equals or contains.");
  const value = typeof raw["value"] === "string" ? raw["value"] : undefined;
  if (!value || value.length > BOT_TRIGGER_LIMITS.match || CONTROL.test(value)) throw new TriggerInputError(`match.value must be 1-${BOT_TRIGGER_LIMITS.match} characters on one line.`);
  return { field, op: raw["op"], value };
}

/** An optional switch: `true` sets it; `false` and `null` leave it out. */
function flag(raw: unknown, what: string): true | undefined {
  if (raw == null || raw === false) return undefined;
  if (raw !== true) throw new TriggerInputError(`${what} must be true or false.`);
  return true;
}

/** A trigger's filter, every key checked. */
export function triggerFilter(raw: unknown): BotTriggerFilter {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new TriggerInputError("filter must be an object.");
  refuseUnknown(raw, FILTER_KEYS, "filter");
  const filter: BotTriggerFilter = raw["match"] == null ? {} : { match: triggerMatch(raw["match"]) };
  if (flag(raw["prLinks"], "prLinks")) filter.prLinks = true;
  if (flag(raw["bots"], "bots")) filter.bots = true;
  if (flag(raw["external"], "external")) filter.external = true;
  return filter;
}

function sourceField(raw: unknown): BotTriggerSource {
  const source = BOT_TRIGGER_SOURCES.find((candidate) => candidate === (raw ?? "listener"));
  if (!source) throw new TriggerInputError("source must be listener: a program you run reports what it watches to the trigger's URL. HUI no longer reads GitHub, sessions, webhooks or Slack for triggers itself.");
  return source;
}

/** Validates `POST /__hui/bots/:id/triggers`; `source` may be left out. */
export function normalizeTriggerInput(value: unknown): BotTriggerInput {
  if (!isRecord(value)) throw new TriggerInputError("A trigger must be an object.");
  refuseUnknown(value, ["name", "source", "filter", "prompt", "delivery", "enabled", "cooldownSeconds"], "trigger");
  const prompt = value["prompt"] === undefined ? "" : promptField(value["prompt"]);
  if (value["enabled"] !== undefined && typeof value["enabled"] !== "boolean") throw new TriggerInputError("enabled must be a boolean.");
  return {
    name: triggerName(value["name"]),
    source: sourceField(value["source"]),
    filter: triggerFilter(value["filter"]),
    ...(prompt ? { prompt } : {}),
    ...(value["delivery"] !== undefined ? { delivery: deliveryField(value["delivery"]) } : {}),
    enabled: value["enabled"] !== false,
    cooldownSeconds: value["cooldownSeconds"] === undefined ? BOT_TRIGGER_LIMITS.cooldownDefault : cooldownField(value["cooldownSeconds"]),
  };
}

/** Validates `PATCH /__hui/bots/:id/triggers/:trigger`; the filter is checked once merged. */
export function normalizeTriggerPatch(value: unknown): BotTriggerPatch {
  if (!isRecord(value)) throw new TriggerInputError("A trigger change must be an object.");
  if ("source" in value) throw new TriggerInputError("A trigger's source can't change.");
  refuseUnknown(value, ["name", "filter", "prompt", "delivery", "enabled", "cooldownSeconds"], "trigger");
  if (!Object.keys(value).length) throw new TriggerInputError("Nothing to change.");
  const patch: BotTriggerPatch = {};
  if ("name" in value) patch.name = triggerName(value["name"]);
  if ("prompt" in value) patch.prompt = promptField(value["prompt"]);
  if ("delivery" in value) patch.delivery = deliveryField(value["delivery"]);
  if ("enabled" in value) {
    if (typeof value["enabled"] !== "boolean") throw new TriggerInputError("enabled must be a boolean.");
    patch.enabled = value["enabled"];
  }
  if ("cooldownSeconds" in value) patch.cooldownSeconds = cooldownField(value["cooldownSeconds"]);
  if ("filter" in value) {
    if (!isRecord(value["filter"])) throw new TriggerInputError("filter must be an object of the keys to change.");
    patch.filter = value["filter"];
  }
  return patch;
}

/** The filter after a patch's keys: each given key replaces, `null` or `false` clears it. */
export function patchedFilter(current: BotTriggerFilter, change: Record<string, unknown>): BotTriggerFilter {
  refuseUnknown(change, FILTER_KEYS, "filter");
  const entries = new Map<string, unknown>(Object.entries(current));
  for (const key of FILTER_KEYS) {
    if (!Object.hasOwn(change, key)) continue;
    const value = change[key];
    if (value === null || value === false) entries.delete(key);
    else entries.set(key, value);
  }
  return triggerFilter(Object.fromEntries(entries));
}

function storedText(raw: unknown, max: number): string | undefined {
  return typeof raw === "string" && raw.trim() && raw.length <= max ? raw : undefined;
}

/**
 * A stored record, or undefined when anything required is missing or invalid: a trigger HUI can't read exactly (one
 * of a source it no longer has among them) is kept aside rather than run with a guessed filter.
 */
export function parseTriggerRecord(raw: unknown): BotTriggerRecord | undefined {
  if (!isRecord(raw)) return undefined;
  try {
    const id = String(raw["id"] ?? "");
    const botId = String(raw["botId"] ?? "");
    const createdAt = String(raw["createdAt"] ?? "");
    const updatedAt = String(raw["updatedAt"] ?? "");
    if (!ID.test(id) || !ID.test(botId) || !ISO.test(createdAt) || !ISO.test(updatedAt)) return undefined;
    // Only the one source a record names: one without `source` is from no HUI that wrote this file.
    if (raw["source"] === undefined) return undefined;
    const source = sourceField(raw["source"]);
    const filter = triggerFilter(raw["filter"] ?? {});
    if (typeof raw["enabled"] !== "boolean") return undefined;
    const cooldownSeconds = cooldownField(raw["cooldownSeconds"]);
    const createdBy = raw["createdBy"] === "bot" ? "bot" : raw["createdBy"] === "operator" ? "operator" : undefined;
    if (!createdBy) return undefined;
    const prompt = storedText(raw["prompt"], BOT_TRIGGER_LIMITS.prompt);
    const lastFiredAt = typeof raw["lastFiredAt"] === "string" && ISO.test(raw["lastFiredAt"]) ? raw["lastFiredAt"] : undefined;
    const tokenHash = typeof raw["tokenHash"] === "string" && /^[0-9a-f]{64}$/u.test(raw["tokenHash"]) ? raw["tokenHash"] : undefined;
    const tokenHint = typeof raw["tokenHint"] === "string" && /^[A-Za-z0-9_-]{4}$/u.test(raw["tokenHint"]) ? raw["tokenHint"] : undefined;
    // A trigger without its token's hash could never be called: it is not a trigger HUI can run.
    if (!tokenHash) return undefined;
    return {
      id, botId, name: triggerName(raw["name"]), source, filter,
      ...(prompt ? { prompt } : {}),
      ...(raw["delivery"] !== undefined ? { delivery: deliveryField(raw["delivery"]) } : {}),
      enabled: raw["enabled"], cooldownSeconds, createdBy, createdAt, updatedAt,
      ...(lastFiredAt ? { lastFiredAt } : {}),
      tokenHash, ...(tokenHint ? { tokenHint } : {}),
    };
  } catch {
    return undefined;
  }
}
