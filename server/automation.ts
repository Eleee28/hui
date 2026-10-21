/**
 * HUI's scheduled prompts: the task and run registry in one JSON file, the at/every/cron schedule rules, and
 * the in-process timer that fires due tasks. Sending a prompt to its session is the injected executor's job:
 * the service only decides when a task runs and records how each run ended. Runs a previous gateway left
 * queued or running are reconciled through a saved delivery, never blindly sent again.
 * `executeAutomationTask` is the gateway's executor: it prompts the target session, or hands a bot's routine to
 * the bot service, and waits for the run to settle.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { recordDiagnosticEvent } from "./observability.ts";
import { BotStoreError, BotWorkerOfflineError } from "./bots/bots.ts";
import type { LiveSessions } from "./sessions/live-sessions.ts";
import { readRegistry, type SessionRecord } from "./sessions/sessions.ts";
import type { BotRecord } from "./bots-format.ts";

import type {
  AutomationCreator,
  AutomationFailureKind,
  AutomationRun,
  AutomationSchedule,
  AutomationSnapshot,
  AutomationTask,
  AutomationTaskInput,
} from "./api/automation.ts";

export type { AutomationSchedule, AutomationRunStatus, AutomationCreator, AutomationTask, AutomationRun, AutomationFailureKind, AutomationSnapshot, AutomationTaskInput } from "./api/automation.ts";

const STORE_VERSION = 1;
const MAX_RUNS = 500;
const MIN_INTERVAL_MS = 60_000;
const MAX_TIMEOUT_SECONDS = 86_400;
/** The most runs a temporary task may be given. */
export const MAX_TASK_RUNS = 1_000;

type AutomationFile = {
  version: number;
  tasks: AutomationTask[];
  runs: AutomationRun[];
};

export type AutomationExecution = {
  summary?: string;
};

export type AutomationExecutor = (
  task: AutomationTask,
  signal: AbortSignal,
  context: AutomationExecutionContext,
) => Promise<AutomationExecution>;

export type AutomationExecutionContext = {
  run: AutomationRun;
  /** Flush before dispatch. A failed checkpoint must prevent sending the prompt. */
  checkpoint: (delivery: NonNullable<AutomationRun["delivery"]>) => Promise<void>;
};

/** Only an executor that knows input was NOT dispatched may request another attempt. */
export class AutomationRetryError extends Error {
  readonly kind: AutomationFailureKind;
  constructor(message: string, kind: AutomationFailureKind) {
    super(message);
    this.kind = kind;
  }
}

const RETRY_DELAYS = [30_000, 120_000];
/** Shutdown detaches observers; it must not cancel work the runtime will resume. */
export const AUTOMATION_SUSPENDED = "HUI automation scheduler suspended";

/** Labels explain a failure; they never decide that replaying a prompt is safe. */
export function automationFailureKind(error: unknown): AutomationFailureKind {
  if (error instanceof AutomationRetryError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  if (/quota|rate.?limit|too many requests|\b429\b|insufficient.credit|billing/iu.test(message)) return "rate-limit";
  if (/unauthori[sz]ed|forbidden|api.?key|authentication|credential|unknown model|no[_ ]model|not configured|archived|no longer exists|could not start/iu.test(message)) return "configuration";
  if (/disconnect|reconnect|offline|unreachable|connection/iu.test(message)) return "connection";
  if (/restart|interrupted|not delivered|could not.*recover|cannot.*recover/iu.test(message)) return "interrupted";
  if (/timed? ?out|timeout/iu.test(message)) return "timeout";
  if (/temporar|overload|service unavailable|\b50[234]\b/iu.test(message)) return "transient";
  return "unknown";
}

export class AutomationInputError extends Error {}
export class AutomationNotFoundError extends Error {}
export class AutomationConflictError extends Error {}
export class AutomationStoreError extends Error {}

type Clock = {
  now: () => number;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
};

const SYSTEM_CLOCK: Clock = {
  now: Date.now,
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isSchedule(value: unknown): value is AutomationSchedule {
  if (!isRecord(value)) return false;
  if (value["kind"] === "at") return typeof value["at"] === "string";
  if (value["kind"] === "every") return typeof value["everyMs"] === "number";
  return (
    value["kind"] === "cron" &&
    typeof value["expression"] === "string" &&
    typeof value["timezone"] === "string"
  );
}

function parseCreator(value: unknown): AutomationCreator | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "operator") return { kind: "operator" };
  const botId = string(value["botId"]);
  return value["kind"] === "bot" && botId ? { kind: "bot", botId, handle: string(value["handle"]) } : undefined;
}

/** A task's optional fields (who made it, its limits), as stored: a value that is not one of them is left out, so a
 * task written before them, or edited by hand, still loads. */
function parseTaskExtras(value: Record<string, unknown>): Pick<AutomationTask, "createdBy" | "until" | "runsLeft"> {
  const createdBy = parseCreator(value["createdBy"]);
  const until = typeof value["until"] === "string" && Number.isFinite(Date.parse(value["until"])) ? value["until"] : undefined;
  const runsLeft = Number.isSafeInteger(value["runsLeft"]) && (value["runsLeft"] as number) >= 0 ? value["runsLeft"] as number : undefined;
  return { ...(createdBy ? { createdBy } : {}), ...(until ? { until } : {}), ...(runsLeft !== undefined ? { runsLeft } : {}) };
}

