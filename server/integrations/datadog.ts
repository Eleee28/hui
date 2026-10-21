/**
 * Datadog orgs through the operator's Datadog CLI (`pup`).
 *
 * HUI owns no Datadog credential. It keeps the orgs the operator added (a pup session name, empty for pup's default
 * session, and the Datadog host its links use) in `~/.config/hui/datadog.json`, written with mode 0600; reads their
 * status from `pup auth list`; runs every lookup as one read-only pup call for exactly that session (`--org=<name>`
 * with `DD_SITE`, and none of the environment that would make pup use another identity); and, on request, runs
 * `pup auth login` so the operator approves it in the browser pup opens on this machine. pup keeps the tokens.
 * Lookup output never leaves the gateway; only a failed sign-in's last line does.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DATADOG_CLI_REQUIRED, isDatadogHost, normalizeDatadogSite, pupSite } from "./datadog-links.ts";
import type { DatadogConnection, DatadogLoginState, DatadogOrg, DatadogOrgStatus } from "../api/datadog.ts";
import { CONFIG_DIR } from "../paths.ts";

const DATADOG_CONFIG_FILE = join(CONFIG_DIR, "datadog.json");
const CONFIG_VERSION = 1;
/** pup gives up on the browser callback after 300 s; HUI stops waiting a little later. */
const LOGIN_TIMEOUT_MS = 6 * 60_000;
const OUTPUT_LIMIT = 16 * 1024;
const MESSAGE_LIMIT = 300;
const NAME_LIMIT = 100;
/** Environment that would make pup answer as another identity or in another shape (`PUP_FILTER` is a jq filter). */
const IDENTITY_ENV = ["DD_API_KEY", "DD_APP_KEY", "DD_ACCESS_TOKEN", "DD_ORG", "DD_SITE", "DD_OUTPUT", "PUP_OUTPUT", "PUP_FILTER", "PUP_AGENT_MODE"];

export class DatadogError extends Error {
  readonly status: 400 | 404 | 409 | 500;
  constructor(message: string, status: 400 | 404 | 409 | 500 = 400) {
    super(message);
    this.name = "DatadogError";
    this.status = status;
  }
}

/** Why a pup call failed, without its output. `expired`: pup could not renew the token itself; `pup auth refresh`
 * may. `not_found`: this org cannot see it (404 or 403). */
export type PupFailure = "cli_missing" | "expired" | "signed_out" | "not_found" | "unavailable";

export class PupError extends Error {
  readonly reason: PupFailure;
  constructor(reason: PupFailure) {
    super(`pup failed: ${reason}`);
    this.name = "PupError";
    this.reason = reason;
  }
}

/** Maps a failed pup run to a reason. pup prints `Error: …` with the HTTP status of API failures. */
export function classifyPupFailure(error: { code?: unknown; stderr?: unknown }): PupFailure {
  if (error.code === "ENOENT" || error.code === "EACCES") return "cli_missing";
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  if (/authentication expired|(?:status: |HTTP )401\b/u.test(stderr)) return "expired";
  if (/authentication required|no refresh token available/u.test(stderr)) return "signed_out";
  if (/(?:status: |HTTP )40[34]\b/u.test(stderr)) return "not_found";
  return "unavailable";
}

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "");

/** The last line pup printed before a failed sign-in, as the operator would read it in a terminal. */
export function loginFailureMessage(output: string, code: number | null): string {
  const lines = stripAnsi(output).split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? `pup auth login exited with code ${code ?? "unknown"}.`).slice(0, MESSAGE_LIMIT);
}

