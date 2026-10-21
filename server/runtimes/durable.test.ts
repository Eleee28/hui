import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test, type TestContext } from "vitest";
import { normalizeSettings } from "../hui-settings.ts";
import type { DurableSession } from "./durable.ts";
import type { AgentToolInvocation } from "../agent-tools/bridge.ts";
import type { RuntimeEvent, TranscriptEntry } from "./types.ts";
import { SecretFiles, SecretRequests } from "../agent-tools/secret-requests.ts";
import { completeLines } from "../test-support/json-lines.ts";

// HUI's configuration directory (provider selections, credentials, the default
// Durable store) is resolved at import time, and PI finds skills in
// ~/.agents/skills: never read the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-durable-home-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
afterAll(() => rm(root, { recursive: true, force: true }));
const { DurableHost, durableContext, registryCaller } = await import("./durable-host.ts");
const { createDurableBots } = await import("../bots/durable-access.ts");
// The estimate Durable's compaction thresholds use; the package root does not export it.
const { estimateContext } = await import(new URL("./harness/compaction.js", import.meta.resolve("@earendil-works/pi-durable")).href) as {
  estimateContext(view: unknown, extra: readonly unknown[]): number;
};
const { durableConversationId, durableReference, expandSkill, startDurable } = await import("./durable.ts");
const { importPiSession } = await import("./pi-import.ts");
const { searchTranscripts } = await import("./transcript-search.ts");
const { aggregateUsage } = await import("../observability.ts");
type DurableHost = import("./durable-host.ts").DurableHost;

const settings = normalizeSettings(undefined);

