/**
 * A bot's own routines (HUI-18; SPEC.md, "Schedules are a CLI, and bots schedule their own routines"): what the
 * `routines` tool of a bot's chat (`durable-routines.ts`) asks the gateway, as that chat's session,
 * wherever the chat runs. Routines are Automation tasks aimed at the bot's chat, and this is their one gate:
 *
 * - **Its own chat only.** A bot lists, changes and removes only the tasks whose session is its chat; another
 *   bot's or session's task is never named, as if it did not exist.
 * - **Who started the turn.** Only the operator's turns, its routines' turns and HUI's kickoff may add or change one,
 *   judged by every input of the run as `set_profile` judges it: the one that started it (its originating input) and
 *   any since (`runOrigins`, as the host running the chat saw them). A run that took any other is refused, another
 *   bot's (`[from @…]`) and a trigger's (`[trigger: …]`, whose event comes from outside HUI) among them. Listing and
 *   removing work in any turn: they never make more work.
 * - **Limits.** At most `BOT_ROUTINE_LIMITS.active` enabled routines in its chat once it adds or resumes one, one
 *   name per routine, Automation's own one-minute minimum, and up to `BOT_ROUTINE_LIMITS.runs` runs.
 * - **Temporary routines** carry `until` and/or `runs`; Automation deletes them after either, and the bot may
 *   remove one itself, from that routine's own turn too, which then finishes.
 *
 * What it makes is recorded as the bot's (`createdBy`). An archived bot has none to manage.
 */
import { type BotRecord } from "../bots-format.ts";
import { botTurnOrigin, runTurnOrigins, type BotTurnOrigin } from "../runtimes/turn-origins.ts";
import type { AutomationSchedule, AutomationTask } from "../automation.ts";
import { AutomationInputError, normalizeSchedule, type AutomationService } from "../automation.ts";
import { BotConflictError, BotInputError } from "./bots.ts";
import { BOT_ROUTINE_LIMITS, ROUTINE_ACTIONS, ROUTINES_TOOL } from "./durable-routines.ts";
import type { SessionRecord } from "../sessions/sessions.ts";

export type BotRoutineDeps = {
  /** The bot whose chat a session is; the bot registry decides. */
  botForSession(sessionId: string): Promise<BotRecord | undefined>;
  /** HUI's session records: the caller's `runPrompt` says who started its turn. */
  readSessions(): Promise<readonly SessionRecord[]>;
  automation: Pick<AutomationService, "snapshot" | "create" | "update" | "remove" | "cancel" | "activeRun">;
  /** Where a cron without a time zone runs: the gateway's own. */
  timezone?(): string;
  now?(): number;
};

const FIELDS = new Set(["action", "routine", "name", "prompt", "every", "cron", "timezone", "at", "until", "runs", "enabled"]);
const DURATION = /^(\d{1,9})(s|m|h|d)$/u;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const PROMPT_PREVIEW = 160;

