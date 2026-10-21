/**
 * Finding the VS Codes this machine can run for the VS Code view, and the arguments each is launched with.
 *
 * Four sources, in the order `auto` prefers them: a path saved in Settings; the installed VS Code desktop's `code`
 * CLI (on PATH and in each platform's standard install locations), which HUI runs as `code serve-web`, Microsoft's
 * own web server, only after the operator accepted its license; the openvscode-server HUI installed itself
 * (vscode-install.ts); and openvscode-server or a compatible code-server on PATH. Every candidate is checked by
 * running it (`--help`, `--version`, `serve-web --help`), never by its name alone, and one that does not fit is reported
 * with the reason. Running the chosen one is vscode.ts's job.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { promisify } from "node:util";
import { VSCODE_BASE_PATH, VSCODE_PROVIDER_ORDER } from "./contract.ts";
import type { VscodeProvider, VscodeProviderKind, VscodeProviderPreference } from "../api/vscode.ts";

export type VscodeProbe = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  isExecutable: (path: string) => Promise<boolean>;
  /** The program's stdout and stderr for these arguments; throws when it cannot run or exits non-zero. */
  run: (path: string, args: readonly string[]) => Promise<string>;
  /** The file a path resolves to, so two links to one install count once. */
  realpath?: (path: string) => Promise<string>;
};

/** The gateway's environment without what belongs to it (agent bridge credentials, a parent VS Code's hooks, which
 * would turn `code` into a remote terminal's CLI), and without the WSL install prompt that would wait on stdin. */
export function vscodeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !key.startsWith("HUI_AGENT_") && !key.startsWith("VSCODE_")));
  return kept;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One run per executable version and arguments: Settings and every open poll the status. */
const runCache = new Map<string, Promise<string>>();
async function cachedRun(path: string, args: readonly string[]): Promise<string> {
  const info = await stat(path);
  const key = `${path}\0${info.mtimeMs}\0${info.size}\0${args.join("\0")}`;
  let pending = runCache.get(key);
  if (!pending) {
    pending = promisify(execFile)(path, [...args], {
      timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...vscodeEnvironment(process.env), DONT_PROMPT_WSL_INSTALL: "1" },
    }).then(({ stdout, stderr }) => `${stdout}\n${stderr}`);
    pending.catch(() => runCache.delete(key));
    if (runCache.size > 32) runCache.clear();
    runCache.set(key, pending);
  }
  return pending;
}

export function defaultVscodeProbe(): VscodeProbe {
  return { platform: process.platform, env: process.env, home: homedir(), isExecutable: isExecutableFile, run: cachedRun, realpath };
}

function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
}

// ── openvscode-server and compatible servers ───────────────────────────────────────────────────────────────────

/** The flags HUI launches a server with. A server without them (code-server's `--bind-addr`/`--auth` CLI) cannot sit
 * behind HUI's proxy, so it is reported, never launched. */
export const REQUIRED_VSCODE_FLAGS = ["--server-base-path", "--connection-token-file", "--server-data-dir", "--extensions-dir"] as const;
/** Detection order on PATH. code-server is tried only to say why it does not fit, or to use a build whose CLI does. */
const SERVER_COMMANDS = ["openvscode-server", "code-server"] as const;

/** A server's banner is its first non-empty line, "OpenVSCode Server 1.109.5". */
export function parseVscodeHelp(path: string, help: string): { name: string; version: string } | { error: string } {
  const banner = help.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
  const match = /^(.*?)\s+v?(\d+\.\d+\.\d+[\w.+-]*)\b/u.exec(banner);
  const name = match?.[1]?.trim() || banner || "This program";
  const missing = REQUIRED_VSCODE_FLAGS.filter((flag) => !help.includes(flag));
  if (missing.length > 0) {
    return { error: `${name}${match ? ` ${match[2]}` : ""} at ${path} cannot run behind HUI: it has no ${missing.join(", ")}. Install openvscode-server.` };
  }
  return { name, version: match?.[2] ?? "unknown version" };
}

/** Throws, with the reason, unless this server runs and takes HUI's flags: an install is checked before it lands. */
export async function verifyVscodeServer(executable: string): Promise<void> {
  const { stdout, stderr } = await promisify(execFile)(executable, ["--help"], {
    timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, env: vscodeEnvironment(process.env),
  }).catch((error: unknown) => {
    const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr: unknown }).stderr).trim().split("\n")[0] : "";
    throw new Error(detail || firstLine(error));
  });
  const parsed = parseVscodeHelp(executable, `${stdout}\n${stderr}`);
  if ("error" in parsed) throw new Error(parsed.error);
}

