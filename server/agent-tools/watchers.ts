/** HUI-owned background watchers.
 *
 * A watcher is a detached shell command that waits for an external condition
 * (pull request approval, a CI run, a deploy) and acts when it becomes true.
 * HUI starts it in its own process group, in the conversation's directory,
 * appends its output to a log and has the wrapper write the exit status beside
 * the log, so the watcher outlives the gateway while HUI can still report
 * running, done, failed, stopped or dead. State is derived on every refresh: a
 * recorded PID only counts as running when it is the same process HUI started
 * (a reboot reuses PIDs), or, once that shell was killed (`pkill -f` matches
 * the script's path), while a process that started with it still runs in its
 * process group. A watcher started with `keepRunning` that HUI finds dead
 * starts again. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { Watcher, WatcherState, WatcherLog } from "../api/watchers.ts";

export const WATCHER_LIMITS = {
  purpose: 200,
  target: 500,
  outcome: 200,
  command: 4_000,
  perSession: 10,
  logLines: 400,
  logLine: 500,
} as const;

const execFileAsync = promisify(execFile);
const STORE_VERSION = 1;
const MAX_LOG_BYTES = 256 * 1024;
const LAST_LINE_BYTES = 8 * 1024;
const DEFAULT_POLL_MS = 10_000;
/** A just-launched process that is already gone gets this long for its wrapper
 * to record the exit status before it is called dead. */
const DEFAULT_SETTLE_MS = 5_000;
const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 250;
/** A recorded PID whose process started within this window of the recorded
 * start is treated as the watcher; anything else is a reused PID. */
const OWN_TOLERANCE_SECONDS = 20;

export class WatcherInputError extends Error {
  override name = "WatcherInputError";
}

export class WatcherNotFoundError extends Error {
  override name = "WatcherNotFoundError";
}

export class WatcherConflictError extends Error {
  override name = "WatcherConflictError";
}

export class WatcherStoreError extends Error {
  override name = "WatcherStoreError";
}

/** The persisted part of a watcher. Everything else is derived from the
 * process identity and the exit record. */
type WatcherRecord = {
  id: string;
  sessionId: string;
  /** The conversation's directory; the command runs there. */
  cwd: string;
  purpose: string;
  target: string;
  outcome: string;
  command: string;
  logPath: string;
  pid: number;
  startedAt: string;
  /** Set by an operator stop; survives so a killed watcher reads as stopped
   * even when the wrapper never recorded its exit. */
  stoppedAt?: string;
  /** Found dead, it runs its command again. */
  keepRunning?: true;
};

type WatcherFile = {
  version: number;
  watchers: WatcherRecord[];
};

export type WatcherServiceOptions = {
  file: string;
  logDir: string;
  onChange?: (sessionId: string) => void;
  now?: () => number;
  uuid?: () => string;
  pollMs?: number;
  /** How long a gone process may still be settling before it reads dead. */
  settleMs?: number;
  /** Test seam: run one detached script and return its process-group PID. */
  launch?: (scriptPath: string, cwd: string, logPath: string) => number;
  /** Test seam: signal a watcher's process group, tolerating a dead one. */
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test seam: is the recorded PID still the process that started then?
   * `undefined` means the check could not answer. */
  ownsProcess?: (pid: number, startedAtMs: number) => Promise<boolean | undefined>;
};

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** One `sh -c` script: run the command with its output appended to the log,
 * then record the exit status. Written as one line so the recorded process is
 * the command's own shell, not a parent that could die first. */
export function watcherScript(command: string, logPath: string, exitPath: string): string {
  return `(${command}\n) >> ${quote(logPath)} 2>&1\nprintf '%s\\n' "$?" > ${quote(exitPath)}`;
}

function signalAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone, or not ours to signal: nothing to escalate.
  }
}

function signalGroupAlive(pid: number): boolean {
  return signalAlive(-pid);
}

async function readTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return { text: "", truncated: false };
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8"), truncated: start > 0 };
  } catch {
    return { text: "", truncated: false };
  } finally {
    await handle.close();
  }
}

/** `ps` reports how long a process has been alive (`etime`), which tells a
 * watcher apart from an unrelated process that inherited its PID. */
