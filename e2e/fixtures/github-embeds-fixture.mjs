/** Seed a disposable PI transcript whose messages mention GitHub links and
 * whose tool call created a pull request, for GitHub embed and badge E2E. Thirty
 * earlier turns link more pull requests, issues and a Slack thread, a long
 * history that stays plain links: only the latest user message and reply unfurl.
 * Usage: node e2e/fixtures/github-embeds-fixture.mjs <fresh /tmp/hui-github-embeds-* root> <pi session-manager.js>
 * Pair with HUI_GITHUB_CLI=e2e/fixtures/github-cli-fixture.mjs, whose canned `gh api graphql`
 * previews describe acme/web, acme/web#12 (open PR), #13 (merged PR) and #7 (issue). */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const [rootArg, managerArg] = process.argv.slice(2);
if (!rootArg || !managerArg) throw new Error("Provide a disposable root and the installed PI session-manager.js");
const root = resolve(rootArg);
if (!root.startsWith(`${tmpdir()}/`) || !basename(root).startsWith("hui-github-embeds-")) {
  throw new Error("Use a fresh /tmp/hui-github-embeds-* directory");
}
const { SessionManager } = await import(pathToFileURL(resolve(managerArg)).href);
const workspace = join(root, "workspace");
for (const dir of [workspace, join(root, "xdg/hui"), join(root, "pi-agent"), join(root, "gh")]) await mkdir(dir, { recursive: true });
await writeFile(join(root, "gh/account"), "hui-e2e\n");
await writeFile(join(root, "pi-agent/models.json"), JSON.stringify({ providers: { "hui-e2e": {
  baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", apiKey: "***",
  models: [{ id: "fixture", name: "HUI E2E Fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
await writeFile(join(root, "pi-agent/settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", api: "anthropic-messages", provider: "hui-e2e", model: "fixture", content, stopReason, usage, timestamp: Date.now() });

const manager = SessionManager.create(workspace, join(root, "pi-sessions"));
manager.appendModelChange("hui-e2e", "fixture");
for (let turn = 1; turn <= 30; turn++) {
  manager.appendMessage({ role: "user", content: [{ type: "text", text: `Step ${turn}: review https://github.com/acme/web/pull/${100 + turn} and acme/web#${200 + turn}.` }], timestamp: Date.now() });
  manager.appendMessage(assistant([{ type: "text", text: `Reviewed https://github.com/acme/web/pull/${100 + turn}.\n\nhttps://acme.slack.com/archives/C01234567/p1723456789012345` }]));
}
manager.appendMessage({ role: "user", content: [{ type: "text", text: "Open the checkout PR on acme/web. Context: https://github.com/acme/web/issues/7" }], timestamp: Date.now() });
manager.appendMessage(assistant([{ type: "toolCall", id: "call_pr", name: "bash", arguments: { command: "git push -u origin HEAD && gh pr create --fill" } }], "toolUse"));
manager.appendMessage({ role: "toolResult", toolCallId: "call_pr", toolName: "bash", isError: false, timestamp: Date.now(),
  content: [{ type: "text", text: "Creating pull request for checkout into main in acme/web\n\nhttps://github.com/acme/web/pull/12\n" }] });
manager.appendMessage(assistant([{ type: "text", text: [
  "Opened https://github.com/acme/web/pull/12 on top of acme/web#13. The repo is https://github.com/acme/web and the bug was https://github.com/acme/web/issues/7.",
  "",
  "`https://github.com/acme/web/pull/99` stays code, and https://github.com/acme/missing is a fifth link that is not unfurled.",
].join("\n") }]));

const now = new Date().toISOString();
const sessions = [{
  id: "github-embeds", title: "Checkout PR", group: "Browser checks", cwd: workspace, tool: "pi", model: "hui-e2e/fixture",
  piSessionFile: manager.getSessionFile(), createdAt: now, updatedAt: now, source: "hui",
}];
await writeFile(join(root, "xdg/hui/sessions.json"), JSON.stringify({ version: 2, sessions, groups: [{ label: "Browser checks" }] }), { flag: "wx" });
console.log(JSON.stringify({ root, session: "github-embeds" }));