async function fixture(t: TestContext, options: { contextWindow?: number; settings?: Record<string, unknown>; extensions?: Record<string, string>; models?: readonly string[]; thinkingLevelMaps?: Record<string, object> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hui-durable-test-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  const store = join(dir, "store");
  await mkdir(agentDir); await mkdir(cwd);
  if (options.extensions) {
    await mkdir(join(agentDir, "extensions"));
    for (const [name, source] of Object.entries(options.extensions)) await writeFile(join(agentDir, "extensions", name), source);
  }
  await writeFile(join(cwd, "fixture.txt"), "Durable fixture content\n");
  const log = join(dir, "requests.jsonl");
  const provider = spawn(process.execPath, [fileURLToPath(new URL("../../e2e/fixtures/pi-provider-fixture.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: cwd, HUI_E2E_PROVIDER_LOG: log },
  });
  const hosts: DurableHost[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  t.onTestFinished(async () => {
    for (const host of hosts) await host.close().catch(() => {});
    for (const child of children) child.kill("SIGKILL");
    const exit = once(provider, "exit"); provider.kill(); await exit;
    await rm(dir, { recursive: true, force: true });
  });
  const [ready] = await once(provider.stdout!, "data");
  const baseUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
  assert(baseUrl, String(ready));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
    // Requires the provider identity HUI gives every PI request (docs/api.md).
    baseUrl, api: "anthropic-messages", headers: { "x-client-session-id": "${PI_CLIENT_SESSION_ID}" }, apiKey: "fixture-key", models: (options.models ?? ["fixture", "group/second"]).map((id) => ({
      id, name: id, reasoning: true, input: ["text", "image"], contextWindow: options.contextWindow ?? 32000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(options.thinkingLevelMaps?.[id] ? { thinkingLevelMap: options.thinkingLevelMaps[id] } : {}),
    })),
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "hui-e2e", defaultModel: "fixture", defaultThinkingLevel: "high",
    ...options.settings,
  }));
  const invocations: AgentToolInvocation[] = [];
  const host = (options: { invokeTool?: (invocation: AgentToolInvocation) => Promise<unknown>; huiSettings?: typeof settings } = {}) => {
    const created = new DurableHost({
      dir: store, agentDir,
      readSettings: async () => options.huiSettings ?? settings,
      invokeTool: options.invokeTool ?? (async (invocation) => { invocations.push(invocation); return { ok: true }; }),
      lookupCaller: async () => undefined,
    });
    created.configureDurableBots(createDurableBots(created, {}));
    hosts.push(created);
    return created;
  };
  const control = (path: string, method = "GET") => fetch(`${baseUrl}${path}`, { method });
  return { dir, cwd, agentDir, store, log, host, invocations, control, children };
}

/** Resolves once the transcript satisfies `predicate`, checking now and after every event. */
function transcriptWhere(session: DurableSession, predicate: (entries: TranscriptEntry[]) => boolean, timeoutMs = 20_000): Promise<TranscriptEntry[]> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const entries = session.transcript();
      if (!predicate(entries)) return false;
      clearTimeout(timer); unsubscribe(); resolve(entries); return true;
    };
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Expected transcript never arrived: ${JSON.stringify(session.transcript())}`)); }, timeoutMs);
    const unsubscribe = session.subscribe(() => { check(); });
    check();
  });
}

function nextEvent(session: DurableSession, predicate: (event: RuntimeEvent) => boolean, timeoutMs = 20_000): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Expected runtime event timed out.")); }, timeoutMs);
    const unsubscribe = session.subscribe((event) => {
      if (predicate(event)) { clearTimeout(timer); unsubscribe(); resolve(event); }
    });
  });
}

const answered = (text: string) => (entries: TranscriptEntry[]) =>
  entries.some((entry) => entry.kind === "message" && entry.role === "assistant" && entry.text.includes(text));

const answers = (entries: TranscriptEntry[]) => entries.filter((entry) => entry.kind === "message" && entry.role === "assistant").length;

/** Sends each prompt once the previous one is answered and settled. */
async function turns(session: DurableSession, prompts: readonly string[]): Promise<void> {
  for (const text of prompts) {
    const before = answers(session.transcript());
    await session.prompt(text);
    await transcriptWhere(session, (entries) => answers(entries) > before && !session.isStreaming);
  }
}

/** A short transcript outline: user prompts by their first word, then roles and markers. */
const outline = (entries: TranscriptEntry[]) => entries.flatMap((entry) =>
  entry.kind === "message" ? [entry.role === "user" ? `user:${entry.text.split(" ")[0]}` : "assistant"]
    : entry.kind === "compaction" ? ["compaction"] : []);

function userEntryId(session: DurableSession, prefix: string): string {
  const entry = session.transcript().find((item) => item.kind === "message" && item.role === "user" && item.text.startsWith(prefix));
  assert(entry?.kind === "message" && entry.entryId, `no stored user message ${prefix}`);
  return entry.entryId;
}

type ProviderRequest = { system?: unknown; messages?: unknown; speed?: unknown };
async function providerRequests(log: string): Promise<ProviderRequest[]> {
  return completeLines(await readFile(log, "utf8")).map((line) => JSON.parse(line) as ProviderRequest);
}
const summarizing = (request: ProviderRequest) => JSON.stringify(request.system ?? "").includes("context summarization assistant");
/** The messages of the newest model request that was not a summary. */
async function lastTurnRequest(log: string): Promise<string> {
  return JSON.stringify((await providerRequests(log)).filter((request) => !summarizing(request)).at(-1)?.messages);
}

/** Short turns have something to summarize; the window is large enough that Durable never compacts by itself. */
const KEPT_WINDOW = { contextWindow: 200_000, settings: { compaction: { keepRecentTokens: 40 } } };
const LONG_TURN = `COMPACT_THREE ${"kept ".repeat(400)}`;

/** Runs a manual compaction to its end and returns what it reported. */
async function compacted(session: DurableSession, instructions?: string): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const unsubscribe = session.subscribe((event) => { if (event.type.startsWith("compaction") || event.type === "settled") events.push(event); });
  const ended = nextEvent(session, (event) => event.type === "compaction_end");
  await session.compact(instructions);
  await ended;
  unsubscribe();
  return events;
}

/** Two turns that leave Durable a background compaction whose summary the provider holds. */
async function heldBackgroundCompaction(t: TestContext) {
  // A 32k window puts Durable's background threshold (32,768 below `contextWindow - reserveTokens`) under zero.
  const f = await fixture(t, { contextWindow: 32_000, settings: { compaction: { keepRecentTokens: 40 } } });
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-background" }, host);
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => { if (event.type.startsWith("compaction")) events.push(event); });
  await turns(session, ["E2E_SLOW_COMPACT first turn", `AUTO_TWO ${"kept ".repeat(400)}`]);
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200, "the background summary request is held");
  return { f, host, session, events };
}

test("resume references round-trip Durable's integer conversation IDs only", () => {
  const id = 42 as never;
  assert.equal(durableReference(id), "durable:42");
  assert.equal(durableConversationId("durable:42"), 42);
  for (const reference of [undefined, "/home/me/.pi/session.jsonl", "durable:", "durable:4x", "durable:-1"]) {
    assert.equal(durableConversationId(reference), undefined, String(reference));
  }
});

test("a host whose bots were never configured refuses to open its store, so no conversation runs without bot policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-durable-unconfigured-"));
  const host = new DurableHost({ dir: join(dir, "store"), agentDir: dir, resume: false });
  await assert.rejects(host.open(), /before its bots were configured/u);
  assert.equal(existsSync(join(dir, "store")), false);
  await rm(dir, { recursive: true, force: true });
});

test("the live view streams an answer Durable sends whole, exactly once", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-whole-answer" }, f.host());
  const streamed: string[] = [];
  session.subscribe((event) => { if (event.type === "text") streamed.push(event.delta); });
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("hello there");
  await settled;
  // The fixture's short reply reaches Durable's stream as one partial; the live view shows it from these events.
  assert.equal(streamed.join(""), "Fixture response.");
  await transcriptWhere(session, answered("Fixture response."));
});

test("fast mode asks a Claude Opus model for speed: fast, while the session has it on", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t, { models: ["fixture", "claude-opus-5-5"] });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-fast", model: "hui-e2e/claude-opus-5-5" }, f.host());
  assert.equal(session.currentModel()?.fast, true);
  assert.deepEqual(session.currentModel()?.thinkingLevels, ["off", "minimal", "low", "medium", "high", "ultra"]);
  assert.equal(session.currentFast(), false);
  const speeds = async () => (await providerRequests(f.log)).map((request) => request.speed ?? "standard");

  await session.setFast(true);
  assert.equal(session.currentFast(), true);
  await turns(session, ["hello fast"]);
  assert.deepEqual(await speeds(), ["fast"]);
  // A model without fast mode is asked for nothing, though the session keeps it on.
  await session.setModel("hui-e2e", "fixture");
  await turns(session, ["hello fixture"]);
  await session.setModel("hui-e2e", "claude-opus-5-5");
  await session.setFast(false);
  await turns(session, ["hello standard"]);
  assert.deepEqual(await speeds(), ["fast", "standard", "standard"]);
});

test("a switch to a model without the chosen thinking level lowers it for that model only", { timeout: 45_000 }, async (t) => {
  const max = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  const f = await fixture(t, { models: ["fixture", "claude-opus-5-5"], thinkingLevelMaps: { "claude-opus-5-5": max } });
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-fit", model: "hui-e2e/claude-opus-5-5" }, host);
  assert.deepEqual(session.currentModel()?.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  await session.setThinking("max");
  await session.setModel("hui-e2e", "fixture");
  assert.equal(session.currentThinking(), "high");
  await session.setModel("hui-e2e", "claude-opus-5-5");
  assert.equal(session.currentThinking(), "max");

  // A level chosen at creation that the first model lacks comes back the same way.
  const created = await startDurable({ cwd: f.cwd, huiSessionId: "durable-fit-new", model: "hui-e2e/fixture", thinking: "max" }, host);
  assert.equal(created.currentThinking(), "high");
  await created.setModel("hui-e2e", "claude-opus-5-5");
  assert.equal(created.currentThinking(), "max");
});

test("Ultra sends the model its highest level and asks the agent to plan, decide, delegate and verify, until it is turned off", { timeout: 45_000 }, async (t) => {
  const max = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  const f = await fixture(t, { models: ["claude-opus-5-5"], thinkingLevelMaps: { "claude-opus-5-5": max } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-ultra", model: "hui-e2e/claude-opus-5-5" }, f.host());
  assert.equal(session.currentModel()?.thinkingLevels?.at(-1), "ultra");
  const ultraPrompt = async () => JSON.stringify((await providerRequests(f.log)).filter((request) => !summarizing(request)).at(-1)?.system);

  await session.setThinking("ultra");
  assert.deepEqual([session.currentThinking(), session.modelThinking()], ["ultra", "max"]);
  await turns(session, ["hello ultra"]);
  assert.match(await ultraPrompt(), /Proactive Sub-Agent Orchestration[^"]*Ultra active for this session[^"]*Ask only before actions that are hard to undo[^"]*sessions_spawn/u);

  await session.setThinking("high");
  assert.deepEqual([session.currentThinking(), session.modelThinking()], ["high", "high"]);
  await turns(session, ["hello high"]);
  assert.doesNotMatch(await ultraPrompt(), /Ultra active/u);
});

test("Durable runs a real tool turn and reopens the conversation from its store", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-rich" }, host);
  assert.match(session.sessionFile, /^durable:\d+$/u);
  assert.equal(session.currentModel()?.id, "fixture");
  assert.equal(session.currentThinking(), "high");
  const settled = nextEvent(session, (event) => event.type === "settled");
  const tools: string[] = [];
  session.subscribe((event) => { if (event.type === "tool_end") tools.push(`${event.name}:${event.failed ? "failed" : "ok"}`); });
  await session.prompt("E2E_RICH read the fixture");
  assert.equal(session.isStreaming, true);
  await settled;
  assert.equal(session.isStreaming, false);
  assert.deepEqual(tools, ["read:ok"]);
  const live = await transcriptWhere(session, answered("Tool complete"));
  const shape = live.map((entry) => entry.kind === "message" ? entry.role : entry.kind).filter((kind) => kind !== "thinking");
  assert.deepEqual(shape, ["user", "tool", "assistant"]);
  const read = live.find((entry) => entry.kind === "tool");
  assert(read?.kind === "tool" && read.name === "read" && read.failed === false, JSON.stringify(read));
  const requests = completeLines(await readFile(f.log, "utf8")).map((line) => JSON.parse(line) as { system?: unknown });
  const system = JSON.stringify(requests[0]!.system);
  assert.match(system, /You are the coding assistant in HUI/u, "HUI's default preamble");
  assert.match(system, /hui_tools/u, "HUI's active-tool section");
  assert.match(system, new RegExp(f.cwd.replaceAll("/", "\\/"), "u"), "the working directory");

  const reference = session.sessionFile;
  session.dispose();
  await host.close();
  const reopened = await startDurable({ cwd: f.cwd, sessionFile: reference }, f.host());
  assert.equal(reopened.sessionFile, reference);
  const withoutMetrics = (entries: TranscriptEntry[]) => entries.map(({ metrics: _metrics, ...entry }) => entry);
  assert.deepEqual(withoutMetrics(reopened.transcript()), withoutMetrics(live), "the reopened transcript is the stored one");
});

test("tracked inputs deduplicate handlers and inbox admission, then recover their own answer after reattach and reopen", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, { extensions: { "tracked.js": `
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    export default function (pi) {
      pi.on('input', (event, ctx) => { appendFileSync(join(ctx.cwd, 'tracked-inputs.log'), event.text + '\\n'); });
    }
  ` } });
  const host = f.host();
  const first = await startDurable({ cwd: f.cwd, huiSessionId: "tracked-routine" }, host);
  const input = "E2E_COMMAND_RUNNING tracked routine";
  const request = { requestId: "automation-run-1" };
  await Promise.all([first.prompt(input, undefined, request), first.prompt(input, undefined, request)]);
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200);
  const queueUpdate = nextEvent(first, (event) => event.type === "queue_update" && event.queue.followUp.length === 1);
  await Promise.all([
    first.followUp("queued routine", undefined, { requestId: "automation-run-2" }),
    first.followUp("queued routine", undefined, { requestId: "automation-run-2" }),
  ]);
  const queued = await queueUpdate;
  assert(queued.type === "queue_update");
  assert.deepEqual(queued.queue.followUp, ["queued routine"], "the duplicate identity admitted one durable inbox item");
  await first.cancelTrackedPrompt("automation-run-2");
  await assert.rejects(first.waitForTrackedPrompt("automation-run-2"), /not answered/u);
  assert.equal(first.isStreaming, true, "withdrawing a queued receipt leaves the active unrelated routine running");
  assert.deepEqual((await readFile(join(f.cwd, "tracked-inputs.log"), "utf8")).trim().split("\n"), [input, "queued routine"], "deduplication happens before input handlers too");

  const reference = first.sessionFile;
  first.dispose();
  const reattached = await startDurable({ cwd: f.cwd, sessionFile: reference, huiSessionId: "tracked-routine" }, host);
  const recovering = reattached.waitForTrackedPrompt(request.requestId);
  await f.control("/control/release-replay", "POST");
  const original = await recovering;
  assert.match(original.summary ?? "", /Tool complete/u);
  await transcriptWhere(reattached, (entries) => answered("Tool complete")(entries) && !reattached.isStreaming);
  await turns(reattached, ["An unrelated later question"]);
  assert.deepEqual(await reattached.waitForTrackedPrompt(request.requestId), original, "a later reply cannot replace the receipt's answer");
  const before = await readFile(join(f.cwd, "tracked-inputs.log"), "utf8");
  const requestsBeforeRetry = await readFile(f.log, "utf8");
  await reattached.prompt(input, undefined, request);
  assert.equal(await readFile(join(f.cwd, "tracked-inputs.log"), "utf8"), before, "a completed retry does not run hooks");
  reattached.dispose();
  await host.close();
  const reopened = await startDurable({ cwd: f.cwd, sessionFile: reference, huiSessionId: "tracked-routine" }, f.host());
  assert.deepEqual(await reopened.waitForTrackedPrompt(request.requestId), original);
  await reopened.prompt(input, undefined, request);
  assert.equal(reopened.transcript().filter((entry) => entry.kind === "message" && entry.role === "user" && entry.text === input).length, 1);
  assert.equal(await readFile(f.log, "utf8"), requestsBeforeRetry, "reacquiring and retrying the same receipt sends no new model requests");
  assert.equal(reopened.transcript().filter((entry) => entry.kind === "tool" && entry.name === "bash").length, 1, "the original command is the only bash invocation");
  await assert.rejects(reopened.waitForTrackedPrompt("not-admitted"), /could not be found/u);
});

test("cancelling a placed tracked input aborts its task, and cancelling it again cannot stop a later turn", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "tracked-cancel" }, f.host());
  await session.prompt("E2E_COMMAND_RUNNING tracked cancellation", undefined, { requestId: "cancel-me" });
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200);
  await session.cancelTrackedPrompt("cancel-me");
  await assert.rejects(session.waitForTrackedPrompt("cancel-me"), /not answered/u);
  await transcriptWhere(session, () => !session.isStreaming);
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("Later unrelated question", undefined, { requestId: "keep-running" });
  await session.cancelTrackedPrompt("cancel-me");
  assert.match((await session.waitForTrackedPrompt("keep-running")).summary ?? "", /Fixture response/u);
  await settled;
});

test("a provider retry is announced as a recovery notice", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t, { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-retry-notice" }, f.host());
  const notified = nextEvent(session, (event) => event.type === "notice");
  await session.prompt("E2E_ERROR retried");
  const notice = await notified;
  assert(notice.type === "notice" && notice.level === "warning" && notice.recovery === true, JSON.stringify(notice));
});

test("a skill turned off in HUI is refused with a notice and never reaches the model", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const skill = join(f.agentDir, "skills", "review", "SKILL.md");
  await mkdir(join(f.agentDir, "skills", "review"), { recursive: true });
  await writeFile(skill, "---\nname: review\ndescription: Review fixture skill.\n---\nReview body.\n");
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-disabled-skill" }, f.host({ huiSettings: normalizeSettings({ disabledSkills: [{ name: "review", path: skill }] }) }));
  const notified = nextEvent(session, (event) => event.type === "notice");
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("/skill:review now");
  assert.deepEqual(await notified, { type: "notice", level: "warning", message: "Skill “review” is disabled for HUI sessions." });
  await settled;
  const aliased = nextEvent(session, (event) => event.type === "notice");
  await session.prompt("$review now");
  assert.deepEqual(await aliased, { type: "notice", level: "warning", message: "Skill “review” is disabled for HUI sessions." }, "the composer's $name form too");
  assert.equal(session.isStreaming, false);
  assert.deepEqual(session.transcript(), [], "nothing reached the model");
});

test("a skill of the same name from another folder stays usable when only one of them is turned off", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "skills", "review"), { recursive: true });
  await writeFile(join(f.agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review fixture skill.\n---\nReview body.\n");
  const elsewhere = join(f.cwd, "elsewhere", "review", "SKILL.md");
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-same-name-skill" }, f.host({ huiSettings: normalizeSettings({ disabledSkills: [{ name: "review", path: elsewhere }] }) }));
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("/skill:review now");
  await settled;
  assert.ok(session.transcript().some((entry) => entry.kind === "message" && entry.role === "user"), "the enabled review ran");
});

test("a bundled skill turned off in HUI is refused with a notice", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const visualizeOff = normalizeSettings({ disabledSkills: [{ name: "visualize", path: "hui:skill:visualize" }] });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-disabled-bundled-skill" }, f.host({ huiSettings: visualizeOff }));
  for (const text of ["/skill:visualize now", "$visualize now"]) {
    const notified = nextEvent(session, (event) => event.type === "notice");
    await session.prompt(text);
    assert.deepEqual(await notified, { type: "notice", level: "warning", message: "Skill “visualize” is disabled for HUI sessions." }, text);
  }
  assert.deepEqual(session.transcript(), [], "nothing reached the model");
});

test("a skill named like a bundled one turned off in HUI stays usable", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "skills", "visualize"), { recursive: true });
  await writeFile(join(f.agentDir, "skills", "visualize", "SKILL.md"), "---\nname: visualize\ndescription: Local visualize skill.\n---\nLocal body.\n");
  const visualizeOff = normalizeSettings({ disabledSkills: [{ name: "visualize", path: "hui:skill:visualize" }] });
  const replaced = await startDurable({ cwd: f.cwd, huiSessionId: "durable-replaced-bundled-skill" }, f.host({ huiSettings: visualizeOff }));
  const settled = nextEvent(replaced, (event) => event.type === "settled");
  await replaced.prompt("/skill:visualize now");
  await settled;
  assert.ok(replaced.transcript().some((entry) => entry.kind === "message" && entry.role === "user"), "the local visualize ran");
});

test("a tracked provider failure retains its original diagnostic for routine failure classification", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t, { settings: { retry: { enabled: false } } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "tracked-model-error" }, f.host());
  await session.prompt("E2E_ERROR tracked failure", undefined, { requestId: "failed-model-request" });
  await assert.rejects(session.waitForTrackedPrompt("failed-model-request"), /model_error: .*fixture provider error/u);
});

test("a gateway killed mid-tool resumes the run without replaying bash", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const hostUrl = new URL("./durable-host.ts", import.meta.url).href;
  const durableUrl = new URL("./durable.ts", import.meta.url).href;
  const settingsUrl = new URL("../hui-settings.ts", import.meta.url).href;
  // A separate process owns the store and is SIGKILLed while bash is running.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { DurableHost } = await import(${JSON.stringify(hostUrl)});
    const { startDurable } = await import(${JSON.stringify(durableUrl)});
    const { normalizeSettings } = await import(${JSON.stringify(settingsUrl)});
    const host = new DurableHost({ dir: ${JSON.stringify(f.store)}, agentDir: ${JSON.stringify(f.agentDir)},
      readSettings: async () => normalizeSettings(undefined), invokeTool: async () => ({}), lookupCaller: async () => undefined });
    host.configureDurableBots(null);
    const session = await startDurable({ cwd: ${JSON.stringify(f.cwd)}, huiSessionId: "crash" }, host);
    process.stdout.write("REF " + session.sessionFile + "\\n");
    await session.prompt("E2E_COMMAND_RUNNING hold the command", undefined, { requestId: "routine-crash" });
  `], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  f.children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const [line] = await once(child.stdout!, "data");
  const reference = /REF (durable:\d+)/u.exec(String(line))?.[1];
  assert(reference, `${String(line)}${stderr}`);
  const waiting = await f.control("/control/wait-replay-ready");
  assert.equal(waiting.status, 200, "bash is running the held command");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;

  // A new gateway opens the same store; the harness resumes the run by itself.
  const session = await startDurable({ cwd: f.cwd, sessionFile: reference }, f.host());
  assert.match((await session.waitForTrackedPrompt("routine-crash")).summary ?? "", /Tool complete/u, "the same accepted input's receipt survives SIGKILL");
  const entries = await transcriptWhere(session, answered("Tool complete"));
  const tool = entries.find((entry) => entry.kind === "tool");
  assert(tool && tool.kind === "tool" && tool.name === "bash", JSON.stringify(entries));
  assert.equal(tool.failed, true);
  assert.match(tool.output ?? "", /interrupted/u, "the model is told the call was interrupted");
  assert.equal(entries.filter((entry) => entry.kind === "message" && entry.role === "user").length, 1, "no synthetic recovery prompt");
  const replays = (await readFile(f.log, "utf8")).split("wait-command").length - 1;
  assert.equal(replays, 1, "bash was not re-run after the restart");
});

