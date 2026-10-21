/**
 * Importing and exporting bots through a real, isolated gateway: HUI's and PI's directories are temporary and the model
 * is the deterministic fixture provider. Every source is a small synthetic fixture written here.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { botKickoffName, type BotCatalog, type BotView } from "../bots-format.ts";
import type { BotExportManifest, BotExportReview } from "../bots/export-format.ts";
import type { BotImportPreview, BotImportResult } from "../bots/templates/formats.ts";
import type { AutomationTask } from "../automation.ts";
import type { TranscriptEntry } from "../runtimes/types.ts";
import { readZip, writeZip } from "../bots/templates/zip.ts";

const dir = await mkdtemp(join(tmpdir(), "hui-bot-templates-"));
const agentDir = join(dir, "agent");
const workspace = join(dir, "workspace");
await mkdir(agentDir);
await mkdir(workspace);
process.env["HOME"] = dir;
process.env["XDG_CONFIG_HOME"] = join(dir, "config");
process.env["PI_CODING_AGENT_DIR"] = agentDir;
// No gh: startup would run the operator's in the background, writing into this home while afterAll() removes it.
process.env["HUI_GITHUB_CLI"] = join(dir, "no-gh");
const provider = spawn(process.execPath, [fileURLToPath(new URL("../../e2e/fixtures/pi-provider-fixture.mjs", import.meta.url))], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: workspace, HUI_E2E_PROVIDER_LOG: join(dir, "requests.jsonl") },
});
const [ready] = await once(provider.stdout!, "data");
const providerUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
assert(providerUrl, String(ready));
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
  baseUrl: providerUrl, api: "anthropic-messages", apiKey: "***", models: ["fixture", "other"].map((id) => ({
    id, name: id, reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
} } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", defaultThinkingLevel: "low" }));
await mkdir(join(dir, "config", "hui"), { recursive: true });

const { middleware } = await import("../hui.ts");
const { startBackend, stopBackend } = await import("../backend.ts");
const { liveSessions } = await import("../sessions/live-sessions.ts");
let origin = "";
const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404).end(); }));

beforeAll(async () => {
  await startBackend();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await stopBackend();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const exit = once(provider, "exit");
  provider.kill();
  await exit;
  await rm(dir, { recursive: true, force: true });
});

async function call<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T; raw: Buffer; headers: Headers }> {
  const response = await fetch(origin + path, {
    method,
    headers: { "x-hui": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = Buffer.from(await response.arrayBuffer());
  let parsed = {} as T;
  try { parsed = JSON.parse(raw.toString("utf8")) as T; } catch { /* a download */ }
  return { status: response.status, body: parsed, raw, headers: response.headers };
}

function settledWith(id: string, predicate: (entries: TranscriptEntry[]) => boolean): Promise<TranscriptEntry[]> {
  return new Promise((resolve) => {
    let done = false;
    const check = () => {
      if (done || liveSessions.status(id) !== "idle" || !predicate(liveSessions.transcript(id))) return;
      done = true;
      watched.unsubscribe();
      resolve(liveSessions.transcript(id));
    };
    const watched = liveSessions.watch(id, check);
    check();
  });
}

const text = (path: string, value: string) => ({ path, data: Buffer.from(value, "utf8") });
const WORKSPACE = writeZip([
  text("nova/SOUL.md", "# Who I am\n\nYou are Nova, a calm research partner.\n"),
  text("nova/IDENTITY.md", "- **Name:** Nova\n- **Emoji:** 🦊\n- **Vibe:** calm and precise\n"),
  text("nova/AGENTS.md", "# AGENTS.md\n\nRead your memory files first.\n"),
  text("nova/MEMORY.md", "# MEMORY.md\n\n## Projects\nHUI, a Lit app.\n"),
  text("nova/HEARTBEAT.md", "# HEARTBEAT.md\n\nCheck the nightly build.\n"),
  text("nova/skills/weather/SKILL.md", "---\nname: weather\ndescription: Current weather and forecasts\n---\n\nUse wttr.in for the forecast.\n"),
]);
let nova: BotView | undefined;

