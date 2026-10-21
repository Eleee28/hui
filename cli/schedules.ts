/**
 * `hui schedule` (or `schedules`): every scheduled task from a terminal (HUI-18; SPEC.md, "Schedules are a CLI, and
 * bots schedule their own routines"). A schedule is an Automation task: a prompt HUI sends a session, or a bot's chat
 * (where it is one of the bot's routines), on a schedule. Everything goes through the running gateway's Automation
 * routes, as the Automations page does; the session list names each target. `hui bot routine …` runs on the same
 * code, scoped to one bot.
 */
import type { BotView } from "../server/api/bots.ts";
import type { AutomationRun, AutomationSchedule, AutomationSnapshot, AutomationTask } from "../server/automation.ts";
import { findBot, request, routineSchedule, type BotFlags, type BotIO } from "./gateway-client.ts";

export type ScheduleFlags = BotFlags & {
  /** `add` and `edit`: the bot whose chat it targets; `list`: only that bot's routines. */
  bot?: string;
  /** `add` and `edit`: the session it targets, by id or exact title; `list`: only that session's schedules. */
  session?: string;
  description?: string;
  /** An ISO date and time; on edit `""` clears it. */
  until?: string;
  /** 1–1000; on edit `""` clears it. */
  runs?: string;
  /** `add`: created paused; `edit`: pause it. */
  disabled?: boolean;
};

/** A session as `GET /__hui/sessions` lists it: enough to name a schedule's target. */
export type ScheduleSession = { id: string; title: string; group?: string; archived?: boolean; bot?: { id: string; handle: string; name: string } };

/** What a schedule targets, as people read it. */
type Target = { sessionId: string; session?: ScheduleSession };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const automation = (base: string) => request<AutomationSnapshot>(base, "/__hui/automation");

async function sessionsOf(base: string): Promise<Map<string, ScheduleSession>> {
  const { groups } = await request<{ groups?: Array<{ sessions?: ScheduleSession[] }> }>(base, "/__hui/sessions");
  return new Map((groups ?? []).flatMap((group) => group.sessions ?? []).map((session) => [session.id, session]));
}

/** `every 5m`, `cron 0 9 * * 1-5 (Europe/Madrid)`, `at 2026-10-06T07:00:00.000Z`. */
export function scheduleText(schedule: AutomationSchedule): string {
  if (schedule.kind === "at") return `at ${schedule.at}`;
  if (schedule.kind === "every") {
    const units = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"], [1_000, "s"]] as const;
    const [size, unit] = units.find(([step]) => schedule.everyMs % step === 0) ?? [1, "ms"];
    return `every ${schedule.everyMs / size}${unit}`;
  }
  return `cron ${schedule.expression} (${schedule.timezone})`;
}

/** Who made it and its limits, as the bot's Routines page shows them: `made by @ada · until … · 3 runs left`. */
export function taskFacts(task: Pick<AutomationTask, "createdBy" | "until" | "runsLeft">): string {
  return [
    ...(task.createdBy?.kind === "bot" ? [`made by @${task.createdBy.handle}`] : []),
    ...(task.until ? [`until ${task.until}`] : []),
    ...(task.runsLeft !== undefined ? [task.runsLeft === 0 ? "last run" : `${plural(task.runsLeft, "run")} left`] : []),
  ].join(" · ");
}

function targetLabel(target: Target): string {
  if (!target.session) return `session ${target.sessionId} (gone)`;
  return target.session.bot ? `@${target.session.bot.handle}` : `session "${target.session.title}"`;
}

/** One line per schedule, for people; --json prints the tasks. */
export function formatSchedules(tasks: readonly AutomationTask[], sessions: ReadonlyMap<string, ScheduleSession>, empty: string): string {
  if (!tasks.length) return empty;
  return tasks.map((task) => {
    const facts = taskFacts(task);
    return [
      task.name,
      scheduleText(task.schedule),
      task.enabled ? `next ${task.nextRunAt ?? "-"}` : "paused",
      targetLabel({ sessionId: task.sessionId, session: sessions.get(task.sessionId) }),
      ...(facts ? [facts] : []),
      task.id,
    ].join("  ");
  }).join("\n");
}

