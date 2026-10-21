#!/usr/bin/env node
/** Start a disposable real-SDK browser fixture. No operator config is modified.
 * Ctrl+C stops children; the printed temporary directory is retained for proof. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), "hui-sdk-browser-"));
const agentDir = join(dir, "agent");
const workspace = join(dir, "workspace");
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(join(agentDir, "skills", "sdk-fixture"), { recursive: true });
await writeFile(join(agentDir, "skills", "sdk-fixture", "SKILL.md"), "---\nname: sdk-fixture\ndescription: SDK browser skill enablement fixture.\n---\nUse only for fixture skill checks.\n");
await mkdir(workspace);
await writeFile(join(workspace, "fixture.txt"), "Real SDK browser fixture\n");
await copyFile(join(repo, "e2e/fixtures/question-extension.ts"), join(agentDir, "extensions/question.ts"));
await copyFile(join(repo, "e2e/fixtures/slash-commands-extension.ts"), join(agentDir, "extensions/commands.ts"));
const provider = spawn(process.execPath, [join(repo, "e2e/fixtures/pi-provider-fixture.mjs")], {
  env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: workspace, HUI_E2E_PROVIDER_LOG: join(dir, "provider.jsonl") },
  stdio: ["ignore", "pipe", "inherit"],
});
const [ready] = await once(provider.stdout, "data");
const baseUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
if (!baseUrl) throw new Error("Provider did not report its address.");
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
  baseUrl, api: "anthropic-messages", apiKey: "e2e-not-a-secret",
  models: [{ id: "fixture", name: "HUI SDK Fixture", reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", defaultThinkingLevel: "high" }));
const gateway = spawn(process.execPath, [join(repo, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", process.env.HUI_E2E_PORT ?? "43128", "--strictPort"], {
  cwd: repo,
  env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir, PI_OFFLINE: "1", HUI_PI_BACKEND: "sdk" },
  stdio: ["ignore", "inherit", "inherit"],
});
process.stdout.write(`SDK fixture: ${dir}\nWorkspace: ${workspace}\nProvider: ${baseUrl}\n`);
const stop = () => { gateway.kill(); provider.kill(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
gateway.once("exit", () => provider.kill());
