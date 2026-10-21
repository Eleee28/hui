import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { waitFor } from "../test-support/wait-for.ts";
import { parseVscodeHelp, vscodeEnvironment, vscodeLaunchArguments, VscodeError, VscodeService, type VscodeProbe } from "./vscode.ts";
import {
  defaultVscodeProbe, desktopCodeCandidates, detectVscodeProviders, parseCodeVersion, parseServeWebHelp, parseServeWebProgress, planVscode,
  serveWebLaunchArguments, type VscodeDetection,
} from "./providers.ts";
import { DEFAULT_VSCODE_SETTINGS, type VscodeSettings } from "../hui-settings.ts";

const FAKE = fileURLToPath(new URL("../test-support/fake-vscode-server.mjs", import.meta.url));
const COMMIT = "645f29cc3176500b4b5762ba887cf2a7f0ffdf2c";
const OPENVSCODE_HELP = "OpenVSCode Server 1.109.5\n\nUsage: openvscode-server [options]\n  --server-base-path <path>\n  --connection-token-file <path>\n  --server-data-dir\n  --extensions-dir <dir>\n";
const CODE_SERVER_HELP = "code-server 4.96.4 abc123 with Code 1.96.4\n\nUsage: code-server [options] [path]\n  --bind-addr\n  --auth\n  --user-data-dir\n  --extensions-dir\n";
/** VS Code 1.137's `code serve-web --help`, abridged to what HUI reads. */
const SERVE_WEB_HELP = "Runs a local web version of Visual Studio Code\n\nUsage: code-tunnel serve-web [OPTIONS]\n\nOptions:\n      --host <HOST>\n      --port <PORT>\n      --connection-token-file <CONNECTION_TOKEN_FILE>\n      --accept-server-license-terms\n      --server-base-path <SERVER_BASE_PATH>\n      --server-data-dir <SERVER_DATA_DIR>\n      --disable-telemetry\n      --commit-id <COMMIT_ID>\n\nGLOBAL OPTIONS:\n      --cli-data-dir <CLI_DATA_DIR>\n      --log <level>\n";
const CODE_VERSION = `1.137.0\n${COMMIT}\nx64\n`;

/** A launcher script named like the real binary and, like it, running node as a child rather than exec-ing it, so
 * detection, spawning and stopping go through the same process shape. */