/** PATH first, then the places a package manager puts binaries that a launchd or systemd PATH often lacks. */
export function vscodeSearchPath(probe: Pick<VscodeProbe, "env" | "home" | "platform">): string[] {
  const separator = probe.platform === "win32" ? ";" : delimiter;
  const absolute = probe.platform === "win32" ? win32.isAbsolute : isAbsolute;
  const directories = (probe.env["PATH"] ?? probe.env["Path"] ?? "").split(separator);
  if (probe.platform !== "win32") {
    let user = probe.env["USER"] ?? "";
    if (!user) { try { user = userInfo().username; } catch { user = ""; } }
    directories.push(
      "/opt/homebrew/bin", "/usr/local/bin",
      join(probe.home, ".nix-profile", "bin"),
      ...(user ? [`/etc/profiles/per-user/${user}/bin`] : []),
      "/run/current-system/sw/bin", "/nix/var/nix/profiles/default/bin",
    );
  }
  return [...new Set(directories.filter((directory) => directory && absolute(directory)))];
}

// ── VS Code desktop: code serve-web ────────────────────────────────────────────────────────────────────────────

/** `code serve-web`'s flags HUI needs (from VS Code 1.137's `serve-web --help`; `--cli-data-dir` is a global option). */
export const REQUIRED_SERVE_WEB_FLAGS = [
  "--host", "--port", "--connection-token-file", "--server-base-path", "--server-data-dir", "--accept-server-license-terms", "--cli-data-dir",
] as const;

export type ServeWebFeatures = { disableTelemetry: boolean; commitId: boolean; log: boolean };

export function parseServeWebHelp(path: string, help: string): ServeWebFeatures | { error: string } {
  if (!/serve-web/u.test(help)) return { error: `${path} has no serve-web command; VS Code 1.86 or newer has it.` };
  const missing = REQUIRED_SERVE_WEB_FLAGS.filter((flag) => !help.includes(flag));
  if (missing.length > 0) return { error: `VS Code at ${path} cannot run behind HUI: its serve-web has no ${missing.join(", ")}. Update VS Code.` };
  return { disableTelemetry: help.includes("--disable-telemetry"), commitId: help.includes("--commit-id"), log: help.includes("--log") };
}

/** `code --version` prints the version, the commit and the architecture on three lines; the standalone CLI
 * (`code-tunnel`) prints "code 1.137.0 (commit 645f…)". */
export function parseCodeVersion(output: string): { version: string; commit: string } | undefined {
  const cli = /\b(\d+\.\d+\.\d+)\s+\(commit\s+([0-9a-f]{40})\)/u.exec(output);
  if (cli?.[1] && cli[2]) return { version: cli[1], commit: cli[2] };
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /^\d+\.\d+\.\d+$/u.test(line));
  const version = lines[index];
  const commit = lines[index + 1];
  if (index >= 0 && version && commit && /^[0-9a-f]{40}$/u.test(commit)) return { version, commit };
  return undefined;
}

/** Where an installed VS Code keeps its CLI: PATH first, then each platform's standard install locations. Windows
 * uses the CLI binary next to `code.cmd` (`bin\code-tunnel.exe`), which runs without a shell. */
export function desktopCodeCandidates(probe: Pick<VscodeProbe, "env" | "home" | "platform">): string[] {
  if (probe.platform === "win32") {
    const roots = [probe.env["LOCALAPPDATA"] && win32.join(probe.env["LOCALAPPDATA"], "Programs"), probe.env["ProgramFiles"], probe.env["ProgramFiles(x86)"]]
      .filter((root): root is string => Boolean(root));
    return [...new Set([
      ...vscodeSearchPath(probe).filter((directory) => /microsoft vs code/iu.test(directory)).map((directory) => win32.join(directory, "code-tunnel.exe")),
      ...roots.map((root) => win32.join(root, "Microsoft VS Code", "bin", "code-tunnel.exe")),
    ])];
  }
  const installs = probe.platform === "darwin"
    ? ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", join(probe.home, "Applications", "Visual Studio Code.app", "Contents", "Resources", "app", "bin", "code")]
    : ["/usr/share/code/bin/code", "/usr/bin/code", "/snap/bin/code", "/opt/visual-studio-code/bin/code"];
  return [...new Set([...vscodeSearchPath(probe).map((directory) => join(directory, "code")), ...installs])];
}

