/**
 * A bot's triggers in the Bots tab (HUI-18): the list on its panel's overview and its Triggers page. This module narrows
 * what the trigger routes answer, formats a trigger's filter and cooldown, turns the add form into a request body and holds what the section shows; the
 * section's state, its polling and its requests live in `controllers/bot-triggers-controller.ts` and
 * `api/bot-triggers.ts`. The view is `src/views/bot-triggers.ts`.
 */
import type {
  BotTrigger, BotTriggerCreated, BotTriggerFilter, BotTriggerInput, BotTriggerRun, BotTriggerRunStatus, BotTriggerSource, BotTriggersList,
} from "../../api/schema/bot-triggers.ts";

const BOT_TRIGGER_SOURCES: readonly BotTriggerSource[] = ["listener"];

/** The gateway's limits the add form and the section show (`server/bots/triggers-format.ts` enforces them). */
export const BOT_TRIGGER_LIMITS = { name: 60, prompt: 4_000, perHour: 12, cooldownDefault: 300 } as const;

/** `5 min`, `1 h 30 min`, `45 s`, `none`. */
export function cooldownLabel(seconds: number): string {
  if (seconds <= 0) return "none";
  if (seconds < 60) return `${seconds} s`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return [hours ? `${hours} h` : "", minutes ? `${minutes} min` : "", rest && !hours ? `${rest} s` : ""].filter(Boolean).join(" ");
}

/** One line for what a trigger lets through: `fields.channel equals "C0123" · PR links only`. */
export function botTriggerFilterSummary(trigger: { filter: BotTriggerFilter }): string {
  const filter = trigger.filter;
  return [
    filter.match ? `${filter.match.field || "event"} ${filter.match.op} "${filter.match.value}"` : "Any event",
    ...(filter.prLinks ? ["PR links only"] : []),
    ...(filter.external ? ["outsiders too"] : []),
    ...(filter.bots ? ["bots too"] : []),
  ].join(" · ");
}

/** How often the open section reads the triggers again: they fire on their own. */
export const TRIGGERS_POLL_MS = 5_000;

/* ── reading ─────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const RUN_STATUSES: readonly BotTriggerRunStatus[] = ["fired", "coalesced", "skipped", "failed"];

function parseFilter(raw: unknown): BotTriggerFilter {
  if (!isRecord(raw)) return {};
  const match = isRecord(raw["match"]) && (raw["match"]["op"] === "equals" || raw["match"]["op"] === "contains") && str(raw["match"]["value"])
    ? { field: str(raw["match"]["field"]), op: raw["match"]["op"] === "contains" ? "contains" as const : "equals" as const, value: str(raw["match"]["value"]) }
    : undefined;
  return {
    ...(match ? { match } : {}),
    ...(raw["prLinks"] === true ? { prLinks: true as const } : {}),
    ...(raw["external"] === true ? { external: true as const } : {}),
    ...(raw["bots"] === true ? { bots: true as const } : {}),
  };
}

/** One trigger as the routes return it, narrowed; undefined when it doesn't validate. */
export function parseTrigger(raw: unknown): BotTrigger | undefined {
  if (!isRecord(raw) || !str(raw["id"]) || !str(raw["name"]) || !str(raw["botId"])) return undefined;
  const source = BOT_TRIGGER_SOURCES.find((candidate) => candidate === raw["source"]);
  if (!source) return undefined;
  const pending = isRecord(raw["pending"]) && Number.isInteger(raw["pending"]["events"]) && str(raw["pending"]["until"])
    ? { events: raw["pending"]["events"] as number, until: str(raw["pending"]["until"]) }
    : undefined;
  const watch = isRecord(raw["watch"]) ? { ...(str(raw["watch"]["polledAt"]) ? { polledAt: str(raw["watch"]["polledAt"]) } : {}), ...(str(raw["watch"]["error"]) ? { error: str(raw["watch"]["error"]) } : {}) } : undefined;
  return {
    id: str(raw["id"]), botId: str(raw["botId"]), name: str(raw["name"]), source, filter: parseFilter(raw["filter"]),
    ...(str(raw["prompt"]) ? { prompt: str(raw["prompt"]) } : {}),
    ...(raw["delivery"] === "steer" || raw["delivery"] === "followUp" ? { delivery: raw["delivery"] } : {}),
    enabled: raw["enabled"] !== false,
    cooldownSeconds: Number.isInteger(raw["cooldownSeconds"]) ? raw["cooldownSeconds"] as number : BOT_TRIGGER_LIMITS.cooldownDefault,
    createdBy: raw["createdBy"] === "bot" ? "bot" : "operator",
    createdAt: str(raw["createdAt"]), updatedAt: str(raw["updatedAt"]),
    ...(str(raw["lastFiredAt"]) ? { lastFiredAt: str(raw["lastFiredAt"]) } : {}),
    ...(str(raw["tokenHint"]) ? { tokenHint: str(raw["tokenHint"]) } : {}),
    ...(pending ? { pending } : {}),
    ...(watch && Object.keys(watch).length ? { watch } : {}),
  };
}

