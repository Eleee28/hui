import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, type TestContext } from "vitest";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { normalizeSettings } from "../hui-settings.ts";
import type { AgentToolInvocation } from "../agent-tools/bridge.ts";
import type { BotMemory } from "./memory.ts";

// HUI's configuration directory is resolved at import time, and PI finds skills in ~/.agents/skills: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-bot-routines-tool-home-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
afterAll(() => rm(root, { recursive: true, force: true }));
const { DurableHost, durableContext } = await import("../runtimes/durable-host.ts");
const { startDurable, durableConversationId } = await import("../runtimes/durable.ts");
const { BotDoc } = await import("./durable.ts");
const { durableBotConversations } = await import("./conversations.ts");
const { builtinBotOffer, createDurableBots, describeTool, POWERFUL_TOOLS } = await import("./durable-access.ts");
const { ROUTINES_TOOL } = await import("./durable-routines.ts");
type DurableHost = import("../runtimes/durable-host.ts").DurableHost;

function fakeMemory(): BotMemory {
  return {
    enable: async () => {}, configure: async () => {}, disable: async () => {}, purge: async () => {}, status: async () => undefined,
    view: async () => "", zoom: async () => "", html: async () => "", subscribe: () => () => {},
  };
}

/** A real host; no request reaches a model, so its provider is never contacted. */
async function fixture(t: TestContext, answer: (invocation: AgentToolInvocation) => unknown = () => ({ text: "You have no routines." })) {
  const dir = await mkdtemp(join(tmpdir(), "hui-bot-routines-tool-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "hui-e2e": {
    baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", apiKey: "***", models: [{
      id: "fixture", name: "fixture", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));
  const invocations: AgentToolInvocation[] = [];
  const host: DurableHost = new DurableHost({
    dir: join(dir, "store"), agentDir,
    readSettings: async () => normalizeSettings(undefined),
    invokeTool: async (invocation) => { invocations.push(invocation); return answer(invocation); },
    lookupCaller: async () => undefined,
  });
  host.configureDurableBots(createDurableBots(host, {}));
  t.onTestFinished(async () => {
    await host.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const port = durableBotConversations(host, fakeMemory());
  /** A bot's chat with `disabledTools` off, open as the HUI session `huiSessionId`. */
  const bot = async (disabledTools: string[], huiSessionId: string) => {
    const reference = await port.create({ botId: `bot-${huiSessionId}`, cwd, memory: { name: "Ada" } });
    const id = durableConversationId(reference)!;
    await (await host.open()).commit(async (tx) => { (await tx.doc(BotDoc, id)).disabledTools = [...disabledTools]; }, durableContext);
    const session = await startDurable({ cwd, sessionFile: reference, huiSessionId }, host);
    return { id, session };
  };
  const harness = await host.open();
  const api = (conversationId: ConversationId) => ({
    conversationId, callId: `call-${String(conversationId)}`,
    snapshot: (doc: never, conversation: ConversationId, context: never) => harness.snapshot(doc, conversation, context),
  }) as unknown as ToolExecutionApi;
  const tool = host.botTools.find((candidate) => candidate.name === ROUTINES_TOOL)!;
  return { cwd, host, invocations, bot, api, tool };
}

const textOf = (result: { output?: unknown }) => JSON.stringify(result.output);

test("routines is a bot tool of the hui-bots-tools extension: it asks HUI as the chat's session, and only from a bot's chat", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, (invocation) => invocation.params["action"] === "add"
    ? Promise.reject(new Error("This turn answers a message from @bob: another bot can't make you add or change routines."))
    : { text: "You have no routines." });
  assert.ok(f.tool, "in the extension only bots' chats select");
  const { id, session } = await f.bot([], "ada-chat");
  const listed = await f.tool.execute({ action: "list" } as never, f.api(id), BACKGROUND_CONTEXT);
  assert.equal(listed.isError, undefined);
  assert.match(textOf(listed), /You have no routines\./u);
  const params = { action: "add", name: "Watch #82", prompt: "Check PR #82.", every: "5m", until: "2030-01-01T18:00:00.000Z", runs: 3 };
  const refused = await f.tool.execute(params as never, f.api(id), BACKGROUND_CONTEXT);
  assert.equal(refused.isError, true, "HUI's refusal is the model's to read");
  assert.match(textOf(refused), /another bot can't make you add or change routines/u);
  // With who brought each input of the run it is called in: none here, outside any run.
  assert.deepEqual(f.invocations, [
    { callerSessionId: "ada-chat", action: ROUTINES_TOOL, params: { action: "list" }, runOrigins: [] },
    { callerSessionId: "ada-chat", action: ROUTINES_TOOL, params, runOrigins: [] },
  ], "HUI acts as the chat's session, with what the model gave");
  const notABot = await f.tool.execute({ action: "list" } as never, { conversationId: 7 as unknown as ConversationId, snapshot: async () => undefined } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
  assert.equal(notABot.isError, true);
  assert.match(textOf(notABot), /routines is only available in a bot's chat/u);
  assert.equal(f.invocations.length, 2, "nothing reached HUI from outside a bot's chat");
  const offered = (await session.inspect()).tools.find((candidate) => candidate.name === ROUTINES_TOOL);
  assert.equal(offered?.source, "HUI");
  const plain = await startDurable({ cwd: f.cwd, huiSessionId: "plain" }, f.host);
  assert.equal((await plain.inspect()).tools.some((candidate) => candidate.name === ROUTINES_TOOL), false, "an ordinary session never has it");
});

test("the Tools catalog offers it as a normal switch, Manage its own routines, on by default and not powerful; off, it leaves the offer and the bridge refuses it", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const entry = { name: ROUTINES_TOOL, label: "Manage its own routines", description: "List, add, change and remove its own routines, temporary ones included", group: "bots", source: "HUI", powerful: false };
  assert.deepEqual(describeTool({ name: ROUTINES_TOOL }, { kind: "bot" }), entry);
  assert.deepEqual((await builtinBotOffer(f.host)).find((tool) => tool.name === ROUTINES_TOOL), entry, "listed while its chat isn't running too");
  assert.equal(POWERFUL_TOOLS.has(ROUTINES_TOOL), false);
  const on = await f.bot([], "on-chat");
  assert.deepEqual(on.session.botOffer().find((tool) => tool.name === ROUTINES_TOOL), entry, "on, and the operator's to turn off");
  const off = await f.bot([ROUTINES_TOOL], "off-chat");
  assert.equal((await off.session.inspect()).tools.some((tool) => tool.name === ROUTINES_TOOL), false, "turned off, it isn't offered");
  assert.ok(off.session.botOffer().some((tool) => tool.name === ROUTINES_TOOL), "and the catalog still lists it, off");
  const refused = await f.tool.execute({ action: "list" } as never, f.api(off.id), BACKGROUND_CONTEXT);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /The operator turned off routines in this bot's chat\. Ask for it with request_access/u);
  assert.equal(f.invocations.length, 0, "the bridge refused it before HUI");
});