export type DetectedProvider = VscodeProvider & { features?: ServeWebFeatures };

/** A VS Code CLI is usable when it reports a version and commit and its serve-web takes HUI's flags. */
export async function inspectDesktopCode(path: string, kind: VscodeProviderKind, probe: VscodeProbe): Promise<DetectedProvider | { error: string }> {
  let version: { version: string; commit: string } | undefined;
  try { version = parseCodeVersion(await probe.run(path, ["--version"])); } catch (error) {
    return { error: `${path} did not run: ${firstLine(error)}` };
  }
  if (!version) return { error: `${path} is not a VS Code CLI: its --version names no version and commit.` };
  let help: string;
  try { help = await probe.run(path, ["serve-web", "--help"]); } catch (error) {
    return { error: `VS Code ${version.version} at ${path} has no usable serve-web: ${firstLine(error)}` };
  }
  const features = parseServeWebHelp(path, help);
  if ("error" in features) return { error: features.error };
  return { kind, flavor: "serve-web", path, name: "Visual Studio Code", version: version.version, commit: version.commit, features };
}

async function inspectServer(path: string, kind: VscodeProviderKind, probe: VscodeProbe, help?: string): Promise<DetectedProvider | { error: string }> {
  let text = help;
  if (text === undefined) {
    try { text = await probe.run(path, ["--help"]); } catch (error) { return { error: `${path} did not run: ${firstLine(error)}` }; }
  }
  const parsed = parseVscodeHelp(path, text);
  return "error" in parsed ? parsed : { kind, flavor: "server", path, ...parsed };
}

/** A configured path may name a server or the VS Code CLI itself (an install outside the standard locations). */
export async function inspectConfigured(configured: string, probe: VscodeProbe): Promise<DetectedProvider | { error: string }> {
  const raw = configured.trim();
  const path = raw === "~" || raw.startsWith("~/") ? join(probe.home, raw.slice(2)) : raw;
  const absolute = probe.platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
  if (!absolute) return { error: "The VS Code executable must be an absolute path." };
  if (!(await probe.isExecutable(path))) return { error: `No executable was found at ${path}.` };
  let help: string;
  try { help = await probe.run(path, ["--help"]); } catch (error) { return { error: `${path} did not run: ${firstLine(error)}` }; }
  const server = await inspectServer(path, "configured", probe, help);
  if (!("error" in server) || !/serve-web/u.test(help)) return server;
  return inspectDesktopCode(path, "configured", probe);
}

export type VscodeDetection = {
  providers: DetectedProvider[];
  problems: string[];
  /** Why the configured path cannot run; empty when none is set or it can. */
  configuredError: string;
};

/** Every source, in order. `managed` is the executable vscode-install.ts installed, when there is one. */
export async function detectVscodeProviders(options: { configured: string; managed: string | null }, probe: VscodeProbe = defaultVscodeProbe()): Promise<VscodeDetection> {
  const providers: DetectedProvider[] = [];
  const problems: string[] = [];
  let configuredError = "";
  if (options.configured.trim()) {
    const configured = await inspectConfigured(options.configured, probe);
    if ("error" in configured) { configuredError = configured.error; problems.push(configured.error); } else providers.push(configured);
  }
  const seen = new Set<string>();
  for (const path of desktopCodeCandidates(probe)) {
    if (!(await probe.isExecutable(path))) continue;
    const real = await (probe.realpath ?? (async (value: string) => value))(path).catch(() => path);
    if (seen.has(real)) continue;
    seen.add(real);
    const desktop = await inspectDesktopCode(path, "desktop", probe);
    if ("error" in desktop) { problems.push(desktop.error); continue; }
    providers.push(desktop);
    break;
  }
  if (options.managed) {
    const managed = await inspectServer(options.managed, "managed", probe);
    if ("error" in managed) problems.push(`The openvscode-server HUI installed does not run: ${managed.error}`); else providers.push(managed);
  }
  serverSearch: for (const command of SERVER_COMMANDS) {
    for (const directory of vscodeSearchPath(probe)) {
      const path = join(directory, command);
      if (!(await probe.isExecutable(path))) continue;
      const server = await inspectServer(path, "path", probe);
      if (!("error" in server)) { providers.push(server); break serverSearch; }
      problems.push(server.error);
      break;
    }
  }
  return { providers, problems, configuredError };
}

