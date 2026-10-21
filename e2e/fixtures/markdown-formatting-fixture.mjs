/** Seed a disposable PI transcript for Markdown formatting browser proof.
 * Usage: node e2e/fixtures/markdown-formatting-fixture.mjs <fresh-temp-root> <pi-session-manager.js> */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const [rootArg, managerArg] = process.argv.slice(2);
if (!rootArg || !managerArg) throw new Error("Provide a disposable root and the installed PI session-manager.js");
const root = resolve(rootArg);
if (!root.startsWith(`${tmpdir()}/`) || !basename(root).startsWith("hui-markdown-formatting-")) {
  throw new Error("Use a fresh /tmp/hui-markdown-formatting-* directory");
}
const { SessionManager } = await import(pathToFileURL(resolve(managerArg)).href);
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "xdg/hui"), { recursive: true });

const manager = SessionManager.create(workspace, join(root, "pi-sessions"));
manager.appendModelChange("hui-e2e", "fixture");
manager.appendMessage({
  role: "user",
  content: [{ type: "text", text: "Show the supported link and task-list formatting." }],
  timestamp: Date.now(),
});
manager.appendMessage({
  role: "assistant",
  api: "anthropic-messages",
  provider: "hui-e2e",
  model: "fixture",
  content: [{
    type: "text",
    text: "## OpenClaw Markdown\n\nUseful references:\n\n- Documentation: https://example.com/docs/getting-started.\n- Repository: https://github.com/openclaw/openclaw\n- Website: www.example.com/help\n- Contact: support@example.com\n\nTasks:\n\n- [x] Use the OpenClaw parser stack\n- [x] Keep sentence punctuation outside links\n- [ ] Ship the next formatting increment\n\n| Feature | Result |\n| --- | ---: |\n| Tables | **Ready** |\n| Nested lists | Ready |\n\n1. CommonMark nesting\n   - Child item\n   - Another child\n\n<details><summary>More formatting</summary>\n\nStrikethrough: ~~old parser~~. Remote images stay safe: ![demo](https://example.com/demo.png)\n\n</details>\n\nInline code stays literal: `https://not-a-link.example`.",
  }],
  stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  timestamp: Date.now(),
});

const now = new Date().toISOString();
const sessions = [{
  id: "markdown-formatting",
  title: "Links and tasks",
  group: "Browser checks",
  cwd: workspace,
  tool: "pi",
  model: "hui-e2e/fixture",
  piSessionFile: manager.getSessionFile(),
  createdAt: now,
  updatedAt: now,
  source: "hui",
}];
await writeFile(join(root, "xdg/hui/sessions.json"), JSON.stringify({ version: 2, sessions, groups: [{ label: "Browser checks" }] }), { flag: "wx" });
console.log(JSON.stringify({ root, sessions: sessions.map(({ id, title }) => ({ id, title })) }));