function parseTask(value: unknown): AutomationTask | undefined {
  if (!isRecord(value) || !isSchedule(value["schedule"])) return undefined;
  const id = string(value["id"]);
  const name = string(value["name"]);
  const sessionId = string(value["sessionId"]);
  const prompt = string(value["prompt"]);
  const createdAt = string(value["createdAt"]);
  const updatedAt = string(value["updatedAt"]);
  const timeoutSeconds = value["timeoutSeconds"];
  if (
    !id ||
    !name ||
    !sessionId ||
    !prompt ||
    !createdAt ||
    !updatedAt ||
    typeof timeoutSeconds !== "number" ||
    (value["nextRunAt"] !== null && typeof value["nextRunAt"] !== "string")
  ) return undefined;
  return {
    id,
    name,
    description: string(value["description"]),
    sessionId,
    prompt,
    schedule: value["schedule"],
    enabled: value["enabled"] === true,
    timeoutSeconds,
    createdAt,
    updatedAt,
    nextRunAt: value["nextRunAt"],
    ...parseTaskExtras(value),
  };
}

const RUN_STATUSES = new Set(["queued", "running", "completed", "failed", "skipped", "cancelled"]);
const FAILURE_KINDS = new Set(["connection", "rate-limit", "configuration", "transient", "interrupted", "timeout", "unknown"]);

function parseRunRecovery(value: Record<string, unknown>): Partial<AutomationRun> {
  const delivery = value["delivery"];
  const failure = value["failure"];
  return {
    ...(Number.isSafeInteger(value["attempt"]) && (value["attempt"] as number) >= 1 ? { attempt: value["attempt"] as number } : {}),
    ...(typeof value["retryAt"] === "string" && Number.isFinite(Date.parse(value["retryAt"])) ? { retryAt: value["retryAt"] } : {}),
    ...(typeof value["deadlineAt"] === "string" && Number.isFinite(Date.parse(value["deadlineAt"])) ? { deadlineAt: value["deadlineAt"] } : {}),
    ...(isRecord(delivery) && typeof delivery["text"] === "string" && delivery["text"].length > 0 && Number.isSafeInteger(delivery["before"]) && (delivery["before"] as number) >= 0 ? {
      delivery: { text: delivery["text"], before: delivery["before"] as number, ...(typeof delivery["requestId"] === "string" ? { requestId: delivery["requestId"] } : {}) },
    } : {}),
    ...(isRecord(failure) && typeof failure["kind"] === "string" && FAILURE_KINDS.has(failure["kind"]) && typeof failure["needsAttention"] === "boolean" ? {
      failure: { kind: failure["kind"] as AutomationFailureKind, needsAttention: failure["needsAttention"] },
    } : {}),
  };
}

function parseRun(value: unknown): AutomationRun | undefined {
  if (!isRecord(value)) return undefined;
  const id = string(value["id"]);
  const taskId = string(value["taskId"]);
  const taskName = string(value["taskName"]);
  const sessionId = string(value["sessionId"]);
  const source = value["source"];
  const status = value["status"];
  const createdAt = string(value["createdAt"]);
  if (
    !id || !taskId || !taskName || !sessionId || !createdAt ||
    (source !== "manual" && source !== "scheduled") ||
    typeof status !== "string" || !RUN_STATUSES.has(status)
  ) return undefined;
  return {
    id,
    taskId,
    taskName,
    sessionId,
    source,
    status: status as AutomationRun["status"],
    createdAt,
    ...(typeof value["startedAt"] === "string" ? { startedAt: value["startedAt"] } : {}),
    ...(typeof value["finishedAt"] === "string" ? { finishedAt: value["finishedAt"] } : {}),
    ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    ...(typeof value["error"] === "string" ? { error: value["error"] } : {}),
    ...parseRunRecovery(value),
  };
}

