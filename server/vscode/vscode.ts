/**
 * The VS Code view's process side: which VS Code this machine runs (the provider chain in vscode-providers.ts and
 * the optional openvscode-server install in vscode-install.ts), running one shared instance for the gateway, the
 * operator's license consent for `code serve-web`, and the capabilities a browser frame trades for access to it.
 *
 * Nothing runs or downloads until a view opens. The server then listens on 127.0.0.1 on a free port behind a random
 * connection token that is rotated on every start, keeps its data under HUI's config directory and stops with the
 * gateway, after an idle period with no open connections, or when Settings change what it runs. It runs in its own
 * process group (openvscode-server is a shell script around node, `code` a launcher around the VS Code CLI, with
 * servers and extension hosts below them), and every stop signals the whole group. serve-web is started only after
 * the operator accepted Microsoft's license in HUI; its first start downloads the matching VS Code server build,
 * whose progress the status reports. A crash is reported and only an explicit open starts it again; nothing restarts
 * it in a loop. Nothing here blocks a gateway stop. Carrying HTTP and WebSocket traffic to it is vscode-proxy.ts's
 * job; the routes live in routes/vscode.ts.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, get as httpGet } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { VSCODE_BASE_PATH, VSCODE_ENTER_PATH } from "./contract.ts";
import type { VscodeConnection, VscodeErrorCode, VscodeFlavor, VscodeProvider, VscodeState, VscodeStatus, VscodeTheme } from "../api/vscode.ts";
import type { VscodeSettings } from "../hui-settings.ts";
import {
  defaultVscodeProbe, detectVscodeProviders, parseServeWebProgress, planVscode, publicProvider, serveWebLaunchArguments,
  vscodeEnvironment, vscodeLaunchArguments, type DetectedProvider, type VscodePlan, type VscodeProbe,
} from "./providers.ts";
import type { VscodeInstaller } from "./install.ts";

/** The key a cookie session is stored under: the id itself never sits in gateway memory. */
function sessionDigest(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("base64url");
}

export { parseVscodeHelp, vscodeEnvironment, vscodeLaunchArguments, type VscodeProbe } from "./providers.ts";

export class VscodeError extends Error {
  status: number;
  code: VscodeErrorCode;
  constructor(message: string, status = 409, code: VscodeErrorCode = "failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("No free port.")));
    });
  });
}

/** Loopback requests never go through an ambient HTTP proxy. */
export const vscodeAgent = new Agent({ keepAlive: true, maxSockets: 64 });

/** `/version`'s status: 200 once a server answers; serve-web answers 202 while it downloads its build; 0 for no answer. */
function probeVersion(port: number): Promise<number> {
  return new Promise((resolve) => {
    const request = httpGet({ host: "127.0.0.1", port, path: `${VSCODE_BASE_PATH}/version`, agent: vscodeAgent, timeout: 2_000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(0));
  });
}

/** Signals a server's whole process group; on Windows, which has none, just the process. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch { /* already gone */ }
}

/** Whether anything of a process group is left. EPERM says so too: for another user's members, and on macOS for members
 * that exited but are not yet reaped, where Linux answers success. */
function groupAlive(pid: number): boolean {
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Process groups of servers this gateway runs, signalled if the gateway exits without stopping them. */
const liveGroups = new Set<ChildProcess>();
let exitHookInstalled = false;
function trackGroup(child: ChildProcess) {
  liveGroups.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => { for (const group of liveGroups) signalGroup(group, "SIGTERM"); });
}

function providerKey(provider: Pick<VscodeProvider, "kind" | "path" | "flavor">): string {
  return `${provider.kind}\0${provider.flavor}\0${provider.path}`;
}

type Running = {
  child: ChildProcess;
  port: number;
  token: string;
  instance: number;
  startedAt: string;
  provider: DetectedProvider;
  stopping: boolean;
  exited: Promise<void>;
  output: string[];
};

type Ticket = { folder: string; theme?: VscodeTheme; expires: number };
type CookieSession = { theme?: VscodeTheme; expires: number };