async function fakeExecutable(dir: string, name = "openvscode-server", kind: "server" | "code" = "server"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${kind === "code" ? "FAKE_VSCODE_KIND=code " : ""}"${process.execPath}" "${FAKE}" "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

/** Programs that exist only as this map says: a value is what each argument list prints, or an error. */
function probe(files: Record<string, Record<string, string | Error> | string | Error>, env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = "linux"): VscodeProbe {
  return {
    platform,
    env,
    home: "/home/op",
    isExecutable: async (path) => path in files,
    run: async (path, args) => {
      const entry = files[path];
      const output = typeof entry === "string" || entry instanceof Error || entry === undefined ? (args.join(" ") === "--help" ? entry : undefined) : entry[args.join(" ")];
      if (output instanceof Error) throw output;
      if (output === undefined) throw new Error(`${path} ${args.join(" ")}: unknown option`);
      return output;
    },
  };
}

const desktop = (help = SERVE_WEB_HELP) => ({ "--version": CODE_VERSION, "serve-web --help": help, "--help": "Visual Studio Code 1.137.0\n\nSubcommands\n  serve-web  Run a server\n" });

/** Only executables inside `dir` exist, so a test never runs a VS Code installed on the machine it runs on. */
function sandboxProbe(dir: string, env: NodeJS.ProcessEnv = { PATH: dir }): VscodeProbe {
  const base = defaultVscodeProbe();
  return { ...base, env, home: dir, isExecutable: async (path) => path.startsWith(`${dir}/`) && base.isExecutable(path) };
}

test("the help banner names the server and the flags HUI needs decide compatibility", () => {
  assert.deepEqual(parseVscodeHelp("/bin/openvscode-server", OPENVSCODE_HELP), { name: "OpenVSCode Server", version: "1.109.5" });
  const codeServer = parseVscodeHelp("/bin/code-server", CODE_SERVER_HELP);
  assert.ok("error" in codeServer);
  assert.match(codeServer.error, /^code-server 4\.96\.4 at \/bin\/code-server cannot run behind HUI: it has no --server-base-path, --connection-token-file, --server-data-dir\. Install openvscode-server\.$/u);
});

test("serve-web's help and code's version are read from their real formats", () => {
  assert.deepEqual(parseServeWebHelp("/usr/bin/code", SERVE_WEB_HELP), { disableTelemetry: true, commitId: true, log: true });
  const old = parseServeWebHelp("/usr/bin/code", SERVE_WEB_HELP.replace("      --server-base-path <SERVER_BASE_PATH>\n", ""));
  assert.deepEqual(old, { error: "VS Code at /usr/bin/code cannot run behind HUI: its serve-web has no --server-base-path. Update VS Code." });
  assert.deepEqual(parseServeWebHelp("/usr/bin/code", "Usage: code [options]"), { error: "/usr/bin/code has no serve-web command; VS Code 1.86 or newer has it." });
  assert.deepEqual(parseCodeVersion(CODE_VERSION), { version: "1.137.0", commit: COMMIT });
  assert.deepEqual(parseCodeVersion(`code 1.137.0 (commit ${COMMIT})`), { version: "1.137.0", commit: COMMIT }, "the standalone CLI's format");
  assert.equal(parseCodeVersion("code-server 4.96.4"), undefined);
  assert.deepEqual(parseServeWebProgress("[2026-10-09 08:43:45] trace Downloading server: 115646487/233510790 (50%)"), { received: 115_646_487, total: 233_510_790 });
  assert.equal(parseServeWebProgress("[2026-10-09 08:43:33] info Downloading server 645f29c"), undefined);
});

test("VS Code desktop is looked for on PATH, then in each platform's install locations", () => {
  assert.deepEqual(desktopCodeCandidates({ platform: "darwin", env: { PATH: "/usr/bin" }, home: "/Users/op" }).filter((path) => !path.startsWith("/usr/bin")).slice(-2), [
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    "/Users/op/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  ]);
  const linux = desktopCodeCandidates({ platform: "linux", env: { PATH: "/opt/bin" }, home: "/home/op" });
  assert.equal(linux[0], "/opt/bin/code", "PATH comes first");
  for (const path of ["/usr/share/code/bin/code", "/usr/bin/code", "/snap/bin/code"]) assert.ok(linux.includes(path), path);
  assert.deepEqual(desktopCodeCandidates({
    platform: "win32", home: "C:\\Users\\op",
    env: { PATH: "C:\\Windows;C:\\Users\\op\\AppData\\Local\\Programs\\Microsoft VS Code\\bin", LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
  }), [
    "C:\\Users\\op\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code-tunnel.exe",
    "C:\\Program Files\\Microsoft VS Code\\bin\\code-tunnel.exe",
  ], "Windows runs the CLI binary beside code.cmd, never a .cmd through a shell");
});

test("detection finds each source and reports what does not fit", async () => {
  const mac = await detectVscodeProviders({ configured: "", managed: null }, probe({ "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code": desktop() }, { PATH: "/usr/bin" }, "darwin"));
  assert.deepEqual(mac.providers.map(({ kind, flavor, name, version, commit }) => ({ kind, flavor, name, version, commit })), [
    { kind: "desktop", flavor: "serve-web", name: "Visual Studio Code", version: "1.137.0", commit: COMMIT },
  ]);
  const all = await detectVscodeProviders({ configured: "/srv/ovs", managed: "/data/hui/vscode-server/ovs/bin/openvscode-server" }, probe({
    "/srv/ovs": OPENVSCODE_HELP,
    "/usr/share/code/bin/code": desktop(),
    "/data/hui/vscode-server/ovs/bin/openvscode-server": OPENVSCODE_HELP,
    "/opt/tools/openvscode-server": OPENVSCODE_HELP,
  }, { PATH: "/usr/bin:/opt/tools", USER: "op" }));
  assert.deepEqual(all.providers.map((provider) => [provider.kind, provider.path]), [
    ["configured", "/srv/ovs"], ["desktop", "/usr/share/code/bin/code"],
    ["managed", "/data/hui/vscode-server/ovs/bin/openvscode-server"], ["path", "/opt/tools/openvscode-server"],
  ]);
  const nix = await detectVscodeProviders({ configured: "", managed: null }, probe({ "/etc/profiles/per-user/op/bin/openvscode-server": OPENVSCODE_HELP }, { PATH: "/usr/bin", USER: "op" }));
  assert.equal(nix.providers[0]?.path, "/etc/profiles/per-user/op/bin/openvscode-server");
  const broken = await detectVscodeProviders({ configured: "", managed: null }, probe({
    "/usr/bin/code": { "--version": CODE_VERSION, "serve-web --help": new Error("error: unrecognized subcommand 'serve-web'\nmore") },
    "/usr/bin/code-server": CODE_SERVER_HELP,
  }, { PATH: "/usr/bin" }));
  assert.deepEqual(broken.providers, []);
  assert.deepEqual(broken.problems, [
    "VS Code 1.137.0 at /usr/bin/code has no usable serve-web: error: unrecognized subcommand 'serve-web'",
    "code-server 4.96.4 at /usr/bin/code-server cannot run behind HUI: it has no --server-base-path, --connection-token-file, --server-data-dir. Install openvscode-server.",
  ]);
  const compatible = await detectVscodeProviders({ configured: "", managed: null }, probe({ "/usr/bin/code-server": OPENVSCODE_HELP.replace("OpenVSCode Server", "code-server") }, { PATH: "/usr/bin" }));
  assert.equal(compatible.providers[0]?.path, "/usr/bin/code-server", "a code-server build with the right CLI is used");
});

test("a configured path is checked as given: a server, VS Code's own CLI, or a reason", async () => {
  const files = { "/srv/ovs": OPENVSCODE_HELP, "/opt/vscode/bin/code": desktop(), "/bin/broken": new Error("spawn EACCES\nmore") };
  const configured = async (path: string) => detectVscodeProviders({ configured: path, managed: null }, probe(files, { PATH: "/nowhere" }));
  assert.equal((await configured("/srv/ovs")).providers[0]?.flavor, "server");
  const code = (await configured("/opt/vscode/bin/code")).providers[0];
  assert.deepEqual([code?.kind, code?.flavor], ["configured", "serve-web"], "VS Code installed outside the usual places");
  assert.equal((await detectVscodeProviders({ configured: "~/ovs", managed: null }, probe({ "/home/op/ovs": OPENVSCODE_HELP }))).providers[0]?.path, "/home/op/ovs");
  assert.equal((await configured("bin/openvscode-server")).configuredError, "The VS Code executable must be an absolute path.");
  assert.equal((await configured("/nope")).configuredError, "No executable was found at /nope.");
  assert.equal((await configured("/bin/broken")).configuredError, "/bin/broken did not run: spawn EACCES");
});

const provider = (kind: "configured" | "desktop" | "managed" | "path", flavor: "server" | "serve-web" = kind === "desktop" ? "serve-web" : "server") => ({ kind, flavor, path: `/${kind}`, name: kind, version: "1" });
const plan = (detection: Partial<VscodeDetection>, preference: VscodeSettings["provider"] = "auto", licenseAccepted = false, configured = "") =>
  planVscode({ providers: [], problems: [], configuredError: "", ...detection }, { preference, configured, licenseAccepted });

test("the plan prefers the configured path, then VS Code after consent, then HUI's install, then PATH", () => {
  const everything = [provider("configured"), provider("desktop"), provider("managed"), provider("path")];
  assert.equal(plan({ providers: everything }, "auto", true, "/configured").active?.kind, "configured");
  assert.equal(plan({ providers: everything.slice(1) }, "auto", true).active?.kind, "desktop");
  assert.equal(plan({ providers: everything.slice(1) }, "auto", false).active?.kind, "managed", "without consent VS Code desktop is skipped");
  assert.equal(plan({ providers: [provider("desktop"), provider("path")] }, "auto", false).active?.kind, "path");
  const consent = plan({ providers: [provider("desktop")] }, "auto", false);
  assert.equal(consent.active, null, "serve-web never runs before consent");
  assert.equal(consent.consent?.kind, "desktop", "it is offered instead");
  assert.equal(plan({ providers: everything.slice(1) }, "path", true).active?.kind, "path", "an explicit choice wins");
  const chosen = plan({ providers: everything.slice(1) }, "desktop", false);
  assert.deepEqual([chosen.active, chosen.consent?.kind], [null, "desktop"], "choosing VS Code still needs consent");
  assert.equal(plan({ providers: [provider("path")] }, "managed").active?.kind, "path", "an unavailable choice falls back to automatic");
  const broken = plan({ providers: [provider("path")], configuredError: "No executable was found at /x." }, "auto", false, "/x");
  assert.deepEqual([broken.active, broken.error], [null, "No executable was found at /x."], "a broken configured path is not replaced by a detected one");
  assert.deepEqual(plan({}), { active: null, consent: null, error: "" });
});

test("the launch flags bind loopback, keep the token in a file and put state in HUI's directory", () => {
  const args = vscodeLaunchArguments({ port: 4100, tokenFile: "/c/hui/vscode/connection-token", dir: "/c/hui/vscode" });
  assert.deepEqual(args, [
    "--host", "127.0.0.1", "--port", "4100", "--connection-token-file", "/c/hui/vscode/connection-token",
    "--server-base-path", "/__hui/vscode", "--server-data-dir", "/c/hui/vscode/server-data", "--user-data-dir", "/c/hui/vscode/user-data",
    "--extensions-dir", "/c/hui/vscode/extensions", "--accept-server-license-terms", "--telemetry-level", "off",
  ]);
  assert.ok(!args.some((arg) => arg.startsWith("--connection-token=") || arg === "--connection-token"), "the token never appears in argv");
  assert.deepEqual(vscodeEnvironment({ PATH: "/bin", HUI_AGENT_BRIDGE_TOKEN: "x", VSCODE_IPC_HOOK_CLI: "/tmp/s", HOME: "/h" }), { PATH: "/bin", HOME: "/h" });
});

test("serve-web's flags pass the license acceptance only with the operator's recorded consent", () => {
  const options = { port: 4100, tokenFile: "/c/hui/vscode/connection-token", dir: "/c/hui/vscode/serve-web", commit: COMMIT };
  assert.throws(() => serveWebLaunchArguments({ ...options, licenseAcceptedAt: "" }), /accept the VS Code Server license first/u);
  assert.deepEqual(serveWebLaunchArguments({ ...options, licenseAcceptedAt: "2026-10-09T08:00:00.000Z" }), [
    "serve-web", "--host", "127.0.0.1", "--port", "4100", "--connection-token-file", "/c/hui/vscode/connection-token",
    "--server-base-path", "/__hui/vscode", "--server-data-dir", "/c/hui/vscode/serve-web/server-data",
    "--cli-data-dir", "/c/hui/vscode/serve-web/cli", "--accept-server-license-terms", "--disable-telemetry",
    "--commit-id", COMMIT, "--log", "trace",
  ]);
  const older = serveWebLaunchArguments({ ...options, licenseAcceptedAt: "2026-10-09T08:00:00.000Z", features: { disableTelemetry: false, commitId: false, log: false } });
  assert.ok(!older.includes("--commit-id") && !older.includes("--disable-telemetry") && !older.includes("--log"), "flags a CLI lacks are left out");
});

function settingsWith(change: Partial<VscodeSettings>): VscodeSettings {
  return { ...DEFAULT_VSCODE_SETTINGS, ...change };
}

function service(dir: string, settings: () => VscodeSettings, extra: Partial<ConstructorParameters<typeof VscodeService>[0]> = {}) {
  return new VscodeService({ dir: join(dir, "state"), settings: async () => settings(), readyTimeoutMs: 15_000, probe: sandboxProbe(dir), ...extra });
}

test("the server starts lazily, once, and reports what it runs", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-life-"));
  const executable = await fakeExecutable(dir);
  const argsFile = join(dir, "args.json");
  const vscode = service(dir, () => settingsWith({ executable }), { env: () => ({ ...process.env, FAKE_VSCODE_ARGS_FILE: argsFile }) });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });

  const before = await vscode.status();
  assert.equal(before.state, "stopped", "nothing runs until a view opens");
  assert.deepEqual(before.active, { kind: "configured", flavor: "server", path: executable, name: "OpenVSCode Server", version: "9.8.7" });
  assert.equal(before.setup.needed, false);
  const [first, second] = await Promise.all([vscode.ensure(), vscode.ensure()]);
  assert.equal(first, second, "concurrent opens share one start");
  assert.equal(first.instance, 1);
  const running = await vscode.status();
  assert.equal(running.state, "running");
  assert.equal(running.running?.kind, "configured");
  assert.ok(running.pid && running.startedAt);
  const { args, pid: node } = JSON.parse(await readFile(argsFile, "utf8")) as { args: string[]; pid: number };
  assert.equal(args[args.indexOf("--port") + 1], String(first.port));
  assert.notEqual(node, running.pid, "the server runs below its launcher script");
  assert.equal(await readFile(vscode.tokenFile, "utf8"), first.token);
  assert.equal((await stat(vscode.tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(vscode.dir)).mode & 0o777, 0o700);
  assert.equal((await vscode.ensure()).port, first.port, "a running server is reused");
  await vscode.stop();
  assert.equal(alive(node), false, "stopping reaches the server behind the launcher, not only the script");
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("a server with no connections stops after the idle period; a connection holds it", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-idle-"));
  const executable = await fakeExecutable(dir);
  const vscode = service(dir, () => settingsWith({ executable }), { idleMs: 150 });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });

  await vscode.ensure();
  const release = vscode.acquire();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal((await vscode.status()).state, "running", "an open connection keeps it running");
  release();
  await waitFor("idle stop", async () => (await vscode.status()).state === "stopped");
  assert.equal((await vscode.status()).lastError, "", "an idle stop is not an error");
  assert.equal((await vscode.ensure()).instance, 2, "the next open starts it again");
});

test("a crash is reported, not restarted, and the next open starts a new instance", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-crash-"));
  const executable = await fakeExecutable(dir);
  const argsFile = join(dir, "args.json");
  const vscode = service(dir, () => settingsWith({ executable }), { env: () => ({ ...process.env, FAKE_VSCODE_ARGS_FILE: argsFile }) });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });

  await vscode.ensure();
  const { pid: node } = JSON.parse(await readFile(argsFile, "utf8")) as { pid: number };
  process.kill(node, "SIGKILL");
  const failed = await waitFor("crash report", async () => { const status = await vscode.status(); return status.state === "failed" ? status : undefined; });
  assert.match(failed.lastError, /^VS Code exited unexpectedly \(exit code 137\)/u, "the launcher reports node's death");
  assert.doesNotMatch(failed.lastError, /Extension host agent listening/u, "routine stdout is not presented as the error");
  assert.equal(vscode.current(), undefined, "a crashed server is not offered to the proxy");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await vscode.status()).state, "failed", "nothing restarts it on its own");
  const again = await vscode.ensure();
  assert.equal(again.instance, 2);
  assert.equal((await vscode.status()).lastError, "");

  // The launcher dying alone takes the rest of its process group with it.
  const { pid: second } = JSON.parse(await readFile(argsFile, "utf8")) as { pid: number };
  const { pid: launcher } = await vscode.status();
  assert.ok(launcher);
  process.kill(launcher, "SIGKILL");
  await waitFor("the orphaned server to be reaped", () => !alive(second));
  assert.equal((await vscode.status()).state, "failed");
});