function etimeSeconds(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(text.trim());
  if (!match) return undefined;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

async function ownsProcess(pid: number, startedAtMs: number): Promise<boolean | undefined> {
  const startedWith = (age: number | undefined) => age !== undefined && Math.abs(age - (Date.now() - startedAtMs) / 1_000) <= OWN_TOLERANCE_SECONDS;
  try {
    if (signalAlive(pid)) {
      const age = etimeSeconds((await execFileAsync("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 5_000 })).stdout);
      return age === undefined ? undefined : startedWith(age);
    }
    // The shell is gone; what started with it may still run in its group.
    if (!signalGroupAlive(pid)) return false;
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pgid=,etime="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.split("\n").some((line) => {
      const [group, etime = ""] = line.trim().split(/\s+/u);
      return Number(group) === pid && startedWith(etimeSeconds(etime));
    });
  } catch {
    return undefined;
  }
}

function launchDetached(scriptPath: string, cwd: string, logPath: string): number {
  // The child's stdio points at the log too, so a shell-level error that never
  // reaches the script's own redirection still lands there. The script is a
  // HUI-owned file; its path never carries the command text.
  let log: number | undefined;
  try {
    log = openSync(logPath, "a", 0o600);
  } catch {
    log = undefined;
  }
  const child: ChildProcess = spawn("/bin/sh", [scriptPath], {
    detached: true,
    stdio: ["ignore", log ?? "ignore", log ?? "ignore"],
    ...(cwd ? { cwd } : {}),
    // The gateway's own agent-tool credentials must not reach watcher commands.
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HUI_AGENT_"))),
  });
  if (log !== undefined) closeSync(log);
  // A missing shell would otherwise emit an unhandled error event.
  child.on("error", () => undefined);
  const pid = child.pid;
  if (!pid) {
    child.kill();
    throw new WatcherStoreError("HUI could not start the watcher process.");
  }
  child.unref();
  return pid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, maximum: number, optional = false): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed && !optional) throw new WatcherInputError(`${label} must not be empty.`);
    if (trimmed.length > maximum) throw new WatcherInputError(`${label} must be at most ${maximum} characters.`);
    return trimmed;
  }
  if (optional && value === undefined) return "";
  throw new WatcherInputError(`${label} must be text.`);
}

function parseRecord(value: unknown): WatcherRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value["id"] === "string" ? value["id"] : "";
  const sessionId = typeof value["sessionId"] === "string" ? value["sessionId"] : "";
  const cwd = typeof value["cwd"] === "string" ? value["cwd"] : "";
  const purpose = typeof value["purpose"] === "string" ? value["purpose"] : "";
  const command = typeof value["command"] === "string" ? value["command"] : "";
  const logPath = typeof value["logPath"] === "string" ? value["logPath"] : "";
  const pid = value["pid"];
  const startedAt = typeof value["startedAt"] === "string" ? value["startedAt"] : "";
  if (!id || !sessionId || !purpose || !command || !logPath || !startedAt) return undefined;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (!Number.isFinite(Date.parse(startedAt))) return undefined;
  return {
    id,
    sessionId,
    cwd,
    purpose,
    target: typeof value["target"] === "string" ? value["target"] : "",
    outcome: typeof value["outcome"] === "string" ? value["outcome"] : "",
    command,
    logPath,
    pid,
    startedAt,
    ...(typeof value["stoppedAt"] === "string" ? { stoppedAt: value["stoppedAt"] } : {}),
    ...(value["keepRunning"] === true ? { keepRunning: true as const } : {}),
  };
}

export class WatcherService {
  readonly #file: string;
  readonly #logDir: string;
  readonly #onChange: (sessionId: string) => void;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #pollMs: number;
  readonly #settleMs: number;
  readonly #launch: (scriptPath: string, cwd: string, logPath: string) => number;
  readonly #signalGroup: (pid: number, signal: NodeJS.Signals) => void;
  readonly #ownsProcess: (pid: number, startedAtMs: number) => Promise<boolean | undefined>;
  #records = new Map<string, WatcherRecord>();
  #views = new Map<string, Watcher>();
  /** One mutation chain per watcher, so a card and an agent cannot stop,
   * restart or dismiss the same watcher twice. */
  #locks = new Map<string, Promise<unknown>>();
  /** Bumped by every mutation; a poll whose generation changed meanwhile
   * discards its stale view instead of overwriting the mutation's. */
  #versions = new Map<string, number>();
  #mutation = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;
  #started = false;

