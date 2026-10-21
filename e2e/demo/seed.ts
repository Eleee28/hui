/**
 * The demo world: an isolated HUI with a few small Git repositories, sessions
 * of an imaginary team across Kanban stages, local backlog tasks, settings and
 * its Datadog org.
 * Run by `visual-verification.mjs launch --demo` before the gateway starts,
 * with XDG_CONFIG_HOME, PI_CODING_AGENT_DIR, HUI_E2E_WORKSPACE and HUI_FAKE_GH_DIR.
 */
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import { DurableHost, durableContext } from "../../server/runtimes/durable-host.ts";
import { CONFIG_DIR } from "../../server/paths.ts";

const { HUI_E2E_WORKSPACE: workspace, PI_CODING_AGENT_DIR: agentDir, HUI_FAKE_GH_DIR: ghDir } = process.env;
// Run outside the launcher, CONFIG_DIR would be the operator's own ~/.config/hui; the launcher's is in a temporary directory.
if (!workspace || !agentDir || !ghDir || !relative(homedir(), CONFIG_DIR).startsWith("..")) {
  throw new Error("Run by visual-verification.mjs launch --demo, whose isolated XDG_CONFIG_HOME is outside your home directory.");
}
const MINUTE = 60_000;
const now = Date.now();

const repos: Record<string, Record<string, string>> = {
  storefront: {
    "src/orders/orders-page.js": "import { listOrders } from \"../api.js\";\n\n/** The orders table: every order of the last 90 days, newest first. */\nexport async function ordersPage() {\n  const orders = await listOrders({ days: 90 });\n  return { title: \"Orders\", columns: [\"id\", \"customer\", \"total\", \"status\"], rows: orders };\n}\n",
    "src/api.js": "export async function listOrders() {\n  return [];\n}\n",
    "test/export-csv.test.js": "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { toCsv } from \"../src/orders/export-csv.js\";\n\nconst order = { id: \"A-1001\", customer: \"Dana\", total: 42, status: \"paid\" };\ntest(\"writes a header row\", () => assert.equal(toCsv([]), \"id,customer,total,status\"));\ntest(\"writes one row per order\", () => assert.equal(toCsv([order]).split(\"\\n\")[1], \"A-1001,Dana,42,paid\"));\ntest(\"quotes commas\", () => assert.match(toCsv([{ ...order, customer: \"Lee, Sam\" }]), /\"Lee, Sam\"/));\ntest(\"escapes quotes\", () => assert.match(toCsv([{ ...order, customer: \"The \\\"Shop\\\"\" }]), /\"The \"\"Shop\"\"\"/));\n",
    "package.json": "{ \"name\": \"storefront\", \"type\": \"module\", \"private\": true }\n",
    "ci/build-times.csv": "day,branch,median_minutes\nMon,main,14.2\nMon,pr,11.5\nTue,main,13.8\nTue,pr,11.9\nWed,main,8.9\nWed,pr,7.2\nThu,main,8.6\nThu,pr,6.8\nFri,main,8.4\nFri,pr,6.9\n",
  },
  "payments-api": {
    "src/refunds/route.js": "import { orders, issueRefund } from \"../store.js\";\n\nexport async function postRefund(request, response) {\n  const order = await orders.get(request.body.orderId);\n  for (const line of request.body.lines) {\n    await issueRefund(order, line);\n  }\n  response.status(201).json({ refunded: request.body.lines.length });\n}\n",
    "src/store.js": "export const orders = { get: async (id) => ({ id, customerId: \"c-1\" }) };\nexport async function issueRefund() {}\n",
    "test/refunds.test.js": "import { test } from \"node:test\";\n\ntest(\"refunds a whole order\", () => {});\n",
    "package.json": "{ \"name\": \"payments-api\", \"type\": \"module\", \"private\": true }\n",
  },
  "mobile-app": { "README.md": "# Acme mobile\n" },
  docs: { "README.md": "# Acme docs\n" },
};

