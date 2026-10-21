import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { watch } from "node:fs";
import { WebSocket } from "ws";
import { releaseFixture } from "./fixtures/release-fixture.mjs";

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const baseline = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version as string;
const nextVersion = baseline.replace(/\d+$/u, (patch) => String(Number(patch) + 1));
const brokenVersion = baseline.replace(/\d+$/u, (patch) => String(Number(patch) + 2));

test("installed package lifecycle, real SDK resume, verified update and rollback", { timeout: 360_000 }, async (t) => {
  // The installed CLI reports canonical locations, so resolve the temporary
  // directory first: macOS puts it behind the /var -> /private/var symlink.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "hui-package-proof-")));
  const prefix = join(temporary, "prefix");
  const agentDir = join(temporary, "agent");
  const workspace = join(temporary, "workspace");
  await mkdir(agentDir); await mkdir(workspace);
  await writeFile(join(workspace, "fixture.txt"), "Installed SDK content\n");
  const env = { ...process.env, XDG_CONFIG_HOME: join(temporary, "config"), XDG_DATA_HOME: join(temporary, "data"),
    PI_CODING_AGENT_DIR: agentDir, HUI_PI_BACKEND: "sdk" };
  const releases = await releaseFixture(temporary);
  Object.assign(env, releases.env);
  const cli = join(prefix, "lib/node_modules/hui/bin/hui.mjs");
  const installed = dirname(dirname(cli));
  const command = async (...args: string[]) => (await exec(process.execPath, [cli, ...args], { cwd: temporary, env, timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim();
  const npm = async (args: string[], cwd = repo) => (await exec("npm", args, { cwd, env, timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout;
  const provider = spawn(process.execPath, [join(repo, "e2e/fixtures/pi-provider-fixture.mjs")], {
    env: { ...env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: workspace, HUI_E2E_PROVIDER_LOG: join(temporary, "provider.jsonl") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let providerError = "";
  provider.stderr.on("data", (chunk) => { providerError = (providerError + String(chunk)).slice(-4000); });
  t.after(async () => {
    await command("gateway", "stop", "--force").catch(() => {});
    if (provider.exitCode === null && provider.signalCode === null) { const exited = once(provider, "exit"); provider.kill(); await exited; }
    await rm(temporary, { recursive: true, force: true });
  });
  const [ready] = await Promise.race([once(provider.stdout, "data"), once(provider, "exit").then(() => { throw new Error(`Provider failed to start: ${providerError}`); })]);
  const providerUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0]; assert(providerUrl);
  const models = JSON.stringify({ providers: { "hui-e2e": { baseUrl: providerUrl, api: "anthropic-messages", headers: { "x-client-session-id": "${PI_CLIENT_SESSION_ID}" }, apiKey: "e2e-not-a-secret",
    models: [{ id: "fixture", name: "Package fixture", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  // Exercise the composed provider registry from the installed archive while
  // all inference remains on the local PI fixture. An empty HUI selection
  // intentionally hides this built-in; its credential must stay HUI-owned.
  const providersDir = join(env.XDG_CONFIG_HOME, "hui", "providers");
  await mkdir(providersDir, { recursive: true });
  await writeFile(join(providersDir, "models.json"), JSON.stringify({ openai: { models: [] } }));
  await writeFile(join(providersDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "installed-hui-fixture-not-a-secret" } }), { mode: 0o600 });
  await writeFile(join(agentDir, "models.json"), models);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));
  const packed = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]))[0];
  assert(packed.files.some((file: { path: string }) => file.path === "dist/index.html"));
  for (const path of ["desktop/main.cjs", "desktop/launch.mjs", "desktop/install.mjs", "desktop/icon.mjs", "desktop/policy.cjs"]) {
    assert(packed.files.some((file: { path: string }) => file.path === path), `Desktop package contains ${path}`);
  }
  for (const path of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "build/package-lock.json"]) {
    assert(packed.files.some((file: { path: string }) => file.path === path), `Package contains ${path}`);
  }
  for (const path of ["SKILL.md", "references/LICENSE", "references/UPSTREAM.md", "references/agent-compatibility.md", "references/evidence-delivery.md", "references/feature-map-example/README.md", "references/feature-map-example/search.md", "references/feature-map-example/create-note.md"]) {
    assert(packed.files.some((file: { path: string }) => file.path === `build/skills/create-verification-skill/${path}`), `Package contains generator ${path}`);
  }
  assert(packed.files.some((file: { path: string }) => file.path === "build/skills/git-selective-staging/SKILL.md"), "Package contains git-selective-staging");
  assert(packed.files.some((file: { path: string }) => file.path === "build/skills/visualize/SKILL.md"), "Package contains visualize");
  assert(!packed.files.some((file: { path: string }) => /\.test\.|^(src|media|e2e|node_modules)\//u.test(file.path)), "Package excludes source/tests/personal data");
  // npm reads a root npm-shrinkwrap.json instead of package-lock.json, so a stale one breaks npm ci.
  await assert.rejects(stat(join(repo, "npm-shrinkwrap.json")), { code: "ENOENT" }, "The build leaves no npm-shrinkwrap.json in the checkout");
  await npm(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed.filename)]);
  await assert.rejects(stat(join(installed, "node_modules/vite")), { code: "ENOENT" });
  // Remote workers install the lockfile the package was built with.
  const { workerRelease } = await import(pathToFileURL(join(installed, "build/server/worker/release.js")).href);
  const shipped = (await workerRelease()).files.find((file: { path: string }) => file.path === "package-lock.json");
  assert(shipped?.data.equals(await readFile(join(repo, "package-lock.json"))), "The installed worker release ships the built lockfile");
  assert.equal(await command("--version"), baseline);
  assert.match(await command("--help"), /gateway start/u);
  assert.match(await command("--help"), /hui desktop/u);
  // Exercise the installed CLI's Electron dispatch without claiming a native
  // window on headless/NixOS CI. The executable fixture records its handoff.
  const desktopRuntime = join(temporary, "desktop-runtime");
  const desktopProof = join(temporary, "desktop-launch.json");
  await mkdir(desktopRuntime);
  await writeFile(join(desktopRuntime, "electron"), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.HUI_DESKTOP_PROOF, JSON.stringify({ args: process.argv.slice(2), config: JSON.parse(process.env.HUI_DESKTOP_LAUNCH) }));
`, { mode: 0o755 });
  // hui desktop detaches and returns; wait for the launched shell's handoff.
  // A temporary HOME keeps a developer's real ~/Applications/HUI.app out of it.
  const proofWritten = new Promise<void>((resolve) => {
    const watcher = watch(temporary, (_event, name) => { if (name === "desktop-launch.json") { watcher.close(); resolve(); } });
  });
  await exec(process.execPath, [cli, "desktop"], {
    cwd: temporary, env: { ...env, HOME: temporary, ELECTRON_OVERRIDE_DIST_PATH: desktopRuntime, HUI_DESKTOP_PROOF: desktopProof }, timeout: 10000,
  });
  await Promise.race([proofWritten, new Promise((_, reject) => setTimeout(() => reject(new Error("Desktop shell was not launched")), 10_000))]);
  const desktopLaunch = JSON.parse(await readFile(desktopProof, "utf8"));
  assert.deepEqual(desktopLaunch.args, [join(installed, "desktop/main.cjs")]);
  assert.equal(desktopLaunch.config.root, installed);
  assert.equal(desktopLaunch.config.node, process.execPath);

  await assert.rejects(command("ui", "--no-open"), /Gateway is not running/u);
  await assert.rejects(command("update"), /No stable HUI release is published/u);
  assert.equal(JSON.parse(await command("update", "--check", "--json")).status, "unpublished");
  await releases.set({ mode: "denied" });
  const inaccessible = JSON.parse(await command("update", "--check", "--json"));
  assert.equal(inaccessible.status, "unavailable"); assert.equal(inaccessible.canInstall, false);
  assert(!inaccessible.message.includes("fixture token"), "remote diagnostics never echo credential-shaped CLI stderr");
  await releases.set({ mode: "unpublished" });
  const occupied = createServer();
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const occupiedAddress = occupied.address(); assert(occupiedAddress && typeof occupiedAddress !== "string");
  await assert.rejects(command("gateway", "start", "--port", String(occupiedAddress.port)), /EADDRINUSE/u);
  await new Promise<void>((resolve) => occupied.close(() => resolve()));
  let status = JSON.parse(await command("gateway", "start", "--port", "0", "--json"));
  assert.equal(status.status, "running"); assert.equal(status.version, baseline);
  assert.equal(JSON.parse(await command("gateway", "start", "--json")).pid, status.pid);
  // Lifecycle, warning and error diagnostics reach the private log via stderr.
  assert.match(await command("gateway", "logs"), /^\S+Z INFO gateway\/start HUI gateway started$/mu);
  assert.equal(await command("ui", "--no-open"), status.url);
  assert(!JSON.stringify(status).includes("token"));
  const api = async (path: string, body?: object) => {
    const response = await fetch(new URL(`/__hui/${path}`, status.url), {
      method: body ? "POST" : "GET", headers: { "x-hui": "1", "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.ok, true, `${path}: ${response.status}`);
    return response.json();
  };
  const waitIdle = (id: string, label = "session") => waitStatus(id, "idle", label);
  // A failure names what the stream showed and why it ended, with the gateway's
  // log: the TAP report carries only the message, and the log is deleted after.
  const waitStatus = async (id: string, wanted: "idle" | "running", label: string) => {
    const seen: string[] = [];
    try {
      const response = await fetch(new URL(`/__hui/sessions/${id}/events`, status.url), { headers: { "x-hui": "1" }, signal: AbortSignal.timeout(20_000) });
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = "";
      try {
        for (;;) {
          const result = await reader.read(); assert(!result.done, "SSE must remain open until idle");
          buffer += decoder.decode(result.value, { stream: true });
          while (buffer.includes("\n\n")) {
            const end = buffer.indexOf("\n\n"); const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            const parsed = data ? JSON.parse(data) as { status?: unknown; type?: unknown; message?: unknown } : undefined;
            if (parsed?.status !== undefined) seen.push(`${event}:${String(parsed.status)}`);
            else if (event === "event" && parsed?.type === "error") seen.push(`error:${String(parsed.message)}`);
            if (parsed?.status === wanted) return;
            if (parsed?.status === "error") throw new Error("SDK session boot failed");
          }
        }
      } finally { await reader.cancel(); }
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const log = await command("gateway", "logs", "--lines", "40").catch((logError: unknown) => `gateway logs unavailable: ${String(logError)}`);
      throw new Error(`${label} did not reach ${wanted} (${reason}; stream: ${seen.join(", ") || "nothing"}).\nGateway log:\n${log}`, { cause: error });
    }
  };
  assert.match(await (await fetch(new URL("/settings/tools", status.url))).text(), /hui-app/u);
  // The installed gateway serves the terminal's Gespenst worker and Ghostty WebAssembly from the package.
  const terminalAssets = packed.files.map((file: { path: string }) => file.path).filter((path: string) => /^dist\/assets\/(?:terminal-worker-.+\.js|ghostty-vt-.+\.wasm)$/u.test(path));
  assert.equal(terminalAssets.length, 2, "Package contains the terminal worker and WebAssembly");
  for (const path of terminalAssets) {
    const asset = await fetch(new URL(path.slice("dist".length), status.url));
    assert.equal(asset.status, 200, path);
    assert.match(asset.headers.get("content-type") ?? "", path.endsWith(".wasm") ? /^application\/wasm$/u : /javascript/u, path);
    await asset.arrayBuffer();
  }
  assert.equal((await fetch(new URL("/__hui/tools", status.url))).status, 403);
  const deniedHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = get(status.url, { headers: { host: "untrusted.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.once("error", reject);
  });
  assert.equal(deniedHost, 403);
  assert((await api("themes")).themes.length > 0);
  const providers = await api("providers");
  assert(!JSON.stringify(providers).includes("installed-hui-fixture-not-a-secret"));
  const openai = providers.providers.find((provider: { id: string }) => provider.id === "openai");
  assert.equal(openai.configured, true); assert.equal(openai.authenticated, true);
  assert.deepEqual(openai.selected, []);
  assert(openai.models[0].contextWindow > 0);

  assert.equal(providers.providers.some((provider: { id: string }) => provider.id === "claude-code"), false);

  const { session } = await api("sessions", { cwd: workspace, title: "Installed package proof", tool: "pi" });
  await waitIdle(session.id, "initial session boot");
  assert.deepEqual((await api(`sessions/${session.id}/models`)).models.map((model: { provider: string; id: string }) => `${model.provider}/${model.id}`), ["hui-e2e/fixture"]);

  await api(`sessions/${session.id}/prompt`, { text: "E2E_RICH" }); await waitIdle(session.id, "rich tool turn");
  const history = (await api(`sessions/${session.id}/open`, {})).transcript;
  assert.match(JSON.stringify(history), /Installed SDK content/u);
  assert.equal((await api(`sessions/${session.id}/tools`)).backend, "sdk");
  const bundledSkills = (await api("pi")).skills.filter((skill: { origin?: string }) => skill.origin === "hui");
  assert.deepEqual(bundledSkills.map((skill: { name: string }) => skill.name), ["create-verification-skill", "git-selective-staging", "visualize"]);
  const commands = (await api(`sessions/${session.id}/commands`)).commands as { name: string }[];
  const tags: Record<string, string[]> = { "create-verification-skill": ["good practices"], "git-selective-staging": ["good practices"], visualize: ["presentation"] };
  for (const bundled of bundledSkills) {
    assert.equal(bundled.preferencePath, `hui:skill:${bundled.name}`);
    assert.deepEqual(bundled.tags, tags[bundled.name]);
    assert(bundled.path.startsWith(installed), `${bundled.name} resolves inside the installed package, not the checkout`);
    assert(commands.some((command) => command.name === `skill:${bundled.name}`), `${bundled.name} is loaded as a skill command`);
  }
  // Exercise native PTY dependencies and the standalone gateway upgrade path
  // from the installed archive, not Vite or the source checkout.
  const terminalPath = `sessions/${session.id}/terminals`;
  const { terminal } = await api(terminalPath, {});
  const connection = await api(`${terminalPath}/${terminal.id}/connect`, {});
  const terminalUrl = new URL(connection.url, status.url); terminalUrl.protocol = "ws:";
  const socket = new WebSocket(terminalUrl, { origin: new URL(status.url).origin });
  const [snapshot] = await once(socket, "message");
  assert.equal(JSON.parse(snapshot.toString()).type, "snapshot");
  const terminalOutput = new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Installed PTY output timed out.")), 5000);
    // PTY output arrives as binary messages; text messages are JSON metadata.
    socket.on("message", (raw, binary) => {
      if (binary) buffer += raw.toString();
      else if (JSON.parse(raw.toString()).type === "error") { clearTimeout(timer); reject(new Error("Installed PTY reported an error.")); }
      if (buffer.includes("INSTALLED_PTY")) { clearTimeout(timer); resolve(); }
    });
  });
  socket.send(JSON.stringify({ action: "input", data: "printf '%s%s\\n' INSTALLED_ PTY\r" }));
  await terminalOutput;
  socket.close(); await once(socket, "close");
  const terminalStatus = JSON.parse(await command("gateway", "status", "--json"));
  assert.equal(terminalStatus.activeSessions, 0);
  assert.equal(terminalStatus.activeTerminals, 1);
  await assert.rejects(command("gateway", "stop"), /active sessions, terminals/u);
  await assert.rejects(command("gateway", "restart"), /active sessions, terminals/u);
  await assert.rejects(command("update", "--from", join(temporary, packed.filename)), /idle gateway/u);
  await api(`${terminalPath}/${terminal.id}`, { action: "close" });
  await api(`sessions/${session.id}/prompt`, { text: "E2E_REPLAY" });
  await assert.rejects(command("gateway", "stop"), /active sessions/u);
  await assert.rejects(command("gateway", "restart"), /active sessions/u);
  await assert.rejects(command("update", "--from", join(temporary, packed.filename)), /idle gateway/u);
  await fetch(`${providerUrl}/control/release-replay`, { method: "POST" }); await waitIdle(session.id, "released replay turn");
  const beforeRestart = status.pid;
  status = JSON.parse(await command("gateway", "restart", "--json")); assert.notEqual(status.pid, beforeRestart);
  const reopened = await api(`sessions/${session.id}/open`, {});
  if (reopened.session.status !== "idle") await waitIdle(session.id, "reopened session");
  assert.match(JSON.stringify((await api(`sessions/${session.id}/open`, {})).transcript), /Installed SDK content/u);

  const candidate = async (version: string, failActivation = false): Promise<string> => {
    const directory = join(temporary, `candidate-${version}`); await mkdir(directory);
    for (const asset of ["bin", "build", "dist", "desktop"]) await cp(join(installed, asset), join(directory, asset), { recursive: true });
    const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ ...pkg, version }));
    await writeFile(join(directory, "build/release.json"), JSON.stringify({ format: 1, version }));
    if (failActivation) {
      const entry = join(directory, "build/cli/gateway-run.js");
      await writeFile(entry, `if (process.env.XDG_CONFIG_HOME === ${JSON.stringify(env.XDG_CONFIG_HOME)}) throw new Error("Fixture activation failure");\n` + await readFile(entry, "utf8"));
    }
    const [result] = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], directory));
    return join(temporary, result.filename);
  };
  const release = await candidate(nextVersion);
  const before = await readFile(join(env.XDG_CONFIG_HOME, "hui/sessions.json"), "utf8");
  await assert.rejects(command("update", "--from", release, "--sha256", "0".repeat(64)), /SHA-256/u);
  assert.equal(JSON.parse(await command("gateway", "status", "--json")).pid, status.pid);
  const updated = JSON.parse(await command("update", "--from", release));
  assert.equal(updated.version, nextVersion); assert.equal(updated.restarted, true); assert.match(updated.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(await command("--version"), nextVersion);
  status = JSON.parse(await command("gateway", "status", "--json")); assert.equal(status.version, nextVersion);
  assert.equal(await readFile(join(env.XDG_CONFIG_HOME, "hui/sessions.json"), "utf8"), before);
  assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), models);
  const updates = join(env.XDG_DATA_HOME, "hui/updates", createHash("sha256").update(installed).digest("hex").slice(0, 20));
  const pointer = JSON.parse(await readFile(join(updates, "current.json"), "utf8"));
  await writeFile(join(updates, pointer.current, "node_modules/hui/build/cli/main.js"), 'throw new Error("Fixture broken active CLI");\n');
  await assert.rejects(command("--version"), /Fixture broken active CLI/u);
  const rollback = JSON.parse(await command("update", "--rollback")); assert.equal(rollback.version, baseline);
  assert.equal(await command("--version"), baseline);
  const broken = await candidate(brokenVersion, true);
  await assert.rejects(command("update", "--from", broken), /Gateway exited during startup/u);
  status = JSON.parse(await command("gateway", "status", "--json")); assert.equal(status.version, baseline); assert.equal(status.status, "running");
  assert.equal(await command("--version"), baseline);
  assert.equal(await readFile(join(env.XDG_CONFIG_HOME, "hui/sessions.json"), "utf8"), before);
  await api(`sessions/${session.id}/open`, {}); await waitIdle(session.id, "post-rollback reopen");
  await api(`sessions/${session.id}/prompt`, { text: "E2E_REPLAY" });
  const beforeForced = status.pid;
  status = JSON.parse(await command("gateway", "restart", "--force", "--json"));
  assert.notEqual(status.pid, beforeForced);
  await command("gateway", "stop", "--force");
  assert.equal(JSON.parse(await command("gateway", "status", "--json")).status, "stopped");
  await command("gateway", "stop");
  const stoppedUpdate = JSON.parse(await command("update", "--from", release));
  assert.equal(stoppedUpdate.version, nextVersion); assert.equal(stoppedUpdate.restarted, false);
  assert.equal(JSON.parse(await command("gateway", "status", "--json")).status, "stopped");
  const stoppedRollback = JSON.parse(await command("update", "--rollback"));
  assert.equal(stoppedRollback.version, baseline); assert.equal(stoppedRollback.restarted, false);

  // The nightly channel installs the published main build. The stable channel
  // is checked independently, and a nightly already installed is not repeated.
  const nightly = `${nextVersion}-nightly.20261004131149.gb0f30d5`;
  await releases.set({ channel: "nightly", version: nightly, archive: await candidate(nightly) });
  assert.equal(JSON.parse(await command("update", "--check", "--json")).status, "unpublished");
  const nightlyCheck = JSON.parse(await command("update", "--check", "--nightly", "--json"));
  assert.equal(nightlyCheck.status, "available"); assert.equal(nightlyCheck.latest.version, nightly);
  const nightlyUpdate = JSON.parse(await command("update", "--nightly", "--json"));
  assert.equal(nightlyUpdate.version, nightly); assert.equal(nightlyUpdate.restarted, false); assert.match(nightlyUpdate.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(await command("--version"), nightly);
  assert.equal(JSON.parse(await command("update", "--check", "--nightly", "--json")).status, "current");
  assert.deepEqual(JSON.parse(await command("update", "--nightly", "--json")), { version: nightly, restarted: false }, "an installed nightly is not reinstalled");
  assert.equal(JSON.parse(await command("update", "--rollback")).version, baseline);
  assert.equal(await command("--version"), baseline);
  assert.match(await command("gateway", "logs"), /Fixture activation failure/u);

  // Exercise the real detached browser updater, including a refused busy turn,
  // a corrupted remote asset, a gateway replacement and API recovery receipt.
  await releases.set({ version: nextVersion, archive: release });
  const checked = JSON.parse(await command("update", "--check", "--json"));
  assert.equal(checked.canInstall, true); assert.equal(checked.latest.version, nextVersion);
  assert.equal(await command("--version"), baseline, "check never installs");
  // The replay interrupted by the forced restart above resumes when this gateway
  // starts. Count the provider's holds first, so the release below waits for this
  // gateway's own resend rather than for any hold the provider has seen.
  const heldBeforeReopen = (await (await fetch(`${providerUrl}/control/wait-held?count=0`)).json() as { held: number }).held;
  status = JSON.parse(await command("gateway", "start", "--port", "0", "--json"));
  assert.equal((await api("update/check", {})).check.canInstall, true);
  assert.equal((await fetch(new URL("/__hui/update", status.url))).status, 403);
  const post = (path: string, body: object) => fetch(new URL(`/__hui/${path}`, status.url), {
    method: "POST", headers: { "x-hui": "1", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await post("update", { version: nextVersion, from: "/tmp/arbitrary.tgz" })).status, 400);
  assert.equal((await post("update", { version: "9.9.9" })).status, 409);
  for (const verb of ["prompt", "steer", "follow-up"]) {
    assert.equal((await post(`sessions/${session.id}/${verb}`, { text: "/update --force" })).status, 400);
  }
  await api(`sessions/${session.id}/open`, {});
  assert.equal((await fetch(`${providerUrl}/control/wait-held?count=${heldBeforeReopen + 1}`, { signal: AbortSignal.timeout(20_000) })).status, 200);
  await waitStatus(session.id, "running", "remote update reopen resend");
  await fetch(`${providerUrl}/control/release-replay`, { method: "POST" });
  await waitIdle(session.id, "remote update reopen");
  await api(`sessions/${session.id}/prompt`, { text: "E2E_REPLAY" });
  assert.equal((await post("update", { version: nextVersion })).status, 409);
  await api(`sessions/${session.id}/abort`, {}); await waitIdle(session.id, "aborted remote-update replay");
  const waitForJob = () => new Promise<{ status: string; version: string; message: string }>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("Update receipt timed out")); }, 120_000);
    const inspect = async () => {
      try {
        const job = JSON.parse(await readFile(join(updates, "job.json"), "utf8"));
        if (job.status !== "running") { clearTimeout(timer); watcher.close(); resolve(job); }
      } catch (error) { clearTimeout(timer); watcher.close(); reject(error); }
    };
    const watcher = watch(updates, () => { void inspect(); });
    void inspect();
  });
  await releases.set({ version: nextVersion, archive: release, mode: "corrupt" });
  await api("update", { version: nextVersion });
  assert.match((await waitForJob()).message, /SHA-256/u);
  assert.equal(await command("--version"), baseline);
  await releases.set({ version: nextVersion, archive: release });
  const registryBeforeRemote = await readFile(join(env.XDG_CONFIG_HOME, "hui/sessions.json"), "utf8");
  await api("update", { version: nextVersion });
  const job = await waitForJob();
  assert.equal(job.status, "succeeded"); assert.equal(job.version, nextVersion);
  assert.equal((await api("update")).currentVersion, nextVersion);
  assert.equal(await readFile(join(env.XDG_CONFIG_HOME, "hui/sessions.json"), "utf8"), registryBeforeRemote);
  assert.equal((await api("update/check", {})).check.status, "current");
  assert.equal((await post("update", { version: nextVersion })).status, 409, "cannot reinstall current version from stale UI");
  assert.equal(await command("--version"), nextVersion);
  await command("update", "--rollback");
  const remoteCli = JSON.parse(await command("update", "--json"));
  assert.equal(remoteCli.version, nextVersion);
  await command("update", "--from", release);
  const kept = JSON.parse(await readFile(join(updates, "current.json"), "utf8"));
  assert.deepEqual((await readdir(updates)).filter((entry) => entry.startsWith("release-")).sort(), [kept.current, kept.previous].sort(),
    "an update deletes every staged release but the current and previous ones, including the failed activation's");

  // hui doctor finds the PI session made above and, once the gateway is stopped, moves it to Pi Durable without
  // touching PI's transcript. The moved session reopens with its history and runs a turn on Durable.
  const doctor = async (...args: string[]) => {
    try { return { code: 0, stdout: await command("doctor", ...args), stderr: "" }; }
    catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code, stdout: String(failed.stdout ?? "").trim(), stderr: String(failed.stderr ?? "") };
    }
  };
  type Report = { ok: boolean; checks: { id: string; status: string; items: { id: string; status: string }[] }[] };
  const piCheck = (report: Report) => report.checks.find((check) => check.id === "pi-sessions")!;
  const piRecord = JSON.parse(await readFile(join(env.XDG_CONFIG_HOME, "hui/sessions.json"), "utf8")).sessions
    .find((record: { id: string }) => record.id === session.id) as { tool: string; piSessionFile: string };
  assert.equal(piRecord.tool, "pi");
  const piTranscript = await readFile(piRecord.piSessionFile, "utf8");
  const found = await doctor("--json");
  assert.equal(found.code, 1, "issues found");
  assert.deepEqual(piCheck(JSON.parse(found.stdout) as Report).items.map((item) => [item.id, item.status]), [[session.id, "issue"]]);
  const refused = await doctor("--fix");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Stop the gateway before hui doctor --fix/u);
  await command("gateway", "stop");
  const fixed = await doctor("--fix", "--json");
  assert.equal(fixed.code, 0, fixed.stdout + fixed.stderr);
  assert.equal(piCheck(JSON.parse(fixed.stdout) as Report).status, "fixed");
  assert.equal(await readFile(piRecord.piSessionFile, "utf8"), piTranscript, "PI's transcript is unchanged");
  assert.equal((await doctor()).code, 0, "nothing left to fix");
  status = JSON.parse(await command("gateway", "start", "--port", "0", "--json"));
  await api(`sessions/${session.id}/open`, {}); await waitIdle(session.id, "moved session boot");
  const movedHistory = (await api(`sessions/${session.id}/open`, {})).transcript as unknown[];
  assert.match(JSON.stringify(movedHistory), /Installed SDK content/u, "the PI history moved along");
  assert.equal((await api(`sessions/${session.id}/tools`)).backend, "durable");
  const tools = (entries: unknown[]) => entries.filter((entry) => (entry as { kind?: string }).kind === "tool").length;
  const beforeTurn = tools(movedHistory);
  await api(`sessions/${session.id}/prompt`, { text: "E2E_RICH" }); await waitIdle(session.id, "first turn on Durable");
  assert.equal(tools((await api(`sessions/${session.id}/open`, {})).transcript), beforeTurn + 1, "the moved session runs a tool turn on Durable");

  // A Durable run does not block an ordinary restart: Durable resumes it in the
  // replacement gateway, which asks the provider again and finishes the turn.
  await api(`sessions/${session.id}/prompt`, { text: "E2E_REPLAY" });
  await fetch(`${providerUrl}/control/wait-replay-ready`, { signal: AbortSignal.timeout(20_000) });
  await waitStatus(session.id, "running", "held Durable run");
  const running = JSON.parse(await command("gateway", "status", "--json"));
  assert.equal(running.activeSessions, 1); assert.equal(running.resumableSessions, 1);
  const beforeDurableRestart = status.pid;
  status = JSON.parse(await command("gateway", "restart", "--json"));
  assert.notEqual(status.pid, beforeDurableRestart);
  await fetch(`${providerUrl}/control/wait-replay-ready`, { signal: AbortSignal.timeout(20_000) });
  await fetch(`${providerUrl}/control/release-replay`, { method: "POST" });
  await waitIdle(session.id, "resumed Durable run");
  assert.match(JSON.stringify((await api(`sessions/${session.id}/open`, {})).transcript), /replay suffix/u, "the resumed run finished");
});