test("steering and follow-ups queue in the Durable inbox while a tool runs", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-queue" }, host);
  await session.prompt("E2E_COMMAND_RUNNING hold the command");
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200);
  assert.equal(await host.busy(), true, "a running turn keeps a worker host up");
  const queued = nextEvent(session, (event) => event.type === "queue_update" && event.queue.followUp.length === 1);
  await session.steer("Steer note for the running turn");
  await session.followUp("Follow-up note for later");
  await queued;
  assert.deepEqual(session.pendingQueue(), { steering: ["Steer note for the running turn"], followUp: ["Follow-up note for later"] });
  await f.control("/control/release-replay", "POST");
  const entries = await transcriptWhere(session, (items) =>
    items.filter((entry) => entry.kind === "message" && entry.role === "user").length === 3 && !session.isStreaming
    && items.at(-1)?.kind === "message" && (items.at(-1) as { role: string }).role === "assistant");
  const users = entries.flatMap((entry) => entry.kind === "message" && entry.role === "user" ? [entry.text] : []);
  assert.deepEqual(users, ["E2E_COMMAND_RUNNING hold the command", "Steer note for the running turn", "Follow-up note for later"]);
  assert.deepEqual(session.pendingQueue(), { steering: [], followUp: [] });
  assert.equal(await host.busy(), false, "an open store with nothing to run lets a worker host stop");
});

test("HUI tools reach the gateway handler as the bound session, never a model-chosen one", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-tools" }, f.host());
  await session.prompt("E2E_SUGGEST_TASK");
  await transcriptWhere(session, answered("I flagged two follow-ups"));
  assert.deepEqual(f.invocations.map((invocation) => [invocation.callerSessionId, invocation.action]), [
    ["durable-tools", "suggest_task"], ["durable-tools", "suggest_task"],
  ]);
  assert.equal(f.invocations[0]!.params["title"], "Replace native terminal switcher select with HUI picker");
});

test("secret_request keeps the value out of the store and the model, and Stop cancels a pending one", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const changed: Array<() => void> = [];
  const requests = new SecretRequests({ onChange: () => { for (const wake of changed.splice(0)) wake(); } });
  const files = new SecretFiles(f.dir);
  t.onTestFinished(() => { requests.dispose(); files.dispose(); });
  const pending = async (count: number) => {
    while (requests.questions("durable-secret").length !== count) await new Promise<void>((wake) => changed.push(wake));
    return requests.questions("durable-secret");
  };
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-secret" }, f.host({
    invokeTool: async ({ callerSessionId, action, params, signal }) => action === "secret_request" ? files.deliver(await requests.request(callerSessionId, params, signal)) : { ok: true },
  }));
  await session.prompt("E2E_SECRET_REQUEST");
  const [question] = await pending(1);
  requests.answer("durable-secret", question!.id, { value: "sk-fixture-0123456789" });
  const entries = await transcriptWhere(session, (items) => answered("used the secret in a command without seeing it")(items) && !session.isStreaming);
  assert.match(JSON.stringify(entries), /Secret length: 21/u, "the agent's next command read the file");
  const stored = await Promise.all((await readdir(f.store, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), "latin1")));
  assert(stored.some((text) => text.includes("Fixture API key")), "the store keeps the request itself");
  for (const text of [JSON.stringify(entries), await readFile(f.log, "utf8"), ...stored]) {
    assert(!text.includes("sk-fixture"), "neither the store nor the model ever holds the value");
  }

  await session.prompt("E2E_SECRET_REQUEST again");
  await pending(1);
  await session.abort();
  await pending(0);
});

test("rewinding forks the conversation and keeps the abandoned branch", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-rewind" }, host);
  await session.prompt("E2E_RICH read the fixture");
  await transcriptWhere(session, (entries) => answered("Tool complete")(entries) && !session.isStreaming);
  const original = session.sessionFile;
  const user = session.transcript().find((entry) => entry.kind === "message" && entry.role === "user");
  assert(user?.kind === "message" && user.entryId, "history messages carry their Durable entry ID");
  await session.rewind(user.entryId, { excludeUserMessage: true });
  assert.notEqual(session.sessionFile, original, "a fork is a new conversation");
  assert.deepEqual(session.transcript(), []);
  await session.prompt("Second branch");
  await transcriptWhere(session, (entries) => entries.some((entry) => entry.kind === "message" && entry.role === "user" && entry.text === "Second branch") && !session.isStreaming);
  session.dispose();
  const kept = await startDurable({ cwd: f.cwd, sessionFile: original }, host);
  assert(answered("Tool complete")(kept.transcript()), "the abandoned branch is still stored");
});

test("a fork copies the history up to a reply into a new conversation and leaves the source untouched", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-fork-source" }, host);
  await turns(session, ["FORK_ONE first turn", "FORK_TWO second turn"]);
  const messages = (entries: TranscriptEntry[]) => entries.flatMap((entry) => entry.kind === "message" ? [`${entry.role}:${entry.text}`] : []);
  const before = session.transcript();
  const firstAnswer = before.find((entry) => entry.kind === "message" && entry.role === "assistant");
  assert(firstAnswer?.kind === "message" && firstAnswer.entryId, "replies carry their Durable entry ID");

  const reference = await session.fork(firstAnswer.entryId);
  assert(durableConversationId(reference), reference);
  assert.notEqual(reference, session.sessionFile, "the copy is a conversation of its own");
  assert.deepEqual(session.transcript(), before, "the source keeps its whole history");
  const copy = await startDurable({ cwd: f.cwd, sessionFile: reference, huiSessionId: "durable-fork-copy" }, host);
  assert.deepEqual(messages(copy.transcript()), messages(before).slice(0, 2), "the copy ends at the reply it was forked from");
  await turns(copy, ["FORK_THREE in the copy"]);
  const context = await lastTurnRequest(f.log);
  assert.match(context, /FORK_ONE/u, "the model reads the copied history");
  assert.doesNotMatch(context, /FORK_TWO/u, "nothing after the fork point reaches the copy");
  assert.deepEqual(messages(session.transcript()), messages(before), "the copy's turn stays out of the source");

  const latest = await startDurable({ cwd: f.cwd, sessionFile: await session.fork(), huiSessionId: "durable-fork-latest" }, host);
  assert.deepEqual(messages(latest.transcript()), messages(before), "without an entry the fork copies everything");
  await assert.rejects(session.fork("missing-entry"), /no longer available/u);

  // A fork into a worktree moves the copy's agent there; the source keeps its directory.
  const elsewhere = join(f.cwd, "..", "worktree");
  await mkdir(elsewhere);
  const moved = durableConversationId(await session.fork(firstAnswer.entryId, { cwd: elsewhere }))!;
  const harness = await host.open();
  assert.equal((await (await harness.conversation(moved, durableContext))!.agent(durableContext)).cwd, elsewhere);
  assert.equal((await (await harness.conversation(durableConversationId(session.sessionFile)!, durableContext))!.agent(durableContext)).cwd, f.cwd);
});

test("Durable compaction keeps the whole history and marks where it summarized", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, KEPT_WINDOW);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-compact" }, host);
  await turns(session, ["COMPACT_ONE first turn", "COMPACT_TWO second turn", LONG_TURN]);
  const before = session.transcript();
  const sizeBefore = session.currentUsage()!.contextTokens!;

  const events = await compacted(session, "keep the API decisions");
  assert.deepEqual(events.map((event) => event.type === "compaction_end" ? `end:${event.reason}:${event.outcome}`
    : event.type === "compaction_start" ? `start:${event.reason}` : event.type), ["start:manual", "end:manual:done"], "no settle: nothing ran");
  assert.deepEqual(events[0], { type: "compaction_start", reason: "manual", blocking: false }, "Durable runs it beside the conversation");
  const after = session.transcript();
  const withoutMetrics = (entries: TranscriptEntry[]) => entries.map(({ metrics: _metrics, ...entry }) => entry);
  assert.deepEqual(withoutMetrics(after.slice(0, before.length)), withoutMetrics(before), "no earlier message disappears");
  const marker = after.at(-1);
  assert(marker?.kind === "compaction", JSON.stringify(after.at(-1)));
  assert.equal(marker.summary, "FIXTURE_SUMMARY", "the summary without Durable's wrapper");
  // Durable's own estimate, as the context meter showed it just before (the fixture reports tiny usage, so the
  // summary plus the kept 2,000-character turn is not smaller than that here).
  assert.equal(marker.tokensBefore, sizeBefore, "the divider shows the size Durable summarized");
  const summary = (await providerRequests(f.log)).find(summarizing);
  assert.match(JSON.stringify(summary), /Additional focus: keep the API decisions/u);

  const reference = session.sessionFile;
  session.dispose();
  await host.close();
  const reopened = await startDurable({ cwd: f.cwd, sessionFile: reference }, f.host());
  assert.deepEqual(withoutMetrics(reopened.transcript()), withoutMetrics(after), "the marker and history are stored");
  await turns(reopened, ["AFTER_COMPACTION"]);
  const context = await lastTurnRequest(f.log);
  assert.match(context, /FIXTURE_SUMMARY/u);
  assert.match(context, /COMPACT_THREE/u, "the kept window stays verbatim");
  assert.doesNotMatch(context, /COMPACT_ONE|COMPACT_TWO/u, "summarized turns leave the model context");
});

test("a summary on a model that thinks from its output cap gets the model's whole cap", { timeout: 60_000 }, async (t) => {
  // Durable would cap the summary at 0.8 × 1,000 tokens; adaptive thinking spends from that cap too.
  const f = await fixture(t, { contextWindow: 200_000, settings: { compaction: { keepRecentTokens: 40, reserveTokens: 1_000 } } });
  const models = JSON.parse(await readFile(join(f.agentDir, "models.json"), "utf8"));
  for (const model of models.providers["hui-e2e"].models) model.compat = { forceAdaptiveThinking: true };
  await writeFile(join(f.agentDir, "models.json"), JSON.stringify(models));
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-summary-cap" }, f.host());
  await turns(session, ["COMPACT_ONE first turn", "COMPACT_TWO second turn", LONG_TURN]);
  const end = (await compacted(session)).find((event) => event.type === "compaction_end");
  assert(end?.type === "compaction_end" && end.outcome === "done", JSON.stringify(end));
  const summary = (await providerRequests(f.log)).find(summarizing) as { max_tokens?: number; output_config?: unknown };
  assert.deepEqual([summary.max_tokens, summary.output_config], [4096, { effort: "high" }]);
});