const gitIn = (root: string) => (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
for (const [name, files] of Object.entries(repos)) {
  const root = join(workspace, name);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const git = gitIn(root);
  git("init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "Acme"], ["user.email", "dev@acme.test"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git("config", key!, value!);
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
}
await appendFile(join(workspace, "payments-api", "src/refunds/route.js"), "\nexport const PARTIAL_REFUNDS = true;\n");
gitIn(join(workspace, "payments-api"))("commit", "-q", "-a", "-m", "Partial refunds endpoint (#148)");

type Seed = { title: string; repo: string; group: string; stage: string; ago: number; ask: string; answer: string; unread?: boolean };
const seeds: Seed[] = [
  { title: "Apple Pay at checkout", repo: "storefront", group: "Storefront", stage: "implementation", ago: 3, ask: "Add Apple Pay to checkout behind the payments flag", answer: "Apple Pay is wired into the payment sheet; I'm adding the merchant validation endpoint next." },
  { title: "Flaky checkout e2e test", repo: "storefront", group: "Storefront", stage: "investigation", ago: 12, ask: "Why does checkout.spec fail one run in ten?", answer: "The test clicks Pay before the totals request settles. I'm confirming with a trace.", unread: true },
  { title: "Search results skeleton", repo: "storefront", group: "Storefront", stage: "testing", ago: 41, ask: "Show a skeleton while search results load", answer: "Done: skeleton rows match the result card height, so nothing jumps. Ready for review." },
  { title: "Upgrade to Vite 8", repo: "storefront", group: "Storefront", stage: "done", ago: 180, ask: "Upgrade the storefront to Vite 8", answer: "Upgraded; the build is 31% faster and all tests pass." },
  { title: "Rate limiter on Redis", repo: "payments-api", group: "Payments", stage: "implementation", ago: 7, ask: "Move the rate limiter from memory to Redis", answer: "The sliding window now lives in Redis; I'm load testing it." },
  { title: "Retry-safe webhooks", repo: "payments-api", group: "Payments", stage: "testing", ago: 55, ask: "Make the Stripe webhook handler idempotent", answer: "Processed event ids are stored for 7 days, so retries are ignored. Tests cover duplicates." },
  { title: "JPY rounding fix", repo: "payments-api", group: "Payments", stage: "done", ago: 300, ask: "Totals in JPY round to the wrong yen", answer: "Fixed: zero-decimal currencies skip the cents conversion." },
  { title: "Offline receipts", repo: "mobile-app", group: "Mobile", stage: "investigation", ago: 25, ask: "Can receipts work offline?", answer: "Yes, with a small local queue. I'm sketching the sync rules." },
  { title: "Dark mode receipts", repo: "mobile-app", group: "Mobile", stage: "implementation", ago: 18, ask: "Receipts are unreadable in dark mode", answer: "Receipt colors now come from the theme tokens; checking contrast on every screen." },
  // The Work pane clip's conversation (demo-10).
  { title: "Order totals as currency", repo: "storefront", group: "Storefront", stage: "investigation", ago: 2, ask: "Order totals show up as raw numbers, like 1234.5. Format them as currency.", answer: "I'll add a small formatter and use it on the orders page. Open a terminal and I'll run the tests there, so you can watch." },
];

const text = (value: string) => [{ type: "text", text: value }];
const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const host = new DurableHost({ dir: join(CONFIG_DIR, "durable"), agentDir, resume: false, lookupCaller: async () => undefined });
host.configureDurableBots(null);
const harness = await host.open();
const sessions: Record<string, unknown>[] = [];
for (const [index, seed] of seeds.entries()) {
  const cwd = join(workspace, seed.repo);
  const at = now - seed.ago * MINUTE;
  const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd, model: { provider: "hui-e2e", modelId: "fixture" }, thinkingLevel: "high" }, init: async (tx, id) => {
    await tx.appendEntry(id, { kind: UserEntry.kind, model: [{ role: "user", content: text(seed.ask), timestamp: at - 4 * MINUTE }] } as never);
    await tx.appendEntry(id, { kind: AssistantEntry.kind, model: [{ role: "assistant", content: text(seed.answer), api: "anthropic-messages", provider: "hui-e2e", model: "fixture", usage, stopReason: "stop", timestamp: at }] } as never);
  } }, durableContext);
  sessions.push({
    id: `demo-${index + 1}`, title: seed.title, group: seed.group, cwd, tool: "durable", piSessionFile: `durable:${conversation.id}`,
    model: "hui-e2e/fixture", createdAt: new Date(at - 4 * MINUTE).toISOString(), updatedAt: new Date(at).toISOString(), source: "hui",
    stage: seed.stage, stageSource: "agent", ...(seed.unread ? { unread: true } : {}),
  });
}
await host.close();