test("an OpenClaw workspace imports with its soul, memories, its own skill (on, listed as its own) and a disabled routine; the preview creates nothing", async () => {
  const before = (await call<{ bots: BotView[] }>("/__hui/bots")).body.bots.length;
  const source = { kind: "file", name: "nova.zip", data: WORKSPACE.toString("base64") };
  const preview = await call<BotImportPreview>("/__hui/bots/import/preview", "POST", { source });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual([preview.body.bot.name, preview.body.bot.handle, preview.body.bot.emoji, preview.body.bot.description], ["Nova", "nova", "🦊", "calm and precise"]);
  assert.match(preview.body.soul, /^# Who I am\n\nYou are Nova, a calm research partner\.\n\n## What you already know\n[\s\S]*### Projects|^# Who I am[\s\S]*- \*\*Projects:\*\* HUI, a Lit app\./u);
  assert.deepEqual(preview.body.skills.map((skill) => skill.name), ["weather"]);
  assert.deepEqual(preview.body.routines.map((routine) => [routine.name, routine.schedule, routine.guessed]), [["Heartbeat", { kind: "every", everyMs: 1_800_000 }, false]]);
  assert.match(preview.body.dropped.join("\n"), /AGENTS\.md: OpenClaw's operating manual/u);
  assert.equal((await call<{ bots: BotView[] }>("/__hui/bots")).body.bots.length, before, "a preview creates nothing");

  const created = await call<BotImportResult>("/__hui/bots/import", "POST", { template: preview.body.template });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual([created.body.skills, created.body.routines, created.body.opener, created.body.warnings], [["weather"], 1, false, []]);
  nova = created.body.bot;
  assert.deepEqual([nova.name, nova.handle, nova.avatar?.emoji, nova.soul], ["Nova", "nova", "🦊", true]);
  assert.equal((await call<{ soul: string }>(`/__hui/bots/${nova.id}/soul`)).body.soul, preview.body.soul, "SOUL.md as the preview showed it");
  const skill = await readFile(join(dir, "config", "hui", "bots", nova.id, "skills", "weather", "SKILL.md"), "utf8");
  assert.equal(skill, "---\nname: \"weather\"\ndescription: \"Current weather and forecasts\"\n---\n\nUse wttr.in for the forecast.\n");
  const catalog = await call<BotCatalog>(`/__hui/bots/${nova.id}/catalog`);
  assert.deepEqual(catalog.body.skills.filter((each) => each.name === "weather").map((each) => [each.source, each.enabled]), [["Its own skills", true]], "only its chat loads it, and it is on");
  const tasks = (await call<{ tasks: AutomationTask[] }>("/__hui/automation")).body.tasks.filter((task) => task.sessionId === nova!.sessionId);
  assert.deepEqual(tasks.map((task) => [task.name, task.enabled, task.schedule, task.nextRunAt]), [["Heartbeat", false, { kind: "every", everyMs: 1_800_000 }, null]], "its routine starts disabled");
  // Another bot's chat in the same kind of folder does not get Nova's skill.
  const other = await call<{ bot: BotView }>("/__hui/bots", "POST", { name: "Plain", soul: "Plain bot." });
  const otherCatalog = await call<BotCatalog>(`/__hui/bots/${other.body.bot.id}/catalog`);
  assert.equal(otherCatalog.body.skills.some((each) => each.name === "weather"), false, "a bot's own skills are its own");
});

test("a character card's first message is the bot's first message, through a kickoff the chat shows as a note", async () => {
  const card = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Aria", description: "{{char}} keeps a quiet library.", personality: "Kind", scenario: "", first_mes: "Welcome to the library, {{user}}. What are you looking for?", character_book: { entries: [{ keys: ["hours"], content: "Open 9 to 5.", enabled: true }] } } };
  const preview = await call<BotImportPreview>("/__hui/bots/import/preview", "POST", { source: { kind: "text", text: JSON.stringify(card) } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.opener, "Welcome to the library, you. What are you looking for?");
  const created = await call<BotImportResult>("/__hui/bots/import", "POST", { template: preview.body.template });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.opener, true);
  const transcript = await settledWith(created.body.bot.sessionId, (entries) => entries.some((entry) => entry.kind === "message" && entry.role === "assistant"));
  const messages = transcript.filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message");
  assert.equal(botKickoffName(messages[0]!.text), "Aria", "HUI's kickoff, which the chat shows as a note");
  assert.equal(messages.at(-1)!.text, preview.body.opener, "then the opener, as the bot's own first message");
});

test("a Claude Code subagent keeps on only the tools its list maps to, and nothing an import brings turns a tool on", async () => {
  const agent = "---\nname: code-reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: fixture\n---\nYou review code.\n";
  const preview = await call<BotImportPreview>("/__hui/bots/import/preview", "POST", { source: { kind: "file", name: "code-reviewer.md", data: Buffer.from(agent).toString("base64") } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.model, "hui-e2e/fixture", "a bare model id resolves on this gateway");
  assert.ok(preview.body.disabledTools.includes("bash") && preview.body.disabledTools.includes("write") && !preview.body.disabledTools.includes("read"));
  const created = await call<BotImportResult>("/__hui/bots/import", "POST", { template: preview.body.template });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const catalog = await call<BotCatalog>(`/__hui/bots/${created.body.bot.id}/catalog`);
  assert.deepEqual(catalog.body.tools.filter((tool) => tool.enabled).map((tool) => tool.name), ["read"]);
});

test("a bot exports as a reviewed template: the cleanup and the utility model sort it, the picks make the zip, and its import asks the new owner", async () => {
  assert.ok(nova, "Nova was imported");
  assert.equal((await call(`/__hui/bots/${nova.id}`, "PATCH", { tagging: "mention" })).status, 200);
  const settings = (await call<Record<string, unknown> & { models: Record<string, string> }>("/__hui/settings")).body;
  const put = (change: Record<string, unknown>) => call("/__hui/settings", "PUT", { ...settings, ...change });
  assert.equal((await put({ models: { ...settings.models, utility: "hui-e2e/fixture" }, profileName: "Dani Fernandez" })).status, 200);
  try {
    const soul = "# Who I am\n\nI'm Dani Fernandez's research partner. I watch acme/widgets with Pat Doe.\nApprove only when CI is green. Mail dani@example.com.\n";
    assert.equal((await call(`/__hui/bots/${nova.id}/soul`, "PUT", { soul })).status, 200);
    const trigger = await call(`/__hui/bots/${nova.id}/triggers`, "POST", { name: "Reviews", filter: { prLinks: true }, prompt: "Review it with Pat Doe." });
    assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
    const home = join(dir, "config", "hui", "bots", nova.id, "skills", "weather");
    await mkdir(join(home, "scripts"), { recursive: true });
    await writeFile(join(home, "scripts", "check.sh"), "#!/bin/sh\ngh pr list --repo acme/widgets\n");
    await writeFile(join(home, ".env"), "TOKEN=nope\n");

    assert.equal((await call(`/__hui/bots/${nova.id}/export`)).status, 405, "a download takes the operator's picks");
    const review = await call<BotExportReview>(`/__hui/bots/${nova.id}/export/review`, "POST");
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.model, "hui-e2e/fixture");
    assert.deepEqual(review.body.changes.map((change) => [change.quote, change.group]), [["Pat Doe", "remove"], ["acme/widgets", "ask"], ["Approve only when CI is green", "confirm"]]);
    assert.deepEqual(review.body.files.map((file) => [file.part, file.group]), [["skills/weather/scripts/check.sh", "confirm"]], "a script naming the repository travels for the new owner to confirm");
    assert.deepEqual(review.body.needs.map((need) => need.text), ["The GitHub CLI signed in, with access to the repositories it reviews"]);
    assert.ok(review.body.leftOut.includes("Skill weather: .env (a hidden file or folder)."));
    const requests = (await readFile(join(dir, "requests.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { system?: unknown; messages?: unknown });
    const reviewed = requests.filter((request) => JSON.stringify(request.system ?? "").includes("You check a HUI bot"));
    assert.ok(reviewed.length >= 4, "one plain request per part");
    assert.equal(reviewed.some((request) => /Dani Fernandez|dani@example\.com/u.test(JSON.stringify(request.messages))), false, "the model reads the cleaned text only");
    assert.equal(reviewed.some((request) => "tools" in request && Array.isArray((request as { tools?: unknown[] }).tools) && (request as { tools: unknown[] }).tools.length > 0), false, "the reviewer has no tools");

    const exported = await call(`/__hui/bots/${nova.id}/export`, "POST", { review: review.body.id, picks: {} });
    assert.equal(exported.status, 200, exported.raw.toString("utf8").slice(0, 300));
    assert.equal(exported.headers.get("content-type"), "application/zip");
    assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="nova\.hui-bot\.zip"/u);
    const files = new Map(readZip(exported.raw, { files: 100, totalBytes: 1024 * 1024 }).map((entry) => [entry.path, entry.data.toString("utf8")]));
    assert.deepEqual([...files.keys()], ["bot.json", "SOUL.md", "skills/weather/SKILL.md", "skills/weather/scripts/check.sh"]);
    assert.equal([...files.values()].some((text) => /dani|Pat Doe|example\.com/iu.test(text)), false, "nothing of the owner's leaves");
    assert.equal(files.get("SOUL.md"), "# Who I am\n\nI'm {{user}}'s research partner. I watch [ask: the repositories to watch] with a teammate.\nApprove only when CI is green. Mail [removed].\n");
    const manifest = JSON.parse(files.get("bot.json")!) as BotExportManifest;
    assert.equal(manifest.version, 2);
    assert.equal("handle" in manifest.bot, false);
    assert.equal(manifest.bot.tagging, "mention", "who may tag it travels: a policy, nothing of the owner's");
    assert.deepEqual(manifest.triggers, [{ name: "Reviews", filter: { prLinks: true }, prompt: "Review it with a teammate.", cooldownSeconds: 300 }]);
    assert.deepEqual(manifest.open.map((point) => [point.kind, point.where]), [["ask", "SOUL.md"], ["confirm", "SOUL.md"], ["confirm", "Skill weather: scripts/check.sh"]]);
    assert.equal(manifest.open[2]!.question, "It came from someone else's setup: check it before it runs. Which repositories should I watch for pull requests?");

    assert.equal((await call(`/__hui/bots/${nova.id}/soul`, "PUT", { soul: `${soul}One more private line.\n` })).status, 200);
    const stale = await call<{ error: string }>(`/__hui/bots/${nova.id}/export`, "POST", { review: review.body.id, picks: {} });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed since its review/u);

    // The new owner: {{user}} is their name, the open points close SOUL.md, and the bot's first turn starts on them.
    assert.equal((await put({ models: { ...settings.models, utility: "hui-e2e/fixture" }, profileName: "Alex Kim" })).status, 200);
    const preview = await call<BotImportPreview>("/__hui/bots/import/preview", "POST", { source: { kind: "file", name: "nova.hui-bot.zip", data: exported.raw.toString("base64") } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.soul.startsWith("# Who I am\n\nI'm Alex Kim's research partner. I watch [ask: the repositories to watch] with a teammate."), preview.body.soul);
    assert.match(preview.body.soul, /\n## Not agreed yet\n[\s\S]*- Ask \(SOUL\.md\): Which repositories should I watch for pull requests\?/u);
    assert.deepEqual(preview.body.needs, manifest.needs);
    assert.deepEqual(preview.body.triggers.map((each) => each.name), ["Reviews"]);
    assert.deepEqual(preview.body.skills.map((skill) => [skill.name, skill.files?.map((file) => file.path)]), [["weather", ["scripts/check.sh"]]]);
    const created = await call<BotImportResult>("/__hui/bots/import", "POST", { template: preview.body.template });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const bot = created.body.bot;
    assert.equal(await readFile(join(dir, "config", "hui", "bots", bot.id, "skills", "weather", "scripts", "check.sh"), "utf8"), "#!/bin/sh\ngh pr list --repo acme/widgets\n");
    const triggers = (await call<{ triggers: { name: string; enabled: boolean }[] }>(`/__hui/bots/${bot.id}/triggers`)).body.triggers;
    assert.deepEqual(triggers.map((each) => [each.name, each.enabled]), [["Reviews", false]]);
    const transcript = await settledWith(bot.sessionId, (entries) => entries.some((entry) => entry.kind === "message" && entry.role === "assistant"));
    const messages = transcript.filter((entry): entry is Extract<TranscriptEntry, { kind: "message" }> => entry.kind === "message");
    assert.equal(botKickoffName(messages[0]!.text), bot.name, "HUI's kickoff, shown as a note");
    assert.match(messages.at(-1)!.text, /I came from a template someone shared\. First thing to agree: which repositories/u);
  } finally {
    assert.equal((await put({})).status, 200);
  }
});

test("what HUI can't import is refused with what to do instead", async () => {
  const refused = async (path: string, method: string, body: unknown, status: number, pattern: RegExp) => {
    const reply = await call<{ error: string }>(path, method, body);
    assert.equal(reply.status, status, `${method} ${path} ${JSON.stringify(reply.body)}`);
    assert.match(reply.body.error, pattern);
  };
  await refused("/__hui/bots/import/preview", "POST", { source: { kind: "text", text: "[1, 2]" } }, 400, /found no bot to import in this JSON/u);
  await refused("/__hui/bots/import/preview", "POST", { source: { kind: "url", url: "https://example.com/bot.json" } }, 400, /Grok Bot marketplace links only/u);
  await refused("/__hui/bots/import/preview", "POST", { source: { kind: "folder" } }, 400, /source\.kind must be/u);
  await refused("/__hui/bots/import/preview", "POST", { source: { kind: "text", text: "x" }, extra: 1 }, 400, /Unknown field: extra/u);
  await refused("/__hui/bots/import", "POST", { template: { format: "nope", name: "x" } }, 400, /format is not one HUI reads/u);
  await refused("/__hui/bots/import/preview", "GET", undefined, 405, /method not allowed/u);
  await refused("/__hui/bots/nobody/export/review", "POST", undefined, 404, /No bot named nobody/u);
  await refused("/__hui/bots", "POST", { name: "Import", handle: "import" }, 400, /@import is reserved/u);
});