/** The sign-in page pup prints before it opens the browser, when it is a Datadog page. */
export function parseLoginUrl(output: string): string | undefined {
  const raw = /If the browser doesn't open, visit: (https:\/\/\S+)/u.exec(stripAnsi(output))?.[1];
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && isDatadogHost(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A pup session from `pup auth list`; `org` is empty for the default session. */
export type PupSession = { org: string; site: string; status: string; hasRefresh: boolean };

export function parsePupSessions(raw: unknown): PupSession[] {
  if (!Array.isArray(raw)) throw new PupError("unavailable");
  return raw.flatMap((entry): PupSession[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item["site"] !== "string") return [];
    return [{
      org: typeof item["org"] === "string" ? item["org"] : "",
      site: item["site"],
      status: typeof item["status"] === "string" ? item["status"] : "",
      hasRefresh: item["has_refresh"] === true,
    }];
  });
}

/** `valid`, or `expired` with a refresh token pup renews on its next call, is usable. */
export function sessionStatus(org: DatadogOrg, sessions: readonly PupSession[]): DatadogOrgStatus["status"] {
  const session = sessions.find((entry) => entry.org === org.name && normalizeDatadogSite(entry.site) === org.site);
  return session && (session.status === "valid" || (session.status === "expired" && session.hasRefresh)) ? "connected" : "signed_out";
}

const orgKey = (org: DatadogOrg) => `${org.site}\n${org.name}`;

/** An org from operator input: a trimmed pup session name (empty: the default session) and a Datadog host. */
export function normalizeOrg(raw: unknown): DatadogOrg {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const name = typeof source["name"] === "string" ? source["name"].trim() : source["name"] == null ? "" : undefined;
  if (name === undefined || name.length > NAME_LIMIT || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new DatadogError(`Enter the pup org name (at most ${NAME_LIMIT} characters), or leave it empty for pup's default session.`);
  }
  const site = normalizeDatadogSite(source["site"]);
  if (!site) throw new DatadogError("Enter a Datadog site such as app.datadoghq.com.");
  return { name, site };
}

function parseConfig(raw: unknown): DatadogOrg[] {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!source || source["version"] !== CONFIG_VERSION || !Array.isArray(source["orgs"])) {
    throw new DatadogError("~/.config/hui/datadog.json is not a Datadog org list HUI can read. Fix or remove it.", 500);
  }
  return source["orgs"].flatMap((entry) => {
    try { return [normalizeOrg(entry)]; } catch { return []; }
  });
}

/** `datadog.json`: `{ version: 1, orgs: [{ name, site }] }`. A file HUI cannot read is reported, never overwritten. */
export class DatadogOrgStore {
  readonly path: string;
  constructor(path = DATADOG_CONFIG_FILE) {
    this.path = path;
  }

  async read(): Promise<DatadogOrg[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return parseConfig(parsed);
  }

  async write(orgs: readonly DatadogOrg[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: CONFIG_VERSION, orgs }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

/** One pup call; resolves with its parsed JSON output, rejects with a `PupError`. `org` picks the session. Every call
 * is `--read-only`, so pup refuses any write (sign-in runs separately, without it). */
export type PupRun = (args: readonly string[], org?: DatadogOrg) => Promise<unknown>;

function pupEnv(env: NodeJS.ProcessEnv, org?: DatadogOrg): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };
  for (const name of IDENTITY_ENV) delete next[name];
  if (org) next["DD_SITE"] = pupSite(org.site);
  return next;
}

/** `--org=` keeps a name that starts with `-` from reading as a flag. */
function orgArgs(org?: DatadogOrg): string[] {
  return org?.name ? [`--org=${org.name}`] : [];
}

export function pupRunner(command = "pup", env: NodeJS.ProcessEnv = process.env): PupRun {
  return (args, org) => new Promise((resolve, reject) => {
    const child = execFile(command, [...args, "-o", "json", "--no-agent", "--read-only", ...orgArgs(org)], {
      env: pupEnv(env, org),
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        // The callback form does not attach stderr to the error; classify with both.
        reject(new PupError(classifyPupFailure({ code: error.code, stderr })));
        return;
      }
      // `auth refresh` prints nothing on stdout; callers validate the shape they expect.
      try { resolve(stdout.trim() ? JSON.parse(stdout) : undefined); } catch { reject(new PupError("unavailable")); }
    });
    // A prompt (pup asks before trusting an unknown host) must fail at once, never wait.
    child.stdin?.end();
  });
}

export type DatadogOrgsOptions = {
  /** Executable to run; E2E points this at a fake. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  store?: DatadogOrgStore;
  loginTimeoutMs?: number;
  /** Called after a sign-in succeeds or the org list changes, so previews are looked up again. */
  onChange?: () => void;
};

