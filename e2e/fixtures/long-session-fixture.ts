/**
 * Seeds an isolated HUI configuration with one long Durable session: many turns
 * whose bash results carry a few kilobytes of log text each, so opening it moves
 * a transcript of about two megabytes, like a day-long coding session.
 * Requires XDG_CONFIG_HOME, PI_CODING_AGENT_DIR and HUI_E2E_WORKSPACE; run it
 * before the gateway starts. HUI_E2E_TURNS overrides the turn count (default 160).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { DurableHost, durableContext } from "../../server/runtimes/durable-host.ts";
import { CONFIG_DIR } from "../../server/paths.ts";

const workspace = process.env["HUI_E2E_WORKSPACE"]!;
const agentDir = process.env["PI_CODING_AGENT_DIR"]!;
const turns = Number(process.env["HUI_E2E_TURNS"] ?? 160);
const start = Date.now() - turns * 60_000;
const text = (value: string) => [{ type: "text", text: value }];
const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const log = (turn: number) => Array.from({ length: 60 }, (_, line) =>
  `src/module-${turn % 17}/file-${line}.ts:${line + 1}:${(turn * line) % 80} ok  ${"compiled and type-checked; ".repeat(2)}${line % 7 === 0 ? "warning: unused import" : ""}`).join("\n");

const entries: unknown[] = [];
for (let turn = 0; turn < turns; turn++) {
  const at = start + turn * 60_000;
  entries.push({ kind: UserEntry.kind, model: [{ role: "user", content: text(`Step ${turn + 1}: run the checks for module ${turn % 17} and fix what fails.`), timestamp: at }] });
  entries.push({ kind: ToolResultEntry.kind, model: [{ role: "toolResult", toolCallId: `call-${turn}`, toolName: "bash", content: text(log(turn)), isError: false, timestamp: at + 20_000 }], data: { diagnostics: [] } });
  entries.push({ kind: AssistantEntry.kind, model: [{
    role: "assistant", content: text(`Module ${turn % 17} passes now. I tightened the types in two files and removed the unused import the checker flagged.`),
    api: "anthropic-messages", provider: "hui-e2e", model: "fixture", usage, stopReason: "stop", timestamp: at + 40_000,
  }] });
}

await mkdir(workspace, { recursive: true });
const host = new DurableHost({ dir: join(CONFIG_DIR, "durable"), agentDir, resume: false, lookupCaller: async () => undefined });
host.configureDurableBots(null);
const harness = await host.open();
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd: workspace }, init: async (tx, id) => {
  for (const entry of entries) await tx.appendEntry(id, entry as never);
} }, durableContext);
await host.close();
const session = {
  id: "e2e-long-session", title: "Long remote session", group: "Remote", cwd: workspace, tool: "durable",
  piSessionFile: `durable:${conversation.id}`, model: "hui-e2e/fixture", createdAt: new Date(start).toISOString(),
  updatedAt: new Date(start + turns * 60_000).toISOString(), source: "hui",
};
await mkdir(CONFIG_DIR, { recursive: true });
await writeFile(join(CONFIG_DIR, "sessions.json"), JSON.stringify({ version: 2, groups: [], sessions: [session] }));
process.stdout.write(`Seeded one session with ${turns} turns.\n`);
