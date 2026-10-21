#!/usr/bin/env node
/** Disposable real-HUI/real-PI fixture; only the model provider is mocked. */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `HUI visual verification (run from the checkout being reviewed)

  node e2e/visual-verification.mjs launch --branch <expected-branch> [--pi-sessions] [--fast-fixture] [--quota-fixture | --jira-fixture | --github-fixture | --datadog-fixture | --activity-fixture | --demo]
  node e2e/visual-verification.mjs doctor --receipt <absolute-receipt.json>
  node e2e/visual-verification.mjs cleanup --receipt <absolute-receipt.json>

Launch stays in the foreground and prints one JSON ready receipt. Keep its exec
session alive during Browser-tool checks. App/provider ports are OS-allocated,
state and evidence stay in a private temporary directory outside the checkout.
Doctor checks instance identity, branch/HEAD/content fingerprint, provider health
and the HUI x-hui boundary. Run before and after browser evidence. After any source
edit or commit, cleanup and relaunch: a stale checkout fails doctor.
For an intentionally detached CI checkout, pass --branch HEAD; the receipt still
records the exact commit and detached=true. Never switch branches to make it pass.
Cleanup stops only this authenticated runner's children and retains all artifacts.
Ctrl+C also cleans up. This is an isolated fixture, not a production sandbox.
`;

function git(root, ...args) {
  const env = Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "SystemRoot"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  return execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

export async function checkoutIdentity(root) {
  root = await realpath(git(root, "rev-parse", "--show-toplevel").trim());
  const head = git(root, "rev-parse", "HEAD").trim();
  const branch = git(root, "branch", "--show-current").trim();
  const status = git(root, "status", "--porcelain=v1", "--untracked-files=all");
  const hash = createHash("sha256").update(git(root, "diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv")).update(status);
  for (const path of git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort()) {
    const absolute = join(root, path);
    hash.update(path).update("\0");
    hash.update((await lstat(absolute)).isSymbolicLink() ? await readlink(absolute) : await readFile(absolute));
  }
  return { root, branch: branch || "HEAD", detached: !branch, head, dirty: status.length > 0, status, fingerprint: hash.digest("hex") };
}

export function fixtureEnvironment(dir, inherited = process.env) {
  const env = {};
  // An allowlist avoids inheriting cloud keys, proxy credentials, NODE_OPTIONS,
  // shell startup hooks or the operator's HUI/PI overrides. HOME is not changed.
  // HUI_OPENVSCODE_SERVER_MIRROR points the VS Code view's server install at a local release (the checksums stay
  // pinned), so its journey never downloads from GitHub.
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "SystemRoot", "HUI_OPENVSCODE_SERVER_MIRROR"]) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  return {
    ...env,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
    XDG_DATA_HOME: join(dir, "data"),
    GH_CONFIG_DIR: join(dir, "github"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_AGENT_DIR: join(dir, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
    PI_OFFLINE: "1",
    HUI_PI_BACKEND: "sdk",
  };
}

function sameIdentity(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Checkout changed since launch; cleanup and relaunch before capturing evidence.");
}

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("Receipt must identify a loopback fixture, never a remote service.");
  }
  return url;
}

