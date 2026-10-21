/** GitHub integration through the operator's GitHub CLI.
 *
 * HUI owns no GitHub credential. It asks `gh` whether an account is signed in
 * and, on request, runs `gh auth login --web` so the operator can approve a
 * one-time device code in their own browser. `gh` stores the resulting token in
 * its keyring or config exactly as a terminal login would; HUI only relays the
 * one-time code, the fixed verification URL and the credential-free status.
 *
 * Auto-starring the HUI repo on first GitHub connect is handled here too.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";

import type { GitHubAccount, GitHubConnection, GitHubLoginState } from "../api/github.ts";

export const GITHUB_CLI_REQUIRED = "GitHub CLI (gh) is required. Install it on the machine that runs HUI and make sure `gh` is on the gateway's PATH.";
export const GITHUB_HOST = "github.com";
export const GITHUB_DEVICE_URL = "https://github.com/login/device";
/** GitHub device codes expire after 15 minutes; `gh` keeps polling until then. */
const DEVICE_CODE_TTL_MS = 15 * 60_000;
const START_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 16 * 1024;
const MESSAGE_LIMIT = 300;
export const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" };
const AUTH_REJECTED = /\b401\b|bad credentials|token (?:is )?(?:invalid|expired|revoked)|(?<!proxy )authentication (?:failed|required)/iu;
const ENV_TOKEN_SOURCES = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

export class GitHubCliError extends Error {
  readonly status: 400 | 409 | 502;

  constructor(message: string, status: 400 | 409 | 502 = 400) {
    super(message);
    this.name = "GitHubCliError";
    this.status = status;
  }
}

type Probe = Omit<GitHubConnection, "login">;

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, "");

/** `gh version 2.101.0 (2026-09-01)` → `2.101.0`. */
export function parseGhVersion(output: string): string {
  return /gh version (\S+)/u.exec(output)?.[1] ?? (output.trim().split("\n")[0] ?? "").slice(0, 60);
}

/** The one-time device code from `gh auth login --web` output. */
export function parseDeviceCode(output: string): string | undefined {
  return /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/u.exec(stripAnsi(output))?.[1];
}

/** `gh auth status --json hosts` → the github.com logins, active first. */
export function parseAccounts(stdout: string): { login: string; active: boolean }[] {
  const hosts = (JSON.parse(stdout) as { hosts?: Record<string, unknown> }).hosts;
  const entries = hosts?.[GITHUB_HOST];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry: { login?: unknown; active?: unknown }) => ({ login: typeof entry?.login === "string" ? entry.login : "", active: entry?.active === true }))
    .filter((account) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(account.login))
    .sort((a, b) => Number(b.active) - Number(a.active));
}

/** Maps `gh auth status --hostname github.com --json hosts` to a credential-free status. */
export function parseAuthStatus(stdout: string): Pick<GitHubConnection, "status" | "account" | "message"> {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return { status: "unknown", message: "gh returned an unreadable status." }; }
  const hosts = parsed && typeof parsed === "object" ? (parsed as { hosts?: unknown }).hosts : undefined;
  const entries = hosts && typeof hosts === "object" ? (hosts as Record<string, unknown>)[GITHUB_HOST] : undefined;
  if (!Array.isArray(entries) || entries.length === 0) return { status: "disconnected" };
  const records = entries.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object");
  const active = records.find((entry) => entry["active"] === true) ?? records[0];
  if (!active) return { status: "disconnected" };
  const text = (key: string) => typeof active[key] === "string" ? (active[key] as string).trim() : "";
  const login = text("login");
  const tokenSource = text("tokenSource");
  const account: GitHubAccount = {
    host: text("host") || GITHUB_HOST,
    login,
    scopes: text("scopes").split(",").map((scope) => scope.trim()).filter(Boolean),
    ...(tokenSource ? { tokenSource } : {}),
  };
  const state = text("state");
  if (state === "success" && login) return { status: "connected", account };
  const reason = text("error").slice(0, MESSAGE_LIMIT);
  if (state === "timeout") return { status: "unknown", account, message: reason || "GitHub did not answer in time." };
  // gh reports network and proxy failures with the same `error` state as a
  // rejected token; only a clear authentication refusal means signing in again helps.
  if (reason && !AUTH_REJECTED.test(reason)) return { status: "unknown", account, message: `GitHub could not be reached: ${reason}` };
  return { status: "invalid", account, message: reason || "The saved GitHub token is no longer valid. Sign in again." };
}