test("the context meter is Durable's own estimate, system prompt included", { timeout: 60_000 }, async (t) => {
  // A failed answer is no measurement, so right after it Durable estimates the whole context: the summary, the kept
  // turn, the system baseline it rewrote after the summary and the new prompt.
  const f = await fixture(t, { ...KEPT_WINDOW, settings: { ...KEPT_WINDOW.settings, retry: { enabled: false } } });
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-meter" }, host);
  await turns(session, ["COMPACT_ONE first turn", "COMPACT_TWO second turn", LONG_TURN]);
  await compacted(session);
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("E2E_ERROR after the summary");
  await settled;
  const conversation = await (await host.open()).conversation(durableConversationId(session.sessionFile)!, durableContext);
  let view = await conversation!.context(durableContext);
  assert(view.messages.some((message) => message.role === "system"), "Durable re-baselined its system prompt");
  assert.equal(session.currentUsage()?.contextTokens, estimateContext(view, []), "unmeasured: estimates of the whole context");
  // An answered request after the summary measures the context; what follows it is estimated.
  await turns(session, ["AFTER_ERROR answered"]);
  view = await conversation!.context(durableContext);
  assert.equal(session.currentUsage()?.contextTokens, estimateContext(view, []), "measured by the newest answer");
});

test("a requested compaction with nothing old enough to summarize says so", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-small" }, f.host());
  await turns(session, ["Only turn"]);
  const events = await compacted(session);
  const end = events.find((event) => event.type === "compaction_end");
  assert(end?.type === "compaction_end");
  assert.deepEqual({ outcome: end.outcome, message: end.message }, { outcome: "failed", message: "Nothing to compact (session too small)" });
  assert.equal(session.transcript().some((entry) => entry.kind === "compaction"), false);
});

test("a prompt sent while Durable compacts runs at once, and the summary lands where Durable places it", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, KEPT_WINDOW);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-compact-prompt" }, f.host());
  await turns(session, ["E2E_SLOW_COMPACT first turn", LONG_TURN]);
  const ended = nextEvent(session, (event) => event.type === "compaction_end");
  await session.compact();
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200, "the summary request is held");

  await turns(session, ["WHILE_COMPACTING sent meanwhile"]);
  let context = await lastTurnRequest(f.log);
  assert.match(context, /WHILE_COMPACTING/u, "answered while the summary is still held");
  assert.match(context, /E2E_SLOW_COMPACT first turn/u, "from the whole history: there is no summary yet");
  assert.doesNotMatch(context, /FIXTURE_SUMMARY/u);

  await f.control("/control/release-replay", "POST");
  const end = await ended;
  assert(end.type === "compaction_end" && end.outcome === "done", JSON.stringify(end));
  assert.deepEqual(outline(session.transcript()), [
    "user:E2E_SLOW_COMPACT", "assistant", "user:COMPACT_THREE", "assistant", "user:WHILE_COMPACTING", "assistant", "compaction",
  ], "placed after the turn answered meanwhile");
  await turns(session, ["AFTER_SUMMARY"]);
  context = await lastTurnRequest(f.log);
  assert.match(context, /FIXTURE_SUMMARY/u);
  assert.match(context, /WHILE_COMPACTING/u, "the turn after the cut stays verbatim");
  assert.doesNotMatch(context, /E2E_SLOW_COMPACT first turn/u, "the summarized turn leaves the model context");
});

test("Stop cancels a manual compaction, as Durable's own abort does; a new view sees it running", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t, KEPT_WINDOW);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-cancel" }, host);
  await turns(session, ["E2E_SLOW_COMPACT first turn", LONG_TURN]);
  const ended = nextEvent(session, (event) => event.type === "compaction_end");
  await session.compact();
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200, "the summary request is held");

  // A browser reopening the session meanwhile is told a compaction is running.
  const second = await startDurable({ cwd: f.cwd, sessionFile: session.sessionFile }, host);
  const replayed: RuntimeEvent[] = [];
  second.subscribe((event) => replayed.push(event));
  assert.deepEqual(replayed, [{ type: "compaction_start", reason: "manual", blocking: false }]);
  second.dispose();

  await session.abort();
  const end = await ended;
  assert(end.type === "compaction_end" && end.outcome === "cancelled", JSON.stringify(end));
  assert.equal(session.isStreaming, false, "Stop resolves once the compaction has ended");
  assert.equal(session.transcript().some((entry) => entry.kind === "compaction"), false, "no summary is written");
});

test("cancelling a manual compaction stops only it, and the session carries on", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t, KEPT_WINDOW);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-cancel-alone" }, f.host());
  await turns(session, ["E2E_SLOW_COMPACT first turn", LONG_TURN]);
  const ended = nextEvent(session, (event) => event.type === "compaction_end");
  await session.compact();
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200, "the summary request is held");
  await session.cancelCompaction();
  const end = await ended;
  assert(end.type === "compaction_end" && end.outcome === "cancelled", JSON.stringify(end));
  await turns(session, ["AFTER_CANCEL"]);
  assert.deepEqual(outline(session.transcript()).slice(-2), ["user:AFTER_CANCEL", "assistant"]);
  assert.equal(session.transcript().some((entry) => entry.kind === "compaction"), false, "no summary is written");
});

test("cancelling right after starting reaches a compaction the stream has not listed yet", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t, KEPT_WINDOW);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-cancel-early" }, host);
  await turns(session, ["E2E_SLOW_COMPACT first turn", LONG_TURN]);
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => { if (event.type.startsWith("compaction")) events.push(event); });
  await session.compact();
  await session.cancelCompaction();
  const ends = events.filter((event) => event.type === "compaction_end");
  assert.deepEqual(ends.map((event) => event.type === "compaction_end" && event.outcome), ["cancelled"], "one end, reported before Cancel returns");
  assert.equal(events.at(-1)?.type, "compaction_end", "nothing reports it running afterwards");

  const second = await startDurable({ cwd: f.cwd, sessionFile: session.sessionFile }, host);
  const replayed: RuntimeEvent[] = [];
  second.subscribe((event) => replayed.push(event));
  assert.deepEqual(replayed, [], "Durable lists no compaction");
  second.dispose();
  await turns(session, ["AFTER_EARLY_CANCEL"]);
  assert.equal(session.transcript().some((entry) => entry.kind === "compaction"), false);
  assert.equal(events.filter((event) => event.type === "compaction_end").length, 1, "its listing and end are not reported again");
});

test("a background compaction leaves the session idle and survives Stop", { timeout: 60_000 }, async (t) => {
  const { f, host, session, events } = await heldBackgroundCompaction(t);
  assert.deepEqual(events, [{ type: "compaction_start", reason: "threshold", blocking: false, background: true }]);
  assert.equal(session.isStreaming, false, "the run ended; Durable compacts beside the idle conversation");
  assert.equal(await host.busy(), false, "a background compaction resumes later; it does not keep a worker host up");

  await session.abort();
  await session.cancelCompaction();
  assert.equal(events.some((event) => event.type === "compaction_end"), false, "Stop and Cancel leave background work running");

  const ended = nextEvent(session, (event) => event.type === "compaction_end");
  await f.control("/control/release-replay", "POST");
  const end = await ended;
  assert(end.type === "compaction_end" && end.outcome === "done", JSON.stringify(end));
  assert.equal(session.transcript().at(-1)?.kind, "compaction", "the history holds the summary when its end is reported");
});

test("clearing during a background compaction drops its summary, as Durable makes it stale", { timeout: 60_000 }, async (t) => {
  const { f, host, session, events } = await heldBackgroundCompaction(t);
  await session.clear();
  assert.deepEqual(session.transcript(), []);
  // A second view still sees Durable's compaction run, and reports when it ends.
  const second = await startDurable({ cwd: f.cwd, sessionFile: session.sessionFile }, host);
  const secondEnded = nextEvent(second, (event) => event.type === "compaction_end");
  await f.control("/control/release-replay", "POST");
  await secondEnded;
  second.dispose();
  assert.deepEqual(events.filter((event) => event.type === "compaction_end"), [], "the stale compaction's end is not reported");
  await turns(session, ["AFTER_CLEAR"]);
  assert.deepEqual(outline(session.transcript()), ["user:AFTER_CLEAR", "assistant"]);
  assert.doesNotMatch(await lastTurnRequest(f.log), /FIXTURE_SUMMARY|E2E_SLOW_COMPACT/u);
});

test("a rewind forks Durable's history as it was, without a summary placed later", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, KEPT_WINDOW);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-rewind-compaction" }, f.host());
  await turns(session, ["COMPACT_ONE first turn", "COMPACT_TWO second turn", LONG_TURN]);
  await compacted(session);

  // Even inside the summary's kept window, the fork holds only the history up to it, so the model rereads the
  // original turns; Durable compacts the fork again when it needs to.
  await session.rewind(userEntryId(session, "COMPACT_THREE"), { excludeUserMessage: true });
  assert.deepEqual(outline(session.transcript()), ["user:COMPACT_ONE", "assistant", "user:COMPACT_TWO", "assistant"]);
  await turns(session, ["AFTER_FORK"]);
  const context = await lastTurnRequest(f.log);
  assert.match(context, /COMPACT_ONE/u);
  assert.match(context, /COMPACT_TWO/u);
  assert.doesNotMatch(context, /FIXTURE_SUMMARY|COMPACT_THREE/u);

  // A prompt the browser shows without an entry ID is counted from the end.
  await session.rewind({ userFromEnd: 0 }, { excludeUserMessage: true });
  assert.deepEqual(outline(session.transcript()), ["user:COMPACT_ONE", "assistant", "user:COMPACT_TWO", "assistant"]);
});