test("a start that fails says why; with nothing to run an open asks for setup and starts nothing", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-fail-"));
  // Off PATH, so clearing the configured path leaves nothing to find.
  await mkdir(join(dir, "opt"));
  const executable = await fakeExecutable(join(dir, "opt"));
  let settings = settingsWith({ executable });
  const vscode = service(dir, () => settings, { env: () => ({ ...process.env, FAKE_VSCODE_FAIL: "no display of extensions" }) });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });

  await assert.rejects(vscode.ensure(), (error: unknown) => error instanceof VscodeError && error.status === 502
    && /^OpenVSCode Server exited while starting \(exit code 7\): fake failure: no display of extensions$/u.test(error.message));
  assert.equal((await vscode.status()).state, "failed");
  settings = settingsWith({ executable: join(dir, "missing") });
  await assert.rejects(vscode.ensure(), (error: unknown) => error instanceof VscodeError && error.code === "setup" && error.message === `No executable was found at ${join(dir, "missing")}.`);
  const status = await vscode.status();
  assert.equal(status.state, "setup");
  assert.equal(status.activeError, `No executable was found at ${join(dir, "missing")}.`);
  assert.equal(status.setup.install, false, "a broken path is fixed, not worked around");
  settings = settingsWith({});
  await assert.rejects(vscode.ensure(), (error: unknown) => error instanceof VscodeError && error.code === "setup");
  const empty = await vscode.status();
  assert.deepEqual([empty.state, empty.active, empty.setup.needed, empty.setup.desktop], ["setup", null, true, null]);
  assert.equal(empty.setup.download, true, "with no install offered either, the card links to VS Code's download");
});

