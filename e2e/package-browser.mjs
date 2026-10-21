#!/usr/bin/env node
/** Install a real local package and serve it with disposable PI/HUI state.
 * Run npm run build first. Ctrl+C stops only this fixture; proof files remain. */
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packCandidate, releaseFixture } from "./fixtures/release-fixture.mjs";

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "hui-package-browser-"));
const prefix = join(root, "prefix");
const agentDir = join(root, "agent");
const workspace = join(root, "workspace");
await mkdir(agentDir); await mkdir(workspace);
await writeFile(join(workspace, "fixture.txt"), "Production package browser fixture\n");
const env = { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  PI_CODING_AGENT_DIR: agentDir, HUI_PI_BACKEND: "sdk" };
const releases = process.env.HUI_E2E_RELEASES === "1" ? await releaseFixture(root) : null;
if (releases) Object.assign(env, releases.env);
const provider = spawn(process.execPath, [join(repo, "e2e/fixtures/pi-provider-fixture.mjs")], {
  env: { ...env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: workspace, HUI_E2E_PROVIDER_LOG: join(root, "provider.jsonl") },
  stdio: ["ignore", "pipe", "inherit"],
});
const cli = join(prefix, "lib/node_modules/hui/bin/hui.mjs");
const stop = async () => {
  await exec(process.execPath, [cli, "gateway", "stop", "--force"], { env, timeout: 20_000 }).catch((error) => console.error(error.message));
  provider.kill();
};
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
try {
  const [ready] = await Promise.race([once(provider.stdout, "data"), once(provider, "exit").then(() => { throw new Error("Provider failed to start."); })]);
  const baseUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
  if (!baseUrl) throw new Error("Provider did not report an address.");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
    baseUrl, api: "anthropic-messages", apiKey: "e2e-not-a-secret", models: [{ id: "fixture", name: "Package fixture", reasoning: true,
      input: ["text", "image"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));
  const packed = JSON.parse((await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo })).stdout)[0];
  await exec("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)], { timeout: 120_000 });
  if (releases) {
    const baseline = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version;
    const version = baseline.replace(/\d+$/u, (patch) => String(Number(patch) + 1));
    const archive = await packCandidate(dirname(dirname(cli)), root, version);
    await releases.set({ version, archive });
    console.log(`Release fixture: ${releases.file}`);
  }
  const started = await exec(process.execPath, [cli, "gateway", "start", "--port", process.env.HUI_E2E_PORT ?? "43129", "--json"], { env, timeout: 30_000 });
  console.log(`Package fixture: ${root}\nCLI: ${cli}\nWorkspace: ${workspace}\n${started.stdout}`);
} catch (error) { await stop(); throw error; }