/** `hui schedule show`. */
export function formatSchedule(task: AutomationTask, session: ScheduleSession | undefined, lastRun: AutomationRun | undefined): string {
  const maker = task.createdBy?.kind === "bot" ? `@${task.createdBy.handle} (its routines tool)` : task.createdBy ? "the operator" : "not recorded (made before HUI recorded it)";
  return [
    task.name,
    `target: ${session?.bot ? `@${session.bot.handle} (${session.bot.name}), a bot's routine` : session ? `session "${session.title}" (${session.id})` : `session ${task.sessionId} (gone)`}`,
    `schedule: ${scheduleText(task.schedule)}`,
    `state: ${task.enabled ? `on · next run ${task.nextRunAt ?? "none planned"}` : "paused"}`,
    ...(task.until ? [`until: ${task.until} (HUI deletes it then)`] : []),
    ...(task.runsLeft !== undefined ? [`runs left: ${task.runsLeft} (HUI deletes it after the last)`] : []),
    `made by: ${maker}`,
    `timeout: ${task.timeoutSeconds}s`,
    `last run: ${lastRun ? `${lastRun.status} · ${lastRun.source} · ${lastRun.startedAt ?? lastRun.createdAt}${lastRun.error ? ` · ${lastRun.error}` : ""}` : "none yet"}`,
    ...(task.description ? [`description: ${task.description}`] : []),
    `prompt: ${task.prompt}`,
    `id: ${task.id}`,
  ].join("\n");
}

/** A bot's routines, one line each, as `hui bot routine list` prints them. */
export function formatRoutines(bot: Pick<BotView, "handle">, routines: readonly AutomationTask[]): string {
  if (!routines.length) return `@${bot.handle} has no routines. Add one with hui bot routine add ${bot.handle} --name <name> --prompt <text> --every 1d.`;
  return routines.map((task) => {
    const facts = taskFacts(task);
    return [task.name, scheduleText(task.schedule), task.enabled ? `next ${task.nextRunAt ?? "-"}` : "disabled", ...(facts ? [facts] : []), task.id].join("  ");
  }).join("\n");
}

/** The task an id or exact name names; a shared name must be an id. */
export function findSchedule(tasks: readonly AutomationTask[], target: string, scope: { noun: string; listHint: string; owner?: string } = { noun: "schedules", listHint: "hui schedule list --json" }): AutomationTask {
  const byId = tasks.find((task) => task.id === target);
  if (byId) return byId;
  const named = tasks.filter((task) => task.name === target);
  if (named.length === 1) return named[0]!;
  const owner = scope.owner ? ` of ${scope.owner}` : "";
  throw new Error(named.length
    ? `${named.length} ${scope.noun}${owner} are named ${target}. Use an id: ${scope.listHint}.`
    : `${scope.owner ? `${scope.owner} has no` : "No"} ${scope.noun.replace(/s$/u, "")} named ${target}. See ${scope.listHint.replace(/ --json$/u, "")}.`);
}

/** The session `--session` names: an id, or a title only one session has. */
function findSession(sessions: ReadonlyMap<string, ScheduleSession>, target: string): ScheduleSession {
  const byId = sessions.get(target);
  if (byId) return byId;
  const titled = [...sessions.values()].filter((session) => session.title === target);
  if (titled.length === 1) return titled[0]!;
  throw new Error(titled.length
    ? `${titled.length} sessions are titled ${target}: use an id (${titled.map((session) => session.id).join(", ")}).`
    : `No session ${target}. --session takes a session's id or exact title.`);
}

/** Where `--bot` or `--session` points. */
async function resolveTarget(base: string, flags: ScheduleFlags, sessions: ReadonlyMap<string, ScheduleSession>): Promise<{ sessionId: string; label: string }> {
  if (flags.bot !== undefined) {
    const bot = await findBot(base, flags.bot);
    return { sessionId: bot.sessionId, label: `@${bot.handle}` };
  }
  const session = findSession(sessions, flags.session!);
  return { sessionId: session.id, label: targetLabel({ sessionId: session.id, session }) };
}

/** `--until` as the API takes it: `""` clears (`null`). */
function untilValue(value: string): string | null {
  if (!value.trim()) return null;
  return new Date(Date.parse(value)).toISOString();
}