test("the legacy opt-in switch no longer gates anything", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-legacy-"));
  const executable = await fakeExecutable(dir);
  // A settings file from the opt-in era, saved while the view was off: it still opens now.
  const vscode = service(dir, () => ({ enabled: false, executable, provider: "auto", licenseAcceptedAt: "" }));
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await vscode.status()).enabled, false);
  assert.equal((await vscode.ensure()).instance, 1);
});

test("VS Code desktop: no consent means no spawn and no setup bypass; consent passes the flag", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-consent-"));
  await fakeExecutable(dir, "code", "code");
  const argsFile = join(dir, "args.json");
  let settings = settingsWith({});
  const saved: string[] = [];
  const vscode = service(dir, () => settings, {
    env: () => ({ ...process.env, FAKE_VSCODE_KIND: "code", FAKE_VSCODE_ARGS_FILE: argsFile }),
    saveLicense: async (acceptedAt) => { saved.push(acceptedAt); settings = { ...settings, licenseAcceptedAt: acceptedAt }; await vscode.applySettings(settings); },
  });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });

  const before = await vscode.status();
  assert.equal(before.state, "setup");
  assert.equal(before.active, null);
  assert.deepEqual(before.setup.desktop, { kind: "desktop", flavor: "serve-web", path: join(dir, "code"), name: "Visual Studio Code", version: "1.137.0", commit: COMMIT });
  assert.equal(before.license.accepted, false);
  await assert.rejects(vscode.ensure(), (error: unknown) => error instanceof VscodeError && error.code === "setup" && /accept the VS Code Server license/u.test(error.message));
  await assert.rejects(vscode.connect("/work", undefined), (error: unknown) => error instanceof VscodeError && error.code === "setup");
  await assert.rejects(readFile(argsFile, "utf8"), { code: "ENOENT" }, "nothing was spawned");

  await vscode.acceptLicense();
  assert.equal(saved.length, 1);
  assert.ok(!Number.isNaN(Date.parse(saved[0] ?? "")));
  const connection = await vscode.connect("/work", undefined);
  assert.ok("url" in connection);
  const { args } = JSON.parse(await readFile(argsFile, "utf8")) as { args: string[] };
  assert.equal(args[0], "serve-web");
  assert.ok(args.includes("--accept-server-license-terms"));
  assert.equal(args[args.indexOf("--commit-id") + 1], COMMIT, "the server build matches this desktop");
  assert.equal(args[args.indexOf("--cli-data-dir") + 1], join(dir, "state", "serve-web", "cli"), "its downloads stay in HUI's directory");
  const running = await vscode.status();
  assert.deepEqual([running.state, running.running?.kind], ["running", "desktop"]);
  assert.equal(vscode.current()?.flavor, "serve-web");

  // Revoking stops it, withdraws every frame, and the next open asks again.
  const ticket = new URL((connection as { url: string }).url, "http://h").searchParams.get("ticket") ?? "";
  const entered = vscode.enter(ticket);
  assert.ok(entered);
  await vscode.revokeLicense();
  assert.deepEqual(saved.at(-1), "");
  assert.equal(vscode.session([entered.sessionId]), undefined);
  assert.equal((await vscode.status()).state, "setup");
  await assert.rejects(vscode.ensure(), (error: unknown) => error instanceof VscodeError && error.code === "setup");
});