test("Durable compacts by itself ahead of the threshold, in the background", { timeout: 60_000 }, async (t) => {
  // A 32k window puts Durable's background threshold (32,768 below `contextWindow - reserveTokens`) under zero.
  const f = await fixture(t, { contextWindow: 32_000, settings: { compaction: { keepRecentTokens: 40 } } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-auto" }, f.host());
  const starts: string[] = [];
  session.subscribe((event) => { if (event.type === "compaction_start") starts.push(`${event.reason}:${event.background ? "background" : "foreground"}`); });
  await turns(session, ["AUTO_ONE first turn", `AUTO_TWO ${"kept ".repeat(400)}`]);
  const entries = await transcriptWhere(session, (items) => items.some((entry) => entry.kind === "compaction") && !session.isStreaming);
  assert.deepEqual([...new Set(starts)], ["threshold:background"]);
  assert.deepEqual(outline(entries).filter((item) => item.startsWith("user:")), ["user:AUTO_ONE", "user:AUTO_TWO"], "history stays whole");
});

test("a PI session moved to Durable keeps its history and spend, and the model resumes from PI's context", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, KEPT_WINDOW);
  const time = "2026-10-01T10:00:00.000Z";
  const spent = (input: number) => ({ input, output: 2, cacheRead: 1, cacheWrite: 3, totalTokens: input + 6, cost: { input: 0.2, output: 0.1, cacheRead: 0.05, cacheWrite: 0.05, total: 0.4 } });
  const text = (value: string) => [{ type: "text", text: value }];
  const user = (id: string, parentId: string | null, value: string) => ({ type: "message", id, parentId, timestamp: time, message: { role: "user", content: text(value), timestamp: 1 } });
  const answer = (id: string, parentId: string, content: unknown[], stopReason = "stop") => ({ type: "message", id, parentId, timestamp: time,
    message: { role: "assistant", content, api: "anthropic-messages", provider: "hui-e2e", model: "fixture", usage: spent(10), stopReason, timestamp: 2 } });
  // As PI writes a session: a rewind left an abandoned branch, and a summary keeps the long turn verbatim.
  const content = [
    { type: "session", version: 3, id: "pi-1", timestamp: time, cwd: f.cwd },
    user("u1", null, "PI_ONE first turn"), answer("a1", "u1", text("PI answer one")),
    user("x1", "a1", "PI_ABANDONED branch"), answer("x2", "x1", text("abandoned answer")),
    user("u2", "a1", "PI_TWO second turn"), answer("a2", "u2", text("PI answer two")),
    user("u3", "a2", LONG_TURN.replace("COMPACT_THREE", "PI_THREE")), answer("a3", "u3", text("PI answer three")),
    { type: "compaction", id: "c1", parentId: "a3", timestamp: time, summary: "PI_SUMMARY", firstKeptEntryId: "u3", tokensBefore: 4321, usage: spent(20) },
    user("u4", "c1", "PI_FOUR after the summary"),
    answer("a4", "u4", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "fixture.txt" } }], "toolUse"),
    { type: "message", id: "r4", parentId: "a4", timestamp: time, message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: text("Durable fixture content"), isError: false, timestamp: 3 } },
    answer("a5", "r4", text("PI answer four")),
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const source = join(f.dir, "pi-session.jsonl");
  await writeFile(source, content);
  const host = f.host();
  const session = { id: "moved-session", cwd: f.cwd, source, model: "hui-e2e/fixture", thinking: "high" };
  const imported = await importPiSession(host, session, content);
  assert.deepEqual(
    { reused: imported.reused, messages: imported.messages, summaries: imported.summaries, abandoned: imported.abandoned, model: imported.model },
    { reused: false, messages: 10, summaries: 1, abandoned: 2, model: "hui-e2e/fixture" },
  );

  // HUI reports the same spend for the conversation as it did for the PI file.
  const record = (piSessionFile: string) => ({ id: session.id, title: "Moved", group: "", cwd: f.cwd, tool: "pi", piSessionFile, createdAt: time, updatedAt: time });
  const before = await aggregateUsage([record(source)]);
  const after = await aggregateUsage([record(durableReference(imported.conversationId))], (id) => host.conversationUsage(id as never));
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) assert.equal(after[key], before[key], key);
  assert(Math.abs((after.costUsd ?? 0) - (before.costUsd ?? 0)) < 1e-9, `cost ${after.costUsd} vs ${before.costUsd}`);
  const again = await importPiSession(host, session, content);
  assert.deepEqual([again.reused, again.conversationId], [true, imported.conversationId], "an unchanged file is not copied twice");

  const moved = await startDurable({ cwd: f.cwd, sessionFile: durableReference(imported.conversationId) }, host);
  assert.deepEqual(outline(moved.transcript()), [
    "user:PI_ONE", "assistant", "user:PI_TWO", "assistant", "user:PI_THREE", "assistant", "compaction", "user:PI_FOUR", "assistant",
  ]);
  assert(moved.transcript().some((entry) => entry.kind === "tool" && entry.name === "read"), "the tool call after the summary");
  const divider = moved.transcript().find((entry) => entry.kind === "compaction");
  assert(divider?.kind === "compaction" && divider.summary === "PI_SUMMARY", JSON.stringify(divider));
  assert.deepEqual([moved.currentModel()?.id, moved.currentThinking()], ["fixture", "high"]);

  await turns(moved, ["AFTER_MOVE next turn"]);
  const request = await lastTurnRequest(f.log);
  // Every message PI itself would send next, apart from its summary wrapper, and nothing it summarized or abandoned.
  const { buildSessionContext, convertToLlm, parseSessionEntries } = await import("@earendil-works/pi-coding-agent");
  const piContext = buildSessionContext(parseSessionEntries(content).slice(1) as never).messages.filter((message) => message.role !== "compactionSummary");
  for (const message of convertToLlm(piContext)) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === "text") assert(request.includes(JSON.stringify(block.text).slice(1, -1)), `missing from the request: ${block.text.slice(0, 40)}`);
    }
  }
  assert.match(request, /PI_SUMMARY/u);
  assert.match(request, /AFTER_MOVE/u);
  assert.doesNotMatch(request, /PI_ONE|PI_TWO|PI_ABANDONED/u);
  assert.equal(await readFile(source, "utf8"), content, "the PI file is unchanged");
});

test("transcript search finds a text in a Durable conversation and in a PI file, without starting either", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const message = (id: string, parentId: string | null, role: string, text: string) => ({ type: "message", id, parentId, timestamp: "2026-10-01T10:00:00.000Z",
    message: { role, content: [{ type: "text", text }], timestamp: 1, ...(role === "assistant" ? { api: "anthropic-messages", provider: "hui-e2e", model: "fixture", stopReason: "stop" } : {}) } });
  const content = [
    { type: "session", version: 3, id: "pi-1", timestamp: "2026-10-01T10:00:00.000Z", cwd: f.cwd },
    message("u1", null, "user", "Where is the Flux Capacitor wired?"), message("a1", "u1", "assistant", "The flux capacitor sits behind the seat."),
    message("u2", "a1", "user", '<skill name="time" location="/skills/time/SKILL.md">\nReferences are relative to /skills/time.\n\nThe warp drive manual.\n</skill>\n\nAny news?'),
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const source = join(f.dir, "pi-session.jsonl");
  await writeFile(source, content);
  const host = f.host();
  const { conversationId } = await importPiSession(host, { id: "searched", cwd: f.cwd, source, model: "hui-e2e/fixture" }, content);
  const moved = durableReference(conversationId);

  assert.deepEqual(await searchTranscripts(host, [source, moved, "/missing.jsonl"], "  FLUX capacitor "), [
    { sessionFile: source, snippet: "The flux capacitor sits behind the seat.", matches: 2 },
    { sessionFile: moved, snippet: "The flux capacitor sits behind the seat.", matches: 2 },
  ]);
  assert.deepEqual(await searchTranscripts(host, [source, moved], "warp drive"), [], "an inlined skill is not what the chat shows");
  assert.equal((await searchTranscripts(host, [moved], "any NEWS"))[0]?.snippet, "Any news?");
});

test("model and thinking changes persist on the conversation", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, model: "hui-e2e/fixture", thinking: "low" }, host);
  assert.deepEqual((await session.listModels()).map((model) => model.id).sort(), ["fixture", "group/second"]);
  await session.setModel("hui-e2e", "group/second");
  await session.setThinking("medium");
  const reference = session.sessionFile;
  session.dispose();
  await host.close();
  const reopened = await startDurable({ cwd: f.cwd, sessionFile: reference }, f.host());
  assert.equal(reopened.currentModel()?.id, "group/second");
  assert.equal(reopened.currentThinking(), "medium");
});

test("opening the store leaves the gateway's global fetch untouched", { timeout: 30_000 }, async (t) => {
  // The harness shares the gateway process; GitHub, Jira and update checks
  // must keep the fetch they had (tests and fixtures also override it).
  const f = await fixture(t);
  const before = globalThis.fetch;
  const session = await startDurable({ cwd: f.cwd }, f.host());
  assert.equal(globalThis.fetch, before);
  session.dispose();
});

test("one store has one owner", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await f.host().open();
  await assert.rejects(() => f.host().open(), /already open in this process/u);
});

test("overlapping closes settle once the store is released, and a reopen waits for them", { timeout: 30_000 }, async (t) => {
  // Vite closes the plugins of each environment, so the gateway's stop runs twice at once.
  const f = await fixture(t);
  const host = f.host();
  const lock = join(f.store, "harness.lock");
  const first = await host.open();
  const settled: string[] = [];
  const closes = [host.close(), host.close()].map((close, index) =>
    close.then(() => { settled.push(`close ${index}: ${existsSync(lock) ? "locked" : "released"}`); }));
  const reopened = host.open().then((harness) => {
    settled.push(`open: ${existsSync(lock) ? "locked" : "released"}`);
    return harness;
  });
  await Promise.all(closes);
  const second = await reopened;
  assert.deepEqual(settled, ["close 0: released", "close 1: released", "open: locked"], "the second close waits for the first one's release");
  assert.notEqual(second, first, "the reopened store is a new harness");
  const session = await startDurable({ cwd: f.cwd }, host);
  assert.equal(session.transcript().length, 0);
  session.dispose();
});

test("Durable requests give each HUI session its own PI_CLIENT_SESSION_ID for provider headers", async (t) => {
  const inherited = process.env["PI_CLIENT_SESSION_ID"];
  delete process.env["PI_CLIENT_SESSION_ID"];
  t.onTestFinished(() => {
    if (inherited === undefined) delete process.env["PI_CLIENT_SESSION_ID"];
    else process.env["PI_CLIENT_SESSION_ID"] = inherited;
  });
  const f = await fixture(t, KEPT_WINDOW);
  const host = f.host();
  const first = await startDurable({ cwd: f.cwd, huiSessionId: "identity-first" }, host);
  const second = await startDurable({ cwd: f.cwd, huiSessionId: "identity-second" }, host);
  await turns(first, ["IDENTITY_FIRST one", "IDENTITY_FIRST " + "kept ".repeat(400)]);
  await turns(second, ["IDENTITY_SECOND one"]);
  const compacted = nextEvent(first, (event) => event.type === "compaction_end");
  await first.compact();
  await compacted;
  // The fixture logs the x-client-session-id header each request resolved.
  const identities = async (marker: string, summary = false) => new Set((await providerRequests(f.log))
    .filter((request) => summarizing(request) === summary && JSON.stringify(request.messages).includes(marker))
    .map((request) => (request as ProviderRequest & { clientSessionId?: string }).clientSessionId));
  const [firstId, ...otherFirst] = await identities("IDENTITY_FIRST");
  const [secondId, ...otherSecond] = await identities("IDENTITY_SECOND");
  assert.deepEqual([otherFirst, otherSecond], [[], []], "one identity per HUI session");
  assert.match(String(firstId), /^[0-9a-f-]{36}$/u);
  assert.match(String(secondId), /^[0-9a-f-]{36}$/u);
  assert.notEqual(firstId, secondId, "independent sessions need independent identities");
  assert.deepEqual([...await identities("IDENTITY_FIRST", true)], [firstId], "a summary is requested as its session");
  assert.equal(process.env["PI_CLIENT_SESSION_ID"], undefined, "the gateway environment is unchanged");
  process.env["PI_CLIENT_SESSION_ID"] = "operator-id";
  await turns(second, ["IDENTITY_OPERATOR two"]);
  assert.deepEqual([...await identities("IDENTITY_OPERATOR")], ["operator-id"], "an explicit gateway value is kept, as for PI workers");
});