/** The orgs HUI reads Datadog links through, their status and the one sign-in the gateway may run at a time. */
export class DatadogOrgs {
  readonly run: PupRun;
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #store: DatadogOrgStore;
  readonly #loginTimeout: number;
  readonly #onChange: () => void;
  /** Orgs whose lookups ended signed out; they show *Sign in needed* until a sign-in or a lookup succeeds. */
  readonly #signedOut = new Set<string>();
  #orgs?: Promise<DatadogOrg[]>;
  /** Adds and removals, one at a time, so two tabs cannot lose each other's change. */
  #mutation: Promise<unknown> = Promise.resolve();
  /** pup's version once it answered; a missing pup is asked again, so installing it needs no restart. */
  #cliVersion?: string;
  #login: DatadogLoginState = { phase: "idle" };
  #child?: ChildProcess;
  #cancel?: () => void;
  #settled: Promise<void> = Promise.resolve();

  constructor(options: DatadogOrgsOptions = {}) {
    this.#command = options.command ?? "pup";
    this.#env = options.env ?? process.env;
    this.run = pupRunner(this.#command, this.#env);
    this.#store = options.store ?? new DatadogOrgStore();
    this.#loginTimeout = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.#onChange = options.onChange ?? (() => {});
  }

  list(): Promise<DatadogOrg[]> {
    this.#orgs ??= this.#store.read().catch((error: unknown) => { this.#orgs = undefined; throw error; });
    return this.#orgs;
  }

  /** Configured orgs whose links use `host`, in the operator's order. */
  async orgsFor(host: string): Promise<DatadogOrg[]> {
    return (await this.list().catch(() => [])).filter((org) => org.site === host);
  }

  /** Records what a lookup learned about an org's session. */
  signedOut(org: DatadogOrg, value: boolean): void {
    if (value) this.#signedOut.add(orgKey(org));
    else this.#signedOut.delete(orgKey(org));
  }

  /** `pup auth refresh` for one org; true when it renewed the token. */
  async refresh(org: DatadogOrg): Promise<boolean> {
    try {
      await this.run(["auth", "refresh"], org);
      return true;
    } catch {
      return false;
    }
  }

  async connection(): Promise<DatadogConnection> {
    const orgs = await this.list();
    const version = await this.#version();
    if (!version) return { cli: { installed: false }, orgs: orgs.map((org) => ({ ...org, status: "unknown" })), pupOrgs: [], login: this.#login };
    const sessions = await this.run(["auth", "list"]).then(parsePupSessions, () => undefined);
    const pupOrgs: DatadogOrg[] = [];
    for (const session of sessions ?? []) {
      const site = normalizeDatadogSite(session.site);
      if (site && !pupOrgs.some((org) => org.name === session.org && org.site === site)) pupOrgs.push({ name: session.org, site });
    }
    return {
      cli: { installed: true, version },
      orgs: orgs.map((org) => ({
        ...org,
        status: !sessions ? "unknown" : this.#signedOut.has(orgKey(org)) ? "signed_out" : sessionStatus(org, sessions),
      })),
      pupOrgs,
      login: this.#login,
    };
  }

  /** Adds an org and, when pup has no usable session for it, starts its sign-in. */
  async add(raw: unknown): Promise<DatadogConnection> {
    const org = normalizeOrg(raw);
    await this.#mutate((orgs) => {
      if (orgs.some((entry) => orgKey(entry) === orgKey(org))) throw new DatadogError("That org is already in the list.", 409);
      return [...orgs, org];
    });
    const connection = await this.connection();
    if (connection.orgs.find((entry) => orgKey(entry) === orgKey(org))?.status !== "signed_out") return connection;
    // The org is added either way; another sign-in already running just means this one waits for a click.
    return this.startLogin(org).catch((error: unknown) => {
      if (error instanceof DatadogError && error.status === 409) return this.connection();
      throw error;
    });
  }

