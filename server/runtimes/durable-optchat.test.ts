import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test, type TestContext } from "vitest";
import type { Message, Models, UserMessage } from "@earendil-works/pi-ai";
import { AgentDoc, createRegistry, Harness, UserEntry, type ConversationId, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { OptChatStatus } from "../optchat/memory.ts";
import type { CallRecord } from "../calls-format.ts";
import type { OptChatTuning } from "./durable-optchat.ts";
import type { DurableSession } from "./durable.ts";
import type { RuntimeEvent, TranscriptEntry } from "./types.ts";
import { completeLines } from "../test-support/json-lines.ts";

// HUI's configuration directory is resolved at import time, and PI finds skills in ~/.agents/skills: never read the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-optchat-home-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
afterAll(() => rm(root, { recursive: true, force: true }));
const { DurableHost, durableContext, modelCallable } = await import("./durable-host.ts");
const { createDurableBots } = await import("../bots/durable-access.ts");
const { durableReference, startDurable } = await import("./durable.ts");
const {
  configureOptChat, enableOptChat, freshTurn, freshTurnRequest, OPTCHAT_EXTENSION, OPTCHAT_TOOLS_EXTENSION, OptChatDoc, projectEntry,
} = await import("./durable-optchat.ts");
const { readObservability } = await import("../observability.ts");
const { durableBotConversations } = await import("../bots/conversations.ts");
const { optChatBotMemory } = await import("../bots/memory.ts");
type DurableHost = import("./durable-host.ts").DurableHost;

// ── Pure parts ───────────────────────────────────────────────────────────────

const entry = (kind: string, model?: unknown[]): EntryRecord => ({ id: 7, conversationId: 1, kind, ...(model ? { model } : {}) }) as unknown as EntryRecord;
const assistant = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, stopReason, api: "anthropic-messages", provider: "p", model: "m", usage: {}, timestamp: 2 });

test("Durable entries project to log lines: words, replies, calls and results, never thoughts", () => {
  assert.deepEqual(projectEntry(entry("pi.user", [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: 1 }])),
    [{ kind: "user", text: "look\n[image]" }]);
  assert.deepEqual(projectEntry(entry("pi.user", [{ role: "user", content: "plain", timestamp: 1 }])), [{ kind: "user", text: "plain" }]);
  assert.deepEqual(projectEntry(entry("pi.assistant", [assistant([
    { type: "thinking", thinking: "secret plan", thinkingSignature: "sig" },
    { type: "text", text: "Reading it." },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
    { type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } },
  ], "toolUse")])), [
    { kind: "talk", text: "Reading it." }, { kind: "tool", text: "read {\"path\":\"a.txt\"}" }, { kind: "tool", text: "bash {\"command\":\"ls\"}" },
  ]);
  assert.deepEqual(projectEntry(entry("pi.assistant", [assistant([{ type: "thinking", thinking: "only thoughts" }, { type: "toolCall", id: "c", name: "read", arguments: {} }], "toolUse")])),
    [{ kind: "tool", text: "read {}" }], "an empty reply is not logged");
  for (const stopReason of ["error", "aborted", "deferred"]) {
    assert.deepEqual(projectEntry(entry("pi.assistant", [assistant([{ type: "text", text: "partial" }], stopReason)])), [], stopReason);
  }
  assert.deepEqual(projectEntry(entry("pi.tool-result", [{ role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "missing" }], isError: true, timestamp: 3 }])),
    [{ kind: "echo", text: "error: missing" }]);
  for (const kind of ["pi.system", "pi.reset", "pi.compaction", "hui.pi-message"]) {
    assert.deepEqual(projectEntry(entry(kind, [{ role: "user", content: "x", timestamp: 1 }])), [], kind);
  }
  assert.deepEqual(projectEntry(entry("pi.reset")), [], "model-less");
  // A call's record: its transcript (both sides and the helper's answers) as user, its summary as talk, marked [call].
  const start = Date.parse("2026-10-06T14:00:00Z");
  const call = (data: Record<string, unknown>) => ({ id: 8, conversationId: 1, kind: "hui.call", data: { call: "c1", bot: "Juno", startedAt: start, endedAt: start + 120_000, ...data } }) as unknown as EntryRecord;
  const lines = [
    { role: "user", text: "Remember teal.", at: start + 1 },
    { role: "helper", request: "What colour?", text: "Teal.", at: start + 2 },
    { role: "assistant", text: "Teal it is.", at: start + 3 },
  ];
  assert.deepEqual(projectEntry(call({ lines, summary: "**To remember**: teal." })), [
    { kind: "user", text: "[call] A voice call with Juno (2026-10-06 14:00 UTC, about 2 min). Transcript:\nUser: Remember teal.\nJuno's helper (asked \"What colour?\"): Teal.\nJuno: Teal it is." },
    { kind: "talk", text: "[call] Juno's summary of that call: **To remember**: teal." },
  ]);
  assert.deepEqual(projectEntry(call({ lines, summaryUnavailable: true })).map((line) => line.kind), ["user"], "without a summary, the transcript alone");
  assert.deepEqual(projectEntry({ id: 9, conversationId: 1, kind: "hui.call", data: { call: "c0", role: "user", text: "x", at: 1 } } as unknown as EntryRecord), [], "an entry that is not a record logs nothing");
});

