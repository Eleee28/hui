/** Seed disposable history with PI's own SessionManager, never operator data.
 * Usage: node e2e/fixtures/markdown-tables-fixture.mjs <fresh-temp-root> <pi-session-manager.js>
 * Use the isolated provider configuration from chat-composer.browser.md. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const [rootArg, managerArg] = process.argv.slice(2);
if (!rootArg || !managerArg) throw new Error("Provide a disposable root and the installed PI session-manager.js");
const root = resolve(rootArg);
if (!root.startsWith(`${tmpdir()}/`) || !basename(root).startsWith("hui-markdown-tables-")) throw new Error("Use a fresh /tmp/hui-markdown-tables-* directory");
const { SessionManager } = await import(pathToFileURL(resolve(managerArg)).href);
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "xdg/hui"), { recursive: true });
const reply = "## Program usage\n\nThe programs that triggered it most:\n\n| Program | Times |\n|---|---:|\n| `confetti` | 23 |\n| `rapid` | 19 |\n| `kubectl` | 15 |\n| `ddr` | 13 |\n| `ddtool` direct | 8 |\n| `bzl` | 5 |\n\n### Wide table\n\n| Program | Command | Status | Notes |\n|:--|:--|:-:|--:|\n| **confetti** | `confetti --environment=development --report=summary` | Ready | 23 |\n| rapid | `rapid --workspace=example --format=markdown` | Done | 19 |";
const sessions = [
  { id: "markdown-tables", title: "Readable tables", count: 1 },
].map(({ id, title, count }) => {
  const manager = SessionManager.create(workspace, join(root, "pi-sessions"));
  manager.appendModelChange("hui-e2e", "fixture");
  for (let index = 0; index < count; index++) {
    const prompt = "Show program usage and a wide table";
    manager.appendMessage({ role: "user", content: [{ type: "text", text: `${String(index + 1).padStart(3, "0")} · ${prompt}.\nFocus on the visible behavior and preserve the existing session.` }], timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "hui-e2e", model: "fixture", content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
  }
  return { id, title, group: "Browser checks", cwd: workspace, tool: "pi", model: "hui-e2e/fixture", piSessionFile: manager.getSessionFile(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "hui" };
});
// Exclusive write: rerunning cannot replace an existing registry.
await writeFile(join(root, "xdg/hui/sessions.json"), JSON.stringify({ version: 2, sessions, groups: [{ label: "Browser checks" }] }), { flag: "wx" });
console.log(JSON.stringify({ root, sessions: sessions.map(({ id, title }) => ({ id, title })) }));