export type VscodePlan = {
  /** What the next open runs, or null. */
  active: DetectedProvider | null;
  /** The provider that would run once its license is accepted (it is the choice, or nothing else can run). */
  consent: DetectedProvider | null;
  /** Why nothing runs beyond a missing consent or install; empty otherwise. */
  error: string;
};

/**
 * The provider an open uses. An explicit preference wins while it is available; otherwise the first in order that
 * can run. serve-web runs only after the license was accepted, so before that a desktop VS Code is offered (and
 * chosen only when nothing else can run). A configured path is never replaced by a detected one.
 */
export function planVscode(detection: VscodeDetection, options: { preference: VscodeProviderPreference; configured: string; licenseAccepted: boolean }): VscodePlan {
  const usable = (provider: DetectedProvider) => provider.flavor !== "serve-web" || options.licenseAccepted;
  const decide = (provider: DetectedProvider): VscodePlan => usable(provider)
    ? { active: provider, consent: null, error: "" }
    : { active: null, consent: provider, error: "" };
  if (options.preference !== "auto") {
    const chosen = detection.providers.find((provider) => provider.kind === options.preference);
    if (chosen) return decide(chosen);
  }
  if (options.configured.trim() && (options.preference === "auto" || options.preference === "configured")) {
    const configured = detection.providers.find((provider) => provider.kind === "configured");
    return configured ? decide(configured) : { active: null, consent: null, error: detection.configuredError };
  }
  const ordered = VSCODE_PROVIDER_ORDER.flatMap((kind) => detection.providers.filter((provider) => provider.kind === kind && kind !== "configured"));
  const active = ordered.find(usable);
  if (active) return { active, consent: null, error: "" };
  return { active: null, consent: ordered.find((provider) => provider.flavor === "serve-web") ?? null, error: "" };
}

/** The public shape, without the launch details only the gateway needs. */
export function publicProvider(provider: DetectedProvider): VscodeProvider {
  return {
    kind: provider.kind, flavor: provider.flavor, path: provider.path, name: provider.name, version: provider.version,
    ...(provider.commit ? { commit: provider.commit } : {}),
  };
}

// ── Launch arguments ───────────────────────────────────────────────────────────────────────────────────────────

/** openvscode-server and compatible servers: loopback, the token in a file, all state in HUI's directory. */
export function vscodeLaunchArguments(options: { port: number; tokenFile: string; dir: string }): string[] {
  return [
    "--host", "127.0.0.1",
    "--port", String(options.port),
    "--connection-token-file", options.tokenFile,
    "--server-base-path", VSCODE_BASE_PATH,
    "--server-data-dir", join(options.dir, "server-data"),
    "--user-data-dir", join(options.dir, "user-data"),
    "--extensions-dir", join(options.dir, "extensions"),
    "--accept-server-license-terms",
    "--telemetry-level", "off",
  ];
}

/**
 * `code serve-web`, only with the operator's recorded acceptance of Microsoft's license: without it this throws, so
 * no path can pass `--accept-server-license-terms` on the operator's behalf. Its CLI data (where it downloads the
 * matching VS Code server build, pinned to the desktop's commit) and its server data live in HUI's directory, not
 * in the operator's ~/.vscode. Trace logging reports the download's progress.
 */
export function serveWebLaunchArguments(options: {
  port: number; tokenFile: string; dir: string; licenseAcceptedAt: string; commit?: string; features?: ServeWebFeatures;
}): string[] {
  if (!options.licenseAcceptedAt) throw new Error("code serve-web needs the operator to accept the VS Code Server license first.");
  const features = options.features ?? { disableTelemetry: true, commitId: true, log: true };
  return [
    "serve-web",
    "--host", "127.0.0.1",
    "--port", String(options.port),
    "--connection-token-file", options.tokenFile,
    "--server-base-path", VSCODE_BASE_PATH,
    "--server-data-dir", join(options.dir, "server-data"),
    "--cli-data-dir", join(options.dir, "cli"),
    "--accept-server-license-terms",
    ...(features.disableTelemetry ? ["--disable-telemetry"] : []),
    ...(features.commitId && options.commit ? ["--commit-id", options.commit] : []),
    ...(features.log ? ["--log", "trace"] : []),
  ];
}

/** serve-web's trace line for the server build it downloads: "Downloading server: 115646487/233510790 (50%)". */
export function parseServeWebProgress(line: string): { received: number; total: number } | undefined {
  const match = /Downloading server:\s*(\d+)\s*\/\s*(\d+)/u.exec(line);
  return match ? { received: Number(match[1]), total: Number(match[2]) } : undefined;
}