const system = (sections: Record<string, string>): Message => ({ role: "system", content: "", sections, timestamp: 1 }) as Message;
const user = (text: string, timestamp: number): UserMessage => ({ role: "user", content: [{ type: "text", text }], timestamp });
const reply = (text: string): Message => assistant([{ type: "text", text }]) as unknown as Message;

test("a fresh turn keeps the system messages, puts the view on the run's input, and keeps the run verbatim", () => {
  const steer = user("steer", 40);
  const call = assistant([{ type: "toolCall", id: "c", name: "read", arguments: {} }], "toolUse") as unknown as Message;
  const result = { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 35 } as Message;
  const input = user("now", 30);
  const messages: Message[] = [system({ preamble: "P" }), user("old", 10), reply("old answer"), system({ preamble: "P2" }), input, call, result, steer];
  const turn = freshTurn(messages, input, "<chat>\nV\n</chat>");
  assert.deepEqual(turn, {
    matched: true,
    messages: [system({ preamble: "P" }), system({ preamble: "P2" }), { ...input, content: [{ type: "text", text: "<chat>\nV\n</chat>" }, { type: "text", text: "now" }] }, call, result, steer],
  });
  const plain = { role: "user", content: "string input", timestamp: 50 } as UserMessage;
  assert.deepEqual(freshTurn([plain], plain, "V")?.messages, [{ ...plain, content: [{ type: "text", text: "V" }, { type: "text", text: "string input" }] }]);
  // Not found by its timestamp: the first user message after the last answer or tool result stands in.
  const fallback = freshTurn(messages.slice(0, 5), user("now", 999), "V");
  assert.equal(fallback?.matched, false);
  assert.deepEqual(fallback?.messages.at(-1), { ...input, content: [{ type: "text", text: "V" }, { type: "text", text: "now" }] });
  assert.equal(freshTurn([system({}), reply("no user")], undefined, "V"), undefined);
});