/** `--runs` as the API takes it: `""` clears (`null`). */
const runsValue = (value: string): number | null => (value.trim() ? Number(value) : null);

/** The limits a command gives; absent ones stay as they are. */
function limits(flags: ScheduleFlags): { until?: string | null; runs?: number | null } {
  return {
    ...(flags.until !== undefined ? { until: untilValue(flags.until) } : {}),
    ...(flags.runs !== undefined ? { runs: runsValue(flags.runs) } : {}),
  };
}

/** The whole task as `PUT` takes it, with `change` applied; its limits stay unless `change` names them. */
function putBody(task: AutomationTask, change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: task.name, description: task.description, sessionId: task.sessionId, prompt: task.prompt,
    schedule: task.schedule, enabled: task.enabled, timeoutSeconds: task.timeoutSeconds, ...change,
  };
}

async function updateTask(base: string, task: AutomationTask, change: Record<string, unknown>): Promise<AutomationTask> {
  const { snapshot } = await request<{ snapshot: AutomationSnapshot }>(base, `/__hui/automation/tasks/${encodeURIComponent(task.id)}`, { method: "PUT", body: putBody(task, change) });
  return snapshot.tasks.find((each) => each.id === task.id) ?? { ...task, ...change } as AutomationTask;
}

export async function createTask(base: string, body: Record<string, unknown>): Promise<AutomationTask> {
  return (await request<{ task: AutomationTask }>(base, "/__hui/automation/tasks", { method: "POST", body })).task;
}