test("serve-web's first start reports its download, and an open answers pending until it runs", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-prepare-"));
  await fakeExecutable(dir, "code", "code");
  const vscode = service(dir, () => settingsWith({ licenseAcceptedAt: "2026-10-09T08:00:00.000Z" }), {
    env: () => ({ ...process.env, FAKE_VSCODE_KIND: "code", FAKE_SERVE_WEB_DOWNLOAD_MS: "1500" }), connectWaitMs: 200,
  });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });

  assert.deepEqual(await vscode.connect("/work", undefined), { pending: true });
  const preparing = await waitFor("download progress", async () => { const status = await vscode.status(); return status.preparing?.total ? status : undefined; });
  assert.equal(preparing.state, "starting");
  assert.equal(preparing.preparing?.total, 233_510_790);
  await waitFor("the server to run", async () => (await vscode.status()).state === "running");
  assert.equal((await vscode.status()).preparing, null);
  const connection = await vscode.connect("/work", undefined);
  assert.ok("url" in connection);
});

test("serve-web that cannot download says so, and its processes go", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-offline-"));
  await fakeExecutable(dir, "code", "code");
  const argsFile = join(dir, "args.json");
  const vscode = service(dir, () => settingsWith({ licenseAcceptedAt: "2026-10-09T08:00:00.000Z" }), {
    env: () => ({ ...process.env, FAKE_VSCODE_KIND: "code", FAKE_SERVE_WEB_STALL: "1", FAKE_VSCODE_ARGS_FILE: argsFile }), stallMs: 600,
  });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });

  await assert.rejects(vscode.ensure(), /could not download its web server from Microsoft \(update\.code\.visualstudio\.com\): nothing arrived for 1 seconds\. The first open needs an internet connection/u);
  const status = await vscode.status();
  assert.equal(status.state, "failed");
  assert.match(status.lastError, /internet connection/u);
  const { pid } = JSON.parse(await readFile(argsFile, "utf8")) as { pid: number };
  await waitFor("the stalled server to exit", () => !alive(pid));
});

