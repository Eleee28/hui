/** Seed disposable PI transcripts whose tool calls created GitHub pull requests.
 * Usage: node e2e/fixtures/session-pr-badges-fixture.mjs <fresh-temp-root> <pi-session-manager.js>
 * The URLs point at public cli/cli pull requests in each GitHub state, so the
 * gateway's real `gh pr view` lookup supplies state, title and description. */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const [rootArg, managerArg] = process.argv.slice(2);
if (!rootArg || !managerArg) throw new Error("Provide a disposable root and the installed PI session-manager.js");
const root = resolve(rootArg);
if (!root.startsWith(`${tmpdir()}/`) || !basename(root).startsWith("hui-pr-badges-")) {
  throw new Error("Use a fresh /tmp/hui-pr-badges-* directory");
}
const { SessionManager } = await import(pathToFileURL(resolve(managerArg)).href);
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "xdg/hui"), { recursive: true });
await mkdir(join(root, "pi-agent"), { recursive: true });
await writeFile(join(root, "pi-agent/models.json"), JSON.stringify({ providers: { "hui-e2e": {
  baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", apiKey: "unused",
  models: [{ id: "fixture", name: "HUI E2E Fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(root, "pi-agent/settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function transcript(title, numbers) {
  const manager = SessionManager.create(workspace, join(root, "pi-sessions"));
  manager.appendModelChange("hui-e2e", "fixture");
  manager.appendMessage({ role: "user", content: [{ type: "text", text: `${title}: open the pull requests.` }], timestamp: Date.now() });
  for (const [index, number] of numbers.entries()) {
    const id = `call_${index}`;
    manager.appendMessage({
      role: "assistant", api: "anthropic-messages", provider: "hui-e2e", model: "fixture",
      content: [{ type: "toolCall", id, name: "bash", arguments: { command: "git push -u origin HEAD && gh pr create --fill" } }],
      stopReason: "toolUse", usage, timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult", toolCallId: id, toolName: "bash", isError: false, timestamp: Date.now(),
      content: [{ type: "text", text: `Creating pull request for feature into trunk in cli/cli\n\nhttps://github.com/cli/cli/pull/${number}\n` }],
    });
  }
  manager.appendMessage({
    role: "assistant", api: "anthropic-messages", provider: "hui-e2e", model: "fixture",
    content: [{ type: "text", text: "Pull requests are open. See also https://github.com/cli/cli/pull/1 (mentioned only)." }],
    stopReason: "stop", usage, timestamp: Date.now(),
  });
  return manager.getSessionFile();
}

const now = new Date().toISOString();
const sessions = [
  { id: "pr-release-train", title: "Release train", numbers: [14509, 14517, 14515, 14355, 14485] },
  { id: "pr-readme", title: "README intro", numbers: [14517] },
  { id: "pr-none", title: "No pull requests", numbers: [] },
].map(({ id, title, numbers }) => ({
  id, title, group: "Browser checks", cwd: workspace, tool: "pi", model: "hui-e2e/fixture",
  piSessionFile: transcript(title, numbers), createdAt: now, updatedAt: now, source: "hui",
}));
await writeFile(join(root, "xdg/hui/sessions.json"), JSON.stringify({ version: 2, sessions, groups: [{ label: "Browser checks" }] }), { flag: "wx" });
console.log(JSON.stringify({ root, sessions: sessions.map(({ id, title }) => ({ id, title })) }));
