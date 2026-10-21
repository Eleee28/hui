/**
 * Triggers (HUI-18): what wakes a bot when something happens elsewhere, beside its routines, which wake it on a
 * schedule. Every trigger is a listener's: a program the operator runs outside HUI watches something (a Slack, a Jira
 * board, a repo) and reports what it found to the trigger's URL; when an event matches the trigger's filter, HUI
 * delivers `[trigger: <name> · <summary>] <prompt>` plus the event's details into the bot's chat, as a routine's message
 * is by default (a follow-up while the bot works), or as a compact steering notice when selected.
 * The gateway's and the `hui bot trigger` CLI's limits, markers and labels; the public payloads are
 * `api/bot-triggers.ts`'s and docs/api.md#triggers is the contract.
 */
import type { BotTrigger, BotTriggerFilter, BotTriggerSource } from "../api/bot-triggers.ts";

export type {
  BotTrigger, BotTriggerCreated, BotTriggerFilter, BotTriggerInput, BotTriggerPatch, BotTriggerRun, BotTriggerRunStatus,
  BotTriggerSource, BotTriggersList, TriggerMatch,
} from "../api/bot-triggers.ts";

/** The one source: kept in records and routes so a record of a source HUI no longer has is told apart (`hui doctor`). */
export const BOT_TRIGGER_SOURCES = ["listener"] as const;
export const BOT_TRIGGER_SOURCE_LABELS: Readonly<Record<BotTriggerSource, string>> = { listener: "Listener" };

/** Limits the gateway enforces; the CLI and the browser (`src/lib/bots/triggers.ts`) mirror them. */
export const BOT_TRIGGER_LIMITS = {
  /** A trigger's name: one line, without `[`, `]` or `·`, which mark its deliveries. */
  name: 60,
  prompt: 4_000,
  /** Triggers one bot may have. */
  perBot: 20,
  /** Deliveries one bot takes from all its triggers in an hour; what comes after waits for a free slot. */
  perHour: 12,
  /** Links or fields one event carries, and values one field's list holds. */
  values: 20,
  cooldownDefault: 300,
  cooldownMax: 86_400,
  /** A listener's report's body, in bytes. */
  body: 64 * 1024,
  /** Events one report holds. */
  events: 50,
  /** Event ids remembered per trigger, so a report sent again never wakes the bot twice. */
  seen: 500,
  /** One event's details in a delivery, in characters. */
  details: 5_000,
  /** A delivery's whole text, in characters: it carries the pull requests its events link to, diffs included. */
  message: 40_000,
  /** Events one delivery lists; the rest are counted. */
  listed: 20,
  /** Events that wait for a trigger's cooldown (or the hourly cap); the rest are counted. */
  pending: 50,
  /** Runs kept per trigger. */
  runs: 20,
  /** A filter's field path and value. */
  field: 200,
  match: 500,
  /** Pull request links read from one event. */
  links: 3,
  /** A linked pull request's description in a delivery, in characters. */
  prDescription: 2_000,
  /** A linked pull request's changed files listed in a delivery; the rest are counted. */
  prFiles: 60,
  /** The diffs of one delivery together, in characters, shared evenly by its pull requests. */
  prDiffs: 24_000,
  /** Pull requests one delivery reads; past that, the rest are named, not read. */
  prsPerDelivery: 6,
} as const;

/** The first characters of every delivery: `[trigger: <name> · <summary>] <prompt>`. */
export const BOT_TRIGGER_MARKER = "[trigger: ";

/** The route a trigger's listener reports to: `POST /__hui/hooks/<token>` on the gateway. */
export const BOT_TRIGGER_HOOK_PREFIX = "/__hui/hooks/";

/** One trigger as `bot-triggers.json` stores it: its URL's token only as its SHA-256. */
export type BotTriggerRecord = Omit<BotTrigger, "pending" | "watch"> & { tokenHash: string };

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
