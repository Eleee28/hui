/**
 * Seeds an isolated HUI configuration with two weeks of synthetic Durable
 * sessions for the Contributions → Calendar tab: last week fully worked, with
 * parallel sessions in five projects and five groups, and this week until now.
 * Run by `visual-verification.mjs launch --activity-fixture` before the gateway
 * starts; requires XDG_CONFIG_HOME, PI_CODING_AGENT_DIR and HUI_E2E_WORKSPACE.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { DurableHost, durableContext } from "../../server/runtimes/durable-host.ts";
import { CONFIG_DIR } from "../../server/paths.ts";

const MINUTE = 60_000;
const workspace = process.env["HUI_E2E_WORKSPACE"]!;
const agentDir = process.env["PI_CODING_AGENT_DIR"]!;
const now = Date.now();
// The calendar's days start at 5 AM; seed the week before the one it opens on.
const today = new Date(now - 5 * 3_600_000);
const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7) - 7);
/** Local time on a day of last week (0 = Monday); 7 and later are this week. */
const at = (day: number, hour: number, minute = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + day, hour, minute).valueOf();

type Block = [start: number, minutes: number, firstMessage: string];
/** `project` is a directory under the workspace, so Group by → Project names it. */
type Seed = { title: string; project: string; group: string; model: string; blocks: Block[]; parent?: string };

const OPUS = "anthropic/claude-opus-5-5";
const GPT = "openai/gpt-5.5";
const seeds: Seed[] = [
  { title: "Retry-safe checkout", project: "checkout-api", group: "Payments", model: OPUS, blocks: [
    [at(0, 9, 10), 95, "Make /charge idempotent so retries never charge twice"],
    [at(2, 13, 30), 140, "Ship the retry-safe checkout behind the flag"],
    [at(4, 9, 40), 70, "Roll the flag out to everyone"],
  ] },
  { title: "Webhook double charge", project: "checkout-api", group: "Payments", model: OPUS, blocks: [
    [at(0, 20, 15), 85, "Customers get charged twice when the webhook retries. Find out why and fix it"],
    [at(2, 22, 40), 195, "Store processed webhook event ids and add the failing test"],
  ] },
  { title: "Pricing page redesign", project: "marketing-site", group: "Growth", model: GPT, blocks: [
    [at(0, 13, 0), 55, "Tighten the pricing page copy"],
    [at(1, 14, 20), 150, "Redesign the hero section"],
    [at(2, 16, 10), 80, "Add the annual pricing toggle"],
    [at(4, 11, 45), 60, "Launch the pricing page"],
  ] },
  { title: "Offline sync spike", project: "ios-app", group: "Mobile", model: OPUS, blocks: [
    [at(2, 13, 0), 150, "Spike offline sync with a local queue"],
    [at(3, 14, 10), 75, "Try the hero video test on the sync screen"],
  ] },
  { title: "Receipt screen", project: "ios-app", group: "Payments", model: GPT, blocks: [
    [at(3, 10, 30), 120, "Build the receipt screen from the Figma file"],
  ] },
  { title: "Eval baseline scoring", project: "evals", group: "AI", model: OPUS, blocks: [
    [at(0, 9, 50), 80, "Write a 40-case eval set for the grader"],
    [at(1, 16, 50), 65, "Stricter grader for refusals"],
    [at(3, 15, 30), 90, "Fix the six failing evals"],
    [at(6, 9, 15), 45, "Plan the next eval runs"],
  ] },
  { title: "Staging deploy pipeline", project: "infra", group: "Platform", model: GPT, blocks: [
    [at(3, 9, 0), 50, "Staging deploys hang on the migration step"],
    [at(1, 10, 0), 45, "Move the cron to the queue"],
  ] },
  { title: "Alert rules cleanup", project: "infra", group: "Platform", model: GPT, blocks: [
    [at(4, 14, 30), 70, "Clean up the alert rules that page at night"],
  ] },
  { title: "Onboarding polish", project: "ios-app", group: "Growth", model: OPUS, blocks: [
    [at(5, 11, 0), 140, "Polish the onboarding flow"],
  ] },
  { title: "Hotfix: currency rounding", project: "checkout-api", group: "Payments", model: OPUS, blocks: [
    [at(2, 21, 0), 80, "Totals in JPY round to the wrong yen"],
  ] },
  // The last few hours, never before this week starts.
  { title: "Calendar week view", project: "hui", group: "Tools", model: OPUS, blocks: [
    [Math.max(at(7, 5), now - 200 * MINUTE), 110, "Add a calendar of what we did to HUI"],
    [Math.max(at(7, 5), now - 50 * MINUTE), 40, "Make the popover match the reference"],
  ] },
  { title: "Grader subagent", project: "evals", group: "AI", model: OPUS, parent: "Eval baseline scoring", blocks: [
    [at(1, 16, 55), 40, "Score the refusals set"],
  ] },
];

const text = (value: string) => [{ type: "text", text: value }];
const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A turn every few minutes from the first message to the block's end, never past now. */
function entries(model: string, [start, minutes, first]: Block) {
  const [provider, id] = [model.slice(0, model.indexOf("/")), model.slice(model.indexOf("/") + 1)];
  const end = Math.min(start + minutes * MINUTE, now);
  const answer = (timestamp: number, said: string) => ({ kind: AssistantEntry.kind, model: [{
    role: "assistant", content: text(said), api: "anthropic-messages", provider, model: id, usage, stopReason: "stop", timestamp,
  }] });
  const seeded = [{ kind: UserEntry.kind, model: [{ role: "user", content: text(first), timestamp: start }] }, answer(start + MINUTE, "On it.")];
  for (let time = start + 7 * MINUTE; time < end; time += 7 * MINUTE) {
    seeded.push({ kind: ToolResultEntry.kind, model: [{ role: "toolResult", toolCallId: `call-${time}`, toolName: "bash", content: text("ok"), isError: false, timestamp: time }], data: { diagnostics: [] } } as never);
  }
  seeded.push(answer(end, "Done for now."));
  return seeded.filter((entry) => entry.model[0]!.timestamp <= now);
}

const host = new DurableHost({ dir: join(CONFIG_DIR, "durable"), agentDir, resume: false, lookupCaller: async () => undefined });
host.configureDurableBots(null);
const harness = await host.open();
const created = new Date(at(0, 8)).toISOString();
const sessions: Record<string, unknown>[] = [];
for (const [index, seed] of seeds.entries()) {
  const cwd = join(workspace, seed.project);
  await mkdir(cwd, { recursive: true });
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd }, init: async (tx, id) => {
    for (const entry of seed.blocks.sort((a, b) => a[0] - b[0]).flatMap((block) => entries(seed.model, block))) await tx.appendEntry(id, entry as never);
  } }, durableContext);
  const last = Math.max(...seed.blocks.map(([start, minutes]) => Math.min(now, start + minutes * MINUTE)));
  sessions.push({
    id: `e2e-activity-${index + 1}`, title: seed.title, group: seed.group, cwd, tool: "durable",
    piSessionFile: `durable:${conversation.id}`, model: seed.model, createdAt: created, updatedAt: new Date(last).toISOString(), source: "hui",
    ...(seed.parent ? { parentId: `e2e-activity-${seeds.findIndex(({ title }) => title === seed.parent) + 1}` } : {}),
  });
}
await host.close();
await mkdir(CONFIG_DIR, { recursive: true });
await writeFile(join(CONFIG_DIR, "sessions.json"), JSON.stringify({ version: 2, groups: [], sessions }));
process.stdout.write(`Seeded ${sessions.length} sessions from ${monday.toDateString()}.\n`);