  constructor(options: WatcherServiceOptions) {
    this.#file = options.file;
    this.#logDir = options.logDir;
    this.#onChange = options.onChange ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#uuid = options.uuid ?? randomUUID;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#launch = options.launch ?? ((scriptPath, cwd, logPath) => launchDetached(scriptPath, cwd, logPath));
    this.#signalGroup = options.signalGroup ?? signalGroup;
    this.#ownsProcess = options.ownsProcess ?? ownsProcess;
  }

  /** Loads the registry, reconciles it with reality and starts polling. A
   * failed read keeps the service unstarted so a later attempt can retry. */
  async initialize(): Promise<void> {
    if (this.#started) return;
    const records = await this.#read();
    for (const record of records) {
      this.#records.set(record.id, record);
      this.#views.set(record.id, await this.#refresh(record));
    }
    this.#started = true;
    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
    this.#timer.unref?.();
  }

  /** Watchers of one conversation, newest first. */
  list(sessionId: string): Watcher[] {
    return [...this.#views.values()]
      .filter((watcher) => this.#records.get(watcher.id)?.sessionId === sessionId)
      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** The bridge-facing tool contract: `watcher` with its six actions. */
  async tool(sessionId: string, params: Record<string, unknown>, cwd = process.cwd()): Promise<unknown> {
    const action = typeof params["action"] === "string" ? params["action"] : "";
    if (action === "start") return this.start(sessionId, params, cwd);
    if (action === "list") return { watchers: this.list(sessionId) };
    if (action === "stop") return this.stop(sessionId, this.#watcherId(params));
    if (action === "restart") {
      // Ignoring a new definition would quietly re-run the old command instead.
      // Empty values are what some models send for fields they leave unset.
      if (["command", "purpose", "target", "outcome", "keepRunning"].some((field) => params[field])) {
        throw new WatcherInputError("restart re-runs the recorded command and takes only an id. To run something else, start a new watcher.");
      }
      return this.restart(sessionId, this.#watcherId(params));
    }
    if (action === "dismiss") {
      const id = this.#watcherId(params);
      await this.remove(sessionId, id);
      return { id, status: "dismissed" };
    }
    if (action === "log") {
      const lines = params["lines"];
      if (lines !== undefined && (!Number.isInteger(lines) || (lines as number) < 1 || (lines as number) > WATCHER_LIMITS.logLines)) {
        throw new WatcherInputError(`lines must be between 1 and ${WATCHER_LIMITS.logLines}.`);
      }
      return this.log(sessionId, this.#watcherId(params), lines as number | undefined);
    }
    throw new WatcherInputError(`Unknown watcher action: ${action || "(missing)"}`);
  }

  async start(sessionId: string, params: Record<string, unknown>, cwd = process.cwd()): Promise<Watcher> {
    // One start at a time per conversation, so two calls cannot both pass the
    // per-conversation cap.
    return this.#lock(`session:${sessionId}`, async () => {
      const purpose = text(params["purpose"], "purpose", WATCHER_LIMITS.purpose);
      const command = text(params["command"], "command", WATCHER_LIMITS.command);
      const target = text(params["target"], "target", WATCHER_LIMITS.target, true);
      const outcome = text(params["outcome"], "outcome", WATCHER_LIMITS.outcome, true);
      const keepRunning = params["keepRunning"];
      if (keepRunning !== undefined && typeof keepRunning !== "boolean") throw new WatcherInputError("keepRunning must be true or false.");
      if (target && !/^https?:\/\/\S+$/u.test(target)) {
        throw new WatcherInputError("target must be an http(s) URL.");
      }
      const directory = await stat(cwd).catch(() => undefined);
      if (!directory?.isDirectory()) throw new WatcherInputError(`The conversation's directory is unavailable: ${cwd}`);
      if (this.list(sessionId).length >= WATCHER_LIMITS.perSession) {
        throw new WatcherInputError(`This conversation already has ${WATCHER_LIMITS.perSession} watchers. Dismiss finished ones first.`);
      }
      const id = this.#uuid();
      await mkdir(this.#logDir, { recursive: true });
      const record: WatcherRecord = {
        id,
        sessionId,
        cwd,
        purpose,
        target,
        outcome,
        command,
        logPath: join(this.#logDir, `${id}.log`),
        pid: 0,
        startedAt: new Date(this.#now()).toISOString(),
        ...(keepRunning ? { keepRunning: true as const } : {}),
      };
      // The command may print secrets; the log and the script stay private.
      await writeFile(record.logPath, "", { flag: "a", mode: 0o600 });
      await this.#writeScript(record);
      record.pid = this.#launch(this.#scriptPath(id), record.cwd, record.logPath);
      // The view lands before the record so a poll cannot observe a record with
      // no view and report a spurious state change.
      this.#views.set(id, await this.#refresh(record));
      this.#records.set(id, record);
      this.#bump(id);
      try {
        await this.#write();
      } catch (error) {
        // An unpersisted watcher would become invisible after a restart.
        this.#records.delete(id);
        this.#views.delete(id);
        this.#signalGroup(record.pid, "SIGKILL");
        throw error;
      }
      this.#onChange(sessionId);
      return this.#view(id);
    });
  }

  async stop(sessionId: string, id: string): Promise<Watcher> {
    return this.#lock(id, async () => {
      const record = this.#require(sessionId, id);
      this.#bump(id);
      const current = await this.#refresh(record);
      this.#views.set(id, current);
      if (current.state !== "running") return current;
      await this.#terminate(record);
      // A stop that raced the command's own exit keeps that outcome; a shell
      // that lived long enough to record the signal's status (143, 137) did not.
      const exit = await this.#readExit(id);
      if (!exit || exit.code === 143 || exit.code === 137) record.stoppedAt = new Date(this.#now()).toISOString();
      const view = await this.#refresh(record);
      this.#views.set(id, view);
      await this.#write();
      this.#onChange(sessionId);
      return view;
    });
  }

  async restart(sessionId: string, id: string): Promise<Watcher> {
    return this.#lock(id, async () => {
      const record = this.#require(sessionId, id);
      this.#bump(id);
      const current = await this.#refresh(record);
      this.#views.set(id, current);
      if (current.state === "running") {
        throw new WatcherConflictError("Stop the watcher before restarting it.");
      }
      await this.#relaunch(record);
      this.#onChange(sessionId);
      return this.#view(id);
    });
  }

  /** A keep-running watcher found dead runs its command again, once per death. */
  async #revive(record: WatcherRecord): Promise<void> {
    await this.#lock(record.id, async () => {
      if (this.#records.get(record.id) !== record) return;
      this.#bump(record.id);
      if ((await this.#refresh(record)).state !== "dead") return;
      if (!(await stat(record.cwd).catch(() => undefined))?.isDirectory()) return;
      await this.#relaunch(record);
      await appendFile(record.logPath, `[HUI] Started again at ${record.startedAt}: its processes were gone with no exit status.\n`, { mode: 0o600 });
      this.#onChange(record.sessionId);
    });
  }

  async #relaunch(record: WatcherRecord): Promise<void> {
    await rm(this.#exitPath(record.id), { force: true });
    delete record.stoppedAt;
    await this.#writeScript(record);
    record.pid = this.#launch(this.#scriptPath(record.id), record.cwd, record.logPath);
    record.startedAt = new Date(this.#now()).toISOString();
    this.#views.set(record.id, await this.#refresh(record));
    await this.#write();
  }

  async remove(sessionId: string, id: string): Promise<void> {
    return this.#lock(id, async () => {
      const record = this.#require(sessionId, id);
      this.#bump(id);
      const current = await this.#refresh(record);
      if (current.state === "running") {
        throw new WatcherConflictError("Stop the watcher before dismissing it.");
      }
      this.#records.delete(id);
      this.#views.delete(id);
      this.#versions.delete(id);
      await Promise.all([
        rm(this.#exitPath(record.id), { force: true }),
        rm(this.#scriptPath(record.id), { force: true }),
        rm(record.logPath, { force: true }),
      ]);
      await this.#write();
      this.#onChange(sessionId);
    });
  }

  async log(sessionId: string, id: string, lines = 100): Promise<WatcherLog> {
    const record = this.#require(sessionId, id);
    const tail = await readTail(record.logPath, MAX_LOG_BYTES);
    let text = tail.text;
    let truncated = tail.truncated;
    if (truncated) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    const all = text.split("\n").filter((line, index, array) => line.length > 0 || index < array.length - 1);
    if (all.length > lines) truncated = true;
    return { id, lines: all.slice(-lines), truncated };
  }

  /** Deleted conversations take their watchers with them. */
  async forget(sessionIds: Iterable<string>): Promise<void> {
    const gone = new Set(sessionIds);
    const records = [...this.#records.values()].filter((record) => gone.has(record.sessionId));
    if (!records.length) return;
    for (const record of records) {
      await this.#lock(record.id, async () => {
        this.#bump(record.id);
        const current = await this.#refresh(record);
        if (current.state === "running") await this.#terminate(record);
        this.#records.delete(record.id);
        this.#views.delete(record.id);
        this.#versions.delete(record.id);
        await Promise.all([
          rm(this.#exitPath(record.id), { force: true }),
          rm(this.#scriptPath(record.id), { force: true }),
          rm(record.logPath, { force: true }),
        ]);
      });
    }
    await this.#write();
  }

  /** Watchers whose conversation is gone (a crash between delete and cleanup)
   * are stopped and forgotten at gateway start. */
  async prune(knownSessionIds: ReadonlySet<string>): Promise<void> {
    const gone = new Set<string>();
    for (const record of this.#records.values()) {
      if (!knownSessionIds.has(record.sessionId)) gone.add(record.sessionId);
    }
    await this.forget(gone);
  }

  /** Stops polling; running watchers keep running. */
  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#started = false;
  }

  #lock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const operation = previous.then(run, run);
    this.#locks.set(key, operation.then(() => undefined, () => undefined));
    return operation;
  }

  #bump(id: string): void {
    this.#versions.set(id, (this.#versions.get(id) ?? 0) + 1);
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const changed = new Set<string>();
      for (const record of [...this.#records.values()]) {
        const version = this.#versions.get(record.id) ?? 0;
        const before = this.#views.get(record.id);
        const view = await this.#refresh(record);
        // A mutation that started while this refresh ran owns the newer view,
        // and a removed record must not be resurrected.
        if (this.#records.get(record.id) !== record || (this.#versions.get(record.id) ?? 0) !== version) continue;
        this.#views.set(record.id, view);
        // The card shows the latest line too, so new output is a change.
        if (view.state !== before?.state || view.lastLine !== before?.lastLine) changed.add(record.sessionId);
        if (view.state === "dead" && record.keepRunning) void this.#revive(record).catch(() => undefined);
      }
      for (const sessionId of changed) this.#onChange(sessionId);
    } finally {
      this.#polling = false;
    }
  }

  /** SIGTERM the whole process group, then SIGKILL it if anything survives. */
  async #terminate(record: WatcherRecord): Promise<void> {
    // Never signal a PID that is not the process HUI started.
    if (await this.#ownsProcess(record.pid, Date.parse(record.startedAt)) === false) return;
    this.#signalGroup(record.pid, "SIGTERM");
    const deadline = this.#now() + STOP_GRACE_MS;
    while (this.#now() < deadline && signalGroupAlive(record.pid)) await delay(STOP_POLL_MS);
    if (signalGroupAlive(record.pid)) this.#signalGroup(record.pid, "SIGKILL");
  }

  async #refresh(record: WatcherRecord): Promise<Watcher> {
    const exit = await this.#readExit(record.id);
    const lastLine = await this.#lastLine(record.logPath);
    let state: WatcherState;
    let endedAt: string | undefined;
    if (record.stoppedAt) {
      state = "stopped";
      endedAt = record.stoppedAt;
    } else if (exit) {
      state = exit.code === 0 ? "done" : "failed";
      endedAt = exit.at;
    } else {
      const owns = await this.#ownsProcess(record.pid, Date.parse(record.startedAt));
      // The wrapper writes the exit record just after the command; a process
      // that is already gone this soon may not have written it yet.
      const settling = this.#now() - Date.parse(record.startedAt) < this.#settleMs;
      // An unanswered ownership check keeps the previous claim rather than
      // reporting a live watcher dead.
      state = owns === false && !settling ? "dead" : "running";
    }
    return {
      id: record.id,
      purpose: record.purpose,
      target: record.target,
      outcome: record.outcome,
      command: record.command,
      logPath: record.logPath,
      state,
      pid: record.pid,
      ...(exit ? { exitCode: exit.code } : {}),
      startedAt: record.startedAt,
      ...(endedAt ? { endedAt } : {}),
      lastLine,
      ...(record.keepRunning ? { keepRunning: true as const } : {}),
    };
  }

  async #readExit(id: string): Promise<{ code: number; at: string } | undefined> {
    const path = this.#exitPath(id);
    try {
      const raw = (await readFile(path, "utf8")).trim();
      if (!/^\d{1,3}$/u.test(raw)) return undefined;
      const info = await stat(path).catch(() => undefined);
      return { code: Number(raw), at: new Date(info?.mtimeMs ?? this.#now()).toISOString() };
    } catch {
      return undefined;
    }
  }

  async #lastLine(path: string): Promise<string> {
    const tail = await readTail(path, LAST_LINE_BYTES);
    const lines = tail.text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = (lines[index] ?? "").trim();
      if (line) return line.slice(0, WATCHER_LIMITS.logLine);
    }
    return "";
  }

  #exitPath(id: string): string {
    return join(this.#logDir, `${id}.exit`);
  }

  #scriptPath(id: string): string {
    return join(this.#logDir, `${id}.sh`);
  }

  /** The command lives in a private HUI-owned script file; the child's command
   * line is just the shell and that path. */
  async #writeScript(record: WatcherRecord): Promise<void> {
    await writeFile(this.#scriptPath(record.id), `${watcherScript(record.command, record.logPath, this.#exitPath(record.id))}\n`, { mode: 0o700 });
  }

  #require(sessionId: string, id: string): WatcherRecord {
    const record = this.#records.get(id);
    if (!record || record.sessionId !== sessionId) {
      throw new WatcherNotFoundError(`No watcher ${id} in this conversation.`);
    }
    return record;
  }

  #view(id: string): Watcher {
    const view = this.#views.get(id);
    if (!view) throw new WatcherNotFoundError(`No watcher ${id} in this conversation.`);
    return view;
  }

  #watcherId(params: Record<string, unknown>): string {
    return text(params["id"], "id", 100);
  }

  async #read(): Promise<WatcherRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new WatcherStoreError("HUI's watcher registry could not be read.", { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new WatcherStoreError("HUI's watcher registry is not valid JSON.", { cause: error });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["watchers"])) {
      throw new WatcherStoreError("HUI's watcher registry has an invalid shape.");
    }
    return parsed["watchers"].map(parseRecord).filter((record): record is WatcherRecord => record !== undefined);
  }

  #write(): Promise<void> {
    const operation = this.#mutation.then(async () => {
      const file: WatcherFile = {
        version: STORE_VERSION,
        watchers: [...this.#records.values()].map((record) => ({
          id: record.id,
          sessionId: record.sessionId,
          cwd: record.cwd,
          purpose: record.purpose,
          target: record.target,
          outcome: record.outcome,
          command: record.command,
          logPath: record.logPath,
          pid: record.pid,
          startedAt: record.startedAt,
          ...(record.stoppedAt ? { stoppedAt: record.stoppedAt } : {}),
          ...(record.keepRunning ? { keepRunning: true } : {}),
        })),
      };
      try {
        await mkdir(dirname(this.#file), { recursive: true });
        const temporary = `${this.#file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
        await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.#file);
      } catch (error) {
        throw new WatcherStoreError("HUI's watcher registry could not be written.", { cause: error });
      }
    });
    this.#mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