async function request(url, options = {}) {
  // node:http deliberately bypasses ambient proxy settings for loopback checks.
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest(url, { ...options, signal: AbortSignal.timeout(5_000) }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolveResponse({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        contentType: response.headers["content-type"] ?? "",
        json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function loadReceipt(path) {
  if (!path || !isAbsolute(path)) throw new Error("--receipt requires an absolute JSON path from launch.");
  const receipt = JSON.parse(await readFile(path, "utf8"));
  if (receipt.version !== 1 || !receipt.token || !receipt.runId || !receipt.checkout) throw new Error("Not a visual-verification receipt.");
  localUrl(receipt.url);
  localUrl(receipt.providerUrl);
  return receipt;
}

async function ownedInstance(receipt) {
  const response = await request(`${receipt.url}/__verification`, { headers: { "x-hui-verification": receipt.token } });
  if (!response.ok) throw new Error(`Instance ownership check failed (${response.status}); refusing this port.`);
  const identity = await response.json();
  if (identity.runId !== receipt.runId || identity.serverPid !== receipt.serverPid || identity.runnerPid !== receipt.runnerPid || identity.cwd !== receipt.checkout.root) {
    throw new Error("Instance identity mismatch; refusing this port.");
  }
  sameIdentity(identity.checkout, receipt.checkout);
}

export async function doctor(path) {
  const receipt = await loadReceipt(path);
  if (receipt.state !== "ready") throw new Error(`Fixture is ${receipt.state}, not ready.`);
  await ownedInstance(receipt);
  sameIdentity(await checkoutIdentity(receipt.checkout.root), receipt.checkout);
  const [withoutHeader, withHeader, provider] = await Promise.all([
    request(`${receipt.url}/__hui/settings`),
    request(`${receipt.url}/__hui/settings`, { headers: { "x-hui": "1" } }),
    request(`${receipt.providerUrl}/health`),
  ]);
  if (withoutHeader.status !== 403 || !withHeader.ok || !withHeader.contentType.includes("application/json") || !provider.ok) {
    throw new Error("HUI header guard, API readiness, or fixture provider health failed.");
  }
  const result = { ok: true, checkedAt: new Date().toISOString(), runId: receipt.runId, url: receipt.url, checkout: receipt.checkout, checks: ["owned-instance", "unchanged-checkout", "x-hui-guard", "hui-api", "provider-health"] };
  await writeFile(join(receipt.artifacts, "doctor.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

async function portOpen(value) {
  const url = localUrl(value);
  return new Promise((resolveOpen) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(500);
    const done = (open) => { socket.destroy(); resolveOpen(open); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(true));
  });
}

async function until(check, timeout, message) {
  const deadline = Date.now() + timeout;
  while (true) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(message);
    // Poll an observable condition; delay alone never establishes correctness.
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

export async function cleanup(path) {
  const receipt = await loadReceipt(path);
  if (receipt.state !== "stopped") {
    await ownedInstance(receipt);
    const response = await request(`${receipt.url}/__verification/shutdown`, { method: "POST", headers: { "x-hui-verification": receipt.token } });
    if (!response.ok) throw new Error("Owned runner refused shutdown.");
  }
  await until(async () => {
    const current = await loadReceipt(path);
    return current.state === "stopped" && !(await portOpen(receipt.url)) && !(await portOpen(receipt.providerUrl));
  }, 15_000, "Cleanup did not complete; inspect the retained logs. No unrelated PID was killed.");
  return { ok: true, state: "stopped", runId: receipt.runId, portsClosed: true, artifacts: receipt.artifacts };
}

function ready(child, listen) {
  return new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => done(new Error("Fixture startup timed out; inspect its log.")), 60_000);
    const onError = (error) => done(error);
    const onExit = (code, signal) => done(new Error(`Fixture exited during startup (${code ?? signal}).`));
    const removeListener = listen((value) => done(null, value));
    function done(error, value) {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      removeListener();
      error ? reject(error) : resolveReady(value);
    }
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function launch(expectedBranch) {
  if (!expectedBranch) throw new Error("launch requires --branch <expected-branch> to prevent verifying the wrong checkout.");
  const checkout = await checkoutIdentity(repo);
  if (checkout.branch !== expectedBranch) throw new Error(`Wrong branch: expected ${expectedBranch}, found ${checkout.branch || "detached HEAD"}.`);
  const dir = await mkdtemp(join(tmpdir(), "hui-visual-"));
  const relativeDir = relative(checkout.root, dir);
  if (relativeDir === "" || (!relativeDir.startsWith("..") && !isAbsolute(relativeDir))) throw new Error("Temporary artifacts must be outside the checkout.");
  const artifacts = join(dir, "artifacts");
  // --demo shows the workspace path on screen, so it gets a short one.
  const workspace = process.argv.includes("--demo") ? await mkdtemp("/tmp/acme-") : join(dir, "workspace");
  const agentDir = join(dir, "agent");
  for (const path of [artifacts, workspace, join(agentDir, "extensions"), join(agentDir, "skills", "sdk-fixture")]) await mkdir(path, { recursive: true });
  await writeFile(join(workspace, "fixture.txt"), "Real SDK browser fixture\n");
  await writeFile(join(agentDir, "skills", "sdk-fixture", "SKILL.md"), "---\nname: sdk-fixture\ndescription: SDK browser skill enablement fixture.\n---\nUse only for fixture skill checks.\n");
  await copyFile(join(repo, "e2e/fixtures/question-extension.ts"), join(agentDir, "extensions/question.ts"));
  await copyFile(join(repo, "e2e/fixtures/slash-commands-extension.ts"), join(agentDir, "extensions/commands.ts"));
  await copyFile(join(repo, "e2e/fixtures/compaction-extension.ts"), join(agentDir, "extensions/compaction.ts"));
  const receiptPath = join(dir, "receipt.json");
  const receipt = { version: 1, state: "starting", runId: randomUUID(), token: randomUUID(), runnerPid: process.pid, checkout, workspace, artifacts, receipt: receiptPath, startedAt: new Date().toISOString() };
  const save = async () => {
    const temporary = `${receiptPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, receiptPath);
  };
  await save();
  const env = fixtureEnvironment(dir);
  if (process.argv.includes("--quota-fixture")) {
    env.HUI_VERIFICATION_QUOTAS = "1";
    const providersDir = join(env.XDG_CONFIG_HOME, "hui", "providers");
    const backup = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(providersDir, "accounts", backup), { recursive: true });
    const auth = { type: "api_key", key: "synthetic-quota-fixture-not-a-secret" };
    const oauth = (email) => ({ type: "oauth", access: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email } })).toString("base64url")}.fixture`, refresh: "synthetic-refresh", expires: Date.now() + 86400000 });
    await writeFile(join(providersDir, "auth.json"), JSON.stringify({ "openai-codex": oauth("alex.personal@example.com"), anthropic: auth, openai: auth, "opencode-go": auth }), { mode: 0o600 });
    await writeFile(join(providersDir, "accounts", backup, "auth.json"), JSON.stringify({ "openai-codex": oauth("alex.long.work.account@example.com") }), { mode: 0o600 });
    await writeFile(join(providersDir, "accounts.json"), JSON.stringify({ "openai-codex": [{ id: "default", name: "Personal" }, { id: backup, name: "Backup", cooldownUntil: Date.now() + 10800000 }] }), { mode: 0o600 });
    await writeFile(join(providersDir, "models.json"), JSON.stringify({ "openai-codex": { models: [] }, anthropic: { models: [] }, openai: { models: [] }, "opencode-go": { models: [] } }), { mode: 0o600 });
  }
  const children = [];
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const child of [...children].reverse()) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await exited;
        clearTimeout(deadline);
      }
      receipt.state = "stopped";
      receipt.stoppedAt = new Date().toISOString();
      await save();
    })();
    return stopping;
  }
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  function start(script, extraEnv, ipc = false) {
    if (stopping) throw new Error("Fixture startup was cancelled.");
    const child = spawn(process.execPath, [join(repo, "e2e", script)], { cwd: repo, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])] });
    const log = createWriteStream(join(artifacts, `${basename(script)}.log`), { mode: 0o600 });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("close", () => log.end());
    child.once("exit", (code, signal) => {
      if (!stopping) {
        process.stderr.write(`Fixture child ${script} exited (${code ?? signal}).\n`);
        process.exitCode = code || 1;
        void stop();
      }
    });
    children.push(child);
    return child;
  }
  try {
    // --demo: the scripted model and seeded world of the demo videos (e2e/demo), with the fake GitHub CLI.
    const demo = process.argv.includes("--demo");
    const provider = start(demo ? "demo/provider.ts" : "fixtures/pi-provider-fixture.mjs", { HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: workspace, HUI_E2E_PROVIDER_LOG: join(artifacts, "provider.jsonl") });
    receipt.providerPid = provider.pid;
    receipt.providerUrl = await ready(provider, (done) => {
      let output = "";
      const onData = (data) => { output += data; const url = output.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0]; if (url) done(url); };
      provider.stdout.on("data", onData);
      return () => provider.stdout.off("data", onData);
    });
    // A real model's window. Durable compacts in the background from 32,768 tokens below
    // `contextWindow - reserveTokens`; a 32k window put that under zero, and with the small kept window
    // below every launcher session on Durable would compact by itself after a few turns.
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
      baseUrl: receipt.providerUrl, api: "anthropic-messages", headers: { "x-client-session-id": "${PI_CLIENT_SESSION_ID}" }, apiKey: "e2e-not-a-secret",
      models: [
        { id: "fixture", name: demo ? "Demo model" : "HUI SDK Fixture", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        // --fast-fixture: a Claude Opus 5.5 id, so the composer offers Maximum effort and Speed (fast mode).
        ...process.argv.includes("--fast-fixture") ? [{
          id: "claude-opus-5-5", name: "Opus fixture", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
        }] : [],
      ],
    } } }));
    // A small kept window lets /compact and /fixture-compact summarize a few short turns.
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", defaultThinkingLevel: "high", compaction: { keepRecentTokens: 400 } }));
    const serverEnv = {};
    // New sessions run on Durable, including PI extensions; journeys checking PI-worker semantics opt in.
    if (process.argv.includes("--pi-sessions")) serverEnv.HUI_SESSION_RUNTIME = "pi";
    if (process.argv.includes("--jira-fixture")) {
      // Local Jira Cloud subset (e2e/fixtures/jira-fixture.mjs), connected with its
      // public test credentials; the fixture model is also the utility model.
      const jira = start("fixtures/jira-fixture.mjs", { HUI_E2E_JIRA_PORT: "0" });
      receipt.jiraUrl = await ready(jira, (done) => {
        let output = "";
        const onData = (data) => { output += data; const url = output.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0]; if (url) done(url); };
        jira.stdout.on("data", onData);
        return () => jira.stdout.off("data", onData);
      });
      serverEnv.HUI_JIRA_TEST_ORIGIN = receipt.jiraUrl;
      const hui = join(env.XDG_CONFIG_HOME, "hui");
      await mkdir(hui, { recursive: true });
      await writeFile(join(hui, "jira.json"), JSON.stringify({ site: receipt.jiraUrl, email: "e2e@hui.test", token: "e2e-token", defaultProject: "CI", accountName: "HUI E2E" }), { mode: 0o600 });
      await writeFile(join(hui, "settings.json"), JSON.stringify({ models: { primary: "hui-e2e/fixture", fallback: "", utility: "hui-e2e/fixture" } }));
      const now = new Date().toISOString();
      const session = (id, title) => ({ id, title, group: "CI", cwd: workspace, tool: "pi", createdAt: now, updatedAt: now });
      await writeFile(join(hui, "sessions.json"), JSON.stringify({ version: 2, groups: [], sessions: [
        session("e2e-jira-flaky", "Flaky CI retries"),
        session("e2e-jira-docs", "Docs cleanup"),
      ] }));
    }
    if (process.argv.includes("--github-fixture") || demo) {
      // Fake gh (e2e/fixtures/github-cli-fixture.mjs) signed in to two synthetic accounts
      // with deterministic commits and pull requests since they were created.
      const gh = join(dir, "gh");
      await mkdir(gh, { recursive: true });
      await writeFile(join(gh, "account"), "hui-e2e\n");
      await writeFile(join(gh, "accounts"), "hui-e2e\nhui-e2e-personal\n");
      let seed = 42;
      const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const activity = (createdAt, weekday, weekend, prRate) => {
        const commits = [], pullRequests = [];
        for (let day = 0; day < (Date.now() - Date.parse(createdAt)) / 86_400_000; day++) {
          const date = new Date(Date.now() - day * 86_400_000);
          const busy = date.getDay() % 6 === 0 ? weekend : weekday;
          for (let count = Math.floor(random() * random() * busy); count > 0; count--) commits.push(new Date(date.valueOf() - random() * 36_000_000).toISOString());
          if (random() < prRate * (busy === weekday ? 1 : 0.2)) pullRequests.push(date.toISOString());
        }
        return { createdAt, commits, pullRequests };
      };
      await writeFile(join(gh, "contributions.json"), JSON.stringify({
        "hui-e2e": activity("2022-03-14T09:00:00Z", 14, 1, 0.55),
        "hui-e2e-personal": activity("2019-08-02T18:00:00Z", 2, 9, 0.15),
      }));
      Object.assign(serverEnv, { HUI_GITHUB_CLI: join(repo, "e2e", "fixtures", "github-cli-fixture.mjs"), HUI_FAKE_GH_DIR: gh });
    }
    if (process.argv.includes("--datadog-fixture") || demo) {
      // Fake pup (e2e/fixtures/pup-cli-fixture.mjs). E2E: `e2e-prod` is signed in, `e2e-stale` needs a sign-in, one dashboard
      // each, snapshots answer 403 (no image). The demo: Acme's org and its signup dashboard, whose graph the
      // recorder draws and the demo provider serves (HUI_DATADOG_TEST_ORIGIN admits it). Share links still read the
      // real public Datadog page.
      const pup = join(dir, "pup");
      await mkdir(pup, { recursive: true });
      const session = (org, status = "valid", hasRefresh = true) => ({ org, site: "datadoghq.com", status, has_refresh: hasRefresh });
      await writeFile(join(pup, "sessions.json"), JSON.stringify(demo ? [session("acme")] : [session("e2e-prod"), session("e2e-stale", "expired", false)]));
      await writeFile(join(pup, "dashboards.json"), JSON.stringify(demo ? { acme: { "sgn-fnl-acm": {
        title: "Signup funnel", widgets: [{ id: 1001, definition: { type: "timeseries", title: "Trial signups per minute" } }],
      } } } : { "e2e-prod": { "abc-123-xyz": {
        title: "Checkout service", description: "Latency and errors of the checkout service.", template_variables: [{ name: "env", prefix: "env", defaults: ["prod"] }],
        widgets: [{ id: 42, definition: { type: "timeseries", title: "p99 latency in $env", requests: [{ queries: [{ data_source: "metrics", name: "a", query: "p99:checkout.latency{$env}" }], formulas: [{ formula: "a" }] }] } }],
      } }, "e2e-stale": { "stl-123-xyz": {
        title: "Legacy checkout", description: "Before the migration.", template_variables: [],
        widgets: [{ id: 7, definition: { type: "timeseries", title: "Legacy error rate", requests: [{ q: "sum:legacy.errors{*}" }] } }],
      } } }));
      if (demo) {
        await writeFile(join(pup, "snapshot.json"), JSON.stringify({ snapshot_url: `${receipt.providerUrl}/demo/datadog-graph.png` }));
        serverEnv.HUI_DATADOG_TEST_ORIGIN = receipt.providerUrl;
      }
      Object.assign(serverEnv, { HUI_PUP_CLI: join(repo, "e2e", "fixtures", "pup-cli-fixture.mjs"), HUI_FAKE_PUP_DIR: pup });
    }
    if (demo) {
      serverEnv.HUI_DEMO_STAGE = join(repo, "e2e", "demo", "stage.html");
      // Terminals open a plain zsh with a short prompt, not the operator's own shell setup.
      serverEnv.ZDOTDIR = join(dir, "zdotdir");
      await mkdir(serverEnv.ZDOTDIR, { recursive: true });
      await writeFile(join(serverEnv.ZDOTDIR, ".zshrc"), "PROMPT='%F{blue}%1~%f %F{magenta}❯%f '\nunsetopt PROMPT_SP\nHISTFILE=/dev/null\n");
      if (existsSync("/bin/zsh")) serverEnv.SHELL = "/bin/zsh";
      execFileSync(process.execPath, [join(repo, "e2e", "demo", "seed.ts")], { cwd: repo, stdio: ["ignore", "ignore", "inherit"],
        env: { ...env, HUI_E2E_WORKSPACE: workspace, HUI_FAKE_GH_DIR: join(dir, "gh"), ...(process.env.HUI_DEMO_CACHE ? { HUI_DEMO_CACHE: process.env.HUI_DEMO_CACHE } : {}) } });
    }
    if (process.argv.includes("--activity-fixture")) {
      // Two weeks of synthetic Durable sessions for Contributions → Calendar.
      execFileSync(process.execPath, [join(repo, "e2e", "fixtures", "activity-fixture.ts")], { cwd: repo, env: { ...env, HUI_E2E_WORKSPACE: workspace }, stdio: ["ignore", "ignore", "inherit"] });
    }
    const server = start("visual-verification-server.mjs", {
      ...serverEnv,
      HUI_VERIFICATION_IDENTITY: JSON.stringify({ runId: receipt.runId, runnerPid: process.pid, checkout }),
      HUI_VERIFICATION_TOKEN: receipt.token,
      HUI_VERIFICATION_CACHE: join(dir, "vite-cache"),
    }, true);
    receipt.serverPid = server.pid;
    server.on("message", (message) => { if (message.type === "shutdown") void stop(); });
    receipt.url = await ready(server, (done) => {
      const onMessage = (message) => { if (message.type === "ready") done(message.url); };
      server.on("message", onMessage);
      return () => server.off("message", onMessage);
    });
    receipt.browserUrl = receipt.url.replace("127.0.0.1", "localhost");
    receipt.state = "ready";
    await save();
    await doctor(receiptPath);
    // The private receipt has the control token; stdout is safe to share.
    const { token: _token, ...publicReceipt } = receipt;
    process.stdout.write(`${JSON.stringify(publicReceipt)}\n`);
  } catch (error) {
    await stop();
    throw new Error(`${error.message} Artifacts: ${artifacts}`, { cause: error });
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || args.includes("--help")) return process.stdout.write(help);
  // Trailing launch options; `launch` reads them from argv.
  if (command === "launch") while (["--pi-sessions", "--fast-fixture", "--quota-fixture", "--jira-fixture", "--github-fixture", "--datadog-fixture", "--activity-fixture", "--demo"].includes(args.at(-1))) args.pop();
  const option = command === "launch" ? "--branch" : "--receipt";
  if (!["launch", "doctor", "cleanup"].includes(command) || args.length !== 2 || args[0] !== option) throw new Error("Invalid arguments. Run with --help.");
  if (command === "launch") return launch(args[1]);
  process.stdout.write(`${JSON.stringify(await (command === "doctor" ? doctor(args[1]) : cleanup(args[1])))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); process.exitCode = 1; });
}