test("a fresh turn not found by its timestamp is reported", async () => {
  const before = (await readObservability([])).activity.filter((event) => event.action === "optchat_request_split").length;
  const input = user("now", 30);
  assert.equal(freshTurnRequest(5 as ConversationId, [input], input, "V")?.length, 1);
  assert.equal((await readObservability([])).activity.filter((event) => event.action === "optchat_request_split").length, before, "found: nothing to say");
  assert.equal(freshTurnRequest(5 as ConversationId, [input], user("now", 31), "V")?.length, 1);
  const events = (await readObservability([])).activity.filter((event) => event.action === "optchat_request_split");
  assert.equal(events.length, before + 1);
  assert.match(events[0]!.summary, /conversation 5's view on the first user message after the last answer/u);
});

test("enabling writes the document and selects the tools in the same transaction; it checks what it writes", async () => {
  let optchat: Record<string, unknown> = { enabled: false, name: "" };
  let agent: Record<string, unknown> = {};
  const tx = { doc: async (token: unknown) => token === OptChatDoc ? optchat : token === AgentDoc ? agent : assert.fail("unexpected document") } as never;
  await enableOptChat(tx, 3 as ConversationId, { name: "  Grok  ", model: "anthropic/claude-sonnet-4-5" });
  assert.deepEqual([optchat, agent], [{ enabled: true, name: "Grok", model: "anthropic/claude-sonnet-4-5" }, { extensions: { add: [OPTCHAT_TOOLS_EXTENSION] } }]);
  await configureOptChat(tx, 3 as ConversationId, { model: null, thinking: "low", name: "Grok 2" });
  assert.deepEqual(optchat, { enabled: true, name: "Grok 2", thinking: "low" });
  await configureOptChat(tx, 3 as ConversationId, { enabled: false });
  assert.deepEqual(agent, {}, "disabled: the selection is as it was");
  agent = { extensions: { add: ["pi:session"], remove: [OPTCHAT_EXTENSION] } };
  await configureOptChat(tx, 3 as ConversationId, { enabled: true });
  assert.deepEqual(agent, { extensions: { add: ["pi:session", OPTCHAT_TOOLS_EXTENSION] } }, "OptChat's own hooks are never left out");
  agent = { extensions: ["coding"] };
  await configureOptChat(tx, 3 as ConversationId, { enabled: true });
  assert.deepEqual(agent, { extensions: ["coding", OPTCHAT_EXTENSION, OPTCHAT_TOOLS_EXTENSION] });
  optchat = { enabled: false, name: "" };
  await assert.rejects(() => enableOptChat(tx, 3 as ConversationId, { name: " " }), /needs the agent's name/u);
  await assert.rejects(() => enableOptChat(tx, 3 as ConversationId, { name: "Grok", model: "fixture" }), /provider\/id/u);
  await assert.rejects(() => enableOptChat(tx, 3 as ConversationId, { name: "Grok", thinking: "loud" as never }), /thinking level/u);
});

// ── Pi Durable integration ───────────────────────────────────────────────────

async function fixture(t: TestContext, options: { contextWindow?: number; settings?: Record<string, unknown>; optchat?: OptChatTuning } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hui-optchat-test-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  const store = join(dir, "store");
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(cwd, "fixture.txt"), "Durable fixture content\n");
  const log = join(dir, "requests.jsonl");
  const provider = spawn(process.execPath, [fileURLToPath(new URL("../../e2e/fixtures/pi-provider-fixture.mjs", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HUI_E2E_PROVIDER_PORT: "0", HUI_E2E_WORKSPACE: cwd, HUI_E2E_PROVIDER_LOG: log },
  });
  const hosts: DurableHost[] = [];
  t.onTestFinished(async () => {
    for (const host of hosts) await host.close().catch(() => {});
    const exit = once(provider, "exit"); provider.kill(); await exit;
    await rm(dir, { recursive: true, force: true });
  });
  const [ready] = await once(provider.stdout!, "data");
  const baseUrl = String(ready).match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
  assert(baseUrl, String(ready));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
    baseUrl, api: "anthropic-messages", apiKey: "fixture-key", models: [{
      id: "fixture", name: "fixture", reasoning: true, input: ["text", "image"], contextWindow: options.contextWindow ?? 32000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture", defaultThinkingLevel: "high", ...options.settings }));
  const host = (tuning = options.optchat) => {
    const created = new DurableHost({
      dir: store, agentDir, invokeTool: async () => ({ ok: true }), lookupCaller: async () => undefined,
      ...(tuning ? { optchat: tuning } : {}),
    });
    created.configureDurableBots(createDurableBots(created, {}));
    hosts.push(created);
    return created;
  };
  const control = (path: string, method = "GET") => fetch(`${baseUrl}${path}`, { method });
  return { dir, cwd, agentDir, store, log, host, control };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A conversation created with OptChat on, in its creating commit, as a bot would be, and its session. */
async function botSession(f: Fixture, host: DurableHost, huiSessionId: string) {
  const conversation = await (await host.open()).createConversation({
    ownership: { kind: "ownerless" },
    agent: { cwd: f.cwd, model: { provider: "hui-e2e", modelId: "fixture" } },
    init: (tx, id) => enableOptChat(tx, id, { name: "Grok" }),
  }, durableContext);
  const session = await startDurable({ cwd: f.cwd, sessionFile: durableReference(conversation.id), huiSessionId }, host);
  return { session, id: conversation.id };
}

function transcriptWhere(session: DurableSession, predicate: (entries: TranscriptEntry[]) => boolean, timeoutMs = 20_000): Promise<TranscriptEntry[]> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const entries = session.transcript();
      if (!predicate(entries)) return;
      clearTimeout(timer); unsubscribe(); resolve(entries);
    };
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Expected transcript never arrived: ${JSON.stringify(session.transcript())}`)); }, timeoutMs);
    const unsubscribe = session.subscribe(() => check());
    check();
  });
}

function nextEvent(session: DurableSession, predicate: (event: RuntimeEvent) => boolean, timeoutMs = 20_000): Promise<RuntimeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Expected runtime event timed out.")); }, timeoutMs);
    const unsubscribe = session.subscribe((event) => { if (predicate(event)) { clearTimeout(timer); unsubscribe(); resolve(event); } });
  });
}

/** Resolves with the conversation's OptChat status once `done` holds, checking it on every change. */
function statusWhere(host: DurableHost, id: ConversationId, done: (status: OptChatStatus) => boolean, timeoutMs = 20_000): Promise<OptChatStatus> {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => { off(); reject(new Error("Expected OptChat status never arrived.")); }, timeoutMs);
    off = host.optchat.subscribe(id, (status) => { if (done(status)) { clearTimeout(timer); off(); resolve(status); } });
  });
}

const answers = (entries: TranscriptEntry[]) => entries.filter((item) => item.kind === "message" && item.role === "assistant").length;
async function turns(session: DurableSession, prompts: readonly string[]): Promise<void> {
  for (const text of prompts) {
    const before = answers(session.transcript());
    await session.prompt(text);
    await transcriptWhere(session, (entries) => answers(entries) > before && !session.isStreaming);
  }
}

type Block = { type: string; text?: string; cache_control?: unknown; signature?: string; name?: string };
type ProviderRequest = { system?: Block[]; tools?: Block[]; messages: { role: string; content: string | Block[] }[] };
async function providerRequests(log: string): Promise<ProviderRequest[]> {
  return completeLines(await readFile(log, "utf8")).map((line) => JSON.parse(line) as ProviderRequest);
}
const compacting = (request: ProviderRequest) => JSON.stringify(request.system ?? "").includes("You write the memory of");
const summarizing = (request: ProviderRequest) => JSON.stringify(request.system ?? "").includes("context summarization assistant");
const turnRequests = async (log: string, marker: string) => (await providerRequests(log)).filter((request) => !compacting(request) && !summarizing(request) && JSON.stringify(request.messages).includes(marker));
const blocks = (message: ProviderRequest["messages"][number]): Block[] => typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
/** The view at the head of an OptChat request (pieces joined) and the blocks after it. */
function viewOf(request: ProviderRequest): { view: string; rest: Block[]; pieces: Block[] } {
  const head = blocks(request.messages[0]!);
  const end = head.findIndex((block) => block.type === "text" && block.text!.endsWith("\n</chat>"));
  assert(head[0]?.text?.startsWith("<chat>\n") && end !== -1, JSON.stringify(head));
  return { view: head.slice(0, end + 1).map((block) => block.text).join(""), rest: head.slice(end + 1), pieces: head.slice(0, end + 1) };
}
const toolNames = (request: ProviderRequest) => (request.tools ?? []).map((tool) => tool.name);
const breakpoints = (request: ProviderRequest) => [...request.system ?? [], ...request.tools ?? [], ...request.messages.flatMap(blocks)].filter((block) => block.cache_control !== undefined).length;
/** Each block's text and whether it carries a cache mark. */
const marks = (pieces: readonly Block[]) => pieces.map((piece) => [piece.text, piece.cache_control !== undefined]);

test("a conversation without OptChat sends Durable's requests unchanged and is never offered zoom or date", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "plain" }, host);
  await turns(session, ["PLAIN_ONE first", "PLAIN_TWO second"]);
  const requests = await providerRequests(f.log);
  assert.equal(requests.length, 2, "no compactor call either");
  const [first, second] = requests as [ProviderRequest, ProviderRequest];
  assert.deepEqual(second.messages.map((message) => message.role), ["user", "assistant", "user"], "the history goes as it is");
  assert.equal(blocks(second.messages[0]!)[0]!.text, "PLAIN_ONE first");
  assert.doesNotMatch(JSON.stringify(requests), /<chat>|You keep no memory between turns/u);
  const offered = [...[...host.codingTools, ...host.huiTools, ...modelCallable(host.codemode)].map((tool) => tool.name), "message_bot"];
  assert.deepEqual([toolNames(first), toolNames(second)], [offered, offered], "the coding and HUI tools, codemode and message_bot, as before OptChat");
  assert.deepEqual((await session.inspect()).tools.map((tool) => tool.name), offered);
  const id = Number(session.sessionId) as ConversationId;
  const harness = await host.open();
  assert.deepEqual((await harness.snapshot(AgentDoc, id, durableContext))?.extensions, { add: ["hui-bot-tag"] }, "the stored agent only adds the bot tag");
  assert.equal(await harness.snapshot(OptChatDoc, id, durableContext), undefined);
  assert.equal(await host.optchat.status(id), undefined);
  assert.equal(existsSync(join(f.store, "optchat")), false, "no memory is kept");
});

test("an OptChat turn starts fresh from the view: system messages, then the view and the new message", { timeout: 45_000 }, async (t) => {
  // One line per cache block, so a view of a few lines shows where the marks go.
  const f = await fixture(t, { optchat: { blockLines: 1 } });
  const host = f.host();
  const { session, id } = await botSession(f, host, "bot-fresh");
  await turns(session, [`OPT_ONE${" kept".repeat(150)}`, "OPT_TWO next", `OPT_THREE${" kept".repeat(150)}`]);
  const [first] = await turnRequests(f.log, "OPT_ONE kept");
  const [second] = await turnRequests(f.log, "OPT_TWO next");
  const [third] = await turnRequests(f.log, "OPT_THREE kept");
  assert(first && second && third);
  assert.deepEqual([first.messages.length, viewOf(first).view, viewOf(first).rest.map((block) => block.text)], [1, "<chat>\n\n</chat>", [`OPT_ONE${" kept".repeat(150)}`]]);
  assert.equal(second.messages.length, 1, "no earlier message travels raw");
  const { view, rest, pieces } = viewOf(second);
  assert.equal(view, "<chat>\n0+1|user: FIXTURE_MEMORY OPT_ONE\n1+1|talk: Fixture response.\n</chat>", "the first turn, summarized");
  assert.deepEqual(rest.map((block) => block.text), ["OPT_TWO next"]);
  assert.doesNotMatch(JSON.stringify(second), /kept kept/u);
  assert.match(JSON.stringify(second.system), /You are Grok, an AI agent that works for one user in a single chat/u);
  assert.match(JSON.stringify(second.system), /zoom\(id, 1\) gives message id in full/u);
  assert(toolNames(second).includes("zoom") && toolNames(second).includes("date"), JSON.stringify(toolNames(second)));
  // The view goes in blocks, its last whole one marked (the first turn's view was empty: nothing more to find).
  assert.deepEqual(marks(pieces), [["<chat>\n0+1|user: FIXTURE_MEMORY OPT_ONE", false], ["\n1+1|talk: Fixture response.", true], ["\n</chat>", false]]);
  assert.equal(rest[0]!.cache_control !== undefined, true, "pi-ai's own breakpoint at the request end");
  assert.equal(breakpoints(second), 4, "the tools, the system prompt, the view and the request end");
  // The third turn marks its last whole block, and the block where the second turn's mark sat, which still starts it.
  assert.deepEqual(marks(viewOf(third).pieces), [
    ["<chat>\n0+1|user: FIXTURE_MEMORY OPT_ONE", false], ["\n1+1|talk: Fixture response.", true], ["\n2+1|user: OPT_TWO next", false],
    ["\n3+1|talk: Fixture response.", true], ["\n</chat>", false],
  ]);
  assert.deepEqual([breakpoints(third), marks(third.tools ?? []).some(([, on]) => on), marks(third.system ?? []).some(([, on]) => on)], [4, false, true], "the tools' mark gave way");
  // The long messages went to the compactor through the gateway's models: context first, in blocks like a turn's view.
  await statusWhere(host, id, (current) => current.messages === 6 && current.pending === 0);
  const compactor = (await providerRequests(f.log)).filter(compacting);
  assert.equal(compactor.length, 2, "the replies and the merges fit for free");
  const [context, step] = blocks(compactor[0]!.messages[0]!);
  assert.deepEqual([context!.text, context!.cache_control, step!.cache_control !== undefined], ["<chat>\n\n</chat>", undefined, true], "an empty context: no block to mark");
  assert(step!.text!.startsWith(`For scale, the line of dashes below is exactly 512 bytes:\n${"-".repeat(512)}\n\n`), String(step!.text));
  assert.match(JSON.stringify(compactor[0]!.system), /You write the memory of Grok/u);
  const later = blocks(compactor[1]!.messages[0]!);
  assert.deepEqual(marks(later.slice(0, -1)), [
    ["<chat>\nuser: FIXTURE_MEMORY OPT_ONE", false], ["\ntalk: Fixture response.", false], ["\nuser: OPT_TWO next", false],
    ["\ntalk: Fixture response.", true], ["\n</chat>", false],
  ], "the lines before the message, bare, the last whole block marked");
  assert.match(String(later.at(-1)!.text), /\nuser: OPT_THREE kept/u);
  const status = await statusWhere(host, id, (current) => current.messages === 6);
  assert.equal(status.usage.calls, 2);
});

test("the compactor's size loop runs through the provider and keeps the shortest line", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const { session } = await botSession(f, host, "bot-oversize");
  await turns(session, [`OPT_BIG E2E_OVERSIZE_MEMORY${" kept".repeat(150)}`, "OPT_NEXT"]);
  const calls = (await providerRequests(f.log)).filter(compacting);
  assert.deepEqual(calls.map((call) => call.messages.length), [1, 3], "the second try in the same conversation");
  const [, , feedback] = calls[1]!.messages;
  const reply = `FIXTURE_MEMORY ${"oversize ".repeat(70)}`;
  const oversize = reply.trim();
  assert.equal(blocks(calls[1]!.messages[1]!)[0]!.text, reply, "the model's reply goes back as it came");
  assert.equal(blocks(feedback!).at(-1)!.text, `That line is ${Buffer.byteLength(oversize)} bytes; the limit is 512. It must end where it is cut here:\n${oversize.slice(0, 512)}| ← LIMIT`);
  const [next] = await turnRequests(f.log, "OPT_NEXT");
  assert.equal(viewOf(next!).view, "<chat>\n0+1|FIXTURE_MEMORY retried, now short\n1+1|talk: Fixture response.\n</chat>");
});

test("every request of a tool-calling run carries the same frozen view", { timeout: 45_000 }, async (t) => {
  // A small view: the run's own messages make the memory merge lines before the run's input while it runs.
  const f = await fixture(t, { optchat: { view: 120 } });
  const host = f.host();
  const session = await startDurable({ cwd: f.cwd, huiSessionId: "bot-tools" }, host);
  await configureOptChat(session.conversation(), { enabled: true, name: "Grok" });
  const id = Number(session.sessionId) as ConversationId;
  await turns(session, ["OPT_FIRST hello"]);
  await statusWhere(host, id, (status) => status.messages === 2 && status.pending === 0);
  await turns(session, ["E2E_RICH read the fixture"]);
  const requests = await turnRequests(f.log, "E2E_RICH read the fixture");
  assert.equal(requests.length, 2, "the answer with its tool call, then the answer after the result");
  const [call, answer] = requests as [ProviderRequest, ProviderRequest];
  assert.equal(viewOf(call).view, "<chat>\n0+1|user: OPT_FIRST hello\n1+1|talk: Fixture response.\n</chat>");
  assert.equal(viewOf(answer).view, viewOf(call).view, "frozen for the whole run");
  assert.deepEqual(answer.messages.map((message) => message.role), ["user", "assistant", "user"]);
  const step = blocks(answer.messages[1]!);
  assert(step.some((block) => block.type === "thinking" && block.signature === "e2e-signature"), "the step goes back verbatim, signature included");
  assert(step.some((block) => block.type === "tool_use" && block.name === "read"));
  assert.equal(blocks(answer.messages[2]!)[0]!.type, "tool_result");
  // Meanwhile the memory merged the run's first two lines into one: only the freeze kept the view the same.
  assert.match(String(await host.optchat.view(id)), /^<chat>\n0\+(?:2|4|8)\|user: OPT_FIRST hello talk: Fixture response\./u);
});

test("zoom and date answer from the memory in the spec's formats", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const { session, id } = await botSession(f, host, "bot-zoom");
  await turns(session, ["OPT_ZOOM_SOURCE first line\nsecond line", "E2E_ZOOM please"]);
  const output = (callId: string) => {
    const tool = session.transcript().find((item) => item.kind === "tool" && item.id === callId);
    assert(tool?.kind === "tool" && tool.failed === false, JSON.stringify(tool));
    return tool.output;
  };
  assert.equal(output("tool-e2e-zoom-message"), "0+0|user: OPT_ZOOM_SOURCE first line\nsecond line", "zoom(id, 1): the message whole");
  assert.equal(output("tool-e2e-zoom-lines"), "0+1|user: OPT_ZOOM_SOURCE first line second line\n1+1|talk: Fixture response.");
  assert.equal(output("tool-e2e-zoom-missing"), "No line 1+2.");
  const date = output("tool-e2e-date");
  assert.match(String(date), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}$/u);
  assert.equal(date, await host.optchat.date(id, 0));
  assert.equal(await host.optchat.zoom(id, 0, 1), "0+0|user: OPT_ZOOM_SOURCE first line\nsecond line");
  const page = await host.optchat.html(id);
  assert(page?.includes("OPT_ZOOM_SOURCE first line"), "the browse page holds the log");
});

test("OptChat declines Durable's compactions; other conversations still compact", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, { contextWindow: 200_000, settings: { compaction: { keepRecentTokens: 40 } } });
  const host = f.host();
  const long = (marker: string) => `${marker}${" kept".repeat(400)}`;
  const compacted = async (session: DurableSession) => {
    const ended = nextEvent(session, (event) => event.type === "compaction_end");
    await session.compact();
    return ended;
  };
  const plain = await startDurable({ cwd: f.cwd, huiSessionId: "plain-compact" }, host);
  await turns(plain, ["PLAIN_C1 first", "PLAIN_C2 second", long("PLAIN_C3")]);
  const done = await compacted(plain);
  assert(done.type === "compaction_end" && done.outcome === "done", JSON.stringify(done));
  assert(plain.transcript().some((item) => item.kind === "compaction"), "a summary is placed");

  const { session } = await botSession(f, host, "bot-compact");
  await turns(session, ["OPT_C1 first", "OPT_C2 second", long("OPT_C3")]);
  const declined = await compacted(session);
  assert(declined.type === "compaction_end" && declined.outcome !== "done", JSON.stringify(declined));
  assert.equal(session.transcript().some((item) => item.kind === "compaction"), false, "no summary entry");
  assert(!(await providerRequests(f.log)).some((request) => summarizing(request) && JSON.stringify(request).includes("OPT_C")), "nothing was sent to summarize");
});

test("a restart catches the log up from Durable without duplicates, and a resent request is the same", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const first = f.host();
  const { session, id } = await botSession(f, first, "bot-restart");
  await turns(session, ["OPT_R1 one", "OPT_R2 two"]);
  const built = await statusWhere(first, id, (status) => status.messages === 4 && status.pending === 0);
  const view = await first.optchat.view(id);
  session.dispose();
  await first.close();

  // An entry committed while no gateway follows the conversation.
  const raw = await Harness.open(await openNodeSqliteStorage(join(f.store, "harness.sqlite")), { models: {} as Models, registry: createRegistry() }, durableContext);
  const conversation = (await raw.conversation(id, durableContext))!;
  await conversation.commit((tx) => tx.appendEntry(UserEntry, id, { model: [user("OPT_OFFLINE written while closed", Date.now())] }), durableContext);
  await raw.close(durableContext);

  const second = f.host();
  await second.open();
  const caught = await statusWhere(second, id, (status) => status.messages === 5 && status.pending === 0);
  assert.equal(caught.built, built.built + 1, "one more line: it completes no merge yet");
  const lines = (await Promise.all((await readdir(join(f.store, "optchat", String(id), "main"))).sort().map((name) => readFile(join(f.store, "optchat", String(id), "main", name), "utf8"))))
    .join("").trim().split("\n").map((line) => JSON.parse(line) as { i: number; kind: string; text: string; src: { entry: number; part: number } });
  assert.deepEqual(lines.map((line) => [line.i, line.kind, line.text]), [
    [0, "user", "OPT_R1 one"], [1, "talk", "Fixture response."], [2, "user", "OPT_R2 two"], [3, "talk", "Fixture response."], [4, "user", "OPT_OFFLINE written while closed"],
  ]);
  assert.equal(new Set(lines.map((line) => `${line.src.entry}:${line.src.part}`)).size, 5, "no entry projected twice");
  assert(existsSync(join(f.store, "optchat", String(id), "view.json")), "the views were saved");
  assert(String(await second.optchat.view(id)).startsWith(view!.slice(0, -"\n</chat>".length)), "the view loads as it was saved, plus the new line");

  // A request cut off mid-response is resent after the restart with the same frozen view: the same request.
  await (await (await second.open()).conversation(id, durableContext))!.submit({ type: "input", content: [{ type: "text", text: "E2E_REPLAY OPT_RERUN" }] }, durableContext);
  assert.equal((await f.control("/control/wait-held?count=1")).status, 200);
  await second.close();
  // This gateway's view is much smaller, so the saved one merges at once: only the run's frozen view can make the same
  // request.
  const third = f.host({ view: 40 });
  await third.open();
  assert.equal((await f.control("/control/wait-held?count=2")).status, 200, "Durable resent the request");
  const resent = await turnRequests(f.log, "OPT_RERUN");
  assert.equal(resent.length, 2);
  assert.deepEqual(resent[1], resent[0]);
  assert.equal(viewOf(resent[0]!).view, `${view!.slice(0, -"\n</chat>".length)}\n4+1|user: OPT_OFFLINE written while closed\n</chat>`);
  assert.doesNotMatch(String(await third.optchat.view(id)), /\n0\+1\|/u, "the smaller view merged those lines");
  const runs = (await readFile(join(f.store, "optchat", String(id), "runs.jsonl"), "utf8")).trim().split("\n");
  assert.equal(runs.length, 3, "one frozen view per run, written once: two turns and the resent run");
  await f.control("/control/release-replay", "POST");
  await (await (await third.open()).conversation(id, durableContext))!.waitForIdle(durableContext);
});

test("a turn waits while the view has a line to summarize, says so, and goes on once it is built; Stop ends the wait", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const { session, id } = await botSession(f, host, "bot-settle");
  await turns(session, [`OPT_SETTLE E2E_HOLD_MEMORY${" kept".repeat(150)}`]);
  assert.equal((await f.control("/control/wait-held?count=1")).status, 200, "the compactor holds the summary of the first message");
  const waiting = statusWhere(host, id, (status) => status.waiting === true);
  await session.prompt("OPT_AFTER_SETTLE");
  await waiting;
  assert.equal(session.isStreaming, true);
  assert.deepEqual(await turnRequests(f.log, "OPT_AFTER_SETTLE"), [], "no request while a line is unsummarized");
  await f.control("/control/release-replay", "POST");
  await transcriptWhere(session, (entries) => answers(entries) === 2 && !session.isStreaming);
  const [request] = await turnRequests(f.log, "OPT_AFTER_SETTLE");
  assert.match(viewOf(request!).view, /0\+1\|user: FIXTURE_MEMORY OPT_SETTLE/u);
  assert.equal((await host.optchat.status(id))?.waiting, undefined);

  await turns(session, [`OPT_HOLD_AGAIN E2E_HOLD_MEMORY${" kept".repeat(150)}`]);
  assert.equal((await f.control("/control/wait-held?count=2")).status, 200);
  const waitingAgain = statusWhere(host, id, (status) => status.waiting === true);
  await session.prompt("OPT_STOPPED");
  await waitingAgain;
  await session.abort();
  assert.equal(session.isStreaming, false);
  assert.equal((await host.optchat.status(id))?.waiting, undefined, "Stop ended the wait");
  assert.deepEqual(await turnRequests(f.log, "OPT_STOPPED"), [], "the stopped turn sent nothing");
  assert.equal(answers(session.transcript()), 3, "its message stays in the log, unanswered");
  await f.control("/control/release-replay", "POST");
});


test("a call's record lands in the chat as one card and in OptChat's view, and the next turn sees it", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const host = f.host();
  const { session, id } = await botSession(f, host, "bot-call");
  const conversations = durableBotConversations(host, optChatBotMemory(host));
  const refreshed = nextEvent(session, (event) => event.type === "history");
  const start = Date.parse("2026-10-06T14:00:00Z");
  const record: CallRecord = {
    call: "call-1", bot: "Ada", startedAt: start, endedAt: start + 60_000, summary: "**To remember**: the sister's birthday is March 3.",
    lines: [
      { role: "user", text: "Remember that my sister's birthday is March 3.", at: start + 1_000 },
      { role: "assistant", text: "Got it: March 3.", at: start + 3_000 },
    ],
  };
  await conversations.writeCallRecord(durableReference(id), record);
  await refreshed;
  const shown = await transcriptWhere(session, (entries) => entries.some((entry) => entry.kind === "call"));
  assert.deepEqual(shown.filter((entry) => entry.kind === "call"), [{ kind: "call", ...record }], "one card with the summary and the whole transcript");
  await statusWhere(host, id, (status) => status.messages === 2 && status.pending === 0);
  const view = await host.optchat.view(id);
  assert.match(view ?? "", /0\+1\|user: \[call\] A voice call with Ada \(2026-10-06 14:00 UTC, about 1 min\)\. Transcript:/u);
  assert.match(view ?? "", /User: Remember that my sister's birthday is March 3\./u);
  assert.match(view ?? "", /1\+1\|talk: \[call\] Ada's summary of that call: \*\*To remember\*\*: the sister's birthday is March 3\./u);
  await turns(session, ["OPT_AFTER_CALL when is it?"]);
  const [turn] = await turnRequests(f.log, "OPT_AFTER_CALL when is it?");
  assert.match(viewOf(turn!).view, /User: Remember that my sister's birthday is March 3\./u, "the bot's next turn starts from a view holding the call");
  assert.equal(session.transcript().filter((entry) => entry.kind === "message").length, 2, "no turn ran for the call");
});
