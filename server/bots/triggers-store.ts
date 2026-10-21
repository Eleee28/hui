/**
 * Where triggers live (HUI-18), beside `bots.json` and only written by HUI:
 *
 *   ~/.config/hui/bot-triggers.json        { version: 1, triggers, runs, pending, deliveries, seen }
 *
 * Like `bots.json`: owner-only, every write a temporary file and a rename, every read/modify/write serialized; a record
 * that does not validate (one of a source HUI no longer has among them) is kept in the file untouched and not used
 * (reported once); a file that is not JSON or comes from a newer HUI is refused and never overwritten.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BOT_TRIGGER_LIMITS, type BotTriggerRecord, type BotTriggerRun, type BotTriggerRunStatus } from "./triggers-format.ts";
import { parseTriggerRecord } from "./triggers-input.ts";
import { CONFIG_DIR } from "../paths.ts";

export const TRIGGERS_FILE = join(CONFIG_DIR, "bot-triggers.json");
export const TRIGGERS_VERSION = 1;

/** A store file can't be read or written safely; it is left untouched (500). */
export class TriggerStoreError extends Error {
  override name = "TriggerStoreError";
}

/** An event as it waits for a trigger's cooldown: already rendered, so it survives a restart without its listener. It
 * keeps the pull requests it links to, which its delivery reads when it goes out. */
export type PendingEvent = { summary: string; details: string; at: string; links?: string[] };

/** The GitHub pull request URLs a pending event keeps, as `parseListenerReport` makes them. */
const PULL_LINK = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9]\d{0,8}$/u;

/** Events waiting for a trigger's next delivery; `more` counts those past `BOT_TRIGGER_LIMITS.pending`. */
export type TriggerPending = { events: PendingEvent[]; more: number; since: string; catchUp?: true };

export type TriggerState = {
  triggers: BotTriggerRecord[];
  /** Newest last; at most `BOT_TRIGGER_LIMITS.runs` per trigger. */
  runs: BotTriggerRun[];
  /** Trigger id → what waits for it. */
  pending: Record<string, TriggerPending>;
  /** Bot id → its deliveries in the last hour, for the hourly cap. */
  deliveries: Record<string, string[]>;
  /** Trigger id → the event ids its listener reported, newest last, so one reported again never wakes the bot twice.
   * Written with the delivery they decide. */
  seen: Record<string, string[]>;
  /** Records that did not validate, written back untouched. */
  invalid: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const RUN_STATUSES: ReadonlySet<string> = new Set<BotTriggerRunStatus>(["fired", "coalesced", "skipped", "failed"]);
const line = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

function parseRun(raw: unknown): BotTriggerRun | undefined {
  if (!isRecord(raw) || typeof raw["id"] !== "string" || typeof raw["triggerId"] !== "string" || typeof raw["at"] !== "string" || !ISO.test(raw["at"])) return undefined;
  if (typeof raw["status"] !== "string" || !RUN_STATUSES.has(raw["status"])) return undefined;
  const events = Number.isInteger(raw["events"]) && (raw["events"] as number) >= 0 ? raw["events"] as number : 1;
  const reason = line(raw["reason"], 500);
  return {
    id: raw["id"], triggerId: raw["triggerId"], triggerName: line(raw["triggerName"], BOT_TRIGGER_LIMITS.name), at: raw["at"],
    status: raw["status"] as BotTriggerRunStatus, events, summary: line(raw["summary"], 300),
    ...(reason ? { reason } : {}),
    ...(raw["test"] === true ? { test: true } : {}),
    ...(raw["catchUp"] === true ? { catchUp: true } : {}),
  };
}

function parsePending(raw: unknown): TriggerPending | undefined {
  if (!isRecord(raw) || !Array.isArray(raw["events"]) || typeof raw["since"] !== "string" || !ISO.test(raw["since"])) return undefined;
  const events = raw["events"].flatMap((event): PendingEvent[] => {
    if (!isRecord(event) || typeof event["summary"] !== "string" || typeof event["at"] !== "string") return [];
    const links = Array.isArray(event["links"]) ? event["links"].filter((link): link is string => typeof link === "string" && PULL_LINK.test(link)).slice(0, BOT_TRIGGER_LIMITS.links) : [];
    return [{ summary: line(event["summary"], 300), details: line(event["details"], BOT_TRIGGER_LIMITS.details), at: event["at"], ...(links.length ? { links } : {}) }];
  }).slice(0, BOT_TRIGGER_LIMITS.pending);
  const more = Number.isInteger(raw["more"]) && (raw["more"] as number) > 0 ? raw["more"] as number : 0;
  if (!events.length && !more) return undefined;
  return { events, more, since: raw["since"], ...(raw["catchUp"] === true ? { catchUp: true } : {}) };
}

function parseTriggerState(raw: Record<string, unknown>): TriggerState {
  if (!Array.isArray(raw["triggers"])) throw new TriggerStoreError("HUI's triggers (bot-triggers.json) have an invalid shape.");
  const triggers: BotTriggerRecord[] = [];
  const invalid: unknown[] = [];
  const ids = new Set<string>();
  for (const item of raw["triggers"]) {
    const trigger = parseTriggerRecord(item);
    if (!trigger || ids.has(trigger.id)) {
      invalid.push(item);
      continue;
    }
    ids.add(trigger.id);
    triggers.push(trigger);
  }
  const runs = (Array.isArray(raw["runs"]) ? raw["runs"] : []).flatMap((run) => parseRun(run) ?? []);
  // Built with fromEntries, so no key a hand edit puts in the file (`__proto__` included) is more than a key.
  const pending: Record<string, TriggerPending> = Object.fromEntries(Object.entries(isRecord(raw["pending"]) ? raw["pending"] : {}).flatMap(([id, value]): [string, TriggerPending][] => {
    const parsed = parsePending(value);
    return parsed && ids.has(id) ? [[id, parsed]] : [];
  }));
  const seen: Record<string, string[]> = Object.fromEntries(Object.entries(isRecord(raw["seen"]) ? raw["seen"] : {}).flatMap(([id, events]): [string, string[]][] =>
    ids.has(id) && Array.isArray(events) ? [[id, events.filter((event): event is string => typeof event === "string" && event.length > 0 && event.length <= 200).slice(-BOT_TRIGGER_LIMITS.seen)]] : []));
  const deliveries: Record<string, string[]> = Object.fromEntries(Object.entries(isRecord(raw["deliveries"]) ? raw["deliveries"] : {}).flatMap(([botId, times]): [string, string[]][] =>
    /^[A-Za-z0-9_-]{1,100}$/u.test(botId) && Array.isArray(times) ? [[botId, times.filter((time): time is string => typeof time === "string" && ISO.test(time)).slice(-100)]] : []));
  return { triggers, runs, pending, deliveries, seen, invalid };
}

/**
 * One owner-only JSON file with serialized read/modify/write. `parse` turns its body into the state (throwing
 * `TriggerStoreError` for a shape it refuses) and `serialize` the state back into it.
 */
export class JsonStateFile<T> {
  readonly file: string;
  readonly #label: string;
  readonly #empty: () => T;
  readonly #parse: (raw: Record<string, unknown>) => T;
  readonly #serialize: (value: T) => Record<string, unknown>;
  #mutation: Promise<unknown> = Promise.resolve();

  constructor(file: string, options: { label: string; empty: () => T; parse: (raw: Record<string, unknown>) => T; serialize: (value: T) => Record<string, unknown> }) {
    this.file = file;
    this.#label = options.label;
    this.#empty = options.empty;
    this.#parse = options.parse;
    this.#serialize = options.serialize;
  }

  async read(): Promise<T> {
    let source: string;
    try {
      source = await readFile(this.file, "utf8");
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") return this.#empty();
      throw new TriggerStoreError(`HUI's ${this.#label} could not be read.`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new TriggerStoreError(`HUI's ${this.#label} (${this.file}) is not valid JSON. Fix or move it; HUI will not overwrite it.`, { cause: error });
    }
    if (!isRecord(parsed)) throw new TriggerStoreError(`HUI's ${this.#label} (${this.file}) has an invalid shape.`);
    if (typeof parsed["version"] === "number" && parsed["version"] > TRIGGERS_VERSION) {
      throw new TriggerStoreError(`${this.file} was written by a newer HUI. Update HUI to use these triggers.`);
    }
    return this.#parse(parsed);
  }

  /** Serialized read/modify/write; a failed write changes nothing. `mutate` returns the next state and a result. */
  update<R>(mutate: (value: T) => { value: T; result: R } | Promise<{ value: T; result: R }>): Promise<R> {
    const operation = this.#mutation.then(async () => {
      const { value, result } = await mutate(await this.read());
      await this.#write(value);
      return result;
    });
    // A failed mutation must not poison the queue for later ones.
    this.#mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #write(value: T): Promise<void> {
    // A unique name: a slower writer must not clobber another's temporary file.
    const temporary = `${this.file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify({ version: TRIGGERS_VERSION, ...this.#serialize(value) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new TriggerStoreError(`HUI's ${this.#label} could not be written.`, { cause: error });
    }
  }
}