/** `every 5m`, `cron 0 9 * * 1-5 (Europe/Madrid)`, `once at …`. */
export function routineScheduleText(schedule: AutomationSchedule): string {
  if (schedule.kind === "at") return `once at ${schedule.at}`;
  if (schedule.kind === "cron") return `cron ${schedule.expression} (${schedule.timezone})`;
  const [size, unit] = ([[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"], [1_000, "s"]] as const).find(([step]) => schedule.everyMs % step === 0) ?? [1, "ms"];
  return `every ${schedule.everyMs / size}${unit}`;
}

/** `until …, 3 runs left`, for the model; empty without limits. */
function limitsText(task: AutomationTask): string {
  return [
    ...(task.until ? [`until ${task.until}`] : []),
    ...(task.runsLeft !== undefined ? [task.runsLeft === 0 ? "its last run is going" : `${task.runsLeft} run${task.runsLeft === 1 ? "" : "s"} left`] : []),
  ].join(", ");
}

function routineLine(task: AutomationTask, bot: BotRecord): string {
  const when = task.enabled ? (task.nextRunAt ? `next ${task.nextRunAt}` : "no run planned") : "paused";
  const limits = limitsText(task);
  const maker = task.createdBy?.kind === "bot" ? (task.createdBy.botId === bot.id ? "made by you" : `made by @${task.createdBy.handle}`) : "made by the operator";
  const prompt = task.prompt.replace(/\s+/gu, " ").trim();
  return `- "${task.name}" (id ${task.id}): ${routineScheduleText(task.schedule)}, ${when}${limits ? `; ${limits}` : ""}; ${maker}. Prompt: ${prompt.length > PROMPT_PREVIEW ? `${prompt.slice(0, PROMPT_PREVIEW - 1)}…` : prompt}`;
}

function textField(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new BotInputError(`${field} must be 1-${maximum} characters.`);
  return value.trim();
}

/** Automation's own refusal (a bad cron, a time zone it doesn't know, an end before the next run) as the model's to fix. */
function asInput<T>(work: () => Promise<T>): Promise<T> {
  return work().catch((error: unknown) => {
    throw error instanceof AutomationInputError ? new BotInputError(error.message) : error;
  });
}

export class BotRoutines {
  readonly #deps: BotRoutineDeps;

  constructor(deps: BotRoutineDeps) {
    this.#deps = deps;
  }

  /** One call of the tool from the bot whose chat `callerSessionId` is, with who brought each input of its run as the
   * host running the chat saw them (`runOrigins`; none from a host that can't tell). */
  async handle(callerSessionId: string, params: Record<string, unknown>, runOrigins?: readonly BotTurnOrigin[]): Promise<{ text: string }> {
    const bot = await this.#deps.botForSession(callerSessionId);
    if (!bot) throw new BotInputError(`${ROUTINES_TOOL} is only available in a bot's chat.`);
    if (bot.archived) throw new BotConflictError("An archived bot has no routines to manage.");
    const action = params["action"];
    if (typeof action !== "string" || !(ROUTINE_ACTIONS as readonly string[]).includes(action)) throw new BotInputError("action must be list, add, update or remove.");
    const unknown = Object.keys(params).filter((key) => !FIELDS.has(key));
    if (unknown.length) throw new BotInputError(`${ROUTINES_TOOL} does not take ${unknown.join(", ")}.`);
    const own = (await this.#deps.automation.snapshot()).tasks.filter((task) => task.sessionId === bot.sessionId);
    const runPrompt = (await this.#deps.readSessions()).find((record) => record.id === callerSessionId)?.runPrompt;
    // Whose turn it is, for a routine removing itself: the run's originating input.
    const started = botTurnOrigin(runPrompt);
    if (action === "list") return { text: this.#list(bot, own) };
    if (action === "remove") return this.#remove(own, params, started);
    // Only the operator's turns, its routines' and HUI's kickoff may make more work. Another bot can't (that is how
    // bots would loop), nor a trigger (its event is text from outside HUI), and neither can a turn anything else
    // started: refused by default, not by name. Every input of the run counts, and the first that may not names the refusal.
    const origin = runTurnOrigins(runPrompt, runOrigins).find((each) => each.kind !== "operator" && each.kind !== "routine" && each.kind !== "kickoff") ?? started;
    switch (origin.kind) {
      case "operator":
      case "routine":
      case "kickoff":
        break;
      case "bot":
        throw new BotConflictError(`This turn answers a message from @${origin.handle}: another bot can't make you add or change routines. Ask the operator, or do it in your own turn.`);
      case "agent":
        throw new BotConflictError(`This turn answers a message from the session "${origin.title}": a session can't make you add or change routines. Ask the operator, or do it in your own turn.`);
      case "trigger":
        throw new BotConflictError(`This turn was started by the trigger "${origin.name}", whose event comes from outside HUI: it can't make you add or change routines. Ask the operator instead.`);
      case "imported":
        throw new BotConflictError("This is your first turn after you were imported, before the operator wrote: it can't add or change routines. Ask the operator once they reply.");
      default:
        throw new BotConflictError("Only the operator's messages and your routines can make you add or change routines, and something else started this turn. Ask the operator instead.");
    }
    return action === "add" ? this.#add(bot, own, params) : this.#update(own, params);
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #list(bot: BotRecord, own: readonly AutomationTask[]): string {
    if (!own.length) return `Now: ${new Date(this.#now()).toISOString()}. You have no routines.`;
    const active = own.filter((task) => task.enabled).length;
    return [
      `Now: ${new Date(this.#now()).toISOString()}. Your routines (${active} active of at most ${BOT_ROUTINE_LIMITS.active}):`,
      ...own.toSorted((a, b) => a.name.localeCompare(b.name)).map((task) => routineLine(task, bot)),
    ].join("\n");
  }

  /** The schedule a call names: exactly one of every, cron and at (`required`), or none on update. */
  #schedule(params: Record<string, unknown>, current: AutomationSchedule | undefined): AutomationSchedule | undefined {
    const given = (["every", "cron", "at"] as const).filter((key) => params[key] !== undefined);
    if (given.length > 1) throw new BotInputError("Give one of every, cron or at.");
    if (!given.length && !current) throw new BotInputError("Say when it runs: every (such as 5m, 2h or 1d), cron (five fields) or at (an ISO date and time).");
    const timezone = textField(params["timezone"], "timezone", 100);
    if (timezone && given[0] !== "cron" && !(given.length === 0 && current?.kind === "cron")) throw new BotInputError("timezone only applies to cron.");
    let schedule: unknown;
    if (given[0] === "every") {
      const match = typeof params["every"] === "string" ? DURATION.exec(params["every"].trim()) : null;
      if (!match) throw new BotInputError("every takes a number and s, m, h or d, such as 5m, 2h or 1d.");
      const everyMs = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
      if (everyMs < BOT_ROUTINE_LIMITS.minIntervalMs) throw new BotInputError("A routine runs at most once a minute: every must be at least 1m.");
      schedule = { kind: "every", everyMs };
    } else if (given[0] === "cron") {
      const expression = textField(params["cron"], "cron", 200)!;
      schedule = { kind: "cron", expression, timezone: timezone ?? (current?.kind === "cron" ? current.timezone : this.#timezone()) };
    } else if (given[0] === "at") {
      schedule = { kind: "at", at: textField(params["at"], "at", 100) };
    } else if (timezone && current?.kind === "cron") {
      schedule = { ...current, timezone };
    } else return undefined;
    try {
      return normalizeSchedule(schedule);
    } catch (error) {
      throw error instanceof AutomationInputError ? new BotInputError(error.message) : error;
    }
  }

  #timezone(): string {
    return this.#deps.timezone?.() ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  }

  /** `until` and `runs` as Automation takes them: on update `""` and `0` clear them (`null`); absent stays absent. */
  #limits(params: Record<string, unknown>, update: boolean): { until?: string | null; runs?: number | null } {
    const limits: { until?: string | null; runs?: number | null } = {};
    const until = params["until"];
    if (until !== undefined) {
      if (typeof until !== "string") throw new BotInputError("until must be an ISO date and time.");
      if (until.trim()) {
        const end = Date.parse(until.trim());
        if (!Number.isFinite(end)) throw new BotInputError("until must be an ISO date and time, such as 2026-10-07T18:00:00+02:00.");
        limits.until = new Date(end).toISOString();
      } else if (update) limits.until = null;
    }
    const runs = params["runs"];
    if (runs !== undefined) {
      if (!Number.isInteger(runs) || (runs as number) < 0 || (runs as number) > BOT_ROUTINE_LIMITS.runs) throw new BotInputError(`runs must be a whole number from 1 to ${BOT_ROUTINE_LIMITS.runs}${update ? " (0 clears the limit)" : ""}.`);
      if ((runs as number) > 0) limits.runs = runs as number;
      else if (update) limits.runs = null;
    }
    return limits;
  }

  #capacity(own: readonly AutomationTask[]): void {
    if (own.filter((task) => task.enabled).length >= BOT_ROUTINE_LIMITS.active) {
      throw new BotConflictError(`You already have ${BOT_ROUTINE_LIMITS.active} active routines, the most a bot may have. Remove or pause one first.`);
    }
  }

  /** A routine of its own by id, or by a name only one of them has; any other task is unknown. */
  #find(own: readonly AutomationTask[], params: Record<string, unknown>): AutomationTask {
    const target = textField(params["routine"], "routine", 200);
    if (!target) throw new BotInputError("Name the routine: its id or exact name, as list shows it.");
    const byId = own.find((task) => task.id === target);
    if (byId) return byId;
    const named = own.filter((task) => task.name === target);
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw new BotInputError(`${named.length} of your routines are named "${target}": use its id (${named.map((task) => task.id).join(", ")}).`);
    throw new BotInputError(`You have no routine named "${target}". ${own.length ? `Yours: ${own.map((task) => `"${task.name}"`).join(", ")}.` : "You have no routines."}`);
  }

  async #add(bot: BotRecord, own: readonly AutomationTask[], params: Record<string, unknown>): Promise<{ text: string }> {
    if (params["routine"] !== undefined || params["enabled"] !== undefined) throw new BotInputError("add takes no routine or enabled: a new routine is on.");
    const name = textField(params["name"], "name", 200);
    const prompt = textField(params["prompt"], "prompt", 20_000);
    if (!name || !prompt) throw new BotInputError("add needs a name and a prompt.");
    const same = own.find((task) => task.name === name);
    if (same) throw new BotConflictError(`You already have a routine named "${name}" (id ${same.id}): update it, or pick another name.`);
    const schedule = this.#schedule(params, undefined)!;
    const limits = this.#limits(params, false);
    this.#capacity(own);
    const task = await asInput(() => this.#deps.automation.create(
      { name, description: "", sessionId: bot.sessionId, prompt, schedule, enabled: true, ...limits },
      { createdBy: { kind: "bot", botId: bot.id, handle: bot.handle } },
    ));
    const limitsLine = limitsText(task);
    return { text: `Added the routine "${task.name}" (id ${task.id}): ${routineScheduleText(task.schedule)}, first run ${task.nextRunAt ?? "never"}${limitsLine ? `; ${limitsLine}, then HUI deletes it` : ""}. It arrives in this chat as "[routine: ${task.name}] …".` };
  }

  async #update(own: readonly AutomationTask[], params: Record<string, unknown>): Promise<{ text: string }> {
    const task = this.#find(own, params);
    const changes = ["name", "prompt", "every", "cron", "timezone", "at", "until", "runs", "enabled"].filter((key) => params[key] !== undefined);
    if (!changes.length) throw new BotInputError("Say what to change: name, prompt, every, cron, timezone, at, until, runs or enabled.");
    if (params["enabled"] !== undefined && typeof params["enabled"] !== "boolean") throw new BotInputError("enabled must be true or false.");
    const name = textField(params["name"], "name", 200) ?? task.name;
    if (name !== task.name && own.some((other) => other.id !== task.id && other.name === name)) throw new BotConflictError(`You already have a routine named "${name}".`);
    const enabled = typeof params["enabled"] === "boolean" ? params["enabled"] : task.enabled;
    if (enabled && !task.enabled) this.#capacity(own);
    const updated = await asInput(() => this.#deps.automation.update(task.id, {
      name, description: task.description, sessionId: task.sessionId,
      prompt: textField(params["prompt"], "prompt", 20_000) ?? task.prompt,
      schedule: this.#schedule(params, task.schedule) ?? task.schedule,
      enabled, timeoutSeconds: task.timeoutSeconds,
      ...this.#limits(params, true),
    }));
    const limitsLine = limitsText(updated);
    return { text: `Updated the routine "${updated.name}" (id ${updated.id}): ${routineScheduleText(updated.schedule)}, ${updated.enabled ? `next ${updated.nextRunAt ?? "none planned"}` : "paused"}${limitsLine ? `; ${limitsLine}` : ""}.` };
  }

  /**
   * Removes one of its routines. From that routine's own turn the routine goes and the turn finishes; a run of it
   * that waits behind another turn is withdrawn first, so its message never arrives.
   */
  async #remove(own: readonly AutomationTask[], params: Record<string, unknown>, origin: ReturnType<typeof botTurnOrigin>): Promise<{ text: string }> {
    const task = this.#find(own, params);
    const runId = this.#deps.automation.activeRun(task.id);
    const ownTurn = origin.kind === "routine" && origin.name === task.name;
    if (runId && !ownTurn) await this.#deps.automation.cancel(runId).catch(() => undefined);
    await this.#deps.automation.remove(task.id, { whileRunning: true });
    return { text: ownTurn && runId
      ? `Removed the routine "${task.name}": this turn is its last.`
      : `Removed the routine "${task.name}".` };
  }
}