function int(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new AutomationInputError(`Invalid cron value: ${value}`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) {
    throw new AutomationInputError(`Cron value ${value} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function cronField(source: string, minimum: number, maximum: number, weekday = false): Set<number> {
  const values = new Set<number>();
  const addRange = (start: number, end: number, step: number) => {
    if (start > end) throw new AutomationInputError(`Invalid cron range: ${start}-${end}`);
    for (let value = start; value <= end; value += step) values.add(weekday && value === 7 ? 0 : value);
  };
  for (const part of source.split(",")) {
    const [base = "", stepSource] = part.split("/");
    const step = stepSource === undefined ? 1 : int(stepSource, 1, maximum - minimum + 1);
    if (base === "*") {
      addRange(minimum, maximum, step);
      continue;
    }
    const range = base.split("-");
    if (range.length === 2) {
      addRange(int(range[0] ?? "", minimum, maximum), int(range[1] ?? "", minimum, maximum), step);
      continue;
    }
    if (range.length !== 1 || stepSource !== undefined) {
      throw new AutomationInputError(`Invalid cron field: ${part}`);
    }
    const value = int(base, minimum, maximum);
    values.add(weekday && value === 7 ? 0 : value);
  }
  return values;
}

type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
};

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new AutomationInputError("Cron expressions must have five fields: minute hour day month weekday.");
  }
  return {
    minute: cronField(fields[0] ?? "", 0, 59),
    hour: cronField(fields[1] ?? "", 0, 23),
    day: cronField(fields[2] ?? "", 1, 31),
    month: cronField(fields[3] ?? "", 1, 12),
    weekday: cronField(fields[4] ?? "", 0, 7, true),
    anyDay: fields[2] === "*",
    anyWeekday: fields[4] === "*",
  };
}

function timezoneParts(timestamp: number, timezone: string): {
  minute: number; hour: number; day: number; month: number; weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.find((part) => part.type === "weekday")?.value ?? "",
  );
  return { minute: value("minute"), hour: value("hour"), day: value("day"), month: value("month"), weekday };
}

export function validateTimezone(timezone: string): string {
  const trimmed = timezone.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(0);
  } catch {
    throw new AutomationInputError(`Unknown timezone: ${trimmed}`);
  }
  return trimmed;
}

export function nextCronAt(expression: string, timezone: string, afterMs: number): number {
  const cron = parseCron(expression);
  const zone = validateTimezone(timezone);
  let candidate = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
  const limit = candidate + 366 * 24 * 60 * 60_000;
  for (; candidate <= limit; candidate += 60_000) {
    const parts = timezoneParts(candidate, zone);
    const dayMatch = cron.day.has(parts.day);
    const weekdayMatch = cron.weekday.has(parts.weekday);
    const calendarMatch = cron.anyDay
      ? weekdayMatch
      : cron.anyWeekday
        ? dayMatch
        : dayMatch || weekdayMatch;
    if (
      cron.minute.has(parts.minute) && cron.hour.has(parts.hour) &&
      cron.month.has(parts.month) && calendarMatch
    ) return candidate;
  }
  throw new AutomationInputError("Cron expression has no occurrence in the next 366 days.");
}

export function normalizeSchedule(value: unknown): AutomationSchedule {
  if (!isRecord(value)) throw new AutomationInputError("A schedule is required.");
  if (value["kind"] === "at") {
    const timestamp = Date.parse(string(value["at"]));
    if (!Number.isFinite(timestamp)) throw new AutomationInputError("Run at must be a valid date and time.");
    return { kind: "at", at: new Date(timestamp).toISOString() };
  }
  if (value["kind"] === "every") {
    const everyMs = value["everyMs"];
    if (!Number.isSafeInteger(everyMs) || (everyMs as number) < MIN_INTERVAL_MS) {
      throw new AutomationInputError("Repeat interval must be at least one minute.");
    }
    return { kind: "every", everyMs: everyMs as number };
  }
  if (value["kind"] === "cron") {
    const expression = string(value["expression"]).trim();
    const timezone = validateTimezone(string(value["timezone"]));
    parseCron(expression);
    return { kind: "cron", expression, timezone };
  }
  throw new AutomationInputError("Schedule kind must be at, every, or cron.");
}

export function nextScheduleAt(schedule: AutomationSchedule, afterMs: number): number | null {
  if (schedule.kind === "at") {
    const at = Date.parse(schedule.at);
    return at > afterMs ? at : null;
  }
  if (schedule.kind === "every") return afterMs + schedule.everyMs;
  return nextCronAt(schedule.expression, schedule.timezone, afterMs);
}

/** A task's next time after `afterMs` before its end (`until`); null once it has none. */
export function nextRunWithin(schedule: AutomationSchedule, afterMs: number, until: string | undefined): number | null {
  const next = nextScheduleAt(schedule, afterMs);
  return next === null || until === undefined || next < Date.parse(until) ? next : null;
}

/**
 * A temporary task HUI deletes now: its end (`until`) has come, whether a run of it is still going (`active`) or not,
 * or its last run is over. Deleting it is the one write that also turns it off: it never runs again.
 */
export function taskExpired(task: Pick<AutomationTask, "until" | "runsLeft">, nowMs: number, active: boolean): boolean {
  if (task.until !== undefined && Date.parse(task.until) <= nowMs) return true;
  return task.runsLeft === 0 && !active;
}

/** A new end must be in the future and after the task's next run (`next`, null when it has none), or it never runs. */
function checkUntil(until: string | undefined, next: number | null, nowMs: number): void {
  if (until === undefined) return;
  const end = Date.parse(until);
  if (end <= nowMs) throw new AutomationInputError("Until must be in the future.");
  if (next !== null && next >= end) throw new AutomationInputError("Until must come after the task's next run, or it would never run.");
}

const iso = (timestamp: number) => new Date(timestamp).toISOString();
const isoOrNull = (timestamp: number | null) => (timestamp === null ? null : iso(timestamp));

/** A deleted temporary task can still have an accepted input to observe. This task is NEVER dispatched again. */
function observationTask(run: AutomationRun): AutomationTask {
  return {
    id: run.taskId, name: run.taskName, sessionId: run.sessionId, prompt: run.delivery!.text,
    description: "", enabled: false, nextRunAt: null, schedule: { kind: "at", at: run.createdAt },
    createdAt: run.createdAt, updatedAt: run.createdAt, timeoutSeconds: 900,
  };
}

function text(value: unknown, label: string, maximum: number, required = true): string {
  if (typeof value !== "string") throw new AutomationInputError(`${label} must be text.`);
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > maximum) {
    throw new AutomationInputError(`${label} must be ${required ? `1-${maximum}` : `at most ${maximum}`} characters.`);
  }
  return trimmed;
}

/** `until`: absent stays absent (on update, the task keeps its own), `null` clears it, else an ISO date and time. */
function untilInput(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new AutomationInputError("Until must be a valid date and time.");
  return iso(timestamp);
}

/** `runs`: absent stays absent (on update, the runs left stay), `null` clears the limit, else 1 to `MAX_TASK_RUNS`. */
function runsInput(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_TASK_RUNS) {
    throw new AutomationInputError(`Runs must be a whole number from 1 to ${MAX_TASK_RUNS}.`);
  }
  return value as number;
}

export function normalizeTaskInput(value: unknown): AutomationTaskInput {
  if (!isRecord(value)) throw new AutomationInputError("Expected a task object.");
  const timeoutSeconds = value["timeoutSeconds"] === undefined ? 900 : value["timeoutSeconds"];
  if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 10 || (timeoutSeconds as number) > MAX_TIMEOUT_SECONDS) {
    throw new AutomationInputError(`Timeout must be between 10 and ${MAX_TIMEOUT_SECONDS} seconds.`);
  }
  if (value["enabled"] !== undefined && typeof value["enabled"] !== "boolean") {
    throw new AutomationInputError("Enabled must be a boolean.");
  }
  return {
    name: text(value["name"], "Name", 200),
    description: text(value["description"] ?? "", "Description", 500, false),
    sessionId: text(value["sessionId"], "Session", 200),
    prompt: text(value["prompt"], "Prompt", 20_000),
    schedule: normalizeSchedule(value["schedule"]),
    enabled: value["enabled"] !== false,
    timeoutSeconds: timeoutSeconds as number,
    ...(value["until"] !== undefined ? { until: untilInput(value["until"]) } : {}),
    ...(value["runs"] !== undefined ? { runs: runsInput(value["runs"]) } : {}),
  };
}

export class AutomationService {
  readonly #file: string;
  readonly #execute: AutomationExecutor;
  readonly #clock: Clock;
  #mutation = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active = new Map<string, { runId: string; abort: AbortController; executing: boolean }>();
  #started = false;
  #starting: Promise<void> | undefined;
  #generation = 0;
  #scheduleVersion = 0;

  constructor(file: string, execute: AutomationExecutor, clock: Clock = SYSTEM_CLOCK) {
    this.#file = file;
    this.#execute = execute;
    this.#clock = clock;
  }

  async #read(): Promise<AutomationFile> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isRecord(error) && error["code"] === "ENOENT") return { version: STORE_VERSION, tasks: [], runs: [] };
      throw new AutomationStoreError("HUI's automation registry could not be read.", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AutomationStoreError("HUI's automation registry is not valid JSON.", { cause: error });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["tasks"]) || !Array.isArray(parsed["runs"])) {
      throw new AutomationStoreError("HUI's automation registry has an invalid shape.");
    }
    const tasks = parsed["tasks"].map(parseTask);
    const runs = parsed["runs"].map(parseRun);
    if (tasks.some((task) => !task) || runs.some((run) => !run)) {
      throw new AutomationStoreError("HUI's automation registry contains an invalid record.");
    }
    return { version: STORE_VERSION, tasks: tasks as AutomationTask[], runs: runs as AutomationRun[] };
  }

  async #write(file: AutomationFile): Promise<void> {
    try {
      await mkdir(dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await rename(temporary, this.#file);
    } catch (error) {
      throw new AutomationStoreError("HUI's automation registry could not be written.", { cause: error });
    }
  }

  #update(mutate: (file: AutomationFile) => AutomationFile): Promise<AutomationFile> {
    const operation = this.#mutation.then(async () => {
      const current = await this.#read();
      const next = mutate(current);
      await this.#write({ ...next, version: STORE_VERSION, runs: next.runs.slice(0, MAX_RUNS) });
      return next;
    });
    this.#mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().catch((error: unknown) => { this.#started = false; this.#active.clear(); throw error; }).finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const generation = this.#generation;
    const nowMs = this.#clock.now();
    const now = iso(nowMs);
    const file = await this.#update((file) => {
      if (generation !== this.#generation) return file;
      const runs = file.runs.map((run): AutomationRun => {
        if (run.status !== "queued" && run.status !== "running") return run;
        const task = file.tasks.find((task) => task.id === run.taskId) ?? (run.delivery ? observationTask(run) : undefined);
        const deadline = run.deadlineAt ?? (task ? iso(Date.parse(run.createdAt) + task.timeoutSeconds * 1000) : now);
        // A saved delivery can only be observed, not sent anew. A retry was explicitly safe before dispatch.
        if (task && (run.delivery || (run.retryAt && Date.parse(deadline) > nowMs &&
          (task.until === undefined || Date.parse(task.until) > nowMs)))) {
          this.#active.set(task.id, { runId: run.id, abort: new AbortController(), executing: false });
          return { ...run, deadlineAt: deadline };
        }
        return {
          ...run, status: "failed", finishedAt: now,
          error: "HUI restarted before this run could be reconciled. Check its chat before running it again.",
          failure: { kind: "interrupted", needsAttention: true },
        };
      });
      return {
        ...file, runs,
        // Keep the last temporary run's task until its recovered observer settles it.
        tasks: file.tasks.filter((task) => !taskExpired(task, nowMs, this.#active.has(task.id)) || this.#active.has(task.id)),
      };
    });
    if (generation !== this.#generation) return;
    this.#started = true;
    for (const run of file.runs) {
      if (this.#active.get(run.taskId)?.runId !== run.id) continue;
      const task = file.tasks.find((task) => task.id === run.taskId) ?? (run.delivery ? observationTask(run) : undefined);
      if (task && (!run.retryAt || Date.parse(run.retryAt) <= nowMs)) this.#launchRun(task, run);
    }
    await this.#wake();
  }

  async snapshot(): Promise<AutomationSnapshot> {
    await this.start();
    const file = await this.#read();
    const nextWake = [
      ...file.tasks.filter((task) => task.enabled && task.nextRunAt).map((task) => task.nextRunAt as string),
      ...file.runs.filter((run) => run.status === "queued" && run.retryAt).map((run) => run.retryAt as string),
    ]
      .toSorted()[0] ?? null;
    return {
      scheduler: { enabled: true, activeRuns: this.#active.size, nextWakeAt: nextWake },
      tasks: file.tasks.toSorted((a, b) => a.name.localeCompare(b.name)),
      runs: file.runs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  /**
   * `createdBy`: who makes it; the operator unless a bot's `routines` tool says otherwise. A body never names its
   * maker, so no client of the routes can pass a task off as a bot's.
   */
  async create(value: unknown, options: { createdBy?: AutomationCreator } = {}): Promise<AutomationTask> {
    const { until: untilInput, runs, ...input } = normalizeTaskInput(value);
    const nowMs = this.#clock.now();
    if (input.schedule.kind === "at" && Date.parse(input.schedule.at) <= nowMs) {
      throw new AutomationInputError("Run at must be in the future.");
    }
    const until = untilInput ?? undefined;
    const first = nextScheduleAt(input.schedule, nowMs);
    checkUntil(until, first, nowMs);
    const now = iso(nowMs);
    const task: AutomationTask = {
      id: randomUUID(), ...input, description: input.description ?? "", enabled: input.enabled !== false,
      timeoutSeconds: input.timeoutSeconds ?? 900, createdAt: now, updatedAt: now,
      nextRunAt: input.enabled === false ? null : isoOrNull(first),
      createdBy: options.createdBy ?? { kind: "operator" },
      ...(until ? { until } : {}),
      ...(typeof runs === "number" ? { runsLeft: runs } : {}),
    };
    await this.#update((file) => ({ ...file, tasks: [...file.tasks, task] }));
    this.#reschedule();
    return task;
  }

  /** Replaces what the task does and when. Who made it stays; `until` and `runs` change only when given (`null`
   * clears them), so a client from before them keeps a task's limits. */
  async update(id: string, value: unknown): Promise<AutomationTask> {
    const { until: untilInput, runs, ...input } = normalizeTaskInput(value);
    const nowMs = this.#clock.now();
    if (input.schedule.kind === "at" && input.enabled !== false && Date.parse(input.schedule.at) <= nowMs) {
      throw new AutomationInputError("Run at must be in the future.");
    }
    let updated: AutomationTask | undefined;
    await this.#update((file) => {
      const current = file.tasks.find((task) => task.id === id);
      if (!current) throw new AutomationNotFoundError(`Unknown automation task: ${id}`);
      if (this.#active.has(id) && (input.sessionId !== current.sessionId || input.prompt !== current.prompt || input.name !== current.name)) {
        throw new AutomationConflictError("Stop the active run before changing its target, name or prompt.");
      }
      const enabled = input.enabled !== false;
      const until = untilInput === undefined ? current.until : untilInput ?? undefined;
      const runsLeft = runs === undefined ? current.runsLeft : runs ?? undefined;
      if (untilInput) checkUntil(until, enabled ? nextScheduleAt(input.schedule, nowMs) : null, nowMs);
      const { until: _until, runsLeft: _runsLeft, ...kept } = current;
      updated = {
        ...kept, ...input, description: input.description ?? "", enabled,
        timeoutSeconds: input.timeoutSeconds ?? 900, updatedAt: iso(nowMs),
        // A task with no runs left (its last run going) is not planned again.
        nextRunAt: !enabled || runsLeft === 0 ? null : isoOrNull(nextRunWithin(input.schedule, nowMs, until)),
        ...(until ? { until } : {}),
        ...(runsLeft !== undefined ? { runsLeft } : {}),
      };
      return { ...file, tasks: file.tasks.map((task) => task.id === id ? updated! : task) };
    });
    this.#reschedule();
    return updated!;
  }

  /** The run of the task going now, if any. */
  activeRun(id: string): string | undefined {
    return this.#active.get(id)?.runId;
  }

  /**
   * Deletes a task. A task with a run going is refused unless `whileRunning`: then the task goes and its run finishes
   * on its own, as when a bot removes a routine from that routine's own turn.
   */
  async remove(id: string, options: { whileRunning?: boolean } = {}): Promise<void> {
    if (this.#active.has(id) && !options.whileRunning) throw new AutomationConflictError("Stop the active run before deleting this task.");
    await this.#update((file) => {
      if (!file.tasks.some((task) => task.id === id)) throw new AutomationNotFoundError(`Unknown automation task: ${id}`);
      return { ...file, tasks: file.tasks.filter((task) => task.id !== id) };
    });
    this.#reschedule();
  }

  async run(id: string, source: AutomationRun["source"] = "manual"): Promise<AutomationRun> {
    await this.start();
    if (this.#active.has(id)) throw new AutomationConflictError("This task is already running.");
    let run: AutomationRun | undefined;
    let task: AutomationTask | undefined;
    try { await this.#update((file) => {
      const found = file.tasks.find((item) => item.id === id);
      if (!found) throw new AutomationNotFoundError(`Unknown automation task: ${id}`);
      if (this.#active.has(id)) throw new AutomationConflictError("This task is already running.");
      const nowMs = this.#clock.now();
      if (found.runsLeft === 0) throw new AutomationConflictError("This task has no runs left.");
      if (found.until !== undefined && Date.parse(found.until) <= nowMs) throw new AutomationConflictError("This task has ended.");
      // A temporary task's run counts as it starts (a skipped one gives it back); after its last, nothing is planned.
      task = found.runsLeft === undefined ? found
        : { ...found, runsLeft: found.runsLeft - 1, ...(found.runsLeft === 1 ? { nextRunAt: null } : {}) };
      run = {
        id: randomUUID(), taskId: found.id, taskName: found.name, sessionId: found.sessionId,
        source, status: "queued", createdAt: iso(nowMs),
        attempt: 1, deadlineAt: iso(nowMs + found.timeoutSeconds * 1000),
      };
      this.#active.set(id, { runId: run.id, abort: new AbortController(), executing: false });
      return { ...file, tasks: file.tasks.map((item) => item.id === id ? task! : item), runs: [run, ...file.runs] };
    }); } catch (error) {
      if (run && this.#active.get(id)?.runId === run.id) this.#active.delete(id);
      throw error;
    }
    this.#launchRun(task!, run!);
    return run!;
  }

  async cancel(runId: string): Promise<void> {
    const found = [...this.#active.entries()].find(([, entry]) => entry.runId === runId);
    const active = found?.[1];
    if (!active) throw new AutomationConflictError("That run is no longer active.");
    active.abort.abort();
    if (!active.executing) {
      await this.#finish(found![0], runId, "cancelled", undefined, "Run cancelled.");
      this.#active.delete(found![0]);
      this.#reschedule();
    }
  }

  async #executeRun(task: AutomationTask, run: AutomationRun): Promise<void> {
    const active = this.#active.get(task.id);
    if (!active || active.runId !== run.id || active.executing || active.abort.signal.aborted) return;
    active.executing = true;
    const { abort } = active;
    const generation = this.#generation;
    let current = run;
    let retrying = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const nowMs = this.#clock.now();
      const remaining = Date.parse(run.deadlineAt ?? iso(Date.parse(run.createdAt) + task.timeoutSeconds * 1000)) - nowMs;
      if (remaining <= 0) {
        timedOut = true;
        // Reacquire an accepted receipt with an aborted signal so the executor cancels only its original input.
        if (run.delivery) abort.abort();
        else throw new Error("The run's timeout elapsed before it could finish.");
      }
      if (!run.delivery && task.until !== undefined && Date.parse(task.until) <= nowMs) throw new Error("This temporary task ended before its retry could be delivered.");
      const { retryAt: _retryAt, error: _error, failure: _failure, ...kept } = current;
      current = { ...kept, status: "running", startedAt: current.startedAt ?? iso(nowMs), attempt: (run.attempt ?? 1) + (run.retryAt ? 1 : 0) };
      await this.#update((file) => ({ ...file, runs: file.runs.map((item) => item.id === run.id ? current : item) }));
      if (!this.#started || generation !== this.#generation) return;
      if (abort.signal.aborted && !timedOut) throw new DOMException("Run cancelled.", "AbortError");
      if (remaining > 0) {
        timer = setTimeout(() => { timedOut = true; abort.abort(); }, remaining);
        timer.unref();
      }
      const result = await this.#execute(task, abort.signal, {
        run: current,
        checkpoint: async (delivery) => {
          if (abort.signal.aborted || !this.#started || generation !== this.#generation) throw new DOMException("Run cancelled.", "AbortError");
          current = { ...current, delivery };
          await this.#update((file) => ({ ...file, runs: file.runs.map((item) => item.id === run.id ? current : item) }));
        },
      });
      if (!this.#started || generation !== this.#generation) return;
      await this.#finish(task.id, run.id, timedOut ? "failed" : abort.signal.aborted ? "cancelled" : "completed", result.summary,
        timedOut ? "Run timed out. Check its chat before running it again." : undefined,
        timedOut ? { kind: "timeout", needsAttention: true } : undefined);
    } catch (error) {
      if (!this.#started || generation !== this.#generation) return;
      const cancelled = abort.signal.aborted;
      const kind = timedOut ? "timeout" : automationFailureKind(error);
      const delay = RETRY_DELAYS[(current.attempt ?? 1) - 1];
      const retryAt = delay === undefined ? undefined : this.#clock.now() + delay;
      const deadline = Date.parse(current.deadlineAt ?? iso(Date.parse(current.createdAt) + task.timeoutSeconds * 1000));
      if (!cancelled && !current.delivery && error instanceof AutomationRetryError && retryAt !== undefined && retryAt < deadline &&
        (task.until === undefined || retryAt < Date.parse(task.until))) {
        const queued: AutomationRun = {
          ...current, status: "queued", retryAt: iso(retryAt), error: error.message,
          failure: { kind, needsAttention: false },
        };
        await this.#update((file) => ({ ...file, runs: file.runs.map((item) => item.id === run.id ? queued : item) }));
        if (!this.#started || generation !== this.#generation) return;
        if (abort.signal.aborted) {
          await this.#finish(task.id, run.id, "cancelled", undefined, "Run cancelled.");
          return;
        }
        retrying = true;
        return;
      }
      await this.#finish(
        task.id,
        run.id,
        timedOut ? "failed" : cancelled ? "cancelled" : error instanceof AutomationConflictError ? "skipped" : "failed",
        undefined,
        timedOut ? "Run timed out. Check its chat before running it again." : cancelled ? "Run cancelled." : error instanceof Error ? error.message : "Automation failed.",
        !cancelled || timedOut ? { kind, needsAttention: true } : undefined,
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (this.#active.get(task.id) === active) {
        if (retrying) active.executing = false;
        else this.#active.delete(task.id);
      }
      this.#reschedule();
    }
  }

  #launchRun(task: AutomationTask, run: AutomationRun): void {
    void this.#executeRun(task, run).catch((error: unknown) => this.#reportFailure(error));
  }

  #reportFailure(error: unknown): void {
    recordDiagnosticEvent({ area: "automation", level: "error", action: "scheduler_failed",
      summary: "The scheduler could not record or advance a run. Check its registry before running it again.",
      detail: error instanceof Error ? error.message : String(error) });
  }

  /** Records how a run ended. A skipped run gives a temporary task its run back; a temporary task whose last run this
   * was, or whose end came meanwhile, goes. */
  async #finish(
    taskId: string,
    runId: string,
    status: AutomationRun["status"],
    summary?: string,
    error?: string,
    failure?: AutomationRun["failure"],
  ): Promise<void> {
    const nowMs = this.#clock.now();
    const finishedAt = iso(nowMs);
    let changed = false;
    await this.#update((file) => {
      const runs = file.runs.map((run): AutomationRun => {
        if (run.id !== runId) return run;
        const { retryAt: _retryAt, error: _error, failure: _failure, ...kept } = run;
        return { ...kept, status, finishedAt, ...(summary ? { summary } : {}), ...(error ? { error } : {}), ...(failure ? { failure } : {}) };
      });
      const current = file.tasks.find((task) => task.id === taskId);
      if (!current) return { ...file, runs };
      const task = status === "skipped" && current.runsLeft !== undefined
        ? {
          ...current, runsLeft: current.runsLeft + 1,
          nextRunAt: current.nextRunAt ?? (current.enabled ? isoOrNull(nextRunWithin(current.schedule, nowMs, current.until)) : null),
        }
        : current;
      const expired = taskExpired(task, nowMs, false);
      changed = expired || task !== current;
      return {
        ...file, runs,
        tasks: expired ? file.tasks.filter((item) => item.id !== taskId) : file.tasks.map((item) => item.id === taskId ? task : item),
      };
    });
    if (changed) this.#reschedule();
  }

  async #wake(): Promise<void> {
    if (!this.#started) return;
    const nowMs = this.#clock.now();
    let due: AutomationTask[] = [];
    const retries: Array<{ task: AutomationTask; run: AutomationRun }> = [];
    await this.#update((file) => {
      for (const run of file.runs) {
        const active = this.#active.get(run.taskId);
        const task = file.tasks.find((task) => task.id === run.taskId);
        if (task && active?.runId === run.id && !active.executing && run.retryAt &&
          (Date.parse(run.retryAt) <= nowMs || (task.until !== undefined && Date.parse(task.until) <= nowMs))) retries.push({ task, run });
      }
      // Temporary tasks whose end came go first (a run still going finishes on its own), as do any whose last run is over.
      const tasks = file.tasks.filter((task) => !taskExpired(task, nowMs, this.#active.has(task.id)));
      due = tasks.filter((task) => task.enabled && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= nowMs);
      if (!due.length && tasks.length === file.tasks.length) return file;
      return {
        ...file,
        tasks: tasks.map((task) => {
          if (!due.some((item) => item.id === task.id)) return task;
          return {
            ...task,
            enabled: task.schedule.kind === "at" ? false : task.enabled,
            nextRunAt: isoOrNull(nextRunWithin(task.schedule, nowMs, task.until)),
            updatedAt: iso(nowMs),
          };
        }),
      };
    });
    for (const { task, run } of retries) this.#launchRun(task, run);
    for (const task of due) {
      try {
        await this.run(task.id, "scheduled");
      } catch (error) {
        if (!(error instanceof AutomationConflictError)) throw error;
      }
    }
    this.#reschedule();
  }

  #reschedule(): void {
    const version = ++this.#scheduleVersion;
    if (this.#timer) this.#clock.clearTimer(this.#timer);
    this.#timer = undefined;
    if (!this.#started) return;
    void this.#read().then((file) => {
      if (!this.#started || version !== this.#scheduleVersion) return;
      // The next run, or the next end of a temporary task, paused ones included.
      const next = [
        ...file.tasks.flatMap((task) => [
          ...(task.enabled && task.nextRunAt ? [Date.parse(task.nextRunAt)] : []),
          ...(task.until !== undefined ? [Date.parse(task.until)] : []),
        ]),
        ...file.runs.flatMap((run) => run.status === "queued" && run.retryAt ? [Date.parse(run.retryAt)] : []),
      ]
        .filter(Number.isFinite)
        .toSorted((a, b) => a - b)[0];
      if (next === undefined) return;
      const delay = Math.max(0, Math.min(2_147_000_000, next - this.#clock.now()));
      this.#timer = this.#clock.setTimer(() => { void this.#wake().catch((error: unknown) => this.#reportFailure(error)); }, delay);
      this.#timer.unref?.();
    }).catch((error: unknown) => this.#reportFailure(error));
  }

  dispose(): void {
    this.#started = false;
    this.#generation += 1;
    this.#scheduleVersion += 1;
    if (this.#timer) this.#clock.clearTimer(this.#timer);
    this.#timer = undefined;
    for (const active of this.#active.values()) active.abort.abort(AUTOMATION_SUSPENDED);
    this.#active.clear();
  }
}

export type AutomationTaskDeps = {
  liveSessions: LiveSessions;
  bots: {
    botForSession(sessionId: string): Promise<BotRecord | undefined>;
    runRoutine(
      bot: BotRecord,
      record: SessionRecord,
      task: AutomationTask,
      signal: AbortSignal,
      options: { requestId: string; checkpoint: AutomationExecutionContext["checkpoint"] },
    ): Promise<AutomationExecution>;
    resumeRoutine(bot: BotRecord, record: SessionRecord, delivery: NonNullable<AutomationRun["delivery"]>, signal: AbortSignal): Promise<AutomationExecution>;
  };
};

function waitForAutomationSession(
  record: SessionRecord,
  signal: AbortSignal,
  sessions: Pick<LiveSessions, "watch">,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      watched.unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new DOMException("Run cancelled.", "AbortError"));
    const watched = sessions.watch(record.id, (message) => {
      if (message.kind !== "status") return;
      if (message.status === "idle") finish();
      else if (message.status === "running" || message.status === "waiting") {
        finish(new AutomationConflictError("The target session is already running."));
      } else if (message.status === "error") {
        finish(new Error("The target session runtime could not start."));
      } else if (message.status === "disconnected") {
        finish(new Error("The target session's machine is disconnected."));
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (watched.snapshot.status === "idle") finish();
    else if (watched.snapshot.status === "running" || watched.snapshot.status === "waiting") {
      finish(new AutomationConflictError("The target session is already running."));
    } else if (watched.snapshot.status === "error") {
      finish(new Error("The target session runtime could not start."));
    } else if (watched.snapshot.status === "disconnected") {
      finish(new Error("The target session's machine is disconnected."));
    }
  });
}

export function waitForAutomationRun(
  record: SessionRecord,
  signal: AbortSignal,
  sessions: Pick<LiveSessions, "watch" | "transcript" | "abort">,
): Promise<AutomationExecution> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      watched.unsubscribe();
      if (error) {
        reject(error);
        return;
      }
      const lastAssistant = sessions.transcript(record.id)
        .findLast((entry) => entry.kind === "message" && entry.role === "assistant");
      const summary = lastAssistant?.kind === "message" ? lastAssistant.text.trim() : "";
      resolve(summary ? { summary } : {});
    };
    const onAbort = () => {
      void sessions.abort(record.id).finally(() => {
        finish(new DOMException("Run cancelled.", "AbortError"));
      });
    };
    const watched = sessions.watch(record.id, (message) => {
      if (message.kind === "event" && message.event.type === "settled") finish();
      else if (message.kind === "status" && message.status === "error") {
        finish(new Error("The target session runtime failed."));
      } else if (message.kind === "status" && message.status === "disconnected") {
        finish(new Error("HUI is disconnected from the machine the target session runs on."));
      } else if (message.kind === "closed") {
        finish(new Error("The target session runtime exited."));
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function executeAutomationTask(
  task: AutomationTask,
  signal: AbortSignal,
  context: AutomationExecutionContext,
  { liveSessions, bots }: AutomationTaskDeps,
): Promise<AutomationExecution> {
  const record = (await readRegistry()).find((session) => session.id === task.sessionId);
  if (!record) throw new AutomationNotFoundError("The target session no longer exists.");
  // A bot's routine: marked as such, and queued behind a busy bot instead of skipped.
  const bot = record.bot ? await bots.botForSession(record.id) : undefined;
  if (record.bot && !bot) throw new AutomationNotFoundError("The target bot no longer exists.");
  if (bot) {
    const execution = context.run.delivery
      ? bots.resumeRoutine(bot, record, context.run.delivery, signal)
      : bots.runRoutine(bot, record, task, signal, { requestId: context.run.id, checkpoint: context.checkpoint });
    return execution.catch((error: unknown) => {
      // The scheduler permits this only before the persisted dispatch checkpoint.
      if (error instanceof BotWorkerOfflineError) throw new AutomationRetryError(error.message, "connection");
      throw error;
    });
  }
  if (liveSessions.status(record.id) === "running") {
    throw new AutomationConflictError("The target session is already running.");
  }
  if (!liveSessions.ensure(record)) {
    throw new AutomationNotFoundError("The target session no longer exists.");
  }
  await waitForAutomationSession(record, signal, liveSessions);
  const completion = waitForAutomationRun(record, signal, liveSessions);
  try {
    await liveSessions.prompt(record.id, task.prompt);
  } catch (error) {
    // The completion watcher has not observed a turn yet. Cancelling it keeps
    // the subscription from leaking while the original acceptance error is
    // reported to the automation run.
    if (!signal.aborted) await liveSessions.abort(record.id).catch(() => undefined);
    throw error;
  }
  return completion;
}

export function automationStoreFailure(error: unknown): never {
  throw error instanceof AutomationStoreError ? new BotStoreError(error.message, { cause: error }) : error;
}