test("a stop while serve-web downloads ends the start at once, without an error", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-cancel-"));
  await fakeExecutable(dir, "code", "code");
  const vscode = service(dir, () => settingsWith({ licenseAcceptedAt: "2026-10-09T08:00:00.000Z" }), {
    env: () => ({ ...process.env, FAKE_VSCODE_KIND: "code", FAKE_SERVE_WEB_STALL: "1" }), stallMs: 60_000,
  });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });
  const start = vscode.ensure();
  start.catch(() => undefined);
  await waitFor("the download to begin", async () => (await vscode.status()).preparing !== null);
  const started = performance.now();
  await vscode.stop();
  assert.ok(performance.now() - started < 10_000, "the stop does not wait out the download");
  await assert.rejects(start);
  const status = await vscode.status();
  assert.deepEqual([status.state, status.lastError], ["stopped", ""]);
});

test("tickets are single-use and short-lived; cookie secrets expire and forged ones fail", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-ticket-"));
  const executable = await fakeExecutable(dir);
  let now = 1_000_000;
  const vscode = service(dir, () => settingsWith({ executable }), { now: () => now, ticketMs: 30_000, sessionMs: 60_000 });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });
  const open = async (folder: string, theme?: Parameters<VscodeService["connect"]>[1]) => {
    const connection = await vscode.connect(folder, theme);
    assert.ok("url" in connection);
    return connection;
  };

  const theme = { background: "#101010", panel: "#202020", elevated: "#303030", text: "#eeeeee" };
  const connection = await open("/work/repo", theme);
  assert.match(connection.url, /^\/__hui\/vscode\/enter\?ticket=[\w-]{43}$/u);
  assert.equal(connection.folder, "/work/repo");
  const ticket = new URL(connection.url, "http://h").searchParams.get("ticket") ?? "";
  const entered = vscode.enter(ticket);
  assert.ok(entered);
  assert.equal(entered.folder, "/work/repo");
  assert.equal(vscode.enter(ticket), undefined, "a ticket works once");
  assert.deepEqual(vscode.session([entered.sessionId])?.theme, theme);
  assert.equal(vscode.session(["forged", entered.sessionId.replace(/^./u, (c) => (c === "A" ? "B" : "A"))]), undefined);
  assert.ok(vscode.session(["forged", entered.sessionId]), "any valid secret among several cookies is enough");

  const late = new URL((await open("/work/repo")).url, "http://h").searchParams.get("ticket") ?? "";
  now += 30_001;
  assert.equal(vscode.enter(late), undefined, "an expired ticket fails");
  assert.ok(vscode.session([entered.sessionId]), "30 seconds later the cookie session is still valid");
  now += 59_000;
  assert.ok(vscode.session([entered.sessionId]), "use refreshes a cookie session");
  now += 60_001;
  assert.equal(vscode.session([entered.sessionId]), undefined, "an unused cookie session expires");
});