export type VscodeServiceOptions = {
  /** HUI's VS Code directory: server data, extensions, serve-web's data, the token file and the pid file. */
  dir: string;
  settings: () => Promise<VscodeSettings>;
  /** Saves the license acceptance (an ISO time, or empty to revoke) in HUI's settings. */
  saveLicense?: (acceptedAt: string) => Promise<void>;
  /** The openvscode-server HUI can install; without one no install is offered. */
  installer?: VscodeInstaller;
  probe?: VscodeProbe;
  /** Stop after this long without a connection; 15 minutes by default. */
  idleMs?: number;
  readyTimeoutMs?: number;
  /** serve-web's first start may download a VS Code server build for this long; 15 minutes by default. */
  prepareTimeoutMs?: number;
  /** ...and gives up when no byte of it arrived for this long; 60 seconds by default. */
  stallMs?: number;
  /** How long an open waits for a start before answering that it is still starting; 8 seconds by default. */
  connectWaitMs?: number;
  ticketMs?: number;
  /** A frame's cookie stays valid this long after its last request. */
  sessionMs?: number;
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
};

const MAX_TICKETS = 64;
const MAX_SESSIONS = 32;
const OUTPUT_LINES = 40;

/** The end of a server's output that explains a failure: no routine missing-file lines, nothing holding the token. */
function lastLines(output: readonly string[]): string {
  return output.join("").split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("File not found:") && !line.includes("tkn=") && !/^\*/u.test(line) && !/\] (trace|debug) /u.test(line))
    .slice(-3).join(" · ");
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? signal : `exit code ${code ?? "unknown"}`;
}

/** serve-web logs what its downloaded server prints as "[645f29c stderr]: …"; those lines say why it cannot run. */
function serveWebServerErrors(output: readonly string[]): string {
  return output.join("").split(/\r?\n/u)
    .map((line) => /\[[0-9a-f]{7} stderr\]:\s*(.*)$/u.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean).slice(-3).join(" ");
}

export class VscodeService {
  readonly dir: string;
  readonly idleMs: number;
  #options: VscodeServiceOptions;
  #probe: VscodeProbe;
  #running: Running | undefined;
  #starting: Promise<Running> | undefined;
  #startingProvider: DetectedProvider | undefined;
  #state: Exclude<VscodeState, "setup"> = "stopped";
  #lastError = "";
  #instance = 0;
  #connections = 0;
  #preparing: { received: number; total: number } | null = null;
  /** The process of a start in progress, so a stop does not wait out serve-web's download. */
  #startingChild: ChildProcess | undefined;
  #cancelStart = false;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #reaped = false;
  #disposed = false;
  readonly #tickets = new Map<string, Ticket>();
  readonly #sessions = new Map<string, CookieSession>();

  constructor(options: VscodeServiceOptions) {
    this.#options = options;
    this.dir = options.dir;
    this.idleMs = options.idleMs ?? 15 * 60_000;
    this.#probe = options.probe ?? defaultVscodeProbe();
  }

  #now(): number { return this.#options.now?.() ?? Date.now(); }

  get tokenFile(): string { return join(this.dir, "connection-token"); }
  get #pidFile(): string { return join(this.dir, "server.json"); }
  /** serve-web's data: Microsoft's server builds and the marketplace's extensions stay apart from openvscode-server's. */
  get serveWebDir(): string { return join(this.dir, "serve-web"); }

