import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { lowestThinkingLevel, offIsSent, withUpstreamThinkingMap, type ThinkingModel } from "./thinking-level.ts";
import { runPiUtilityPrompt } from "./pi.ts";

const completions = (extra: Partial<ThinkingModel> = {}): ThinkingModel => ({ api: "openai-completions", reasoning: true, ...extra });

test("off is kept wherever PI sends an explicit disabled value", () => {
  assert.equal(lowestThinkingLevel({ api: "openai-completions", reasoning: false }), "off");
  assert.equal(lowestThinkingLevel(completions({ thinkingLevelMap: { off: "none", minimal: null, low: "low" } })), "off");
  assert.equal(lowestThinkingLevel({ api: "anthropic-messages", reasoning: true }), "off");
  assert.equal(lowestThinkingLevel({ api: "openai-responses", reasoning: true }), "off");
  assert.equal(lowestThinkingLevel(completions({ compat: { thinkingFormat: "qwen" } })), "off");
});

test("an unsent off falls back to the cheapest level the model accepts", () => {
  // Unmapped chat-completions model: nothing would be sent for off.
  assert.equal(offIsSent(completions()), false);
  assert.equal(lowestThinkingLevel(completions()), "low", "minimal is not assumed without a mapping");
  assert.equal(lowestThinkingLevel(completions({ thinkingLevelMap: { minimal: "minimal" } })), "minimal");
  // GPT-5.6 Luna style: off and minimal unsupported.
  assert.equal(lowestThinkingLevel({ api: "openai-responses", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low" } }), "low");
  assert.equal(lowestThinkingLevel(completions({ thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high" } })), "high");
});

test("a gateway entry borrows the upstream catalog map only when it has none", () => {
  const upstream = { api: "openai-completions", reasoning: true, thinkingLevelMap: { off: "none" } };
  const lookup = (provider: string, id: string) => provider === "baseten" && id === "deepseek-ai/DeepSeek-V4.1-Flash" ? upstream : undefined;
  const gateway: ThinkingModel & { id: string } = { id: "baseten/deepseek-ai/DeepSeek-V4.1-Flash", api: "openai-completions", reasoning: true };
  assert.deepEqual(withUpstreamThinkingMap(gateway, lookup).thinkingLevelMap, { off: "none" });
  const mapped = { ...gateway, thinkingLevelMap: { off: null } };
  assert.equal(withUpstreamThinkingMap(mapped, lookup), mapped, "an explicit map wins");
  const otherApi = { ...gateway, api: "anthropic-messages" };
  assert.equal(withUpstreamThinkingMap(otherApi, lookup).thinkingLevelMap, undefined);
  assert.equal(withUpstreamThinkingMap({ ...gateway, id: "unknown/model" }, lookup).thinkingLevelMap, undefined);
});

test("utility calls send the cheapest level a gateway model accepts", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-utility-thinking-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]) response.write("data: " + JSON.stringify(chunk) + "\n\n");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const previous = { ...process.env };
  t.onTestFinished(async () => {
    process.env = previous;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  delete process.env["HUI_PI_CLI"];
  process.env["HOME"] = dir;
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
  process.env["HUI_PI_BACKEND"] = "sdk";
  const model = (id: string) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { gw: {
    baseUrl: "http://127.0.0.1:" + address.port + "/v1", api: "openai-completions", apiKey: "***",
    // The first id names PI's built-in Baseten model; the second has no upstream.
    models: [model("baseten/deepseek-ai/DeepSeek-V4.1-Flash"), model("private/reasoner")],
  } } }));
  assert.equal(await runPiUtilityPrompt({ cwd: dir, agentDir, model: "gw/baseten/deepseek-ai/DeepSeek-V4.1-Flash", prompt: "Say ok" }), "ok");
  assert.equal(await runPiUtilityPrompt({ cwd: dir, agentDir, model: "gw/private/reasoner", prompt: "Say ok" }), "ok");
  assert.equal(bodies[0]?.["reasoning_effort"], "none", "the upstream map turns reasoning off explicitly");
  assert.equal(bodies[1]?.["reasoning_effort"], "low", "an unknown map gets the cheapest standard effort, not the provider default");
});