  async remove(raw: unknown): Promise<DatadogConnection> {
    const org = normalizeOrg(raw);
    await this.#mutate((orgs) => {
      if (!orgs.some((entry) => orgKey(entry) === orgKey(org))) throw new DatadogError("That org is not in the list.", 404);
      return orgs.filter((entry) => orgKey(entry) !== orgKey(org));
    });
    this.#signedOut.delete(orgKey(org));
    return this.connection();
  }

  /** Writes `change(current list)` after any earlier change has finished. */
  #mutate(change: (orgs: DatadogOrg[]) => DatadogOrg[]): Promise<void> {
    const run = this.#mutation.catch(() => {}).then(async () => {
      const next = change(await this.list());
      await this.#store.write(next);
      this.#orgs = Promise.resolve(next);
      this.#onChange();
    });
    this.#mutation = run;
    return run;
  }

  /** Runs `pup auth login` for a configured org. pup prints its sign-in page and opens the browser on this machine. */
  async startLogin(raw: unknown): Promise<DatadogConnection> {
    const org = normalizeOrg(raw);
    const known = (await this.list()).some((entry) => orgKey(entry) === orgKey(org));
    const version = await this.#version();
    // Checked after every await and set before the next one, so two callers can never both start a sign-in.
    if (this.#loginActive()) throw new DatadogError("Another Datadog sign-in is in progress.", 409);
    if (!known) throw new DatadogError("Add the org before signing in to it.", 404);
    if (!version) throw new DatadogError(DATADOG_CLI_REQUIRED);
    let settle!: () => void;
    this.#settled = new Promise<void>((resolve) => { settle = resolve; });
    let child: ChildProcess;
    try {
      // No --read-only: it would narrow the scopes of the operator's own session.
      child = spawn(this.#command, ["auth", "login", ...orgArgs(org), `--site=${pupSite(org.site)}`, "--no-agent"], {
        env: pupEnv(this.#env, org),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.#login = { phase: "failed", org, message: loginFailureMessage(String(error), null) };
      settle();
      return this.connection();
    }
    this.#child = child;
    this.#login = { phase: "pending", org, expiresAt: Date.now() + this.#loginTimeout };
    let output = "";
    let ending: "cancelled" | "expired" | undefined;
    const kill = (reason: NonNullable<typeof ending>) => { ending ??= reason; child.kill("SIGTERM"); };
    const timer = setTimeout(() => kill("expired"), this.#loginTimeout);
    const onOutput = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
      const url = this.#login.phase === "pending" && !this.#login.url ? parseLoginUrl(output) : undefined;
      if (url && this.#child === child && this.#login.phase === "pending") this.#login = { ...this.#login, url };
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    this.#cancel = () => kill("cancelled");
    let finished = false;
    const finish = (code: number | null, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.#child = undefined;
      this.#cancel = undefined;
      if (ending === "cancelled") this.#login = { phase: "idle" };
      else if (ending === "expired") this.#login = { phase: "failed", org, message: "The sign-in timed out. Try again." };
      else if (error) this.#login = { phase: "failed", org, message: (error as NodeJS.ErrnoException).code === "ENOENT" ? DATADOG_CLI_REQUIRED : loginFailureMessage(String(error), null) };
      else if (code !== 0) this.#login = { phase: "failed", org, message: loginFailureMessage(output, code) };
      else {
        this.#login = { phase: "idle" };
        this.#signedOut.delete(orgKey(org));
        this.#onChange();
      }
      settle();
    };
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
    // A killed pup may leave a grandchild holding the pipes open; do not wait for them.
    child.once("exit", (code) => { if (ending) finish(code); });
    return this.connection();
  }

  /** Stops a sign-in that has not finished; clears a failed one. */
  async cancelLogin(): Promise<DatadogConnection> {
    if (this.#cancel) {
      this.#cancel();
      await this.#settled;
    } else if (this.#login.phase === "failed") {
      this.#login = { phase: "idle" };
    }
    return this.connection();
  }

  /** Resolves when the running sign-in (if any) has reached its final state. */
  whenLoginSettled(): Promise<void> {
    return this.#settled;
  }

  dispose(): void {
    this.#cancel?.();
  }

  #loginActive(): boolean {
    return this.#login.phase === "pending";
  }

  async #version(): Promise<string | undefined> {
    this.#cliVersion ??= await new Promise<string | undefined>((resolve) => {
      execFile(this.#command, ["--version"], { env: pupEnv(this.#env), timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
        resolve(error ? undefined : (/pup (\S+)/u.exec(stdout)?.[1] ?? stdout.trim().split("\n")[0] ?? "").slice(0, 60) || undefined);
      });
    });
    return this.#cliVersion;
  }
}