test("a new executable stops the running server; disposing returns at once and the server exits", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-dispose-"));
  const executable = await fakeExecutable(dir);
  const other = await fakeExecutable(dir, "other-openvscode-server");
  let settings = settingsWith({ executable });
  const vscode = service(dir, () => settings);
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));

  await vscode.ensure();
  await vscode.applySettings(settings);
  assert.equal((await vscode.status()).state, "running", "the same settings keep it");
  settings = settingsWith({ executable: other });
  await vscode.applySettings(settings);
  assert.equal((await vscode.status()).state, "stopped");
  await vscode.ensure();
  const { pid } = await vscode.status();
  assert.ok(pid);
  const started = performance.now();
  vscode.dispose();
  assert.ok(performance.now() - started < 50, "dispose does not wait for the process");
  await waitFor("the server process to exit", () => !alive(pid));
  await assert.rejects(vscode.ensure(), /gateway is stopping/u);
});

test("switching the provider in Settings stops the one that runs", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-switch-"));
  await mkdir(join(dir, "bin"));
  await fakeExecutable(join(dir, "bin"));
  await fakeExecutable(dir, "code", "code");
  let settings = settingsWith({ licenseAcceptedAt: "2026-10-09T08:00:00.000Z" });
  const vscode = service(dir, () => settings, { probe: sandboxProbe(dir, { PATH: `${dir}:${join(dir, "bin")}` }), env: () => ({ ...process.env, FAKE_VSCODE_KIND: "code" }) });
  t.onTestFinished(async () => { await vscode.stop(); await rm(dir, { recursive: true, force: true }); });
  const status = await vscode.status();
  assert.deepEqual(status.providers.map((provider) => provider.kind), ["desktop", "path"]);
  assert.equal(status.active?.kind, "desktop", "after consent VS Code comes before PATH");
  await vscode.ensure();
  settings = { ...settings, provider: "path" };
  await vscode.applySettings(settings);
  assert.equal((await vscode.status()).state, "stopped");
  assert.equal((await vscode.status()).active?.kind, "path");
});

test("a server a killed gateway left behind is stopped before the next start", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-reap-"));
  const executable = await fakeExecutable(dir);
  const first = service(dir, () => settingsWith({ executable }));
  await first.ensure();
  const { pid } = await first.status();
  assert.ok(pid);
  const second = service(dir, () => settingsWith({ executable }));
  t.onTestFinished(async () => { await second.stop(); try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } await rm(dir, { recursive: true, force: true }); });
  await waitFor("the pid file", () => readFile(join(dir, "state", "server.json"), "utf8").then(() => true, () => false));
  await second.ensure();
  await waitFor("the orphaned server to exit", () => !alive(pid));
});