const task = (title: string, repo: string, group: string, problem: string, fix: string) =>
  ({ id: `demo-${repo}-${title.toLowerCase().replace(/\W+/gu, "-")}`, title, problem, fix, cwd: join(workspace, repo), group, createdAt: new Date(now - 2 * 86_400_000).toISOString() });
await mkdir(CONFIG_DIR, { recursive: true });
const groups = [["Storefront", "storefront"], ["Payments", "payments-api"], ["Mobile", "mobile-app"], ["Docs", "docs"]].map(([label, repo]) => ({ label, cwd: join(workspace, repo!) }));
await writeFile(join(CONFIG_DIR, "sessions.json"), JSON.stringify({ version: 2, groups, sessions }));
await writeFile(join(CONFIG_DIR, "backlog.json"), JSON.stringify({ version: 1, jira: {}, tasks: [
  task("Add CSV export to the orders page", "storefront", "Storefront", "Support keeps asking engineers for order exports. The orders page has no way to download what it shows.", "Add an Export CSV button that downloads the visible rows."),
  task("Rotate the Stripe webhook secret", "payments-api", "Payments", "The webhook signing secret has not been rotated since launch.", "Support two secrets during the rotation window."),
  task("Document the release checklist", "docs", "Docs", "Releases depend on one person remembering the steps.", "Write the checklist in docs/releasing.md."),
] }));
await writeFile(join(CONFIG_DIR, "settings.json"), JSON.stringify({
  profileName: "Dana", models: { primary: "hui-e2e/fixture", fallback: "", utility: "hui-e2e/fixture" },
}));
// Acme's Datadog org, read through the fake pup the launcher sets up, for the Datadog card in the chat.
await writeFile(join(CONFIG_DIR, "datadog.json"), JSON.stringify({ version: 1, orgs: [{ name: "acme", site: "app.datadoghq.com" }] }));
// Pull requests the fake GitHub CLI describes, for link cards in the chat.
const pull = (number: number, title: string, body: string, patch: Record<string, unknown> = {}) => ({
  __typename: "PullRequest", number, title, body, state: "OPEN", isDraft: false, author: { login: "dana" }, additions: 86, deletions: 12, changedFiles: 4,
  comments: { totalCount: 3 }, reviewThreads: { totalCount: 2 }, ...patch,
});
await writeFile(join(ghDir, "previews.json"), JSON.stringify({
  "acme/storefront#482": pull(482, "Fix double submit on the signup form", "Disables **Create account** while the request is in flight, so a double click no longer creates two trials.", { state: "MERGED", additions: 41, deletions: 9, changedFiles: 3 }),
  "acme/payments-api#142": pull(142, "Partial refunds endpoint", "Adds `POST /refunds` with per-line refunds and an over-refund guard."),
  "acme/payments-api#148": pull(148, "Partial refunds endpoint", "Adds per-line refunds to `POST /refunds`.", { state: "MERGED" }),
  "acme/payments-api#151": pull(151, "Retry-safe Stripe webhooks", "Stores processed event ids for 7 days, so Stripe's retries are ignored.", { additions: 64, deletions: 7, changedFiles: 3 }),
}));
// VS Code's serve-web downloads its server build into the cli folder; a link keeps it between demo runs.
if (process.env["HUI_DEMO_CACHE"]) {
  await mkdir(join(process.env["HUI_DEMO_CACHE"], "vscode-cli"), { recursive: true });
  await mkdir(join(CONFIG_DIR, "vscode", "serve-web"), { recursive: true });
  await symlink(join(process.env["HUI_DEMO_CACHE"], "vscode-cli"), join(CONFIG_DIR, "vscode", "serve-web", "cli"));
}
process.stdout.write(`Seeded ${sessions.length} demo sessions in ${workspace}.\n`);