export function parseRun(raw: unknown): BotTriggerRun | undefined {
  if (!isRecord(raw) || !str(raw["id"]) || !str(raw["triggerId"]) || !str(raw["at"])) return undefined;
  const status = RUN_STATUSES.find((candidate) => candidate === raw["status"]);
  if (!status) return undefined;
  return {
    id: str(raw["id"]), triggerId: str(raw["triggerId"]), triggerName: str(raw["triggerName"]), at: str(raw["at"]), status,
    events: Number.isInteger(raw["events"]) ? raw["events"] as number : 1, summary: str(raw["summary"]),
    ...(str(raw["reason"]) ? { reason: str(raw["reason"]) } : {}),
    ...(raw["test"] === true ? { test: true } : {}),
    ...(raw["catchUp"] === true ? { catchUp: true } : {}),
  };
}

/** `GET /__hui/bots/:id/triggers`, narrowed: entries that don't validate are left out. */
export function parseTriggersList(body: unknown): BotTriggersList {
  if (!isRecord(body) || !Array.isArray(body["triggers"])) throw new Error("The bot's triggers did not come back.");
  const deliveries = isRecord(body["deliveries"]) ? body["deliveries"] : {};
  return {
    triggers: body["triggers"].flatMap((raw) => parseTrigger(raw) ?? []),
    runs: Array.isArray(body["runs"]) ? body["runs"].flatMap((raw) => parseRun(raw) ?? []) : [],
    deliveries: {
      lastHour: Number.isInteger(deliveries["lastHour"]) ? deliveries["lastHour"] as number : 0,
      perHour: Number.isInteger(deliveries["perHour"]) ? deliveries["perHour"] as number : BOT_TRIGGER_LIMITS.perHour,
    },
  };
}

export function parseCreated(body: unknown): BotTriggerCreated {
  const trigger = isRecord(body) ? parseTrigger(body["trigger"]) : undefined;
  if (!trigger || !isRecord(body)) throw new Error("The trigger did not come back.");
  const hook = isRecord(body["hook"]) && str(body["hook"]["token"]) && str(body["hook"]["path"]) ? { token: str(body["hook"]["token"]), path: str(body["hook"]["path"]) } : undefined;
  if (!hook) throw new Error("The trigger's URL did not come back.");
  return { trigger, hook };
}

/* ── the add form ────────────────────────────────────────────────────── */

/** A form the gateway would refuse anyway, refused with what to fix before a request. */
export class TriggerFormError extends Error {
  override name = "TriggerFormError";
}

export type TriggerFormFields = {
  name: string;
  prompt: string;
  cooldown: string;
  matchField: string;
  matchOp: string;
  matchValue: string;
  prLinks: boolean;
  external: boolean;
  bots: boolean;
  steer?: boolean;
};

/** The add form's fields as a `POST /__hui/bots/:id/triggers` body. */
export function triggerFormInput(fields: TriggerFormFields): BotTriggerInput {
  const name = fields.name.trim();
  if (!name) throw new TriggerFormError("Name the trigger.");
  if (/[[\]·]/u.test(name)) throw new TriggerFormError("A trigger's name can't hold [, ] or ·.");
  const cooldown = Number(fields.cooldown);
  const value = fields.matchValue.trim();
  return {
    name, source: "listener",
    ...(fields.prompt.trim() ? { prompt: fields.prompt.trim() } : {}),
    ...(fields.steer ? { delivery: "steer" } : {}),
    cooldownSeconds: Number.isInteger(cooldown) && cooldown >= 0 ? cooldown : BOT_TRIGGER_LIMITS.cooldownDefault,
    filter: {
      ...(value ? { match: { field: fields.matchField.trim(), op: fields.matchOp === "contains" ? "contains" as const : "equals" as const, value } } : {}),
      ...(fields.prLinks ? { prLinks: true as const } : {}),
      ...(fields.external ? { external: true as const } : {}),
      ...(fields.bots ? { bots: true as const } : {}),
    },
  };
}

/* ── the section's state ─────────────────────────────────────────────── */

export type RevealedHook = { triggerId: string; name: string; url: string; copied: boolean };

export type BotTriggersState = {
  botId: string;
  loading: boolean;
  error: string;
  list?: BotTriggersList;
  /** A change on its way: every control waits for it. */
  pending: boolean;
  actionError: string;
  formError: string;
  /** A note after a test: how its run went. */
  notice: string;
  /** A trigger's URL, shown once after it was made or replaced. */
  revealed?: RevealedHook;
};

export type BotTriggersActions = {
  /** Resolves true once the gateway accepted it, so the form clears only then. */
  onCreate: (input: BotTriggerInput) => Promise<boolean>;
  onFormError: (message: string) => void;
  onToggle: (trigger: BotTrigger, enabled: boolean) => void;
  onTest: (trigger: BotTrigger) => void;
  onDelete: (trigger: BotTrigger) => void;
  onRotate: (trigger: BotTrigger) => void;
  onCopy: () => void;
  onDismissUrl: () => void;
  onRetry: () => void;
};