test("a worker row with the same durable:N never becomes the caller of a gateway conversation", async () => {
  const { updateRegistry } = await import("../sessions/sessions.ts");
  const base = { cwd: root, tool: "durable", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await updateRegistry(() => [
    { ...base, id: "remote-row", piSessionFile: "durable:7", worker: "w1" },
    { ...base, id: "local-row", piSessionFile: "durable:7" },
  ] as never);
  assert.equal(await registryCaller(7 as never), "local-row");
  await updateRegistry(() => [{ ...base, id: "remote-row", piSessionFile: "durable:7", worker: "w1" }] as never);
  assert.equal(await registryCaller(7 as never), undefined);
});

/** A PI extension using the surfaces Durable sessions bind: a tool, tool hooks, `input`, `before_agent_start`, a
 * command that asks the user and stores state, and lifecycle events. It logs what it saw, one JSON line each. */
function fixtureExtension(log: string): string {
  return `import { appendFileSync } from "node:fs";
const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
// Module state: a fresh module (a new session, a reload) has a new stamp.
const loaded = Date.now() + Math.random();
export default function (pi) {
  pi.on("session_start", (event, ctx) => {
    const choices = ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "fixture-choice");
    record({ event: "session_start", reason: event.reason, loaded, session: ctx.sessionManager.getSessionId(), choices: choices.map((entry) => entry.data.choice), hasUI: ctx.hasUI });
  });
  pi.on("session_shutdown", (event) => record({ event: "session_shutdown", reason: event.reason, loaded }));
  pi.on("agent_end", async (event, ctx) => {
    record({ event: "agent_end", roles: event.messages.map((message) => message.role), stopped: ctx.signal?.aborted === true });
    if (globalThis.fixtureHoldAgentEnd) {
      ctx.ui.notify("agent_end is holding", "info");
      await globalThis.fixtureHoldAgentEnd;
    }
  });
  pi.on("tool_execution_end", (event) => record({ event: "tool_execution_end", tool: event.toolName, isError: event.isError }));
  for (const name of ["agent_start", "turn_start", "turn_end", "agent_settled", "message_end", "tool_execution_end"]) {
    pi.on(name, (event) => record({ event: "order", name: event.type === "message_end" ? "message_end:" + event.message.role : name }));
  }
  pi.registerTool({
    name: "fixture_echo", label: "Echo", description: "Echoes text with the session it ran in.", promptSnippet: "Echo text back",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id, params, _signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "echoing" }], details: {} });
      return { content: [{ type: "text", text: "echo: " + params.text + " in " + ctx.sessionManager.getSessionId() + " on " + ctx.model?.id }], details: { cwd: ctx.cwd } };
    },
  });
  pi.on("tool_call", (event) => {
    if (event.toolName === "bash" && String(event.input.command).includes("command fixture")) return { block: true, reason: "the fixture extension blocks it" };
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "fixture_echo") return { content: [...event.content, { type: "text", text: " (seen by tool_result)" }] };
  });
  pi.on("input", async (event, ctx) => {
    if (event.text.startsWith("FIXTURE_ASK_FIRST")) await ctx.ui.confirm("Go ahead?", "The fixture asks before sending.");
    return event.text.startsWith("FIXTURE_ALIAS") ? { action: "transform", text: event.text.replace("FIXTURE_ALIAS", "E2E_EXTENSION_TOOL") } : { action: "continue" };
  });
  pi.on("before_agent_start", (event, ctx) => {
    record({ event: "before_agent_start", messageType: event.messageType, idle: ctx.isIdle(), ...(event.messageType === "custom" ? { customType: event.message.customType } : {}) });
    // Context an extension adds while the run starts, without a turn of its own: since PI 1.2.0 a message that may
    // trigger a turn would go into the starting run instead.
    pi.sendMessage({ customType: "fixture-note", content: "FIXTURE_NOTE_MARKER", display: false }, { triggerTurn: false });
    // One that may trigger a turn goes into the run once it started: a steer, not a second run.
    if (event.messageType === "custom") pi.sendMessage({ customType: "fixture-steer", content: "FIXTURE_STEER_MARKER", display: false });
    return {
      message: { customType: "fixture-context", content: "FIXTURE_CONTEXT_MARKER", display: false },
      systemPrompt: "FIXTURE_PROTOCOL\\n" + event.systemPrompt,
    };
  });
  pi.registerCommand("fixture-ask", {
    description: "Asks for a colour and keeps it",
    handler: async (_args, ctx) => {
      const choice = await ctx.ui.select("Pick a colour", ["red", "blue"]);
      pi.appendEntry("fixture-choice", { choice });
      ctx.ui.notify("picked " + choice, "info");
    },
  });
  pi.registerCommand("fixture-note", { description: "Adds independent context", handler: async () => { pi.sendMessage({ customType: "fixture-idle", content: "FIXTURE_IDLE_MARKER", display: false }); } });
  pi.registerCommand("fixture-send", { description: "Sends a prompt", handler: async (args) => { pi.sendUserMessage("E2E_EXTENSION_TOOL " + args); } });
  pi.registerCommand("fixture-trigger", {
    description: "Starts a turn with a custom message",
    handler: async () => { pi.sendMessage({ customType: "fixture-result", content: "E2E_EXTENSION_TOOL from a custom message", display: true }, { triggerTurn: true }); },
  });
}
`;
}

async function extensionLog(log: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return completeLines(text).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const logged = async (log: string, event: string) => (await extensionLog(log)).filter((entry) => entry["event"] === event);

/** Sends `text` and resolves once the session settled: after the run, and after its extensions' end-of-run handlers. */
async function settledAfter(session: DurableSession, text: string): Promise<void> {
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt(text);
  await settled;
}

async function extensionFixture(t: TestContext, options: Parameters<typeof fixture>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hui-durable-extension-log-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const events = join(dir, "extension.jsonl");
  const f = await fixture(t, { ...options, extensions: { "fixture.js": fixtureExtension(events), ...options.extensions } });
  return { ...f, events, eventsDir: dir };
}

test("Durable sessions load PI extensions: their tools, hooks and prompt additions reach the model", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-extensions" }, f.host());
  const [start] = await logged(f.events, "session_start");
  assert.deepEqual({ ...start, loaded: undefined }, { event: "session_start", reason: "startup", loaded: undefined, session: "durable-extensions", choices: [], hasUI: true });
  const inspection = await session.inspect();
  const echo = inspection.tools.find((tool) => tool.name === "fixture_echo");
  assert.match(String(echo?.source), /fixture\.js/u, "inspection names the extension that registered the tool");
  assert.ok(inspection.tools.some((tool) => tool.name === "bash" && tool.source === "Durable"), "the coding tools stay");
  assert.ok((await session.listCommands()).some((command) => command.name === "fixture-ask" && command.source === "extension"));

  const tools: string[] = [];
  session.subscribe((event) => { if (event.type === "tool_end") tools.push(`${event.name}:${event.output}`); });
  await settledAfter(session, "E2E_EXTENSION_TOOL please");
  assert.deepEqual(tools, ["fixture_echo:echo: from the model in durable-extensions on fixture (seen by tool_result)"]);
  const request = JSON.stringify((await providerRequests(f.log))[0]);
  assert.match(request, /FIXTURE_CONTEXT_MARKER/u, "before_agent_start's message reaches the model");
  assert.match(request, /FIXTURE_PROTOCOL/u, "before_agent_start's system prompt is the run's");
  assert.match(request, /fixture_echo: Echo text back/u, "the tool's snippet is in HUI's active-tool list");
  assert.ok(!JSON.stringify(session.transcript()).includes("FIXTURE_CONTEXT_MARKER"), "the custom message is context only");
  // PI's order, each message once. Durable writes the run's custom messages just before its input.
  assert.deepEqual((await logged(f.events, "order")).map((entry) => entry["name"]), [
    "message_end:custom", "message_end:custom", "agent_start", "turn_start", "message_end:user", "message_end:assistant",
    "tool_execution_end", "message_end:toolResult", "turn_end", "turn_start", "message_end:assistant", "turn_end", "agent_settled",
  ]);
  assert.match(request, /FIXTURE_NOTE_MARKER/u, "a message sent without a turn is context for the prompt");
  assert.equal(session.transcript().filter((entry) => entry.kind === "message" && entry.role === "user").length, 1, "and starts no run of its own");
  const [end] = await logged(f.events, "agent_end");
  assert.ok((end?.["roles"] as string[]).includes("toolResult"), JSON.stringify(end));

  const blocked = nextEvent(session, (event) => event.type === "tool_end");
  await settledAfter(session, "E2E_COMMAND run it");
  const result = await blocked;
  assert(result.type === "tool_end" && result.failed === true && /the fixture extension blocks it/u.test(String(result.output)), JSON.stringify(result));
});

test("Stop while an input handler asks leaves the prompt unsent", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-stop-input" }, f.host());
  const asked = nextEvent(session, (event) => event.type === "question");
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("FIXTURE_ASK_FIRST E2E_EXTENSION_TOOL");
  assert.equal((await asked).type, "question", "the prompt returns once a handler asks, as PI's does");
  assert.equal(session.isStreaming, false, "a prompt still passing its handlers is not a run");
  await session.abort();
  await settled;
  assert.deepEqual(session.transcript(), [], "nothing was sent");
  assert.deepEqual(session.pendingQuestions(), []);
  assert.equal(await readFile(f.log, "utf8").catch(() => ""), "", "the model was never asked");
});

test("tracked acceptance waits through an input-handler question and targeted cancellation keeps its prompt unsent", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "tracked-stop-input" }, f.host());
  const asked = nextEvent(session, (event) => event.type === "question");
  const settled = nextEvent(session, (event) => event.type === "settled");
  const dispatch = session.prompt("FIXTURE_ASK_FIRST E2E_EXTENSION_TOOL", undefined, { requestId: "waiting-input" });
  await asked;
  assert.equal(session.isStreaming, false);
  await session.cancelTrackedPrompt("waiting-input");
  await dispatch;
  await settled;
  assert.deepEqual(session.transcript(), []);
  assert.deepEqual(session.pendingQuestions(), []);
  await assert.rejects(session.waitForTrackedPrompt("waiting-input"), /could not be found/u);
  assert.equal(await readFile(f.log, "utf8").catch(() => ""), "", "cancelling pre-admission asks never reaches the model");
});

test("end-of-run handlers see a Stop in ctx.signal and hold the settle, not the extensions' idle view", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-end-handlers" }, f.host());
  let release!: () => void;
  (globalThis as { fixtureHoldAgentEnd?: Promise<void> }).fixtureHoldAgentEnd = new Promise((resolve) => { release = resolve; });
  t.onTestFinished(() => { release(); delete (globalThis as { fixtureHoldAgentEnd?: Promise<void> }).fixtureHoldAgentEnd; });
  const settled = nextEvent(session, (event) => event.type === "settled");
  const holding = nextEvent(session, (event) => event.type === "notice" && event.message === "agent_end is holding");
  await session.prompt("E2E_RICH read the fixture");
  await holding;
  assert.equal(session.running, false, "extensions see the run over");
  assert.equal(session.isStreaming, true, "HUI waits while agent_end runs, as PI does");
  release();
  await settled;
  assert.equal(session.isStreaming, false);
  assert.equal((await logged(f.events, "agent_end"))[0]?.["stopped"], false);

  (globalThis as { fixtureHoldAgentEnd?: Promise<void> }).fixtureHoldAgentEnd = undefined;
  const running = nextEvent(session, (event) => event.type === "tool_start");
  const stopped = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("E2E_COMMAND_RUNNING hold the command");
  await running;
  await session.abort();
  await stopped;
  assert.equal((await logged(f.events, "agent_end"))[1]?.["stopped"], true, "a handler tells a user's Stop by ctx.signal");
});

test("a Stop resolves once the end-of-run handlers ran, so a rewind can follow at once", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-stop-settles" }, f.host());
  let release!: () => void;
  (globalThis as { fixtureHoldAgentEnd?: Promise<void> }).fixtureHoldAgentEnd = new Promise((resolve) => { release = resolve; });
  t.onTestFinished(() => { release(); delete (globalThis as { fixtureHoldAgentEnd?: Promise<void> }).fixtureHoldAgentEnd; });
  const running = nextEvent(session, (event) => event.type === "tool_start");
  const holding = nextEvent(session, (event) => event.type === "notice" && event.message === "agent_end is holding");
  await session.prompt("E2E_COMMAND_RUNNING hold the command");
  await running;
  let stopped = false;
  const stopping = session.abort().then(() => { stopped = true; });
  await holding;
  assert.equal(stopped, false, "Stop waits for the end-of-run handlers, as PI's does");
  const releasedAt = Date.now();
  release();
  await stopping;
  assert.ok(Date.now() - releasedAt < 5_000, "Stop wakes when the handlers finish, not at its wait's timeout");
  assert.equal(session.isStreaming, false, "a resolved Stop is idle");
  await session.rewind({ userFromEnd: 0 }, { excludeUserMessage: true });
  assert.deepEqual(session.transcript(), []);
});

test("rewinding drops prompt-specific extension context but keeps independent context", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-rewind-context" }, f.host());
  await settledAfter(session, "/fixture-note");
  await settledAfter(session, "E2E_RICH first");
  await session.rewind({ userFromEnd: 0 }, { excludeUserMessage: true });
  await settledAfter(session, "E2E_RICH again");
  const request = JSON.stringify((await providerRequests(f.log)).filter((each) => JSON.stringify(each.messages).includes("E2E_RICH again"))[0]?.messages);
  assert.equal(request.split("FIXTURE_CONTEXT_MARKER").length - 1, 1, "only the new prompt's context");
  assert.match(request, /FIXTURE_IDLE_MARKER/u, "the independent command's context survives");
  assert.doesNotMatch(request, /E2E_RICH first/u);
});