/** The last meaningful line of `gh` output, never the device code or its prompt lines.
 * Errors may quote `https://github.com/login/device/code`, so URLs alone do not disqualify a line. */
export function loginFailureMessage(output: string, code: number | null): string {
  const lines = stripAnsi(output).split("\n").map((line) => line.replace(/^[!X✗]\s*/u, "").trim())
    .filter((line) => line && !/one-time code|^open this url|clipboard/iu.test(line));
  return (lines.at(-1) ?? `gh auth login exited with code ${code ?? "unknown"}.`).slice(0, MESSAGE_LIMIT);
}

export type GitHubCliOptions = {
  /** Executable to run; tests and E2E point this at a fake. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  deviceCodeTtlMs?: number;
  startTimeoutMs?: number;
};

/** Owns the one GitHub device login the gateway may run at a time. */
export class GitHubCli {
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #startTimeout: number;
  #login: GitHubLoginState = { phase: "idle" };
  #last?: Probe;
  #child?: ChildProcess;
  #cancel?: () => void;
  #settled: Promise<void> = Promise.resolve();

  constructor(options: GitHubCliOptions = {}) {
    this.#command = options.command ?? "gh";
    this.#env = { ...(options.env ?? process.env), ...GH_ENV };
    this.#now = options.now ?? Date.now;
    this.#ttl = options.deviceCodeTtlMs ?? DEVICE_CODE_TTL_MS;
    this.#startTimeout = options.startTimeoutMs ?? START_TIMEOUT_MS;
  }

  /** Current status. While a login waits for approval the last probe is reused so polling stays local. */
  async connection(): Promise<GitHubConnection> {
    if (!this.#last || !this.#loginActive()) this.#last = await this.#probe();
    return { ...this.#last, login: this.#login };
  }

  /** Starts `gh auth login --web` and resolves once the one-time code (or a failure) is known. */
  async startLogin(): Promise<GitHubConnection> {
    if (this.#loginActive()) return this.connection();
    const probe = await this.#probe();
    this.#last = probe;
    if (!probe.cli.installed) throw new GitHubCliError(GITHUB_CLI_REQUIRED, 409);
    const source = probe.account?.tokenSource ?? "";
    if (ENV_TOKEN_SOURCES.has(source)) {
      throw new GitHubCliError(`gh is using the ${source} environment variable of the HUI gateway. Remove it from the gateway's environment to sign in here.`, 409);
    }
    // Non-interactive gh would otherwise leave the protocol choice to its default;
    // keep whatever the operator already configured (for example ssh).
    const protocol = (await this.#run(["config", "get", "git_protocol", "--host", GITHUB_HOST], 5_000).catch(() => "")).trim();
    const protocolArgs = protocol === "ssh" || protocol === "https" ? ["--git-protocol", protocol] : [];
    this.#login = { phase: "starting" };
    let ready!: () => void;
    const codeKnown = new Promise<void>((resolve) => { ready = resolve; });
    let settle!: () => void;
    this.#settled = new Promise<void>((resolve) => { settle = resolve; });
    let child: ChildProcess;
    try {
      child = spawn(this.#command, ["auth", "login", "--hostname", GITHUB_HOST, "--web", "--skip-ssh-key", ...protocolArgs], {
        env: this.#env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      this.#login = { phase: "failed", message: spawnFailure(error) };
      settle();
      return this.connection();
    }
    this.#child = child;
    let output = "";
    let ending: "cancelled" | "expired" | "no-code" | undefined;
    const kill = (reason: typeof ending) => { ending ??= reason; child.kill("SIGTERM"); };
    const startTimer = setTimeout(() => { if (this.#login.phase === "starting") kill("no-code"); }, this.#startTimeout);
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const onOutput = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT);
      if (this.#child !== child || this.#login.phase !== "starting") return;
      const userCode = parseDeviceCode(output);
      if (!userCode) return;
      clearTimeout(startTimer);
      this.#login = { phase: "pending", userCode, verificationUri: GITHUB_DEVICE_URL, expiresAt: this.#now() + this.#ttl };
      expiryTimer = setTimeout(() => kill("expired"), this.#ttl);
      ready();
    };
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    this.#cancel = () => kill("cancelled");
    let finished = false;
    const finish = async (exitCode: number | null, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(startTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      if (this.#child === child) { this.#child = undefined; this.#cancel = undefined; }
      if (ending === "cancelled") this.#login = { phase: "idle" };
      else if (error) this.#login = { phase: "failed", message: spawnFailure(error) };
      else if (ending === "expired") this.#login = { phase: "failed", message: "The one-time code expired. Connect again to request a new code." };
      else if (ending === "no-code") this.#login = { phase: "failed", message: "gh did not print a one-time code. Run `gh auth login --web` in a terminal to see why." };
      else if (exitCode !== 0) this.#login = { phase: "failed", message: loginFailureMessage(output, exitCode) };
      else {
        const probe = await this.#probe();
        this.#last = probe;
        this.#login = probe.status === "connected"
          ? { phase: "idle" }
          : { phase: "failed", message: probe.message ?? "gh finished, but no GitHub account is signed in." };
      }
      ready();
      settle();
    };
    child.once("error", (error) => void finish(null, error));
    child.once("close", (code) => void finish(code));
    // A killed gh may leave a grandchild holding the pipes open; do not wait for them.
    child.once("exit", (code) => { if (ending) void finish(code); });
    await codeKnown;
    return { ...(this.#last ?? probe), login: this.#login };
  }

  /** Stops a login that has not been approved yet. */
  async cancelLogin(): Promise<GitHubConnection> {
    if (this.#cancel) {
      this.#cancel();
      await this.#settled;
    } else if (this.#login.phase === "failed") {
      this.#login = { phase: "idle" };
    }
    return this.connection();
  }

  /** Resolves when the running login (if any) has reached its final state. */
  whenLoginSettled(): Promise<void> {
    return this.#settled;
  }

  /** Stars the HUI repo. Safe to call repeatedly — gh is idempotent. */
  async starHuiRepo(): Promise<boolean> {
    const connection = await this.connection();
    if (connection.status !== "connected") return false;
    try {
      // gh has no "star" subcommand; use the API directly
      await this.#run(["api", "-X", "PUT", "user/starred/DaniFdz/hui"], 30_000);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
  }

  #loginActive(): boolean {
    return this.#login.phase === "starting" || this.#login.phase === "pending";
  }

  #run(args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.#command, args, { env: this.#env, timeout, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  async #probe(): Promise<Probe> {
    let version: string;
    try {
      version = parseGhVersion(await this.#run(["--version"], 5_000));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return { cli: { installed: false }, status: "disconnected", message: missing ? GITHUB_CLI_REQUIRED : spawnFailure(error) };
    }
    try {
      const status = parseAuthStatus(await this.#run(["auth", "status", "--hostname", GITHUB_HOST, "--json", "hosts"], 15_000));
      return { cli: { installed: true, version }, ...status };
    } catch (error) {
      return { cli: { installed: true, version }, status: "unknown", message: `gh auth status failed: ${spawnFailure(error)}` };
    }
  }
}

export function spawnFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return GITHUB_CLI_REQUIRED;
  if (code === "EACCES") return "The gh executable on the gateway's PATH is not executable.";
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
  return stripAnsi(text).trim().split("\n").at(-1)!.slice(0, MESSAGE_LIMIT);
}
