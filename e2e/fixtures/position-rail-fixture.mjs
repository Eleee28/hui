/** Seed disposable history with PI's own SessionManager, never operator data.
 * Usage: node e2e/fixtures/position-rail-fixture.mjs <fresh-temp-root> <pi-session-manager.js>
 * Use the isolated provider configuration from chat-composer.browser.md. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const [rootArg, managerArg] = process.argv.slice(2);
if (!rootArg || !managerArg) throw new Error("Provide a disposable root and the installed PI session-manager.js");
const root = resolve(rootArg);
if (!root.startsWith(`${tmpdir()}/`) || !basename(root).startsWith("hui-position-rail-")) throw new Error("Use a fresh /tmp/hui-position-rail-* directory");
const { SessionManager } = await import(pathToFileURL(resolve(managerArg)).href);
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(join(root, "xdg/hui"), { recursive: true });
const topics = ["Review the chat layout", "Keep the composer accessible", "Inspect the session sidebar", "Check the Miami theme", "Verify keyboard navigation", "Summarize the latest changes"];
const sessions = [
  { id: "position-rail-long", title: "Conversation navigation", count: 100 },
  { id: "position-rail-short", title: "Short conversation", count: 1 },
].map(({ id, title, count }) => {
  const manager = SessionManager.create(workspace, join(root, "pi-sessions"));
  manager.appendModelChange("hui-e2e", "fixture");
  for (let index = 0; index < count; index++) {
    const prompt = topics[index % topics.length];
    manager.appendMessage({ role: "user", content: [{ type: "text", text: `${String(index + 1).padStart(3, "0")} · ${prompt}.\nFocus on the visible behavior and preserve the existing session.` }], timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "hui-e2e", model: "fixture", content: [{ type: "text", text: `### ${prompt}\n\nThis is a disposable conversation for testing the position rail. Each prompt and response has its own marker.\n\n- Hover to preview the message.\n- Use the keyboard to browse markers without losing your place.\n- Jump to an earlier prompt, then return to the latest response.\n\n${index === 3 ? "```text\n" + "Expandable code fixture\n".repeat(40) + "```" : "The original message order stays unchanged."}` }], stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
  }
  return { id, title, group: "Browser checks", cwd: workspace, tool: "pi", model: "hui-e2e/fixture", piSessionFile: manager.getSessionFile(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: "hui" };
});
// Exclusive write: rerunning cannot replace an existing registry.
await writeFile(join(root, "xdg/hui/sessions.json"), JSON.stringify({ version: 2, sessions, groups: [{ label: "Browser checks" }] }), { flag: "wx" });
console.log(JSON.stringify({ root, sessions: sessions.map(({ id, title }) => ({ id, title })) }));