test("a session_start dialog does not hold the session from opening", { timeout: 45_000 }, async (t) => {
  const asks = "export default function (pi) { pi.on('session_start', async (_event, ctx) => { const ok = await ctx.ui.confirm('Fixture start', 'Allow it?'); ctx.ui.notify('start ' + ok, 'info'); }); }\n";
  const f = await extensionFixture(t, { extensions: { "asks.js": asks } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-start-dialog" }, f.host());
  const [question] = session.pendingQuestions();
  assert(question?.method === "confirm" && question.title === "Fixture start", JSON.stringify(question));
  const notified = nextEvent(session, (event) => event.type === "notice");
  await session.respondQuestion(question.id, { confirmed: true });
  assert.deepEqual(await notified, { type: "notice", level: "info", message: "start true" });
});

test("rewinding to before the first message keeps the session's extensions", { timeout: 45_000 }, async (t) => {
  const tool = "export default function (pi) { pi.registerTool({ name: 'fixture_echo', label: 'Echo', description: 'Echoes.', parameters: { type: 'object', properties: { text: { type: 'string' } } }, async execute(_id, params) { return { content: [{ type: 'text', text: 'echo: ' + params.text }], details: {} }; } }); }\n";
  const f = await fixture(t, { extensions: { "tool.js": tool } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-rewind-extensions" }, f.host());
  await settledAfter(session, "E2E_RICH first");
  const before = session.sessionFile;
  await session.rewind({ userFromEnd: 0 }, { excludeUserMessage: true });
  assert.notEqual(session.sessionFile, before, "the session continues in a new conversation");
  assert.deepEqual(session.transcript(), []);
  assert.ok((await session.inspect()).tools.some((each) => each.name === "fixture_echo"), "with the extension's tool");
  const ended = nextEvent(session, (event) => event.type === "tool_end");
  await settledAfter(session, "E2E_EXTENSION_TOOL after the rewind");
  const result = await ended;
  assert(result.type === "tool_end" && result.output === "echo: from the model", JSON.stringify(result));
});

test("extension commands run in the gateway, ask through HUI questions and keep their state across a reopen", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-commands" }, host);
  const asked = nextEvent(session, (event) => event.type === "question");
  const notified = nextEvent(session, (event) => event.type === "notice");
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt("$fixture-ask");
  const question = await asked;
  assert(question.type === "question" && question.question.method === "select", JSON.stringify(question));
  assert.deepEqual(question.question.options, ["red", "blue"]);
  assert.deepEqual(session.pendingQuestions().map((each) => each.id), [question.question.id]);
  await session.respondQuestion(question.question.id, { value: "blue" });
  assert.deepEqual(await notified, { type: "notice", level: "info", message: "picked blue" });
  await settled;
  assert.equal(session.isStreaming, false, "a command that starts no run leaves the session idle");
  assert.deepEqual(session.transcript(), [], "nothing reached the model");

  // The command's own prompt starts a run through the input pipeline.
  await settledAfter(session, "/fixture-send now");
  assert.ok(answered("Tool complete")(session.transcript()));
  // A custom message that starts a turn reaches the model and stays out of the transcript, as in PI sessions.
  const users = (entries: TranscriptEntry[]) => entries.filter((entry) => entry.kind === "message" && entry.role === "user").length;
  const before = users(session.transcript());
  await settledAfter(session, "/fixture-trigger");
  const triggered = (await providerRequests(f.log)).at(-2);
  assert.match(JSON.stringify(triggered?.messages), /from a custom message/u);
  // As in PI 1.2.0, the run it starts goes through before_agent_start too, which sees the run as busy already.
  assert.match(JSON.stringify(triggered?.system), /FIXTURE_PROTOCOL/u, "its before_agent_start prompt is the run's");
  assert.doesNotMatch(JSON.stringify(triggered?.messages), /FIXTURE_STEER_MARKER/u, "a message sent while it started is not ahead of it");
  assert.match(JSON.stringify((await providerRequests(f.log)).at(-1)?.messages), /FIXTURE_STEER_MARKER/u, "but steers the run");
  assert.deepEqual((await logged(f.events, "before_agent_start")).map(({ messageType, customType, idle }) => ({ messageType, customType, idle })), [
    { messageType: "user", customType: undefined, idle: false },
    { messageType: "custom", customType: "fixture-result", idle: false },
  ]);
  assert.equal(users(session.transcript()), before, "no user message shows for it");
  assert.equal(session.transcript().filter((entry) => entry.kind === "tool").length, 2, "but its turn does");

  const reference = session.sessionFile;
  session.dispose();
  await host.close();
  await startDurable({ cwd: f.cwd, sessionFile: reference, huiSessionId: "durable-commands" }, f.host());
  const starts = await logged(f.events, "session_start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1]!["choices"], ["blue"], "state the extension stored is read back from the store");
});

test("input handlers rewrite prompts, and a reload starts fresh extension instances", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t);
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-reload" }, f.host());
  const tool = nextEvent(session, (event) => event.type === "tool_end");
  await settledAfter(session, "FIXTURE_ALIAS from the input handler");
  assert.equal((await tool).type, "tool_end", "the rewritten prompt asked for the extension tool");
  assert.ok(session.transcript().some((entry) => entry.kind === "message" && entry.role === "user" && entry.text.startsWith("E2E_EXTENSION_TOOL")));

  await session.reload();
  const [first, second] = await logged(f.events, "session_start");
  assert.deepEqual(await logged(f.events, "session_shutdown"), [{ event: "session_shutdown", reason: "reload", loaded: first!["loaded"] }]);
  assert.equal(second?.["reason"], "reload");
  assert.notEqual(second!["loaded"], first!["loaded"], "a reload loads the extension again");
});

test("a disabled package loads neither its extension nor its skills, and a broken extension is reported while the session works", { timeout: 45_000 }, async (t) => {
  const f = await extensionFixture(t, { extensions: { "broken.js": "export default function () { throw new Error('fixture load failure'); }\n" } });
  // A local PI package with an extension and a skill, listed in PI settings.
  const pkg = join(f.eventsDir, "fixture-package");
  await mkdir(join(pkg, "skills", "fixture-skill"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-package", pi: { extensions: ["./index.js"], skills: ["./skills"] } }));
  await writeFile(join(pkg, "index.js"), fixtureExtension(f.events));
  await writeFile(join(pkg, "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: A skill the package ships.\n---\nFixture skill body.\n");
  await rm(join(f.agentDir, "extensions", "fixture.js"));
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", packages: [pkg] }));
  const { configuredResourceId } = await import("./resource-policy.ts");

  const first = f.host();
  const enabled = await startDurable({ cwd: f.cwd, huiSessionId: "durable-enabled" }, first);
  const commands = await enabled.listCommands();
  assert.ok(commands.some((command) => command.name === "skill:fixture-skill"), "the package's skill loads while it is enabled");
  assert.ok(commands.some((command) => command.name === "fixture-ask"), "and so does its extension");
  enabled.dispose();
  await first.close();

  const disabled = normalizeSettings({ disabledPlugins: [{ id: configuredResourceId("package", pkg), name: "fixture-package", kind: "package" }] });
  const host = f.host({ huiSettings: disabled });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-disabled" }, host);
  const inspection = await session.inspect();
  assert.ok(!inspection.tools.some((tool) => tool.name === "fixture_echo"), "a disabled package's extension never runs");
  assert.ok(!(await session.listCommands()).some((command) => command.source === "extension" || command.name === "skill:fixture-skill"));
  assert.ok(inspection.diagnostics.some((line) => /broken\.js: .*fixture load failure/u.test(line)), JSON.stringify(inspection.diagnostics));
  assert.deepEqual((await logged(f.events, "session_start")).map((entry) => entry["session"]), ["durable-enabled"]);
  await settledAfter(session, "E2E_RICH read the fixture");
  assert.ok(answered("Tool complete")(session.transcript()));
});

test("interrupted runs wait for their extensions even when another session's startup starts work", { timeout: 60_000 }, async (t) => {
  const f = await extensionFixture(t, { extensions: { "startup.js": `export default function(pi) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.sessionManager.getSessionId() === "resume-trigger")
        pi.sendMessage({ customType: "startup", content: "STARTUP_NEW_RUN", display: false }, { triggerTurn: true });
    });
  }` } });
  const hostUrl = new URL("./durable-host.ts", import.meta.url).href;
  const durableUrl = new URL("./durable.ts", import.meta.url).href;
  const settingsUrl = new URL("../hui-settings.ts", import.meta.url).href;
  // A separate gateway owns the store and is SIGKILLed while bash is running.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { DurableHost } = await import(${JSON.stringify(hostUrl)});
    const { startDurable } = await import(${JSON.stringify(durableUrl)});
    const { normalizeSettings } = await import(${JSON.stringify(settingsUrl)});
    const host = new DurableHost({ dir: ${JSON.stringify(f.store)}, agentDir: ${JSON.stringify(f.agentDir)},
      readSettings: async () => normalizeSettings(undefined), invokeTool: async () => ({}), lookupCaller: async () => undefined });
    host.configureDurableBots(null);
    const session = await startDurable({ cwd: ${JSON.stringify(f.cwd)}, huiSessionId: "crash-extensions" }, host);
    process.stdout.write("REF " + session.sessionFile + "\\n");
    await session.prompt("E2E_COMMAND_RUNNING hold the command");
  `], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  f.children.push(child);
  const [line] = await once(child.stdout!, "data");
  const reference = /REF (durable:\d+)/u.exec(String(line))?.[1];
  assert(reference, String(line));
  assert.equal((await f.control("/control/wait-replay-ready")).status, 200, "bash is running the held command");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;

  // The next gateway reopens the session before the run goes on, as the gateway does with every session whose
  // conversation has unfinished work.
  const host = f.host();
  let interrupted: readonly unknown[] = [];
  let reopened!: (session: DurableSession) => void;
  const reopening = new Promise<DurableSession>((resolve) => { reopened = resolve; });
  host.beforeResume = async (conversations) => {
    interrupted = conversations;
    // This session's startup handler must not resume the entire store while the interrupted session is still loading.
    await startDurable({ cwd: f.cwd, huiSessionId: "resume-trigger" }, host);
    reopened(await startDurable({ cwd: f.cwd, sessionFile: reference, huiSessionId: "crash-extensions" }, host));
  };
  await host.open();
  await transcriptWhere(await reopening, answered("Tool complete"));
  assert.deepEqual(interrupted.map(String), [reference.slice("durable:".length)]);
  const resumed = (await providerRequests(f.log)).filter((request) => JSON.stringify(request.messages).includes("E2E_COMMAND_RUNNING")).at(-1) as ProviderRequest & { tools?: unknown };
  assert.match(JSON.stringify(resumed.tools), /fixture_echo/u, "the resumed run's next request offers the extension's tool");
});


/** Logs every `ctx.compact()` outcome and `session_compact`. `/ext-compact TAG` compacts with the model's summary
 * (held by E2E_SLOW_COMPACT); instructions `HOOK:<summary>` get that summary from `session_before_compact`; automatic
 * compactions are declined. */
const compactingExtension = (log: string) => `
import { appendFileSync } from "node:fs";
const write = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
export default function (pi) {
  pi.registerCommand("ext-compact", {
    description: "compacts",
    handler: async (tag, ctx) => {
      ctx.compact({
        onComplete: (result) => write({ event: "complete", tag, summary: result.summary }),
        onError: (error) => {
          write({ event: "error", tag, message: error.message });
          if (tag === "A") ctx.compact({
            onComplete: () => write({ event: "complete", tag: "retry" }),
            onError: (retry) => write({ event: "error", tag: "retry", message: retry.message }),
          });
        },
      });
    },
  });
  pi.on("session_before_compact", (event) => {
    if (event.reason !== "manual") return { cancel: true };
    const hook = event.customInstructions?.match(/^HOOK:(.*)$/);
    return hook ? { compaction: { summary: hook[1], firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: 0 } } : undefined;
  });
  pi.on("session_compact", (event) => write({ event: "session_compact", summary: event.compactionEntry.summary, reason: event.reason, fromExtension: event.fromExtension }));
}
`;

async function compactionFixture(t: TestContext, options: Parameters<typeof fixture>[1]) {
  const dir = await mkdtemp(join(tmpdir(), "hui-durable-compaction-log-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "extension.jsonl");
  const f = await fixture(t, { ...options, extensions: { "compaction.js": compactingExtension(log) } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-extension-compaction" }, f.host());
  /** Resolves once the extension logged `count` entries of `event`. */
  const loggedAtLeast = async (event: string, count = 1) => {
    for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
      const entries = await logged(log, event);
      if (entries.length >= count) return entries;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Expected extension log never arrived: ${JSON.stringify(await extensionLog(log))}`);
  };
  return { ...f, session, entries: () => extensionLog(log), loggedAtLeast };
}

const outcomes = (entries: Record<string, unknown>[]) => entries.filter((entry) => entry["event"] === "complete" || entry["event"] === "error");

test("ctx.compact() completes with its own summary, not one another compaction placed first", { timeout: 60_000 }, async (t) => {
  const { session, control, entries, loggedAtLeast } = await compactionFixture(t, KEPT_WINDOW);
  await turns(session, ["E2E_SLOW_COMPACT first turn", LONG_TURN]);
  await session.prompt("/ext-compact A");
  assert.equal((await control("/control/wait-replay-ready")).status, 200, "the extension's summary request is held");

  await compacted(session, "HOOK:USER_SUMMARY");
  await loggedAtLeast("session_compact");
  assert.deepEqual(outcomes(await entries()), [], "the user's compaction ending is not the extension's");

  await control("/control/release-replay", "POST");
  const [result] = await loggedAtLeast("complete");
  assert.equal(result?.["tag"], "A");
  assert.match(String(result?.["summary"]), /FIXTURE_SUMMARY/u);
  assert.doesNotMatch(String(result?.["summary"]), /USER_SUMMARY/u);
  const placed = await loggedAtLeast("session_compact", 2);
  assert.deepEqual(placed.map((entry) => [/USER_SUMMARY/u.test(String(entry["summary"])) ? "user" : /FIXTURE_SUMMARY/u.test(String(entry["summary"])) ? "model" : entry["summary"], entry["fromExtension"]]),
    [["user", true], ["model", false]], "each placed summary once, flagged by who wrote it");
});

test("a compaction that placed no summary sends no session_compact with an earlier one", { timeout: 60_000 }, async (t) => {
  // A 32k window has Durable compact in the background before each request with a cut; the extension declines those.
  const { session, entries, loggedAtLeast } = await compactionFixture(t, { contextWindow: 32_000, settings: { compaction: { keepRecentTokens: 40 } } });
  await turns(session, ["first turn", LONG_TURN]);
  await compacted(session, "HOOK:FIRST_SUMMARY");
  await loggedAtLeast("session_compact");

  const declined = nextEvent(session, (event) => event.type === "compaction_end" && event.reason !== "manual");
  await turns(session, ["third turn", LONG_TURN, "fifth turn"]);
  const end = await declined;
  assert(end.type === "compaction_end" && end.outcome === "done", JSON.stringify(end));
  assert.deepEqual((await entries()).filter((entry) => entry["event"] === "session_compact").map((entry) => entry["reason"]), ["manual"]);
});

test("clearing the session cancels a pending ctx.compact() once; a later compaction is not reported to it", { timeout: 60_000 }, async (t) => {
  const { session, control, entries, loggedAtLeast } = await compactionFixture(t, KEPT_WINDOW);
  await turns(session, ["E2E_SLOW_COMPACT first turn", LONG_TURN]);
  await session.prompt("/ext-compact A");
  assert.equal((await control("/control/wait-replay-ready")).status, 200, "the extension's summary request is held");

  await session.clear();
  await loggedAtLeast("error");
  await control("/control/release-replay", "POST");
  await turns(session, ["after clear", LONG_TURN]);
  await session.prompt("/ext-compact B");
  await loggedAtLeast("complete");
  assert.deepEqual(outcomes(await entries()).map((entry) => `${String(entry["event"])}:${String(entry["tag"])}:${String(entry["message"] ?? "")}`),
    ["error:A:Compaction cancelled", "complete:B:"]);
});

test("a codemode script's calls show on its own tool row, live and once it ends; Settings → Tools → Codemode takes it from open sessions", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const huiSettings = normalizeSettings(undefined);
  const host = f.host({ huiSettings });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-codemode" }, host);
  assert.ok((await session.inspect()).tools.some((tool) => tool.name === "codemode"), "on by default");
  const events: RuntimeEvent[] = [];
  session.subscribe((event) => { events.push(event); });
  const code = [
    'const [found, missing] = await Promise.allSettled([tools.read({ path: "fixture.txt" }), tools.read({ path: "missing.txt" })]);',
    "text(`${found.status} ${missing.status}`);",
  ].join("\n");
  const settled = nextEvent(session, (event) => event.type === "settled");
  await session.prompt(`E2E_CALL:${Buffer.from(JSON.stringify({ name: "codemode", input: { code } })).toString("base64url")}`);
  await settled;

  const starts = events.filter((event) => event.type === "tool_start");
  assert.deepEqual(starts.map((event) => event.name), ["codemode"], "the script's reads are no tool rows of their own");
  const { id } = starts[0]!;
  const live = events.flatMap((event) => event.type === "tool_update" && event.id === id ? [(event.details as { calls: { status: string }[] }).calls] : []);
  assert.ok(live.some((calls) => calls.some((call) => call.status === "running")), `its row shows the calls while they run: ${JSON.stringify(live)}`);
  const end = events.find((event) => event.type === "tool_end");
  assert(end?.type === "tool_end" && end.id === id && !end.failed, JSON.stringify(end));
  assert.match(end.output ?? "", /^Script completed\nWall time [\d.]+ seconds\nOutput:\nfulfilled rejected/u);
  const calls = (end.details as { calls: { name: string; status: string; error?: string }[] }).calls;
  assert.deepEqual(calls.map(({ name, status }) => `${name}:${status}`), ["read:ok", "read:error"]);
  assert.match(calls[1]!.error ?? "", /missing\.txt/u, "a failed call says why");
  assert.deepEqual(session.transcript().filter((entry) => entry.kind === "tool").map((entry) => entry.kind === "tool" && entry.name), ["codemode"]);

  huiSettings.codemode = { enabled: false };
  await host.applyTools();
  assert.ok(!(await session.inspect()).tools.some((tool) => tool.name === "codemode"), "off: the open session goes without it");
  await settledAfter(session, "hello after codemode");
  const request = (await providerRequests(f.log)).at(-1) as { system?: unknown; tools?: { name?: string }[] };
  assert.ok(!request.tools?.some((tool) => tool.name === "codemode"), "the next request offers no codemode");
  assert.doesNotMatch(JSON.stringify(request.system), /<codemode>/u, "nor its prompt section");
  huiSettings.codemode = { enabled: true };
  await host.applyTools();
  assert.ok((await session.inspect()).tools.some((tool) => tool.name === "codemode"), "on again: back from the next request");
});

test("an extension tool's ctx.executeTool() runs nested calls, and tool_result redaction reaches what scripts get", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, { extensions: { "nested.js": `export default function (pi) {
    pi.registerTool({
      name: "nested_reader", label: "Nested reader", description: "Reads a file and runs a command through ctx.executeTool().",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const read = await ctx.executeTool("read", { path: params.path });
        const shell = await ctx.executeTool("bash", { command: "echo REDACT_ME" });
        const missing = await ctx.executeTool("no_such_tool", {});
        const summary = {
          listed: ctx.tools.some((tool) => tool.name === "read"), id: read.toolCall.id,
          read: read.result.content.map((item) => item.text).join(""), shell: shell.result.content.map((item) => item.text).join(""),
          errors: [read.isError, shell.isError, missing.isError],
        };
        return { content: [{ type: "text", text: JSON.stringify(summary) }], details: {} };
      },
    });
    pi.on("tool_result", (event) => {
      const text = event.content.map((item) => item.text ?? "").join("");
      if (event.toolName === "bash" && text.includes("REDACT_ME")) return { content: [{ type: "text", text: text.replaceAll("REDACT_ME", "[redacted]") }] };
    });
  }` } });
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-nested" }, f.host());
  const call = (name: string, input: Record<string, unknown>) => `E2E_CALL:${Buffer.from(JSON.stringify({ name, input })).toString("base64url")}`;
  const ended: Extract<RuntimeEvent, { type: "tool_end" }>[] = [];
  session.subscribe((event) => { if (event.type === "tool_end") ended.push(event); });

  await settledAfter(session, call("nested_reader", { path: "fixture.txt" }));
  const summary = JSON.parse(ended.at(-1)!.output ?? "{}") as Record<string, unknown>;
  assert.equal(summary["listed"], true, "ctx.tools lists what nested calls can reach");
  assert.match(String(summary["id"]), /\/1$/u, "a nested call's ID extends its caller's");
  assert.match(String(summary["read"]), /Durable fixture content/u);
  assert.match(String(summary["shell"]), /\[redacted\]/u, "the calling tool gets what the handler left");
  assert.doesNotMatch(String(summary["shell"]), /REDACT_ME/u, "and never what it took out");
  assert.deepEqual(summary["errors"], [false, true, true], "a schema tool whose content a handler replaced fails its nested call; an unknown tool is an error result");

  const code = 'try { text((await tools.bash({ command: "echo REDACT_ME" })).output); } catch (error) { text(String(error)); }';
  await settledAfter(session, call("codemode", { code }));
  const script = ended.at(-1)!;
  assert.equal(script.name, "codemode");
  assert.doesNotMatch(script.output ?? "", /REDACT_ME/u, "a script never gets what the handler took out");
  assert.match(script.output ?? "", /\[redacted\]/u, "it gets the replaced text, as the error of its call");
});

test("a storage error ends the store's sessions; the host releases it and a session that attaches again carries on", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "durable-store-failure" }, host);
  await settledAfter(session, "hello before");
  const exited = new Promise<unknown>((resolve) => session.onExit!(resolve));
  // The cause outlasts the first attempt to open the store again, which fails as well, and is gone before the second.
  let blocker!: import("node:sqlite").DatabaseSync;
  let attempts = 0;
  const released = new Promise<void>((resolve) => {
    host.storeFailed = async () => {
      assert.equal(host.isOpen, false, "the failed store is released first");
      if (++attempts < 2) return;
      blocker.exec("ROLLBACK");
      blocker.close();
      resolve();
    };
  });
  // Another connection holds the write lock: the harness's next commit waits out SQLite's busy timeout and fails.
  const { DatabaseSync } = await import("node:sqlite");
  blocker = new DatabaseSync(join(f.store, "harness.sqlite"));
  blocker.exec("BEGIN EXCLUSIVE");
  await session.prompt("hello while the store is locked").catch(() => undefined);
  const unreachable = await exited;
  assert(unreachable instanceof Error && (unreachable as { reconnecting?: boolean }).reconnecting === true, String(unreachable));
  await released;
  assert.equal(attempts, 2, "a store that does not open is tried again");

  const again = await startDurable({ cwd: f.cwd, sessionFile: session.sessionFile, huiSessionId: "durable-store-failure" }, host);
  await settledAfter(again, "hello after");
  assert.ok(answered("Fixture response.")(again.transcript()));
  assert.deepEqual(again.transcript().flatMap((entry) => entry.kind === "message" && entry.role === "user" ? [entry.text] : []).filter((text) => text !== "hello while the store is locked"),
    ["hello before", "hello after"], "the conversation is the one it was");
});

test("a skill named later in a message is expanded ahead of it", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hui-skill-"));
  const filePath = join(baseDir, "SKILL.md");
  await writeFile(filePath, "---\nname: arena\n---\nArena body.\n");
  const skills = [{ name: "arena", filePath, baseDir }];
  const block = `<skill name="arena" location="${filePath}">\nReferences are relative to ${baseDir}.\n\nArena body.\n</skill>`;
  assert.equal(expandSkill("/skill:arena fix it", skills), `${block}\n\nfix it`);
  assert.equal(expandSkill("fix it with $arena.", skills), `${block}\n\nfix it with $arena.`);
  assert.equal(expandSkill("/skill:arena then $skill:arena", skills), `${block}\n\nthen $skill:arena`);
  for (const text of ["costs $5", "see $HOME/x", "a$arena"]) assert.equal(expandSkill(text, skills), text);
  assert.equal(expandSkill("/plan with $arena", skills, (body) => body.replace("/plan", "Plan:")), `${block}\n\nPlan: with $arena`);
  await rm(baseDir, { recursive: true });
});