  async #plan(settings: VscodeSettings) {
    const managed = (await this.#options.installer?.installed())?.path ?? null;
    const detection = await detectVscodeProviders({ configured: settings.executable, managed }, this.#probe);
    const plan = planVscode(detection, { preference: settings.provider, configured: settings.executable, licenseAccepted: Boolean(settings.licenseAcceptedAt) });
    return { detection, plan };
  }

  async status(): Promise<VscodeStatus> {
    const settings = await this.#options.settings();
    const { detection, plan } = await this.#plan(settings);
    const install = this.#options.installer
      ? await this.#options.installer.status()
      : { supported: false, reason: "This gateway cannot install a VS Code server.", version: "", arch: "", size: 0, dir: "", installed: null, task: null, error: "", hint: "" };
    const running = this.#running;
    const busy = running ?? (this.#starting ? { provider: this.#startingProvider } : undefined);
    const desktop = plan.consent ?? null;
    const needed = !plan.active;
    const state: VscodeState = busy ? this.#state : plan.active ? this.#state : "setup";
    return {
      platform: this.#probe.platform,
      enabled: settings.enabled,
      configuredExecutable: settings.executable,
      preference: settings.provider,
      providers: detection.providers.map(publicProvider),
      problems: detection.problems,
      active: plan.active ? publicProvider(plan.active) : null,
      activeError: plan.error,
      setup: {
        needed,
        desktop: needed && desktop ? publicProvider(desktop) : null,
        install: needed && !plan.error && install.supported && !install.installed,
        download: needed && !plan.error && !desktop && !install.supported,
      },
      license: { accepted: Boolean(settings.licenseAcceptedAt), acceptedAt: settings.licenseAcceptedAt },
      install,
      state,
      running: busy?.provider ? publicProvider(busy.provider) : null,
      preparing: this.#preparing,
      instance: this.#instance,
      ...(running?.child.pid ? { pid: running.child.pid } : {}),
      ...(running ? { startedAt: running.startedAt } : {}),
      lastError: this.#lastError,
      connections: this.#connections,
      idleMinutes: Math.round(this.idleMs / 60_000),
      dataDir: this.dir,
    };
  }

  /** The running server, if there is one. The proxy uses only this: a frame's requests never start VS Code, so a
   * crashed server is not restarted by its own reconnecting workbench. */
  current(): { port: number; token: string; instance: number; flavor: VscodeFlavor; label: string } | undefined {
    const running = this.#running;
    return running && !running.stopping ? {
      port: running.port, token: running.token, instance: running.instance, flavor: running.provider.flavor,
      label: `${running.provider.name} ${running.provider.version}`,
    } : undefined;
  }

  /** The running server, started now if it is not. Concurrent callers share one start. Refuses with `setup` while
   * nothing can run: no provider, or only a VS Code whose license the operator has not accepted. */
  async ensure(): Promise<{ port: number; token: string; instance: number }> {
    if (this.#disposed) throw new VscodeError("The gateway is stopping.", 503, "failed");
    const running = this.#running;
    if (running && !running.stopping) return running;
    if (this.#starting) return this.#starting;
    const settings = await this.#options.settings();
    const { plan } = await this.#plan(settings);
    if (this.#running && !this.#running.stopping) return this.#running;
    if (this.#starting) return this.#starting;
    const provider = plan.active;
    if (!provider) throw new VscodeError(this.#setupReason(plan), 409, "setup");
    this.#startingProvider = provider;
    this.#starting = this.#start(provider, settings).finally(() => { this.#starting = undefined; this.#startingProvider = undefined; });
    return this.#starting;
  }

  #setupReason(plan: VscodePlan): string {
    if (plan.error) return plan.error;
    if (plan.consent) return "VS Code needs you to accept the VS Code Server license before HUI runs it.";
    return "No VS Code was found on this machine. Choose how to run it in the VS Code view.";
  }

  async #start(provider: DetectedProvider, settings: VscodeSettings): Promise<Running> {
    if (this.#running) await this.#running.exited;
    this.#state = "starting";
    this.#lastError = "";
    this.#preparing = null;
    try {
      await this.#reapStale();
      const serveWeb = provider.flavor === "serve-web";
      const subdirectories = serveWeb ? [join("serve-web", "server-data"), join("serve-web", "cli")] : ["server-data", "user-data", "extensions"];
      for (const sub of subdirectories) await mkdir(join(this.dir, sub), { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
      const token = randomBytes(32).toString("base64url");
      await writeFile(this.tokenFile, token, { mode: 0o600 });
      await chmod(this.tokenFile, 0o600);
      const port = await freePort();
      const args = serveWeb
        ? serveWebLaunchArguments({
          port, tokenFile: this.tokenFile, dir: this.serveWebDir, licenseAcceptedAt: settings.licenseAcceptedAt,
          ...(provider.commit ? { commit: provider.commit } : {}), ...(provider.features ? { features: provider.features } : {}),
        })
        : vscodeLaunchArguments({ port, tokenFile: this.tokenFile, dir: this.dir });
      const child = spawn(provider.path, args, {
        env: { ...vscodeEnvironment(this.#options.env?.() ?? process.env), DONT_PROMPT_WSL_INSTALL: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Its own process group, so a stop reaches what the launcher script started.
        detached: process.platform !== "win32",
      });
      trackGroup(child);
      this.#startingChild = child;
      // openvscode-server's stdout is its routine log and only stderr explains a failure; serve-web logs everything,
      // its download's progress included, to stdout.
      const output: string[] = [];
      const keep = (chunk: Buffer) => { output.push(chunk.toString("utf8")); if (output.length > OUTPUT_LINES) output.shift(); };
      let pending = "";
      if (serveWeb) {
        child.stdout?.on("data", (chunk: Buffer) => {
          keep(chunk);
          const lines = (pending + chunk.toString("utf8")).split(/\r?\n/u);
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const progress = parseServeWebProgress(line);
            if (progress) this.#preparing = progress;
          }
        });
      } else {
        child.stdout?.resume();
      }
      child.stderr?.on("data", keep);
      const exited = new Promise<void>((resolve) => child.once("exit", () => {
        // The launcher is gone; whatever is left of its group follows it.
        void this.#reapGroup(child).finally(() => { liveGroups.delete(child); resolve(); });
      }));
      const running: Running = {
        child, port, token, instance: ++this.#instance, startedAt: new Date(this.#now()).toISOString(),
        provider, stopping: false, exited, output,
      };
      let spawnError: Error | undefined;
      child.once("error", (error) => { spawnError = error; });
      const fail = (message: string): never => { signalGroup(child, "SIGKILL"); throw new VscodeError(message, 502); };
      const readyMs = this.#options.readyTimeoutMs ?? 60_000;
      const deadline = Date.now() + readyMs;
      let prepareDeadline = 0;
      let lastProgress = { received: -1, at: Date.now() };
      for (;;) {
        if (spawnError) throw new VscodeError(`${provider.name} could not be started: ${spawnError.message}`, 502);
        if (child.exitCode !== null || child.signalCode !== null) {
          const detail = lastLines(output);
          throw new VscodeError(`${provider.name} exited while starting (${exitDescription(child.exitCode, child.signalCode)})${detail ? `: ${detail}` : "."}`, 502);
        }
        if (this.#cancelStart) fail("VS Code was stopped while it started.");
        const answer = await probeVersion(port);
        if (answer === 200) break;
        if (serveWeb) {
          if (answer === 202) {
            // Up, and fetching the VS Code server build that matches this desktop: wait for it, with progress.
            prepareDeadline ||= Date.now() + (this.#options.prepareTimeoutMs ?? 15 * 60_000);
            this.#preparing ??= { received: 0, total: 0 };
            if (this.#preparing.received !== lastProgress.received) lastProgress = { received: this.#preparing.received, at: Date.now() };
            const stallMs = this.#options.stallMs ?? 60_000;
            if (Date.now() - lastProgress.at > stallMs) {
              fail(`VS Code could not download its web server from Microsoft (update.code.visualstudio.com): nothing arrived for ${Math.round(stallMs / 1000)} seconds. The first open needs an internet connection; check it, or the gateway's HTTPS_PROXY, then retry.`);
            }
          } else if (answer !== 0) {
            const detail = serveWebServerErrors(output) || lastLines(output);
            fail(`VS Code's web server did not start (HTTP ${answer})${detail ? `: ${detail}` : "."}`);
          }
          if (prepareDeadline && /\[[0-9a-f]{7} process\]: exited/u.test(output.join(""))) {
            // The downloaded build ran and died (on NixOS it cannot run without nix-ld); serve-web would retry forever.
            const detail = serveWebServerErrors(output);
            fail(`VS Code's web server exited while starting${detail ? `: ${detail}` : "."}`);
          }
          if (prepareDeadline && Date.now() > prepareDeadline) fail("VS Code's web server download did not finish within 15 minutes. Check the connection, then retry.");
        }
        if (!prepareDeadline && Date.now() > deadline) {
          fail(`${provider.name} did not answer on 127.0.0.1:${port} within ${Math.round(readyMs / 1000)} seconds.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      this.#preparing = null;
      if (this.#disposed) { signalGroup(child, "SIGTERM"); throw new VscodeError("The gateway is stopping.", 503); }
      this.#running = running;
      this.#state = "running";
      child.once("exit", (code, signal) => this.#exited(running, code, signal));
      void writeFile(this.#pidFile, JSON.stringify({ pid: child.pid, dataDir: serveWeb ? this.serveWebDir : join(this.dir, "server-data") }), { mode: 0o600 }).catch(() => undefined);
      this.#scheduleIdle();
      return running;
    } catch (error) {
      this.#preparing = null;
      const cancelled = this.#cancelStart;
      this.#state = cancelled ? "stopped" : "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.#lastError = cancelled ? "" : message;
      throw error instanceof VscodeError ? error : new VscodeError(message, 502);
    } finally {
      this.#startingChild = undefined;
      this.#cancelStart = false;
    }
  }

  #exited(running: Running, code: number | null, signal: NodeJS.Signals | null) {
    if (this.#running !== running) return;
    this.#running = undefined;
    this.#clearIdle();
    if (running.stopping) {
      this.#state = "stopped";
    } else {
      this.#state = "failed";
      const detail = lastLines(running.output);
      this.#lastError = `VS Code exited unexpectedly (${exitDescription(code, signal)})${detail ? `: ${detail}` : "."}`;
    }
    void rm(this.#pidFile, { force: true }).catch(() => undefined);
  }

  /** Gives the rest of a group a moment to finish after its leader exits, then kills what remains. */
  async #reapGroup(child: ChildProcess) {
    const pid = child.pid;
    if (!pid || !groupAlive(pid)) return;
    signalGroup(child, "SIGTERM");
    const deadline = Date.now() + 3_000;
    while (groupAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    if (groupAlive(pid)) signalGroup(child, "SIGKILL");
  }

  /** A server a killed gateway left behind is stopped before a new one starts: its recorded process group, but only
   * when a member of that group still names this data directory. */
  async #reapStale() {
    if (this.#reaped) return;
    this.#reaped = true;
    let record: { pid?: unknown; dataDir?: unknown };
    try { record = JSON.parse(await readFile(this.#pidFile, "utf8")) as typeof record; } catch { return; }
    const pid = typeof record.pid === "number" ? record.pid : 0;
    const dataDir = typeof record.dataDir === "string" ? record.dataDir : "";
    await rm(this.#pidFile, { force: true }).catch(() => undefined);
    if (!pid || !dataDir || pid === process.pid || process.platform === "win32" || !groupAlive(pid)) return;
    let listing = "";
    try { listing = (await promisify(execFile)("ps", ["-axo", "pgid=,command="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { return; }
    const owned = listing.split("\n").some((line) => {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
      return match?.[1] === String(pid) && (match[2] ?? "").includes(dataDir);
    });
    if (owned) { try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ } }
  }

  /** A proxied request or socket holds the server open; the release starts the idle countdown once none is left. */
  acquire(): () => void {
    this.#connections++;
    this.#clearIdle();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#connections--;
      this.#scheduleIdle();
    };
  }

  #clearIdle() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = undefined;
  }

  #scheduleIdle() {
    this.#clearIdle();
    if (this.#connections > 0 || !this.#running) return;
    this.#idle = setTimeout(() => { this.#idle = undefined; if (this.#connections === 0) void this.stop(); }, this.idleMs);
    this.#idle.unref();
  }

  /** A one-use frame URL on `folder`, starting VS Code if needed. A start that takes longer than the wait (serve-web
   * downloading its first build) answers `{ pending: true }` and carries on; the view follows the status and asks
   * again once it runs. */
  async connect(folder: string, theme: VscodeTheme | undefined): Promise<VscodeConnection | { pending: true }> {
    const start = this.ensure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), this.#options.connectWaitMs ?? 8_000); });
    let server: { instance: number } | undefined;
    try { server = await Promise.race([start, waited]); } finally { clearTimeout(timer); }
    if (!server) { start.catch(() => undefined); return { pending: true }; }
    const now = this.#now();
    for (const [key, ticket] of this.#tickets) if (ticket.expires <= now) this.#tickets.delete(key);
    if (this.#tickets.size >= MAX_TICKETS) throw new VscodeError("Too many pending VS Code connections.", 429, "busy");
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { folder, ...(theme ? { theme } : {}), expires: now + (this.#options.ticketMs ?? 30_000) });
    const home = this.#probe.home;
    const label = folder === home ? "~" : folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
    return { url: `${VSCODE_ENTER_PATH}?ticket=${ticket}`, folder, label, instance: server.instance };
  }

  /** Trades a ticket, once, for a cookie session id. Only its SHA-256 is kept, so the map never holds a usable id. */
  enter(ticket: string): { sessionId: string; folder: string } | undefined {
    const entry = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    const now = this.#now();
    if (!entry || entry.expires <= now) return undefined;
    for (const [key, session] of this.#sessions) if (session.expires <= now) this.#sessions.delete(key);
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.#sessions].sort(([, a], [, b]) => a.expires - b.expires)[0];
      if (!oldest) break;
      this.#sessions.delete(oldest[0]);
    }
    const sessionId = randomBytes(32).toString("base64url");
    this.#sessions.set(sessionDigest(sessionId), { ...(entry.theme ? { theme: entry.theme } : {}), expires: now + (this.#options.sessionMs ?? 12 * 60 * 60_000) });
    return { sessionId, folder: entry.folder };
  }

  /** The cookie session one of these ids names, refreshed; undefined when none is valid. */
  session(sessionIds: readonly string[]): CookieSession | undefined {
    const now = this.#now();
    for (const sessionId of sessionIds) {
      const key = sessionDigest(sessionId);
      const session = this.#sessions.get(key);
      if (!session) continue;
      if (session.expires <= now) { this.#sessions.delete(key); continue; }
      session.expires = now + (this.#options.sessionMs ?? 12 * 60 * 60_000);
      return session;
    }
    return undefined;
  }

  #withdraw() {
    this.#tickets.clear();
    this.#sessions.clear();
  }

  /** Settings changed: a server that is no longer what an open would run (another provider or path, a revoked
   * license) stops, and a revoked license also withdraws every frame's access. The next open runs the new choice. */
  async applySettings(next: VscodeSettings): Promise<void> {
    const running = this.#running;
    if (!running && !this.#starting) return;
    const provider = running?.provider ?? this.#startingProvider;
    if (provider?.flavor === "serve-web" && !next.licenseAcceptedAt) {
      this.#withdraw();
      await this.stop();
      return;
    }
    const { plan } = await this.#plan(next);
    if (provider && (!plan.active || providerKey(plan.active) !== providerKey(provider))) await this.stop();
  }

  /** The operator accepted Microsoft's VS Code Server license in HUI; serve-web may run from now on. */
  async acceptLicense(): Promise<void> {
    if (!this.#options.saveLicense) throw new VscodeError("This gateway cannot record the license acceptance.", 500);
    await this.#options.saveLicense(new Date(this.#now()).toISOString());
  }

  /** Revoking stops a running serve-web (through applySettings) and HUI never starts it again until accepted. */
  async revokeLicense(): Promise<void> {
    if (!this.#options.saveLicense) throw new VscodeError("This gateway cannot record the license acceptance.", 500);
    await this.#options.saveLicense("");
    if (this.#running?.provider.flavor === "serve-web" || this.#startingProvider?.flavor === "serve-web") {
      this.#withdraw();
      await this.stop();
    }
  }

  /** Starts installing openvscode-server and returns at once; the status reports its progress. */
  startInstall(): void {
    const installer = this.#options.installer;
    if (!installer) throw new VscodeError("This gateway cannot install a VS Code server.", 409, "failed");
    void installer.install().catch(() => undefined);
  }

  async cancelInstall(): Promise<void> {
    await this.#options.installer?.cancel();
  }

  /** Removes the openvscode-server HUI installed, stopping it first when it is what runs. */
  async uninstall(): Promise<void> {
    const installer = this.#options.installer;
    if (!installer) return;
    if (this.#running?.provider.kind === "managed" || this.#startingProvider?.kind === "managed") await this.stop();
    await installer.uninstall();
  }

  async stop(): Promise<void> {
    if (this.#starting) {
      this.#cancelStart = true;
      if (this.#startingChild) signalGroup(this.#startingChild, "SIGTERM");
      await this.#starting.catch(() => undefined);
    }
    const running = this.#running;
    this.#clearIdle();
    if (!running) {
      if (this.#state !== "failed") this.#state = "stopped";
      return;
    }
    running.stopping = true;
    signalGroup(running.child, "SIGTERM");
    const killed = setTimeout(() => signalGroup(running.child, "SIGKILL"), 5_000);
    killed.unref();
    await running.exited;
    clearTimeout(killed);
  }

  /** With the gateway: signals the server and returns at once, so a stop or restart never waits for it. */
  dispose(): void {
    this.#disposed = true;
    this.#clearIdle();
    this.#withdraw();
    void this.#options.installer?.cancel();
    if (this.#startingChild) { this.#cancelStart = true; signalGroup(this.#startingChild, "SIGTERM"); }
    const running = this.#running;
    if (!running) return;
    running.stopping = true;
    signalGroup(running.child, "SIGTERM");
    setTimeout(() => signalGroup(running.child, "SIGKILL"), 2_000).unref();
  }
}