/**
 * Work in flight that a `stop()` waits for: `track` keeps a promise until it settles, and `settled` resolves once none
 * is left, counting what started while it waited.
 */
export class InFlight {
  readonly #work = new Set<Promise<unknown>>();

  track<T>(work: Promise<T>): Promise<T> {
    this.#work.add(work);
    const forget = () => { this.#work.delete(work); };
    work.then(forget, forget);
    return work;
  }

  async settled(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }
}

/** `bot-triggers.json`. `onInvalid` hears how many records it keeps aside, once per change of that number. */
export function triggerStore(file = TRIGGERS_FILE, onInvalid: (count: number) => void = () => {}): JsonStateFile<TriggerState> {
  let reported = 0;
  return new JsonStateFile<TriggerState>(file, {
    label: "triggers",
    empty: () => ({ triggers: [], runs: [], pending: {}, deliveries: {}, seen: {}, invalid: [] }),
    parse: (raw) => {
      const state = parseTriggerState(raw);
      if (state.invalid.length !== reported) {
        reported = state.invalid.length;
        if (reported) onInvalid(reported);
      }
      return state;
    },
    serialize: (state) => ({ triggers: [...state.triggers, ...state.invalid], runs: state.runs, pending: state.pending, deliveries: state.deliveries, seen: state.seen }),
  });
}

/** The runs after `run`: newest last, at most `BOT_TRIGGER_LIMITS.runs` per trigger, only triggers still there. */
export function withRun(runs: readonly BotTriggerRun[], run: BotTriggerRun, triggers: readonly { id: string }[]): BotTriggerRun[] {
  const live = new Set(triggers.map((trigger) => trigger.id));
  const next = [...runs.filter((each) => live.has(each.triggerId)), run];
  const counts = new Map<string, number>();
  const kept: BotTriggerRun[] = [];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const each = next[index]!;
    const count = (counts.get(each.triggerId) ?? 0) + 1;
    counts.set(each.triggerId, count);
    if (count <= BOT_TRIGGER_LIMITS.runs) kept.push(each);
  }
  return kept.reverse();
}