export async function runTask(base: string, task: AutomationTask): Promise<AutomationRun> {
  return (await request<{ run: AutomationRun }>(base, `/__hui/automation/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST", body: {} })).run;
}

export async function removeTask(base: string, task: AutomationTask): Promise<void> {
  await request(base, `/__hui/automation/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
}

/** Runs one `hui schedule` action and returns the exit code. */
export async function scheduleCommand(base: string, action: string, operands: readonly string[], flags: ScheduleFlags, io: BotIO): Promise<number> {
  const print = (value: unknown, text: string) => io.out(`${flags.json ? JSON.stringify(value) : text}\n`);
  const [snapshot, sessions] = await Promise.all([automation(base), sessionsOf(base)]);
  const isRoutine = (task: AutomationTask) => Boolean(sessions.get(task.sessionId)?.bot);
  if (action === "list") {
    let tasks = snapshot.tasks;
    let empty = "No schedules. Add one with hui schedule add --name <name> --prompt <text> --every 1d --session <session>.";
    if (flags.bot !== undefined) {
      const bot = await findBot(base, flags.bot);
      tasks = tasks.filter((task) => task.sessionId === bot.sessionId);
      empty = `@${bot.handle} has no routines. Add one with hui schedule add --bot ${bot.handle} --name <name> --prompt <text> --every 1d.`;
    } else if (flags.session !== undefined) {
      const session = findSession(sessions, flags.session);
      tasks = tasks.filter((task) => task.sessionId === session.id);
      empty = `${targetLabel({ sessionId: session.id, session })} has no schedules.`;
    }
    print(tasks, formatSchedules(tasks, sessions, empty));
    return 0;
  }
  if (action === "add") {
    const target = await resolveTarget(base, flags, sessions);
    const task = await createTask(base, {
      name: flags.name, ...(flags.description !== undefined ? { description: flags.description } : {}),
      sessionId: target.sessionId, prompt: flags.prompt, schedule: routineSchedule(flags, io.timezone), enabled: flags.disabled !== true,
      ...(flags.timeout !== undefined ? { timeoutSeconds: Number(flags.timeout) } : {}),
      ...limits(flags),
    });
    const facts = taskFacts(task);
    print(task, `Added schedule ${task.name} for ${target.label}${task.enabled ? (task.nextRunAt ? `; first run ${task.nextRunAt}` : "") : ", paused"}.${facts ? ` Temporary: ${facts}; HUI deletes it after either.` : ""}`);
    return 0;
  }
  const task = findSchedule(snapshot.tasks, operands[0]!);
  const label = targetLabel({ sessionId: task.sessionId, session: sessions.get(task.sessionId) });
  switch (action) {
    case "show": {
      const lastRun = snapshot.runs.filter((run) => run.taskId === task.id).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      print(task, formatSchedule(task, sessions.get(task.sessionId), lastRun));
      return 0;
    }
    case "edit": {
      const change: Record<string, unknown> = { ...limits(flags) };
      if (flags.name !== undefined) change["name"] = flags.name;
      if (flags.prompt !== undefined) change["prompt"] = flags.prompt;
      if (flags.description !== undefined) change["description"] = flags.description;
      if (flags.timeout !== undefined) change["timeoutSeconds"] = Number(flags.timeout);
      if (flags.disabled) change["enabled"] = false;
      if (flags.at !== undefined || flags.every !== undefined || flags.cron !== undefined) {
        change["schedule"] = routineSchedule(flags, task.schedule.kind === "cron" ? task.schedule.timezone : io.timezone);
      } else if (flags.timezone !== undefined) {
        if (task.schedule.kind !== "cron") throw new Error(`--timezone only applies to a cron schedule, and ${task.name} runs ${scheduleText(task.schedule)}.`);
        change["schedule"] = { ...task.schedule, timezone: flags.timezone };
      }
      let moved = "";
      if (flags.bot !== undefined || flags.session !== undefined) {
        const target = await resolveTarget(base, flags, sessions);
        change["sessionId"] = target.sessionId;
        if (target.sessionId !== task.sessionId) moved = `, now for ${target.label}`;
      }
      const updated = await updateTask(base, task, change);
      print(updated, `Updated schedule ${updated.name}${moved}${updated.enabled ? (updated.nextRunAt ? `; next run ${updated.nextRunAt}` : "") : " (paused)"}.`);
      return 0;
    }
    case "pause": {
      const updated = task.enabled ? await updateTask(base, task, { enabled: false }) : task;
      print(updated, task.enabled ? `Paused schedule ${task.name}.` : `${task.name} was already paused.`);
      return 0;
    }
    case "resume": {
      const updated = task.enabled ? task : await updateTask(base, task, { enabled: true });
      print(updated, `${task.enabled ? `${task.name} was already on` : `Resumed schedule ${task.name}`}${updated.nextRunAt ? `; next run ${updated.nextRunAt}` : ""}.`);
      return 0;
    }
    case "run": {
      const run = await runTask(base, task);
      print(run, `Started ${task.name}; ${isRoutine(task) ? `${label} answers in its chat` : `it runs in ${label}`}.`);
      return 0;
    }
    case "remove": {
      await removeTask(base, task);
      print({ removed: task.name, id: task.id }, `Removed schedule ${task.name}.`);
      return 0;
    }
    default:
      throw new Error("Unknown command. Run hui --help.");
  }
}

/** `hui bot routine …`: the same tasks and requests, scoped to one bot, worded as before. */
export async function routineCommand(base: string, bot: BotView, action: string, operands: readonly string[], flags: ScheduleFlags, io: BotIO): Promise<number> {
  const print = (value: unknown, text: string) => io.out(`${flags.json ? JSON.stringify(value) : text}\n`);
  const routines = async () => (await automation(base)).tasks.filter((task) => task.sessionId === bot.sessionId);
  const find = async (target: string) => findSchedule(await routines(), target, { noun: "routines", owner: `@${bot.handle}`, listHint: `hui bot routine list ${bot.handle} --json` });
  switch (action) {
    case "list": {
      const list = await routines();
      print(list, formatRoutines(bot, list));
      return 0;
    }
    case "add": {
      const task = await createTask(base, { name: flags.name, sessionId: bot.sessionId, prompt: flags.prompt, schedule: routineSchedule(flags, io.timezone), enabled: true });
      print(task, `Added routine ${task.name} for @${bot.handle}${task.nextRunAt ? `; first run ${task.nextRunAt}` : ""}.`);
      return 0;
    }
    case "run": {
      const task = await find(operands[0]!);
      print(await runTask(base, task), `Started routine ${task.name}; @${bot.handle} answers in its chat.`);
      return 0;
    }
    case "remove": {
      const task = await find(operands[0]!);
      await removeTask(base, task);
      print({ removed: task.name, id: task.id }, `Removed routine ${task.name} of @${bot.handle}.`);
      return 0;
    }
    default:
      throw new Error("Unknown command. Run hui --help.");
  }
}
