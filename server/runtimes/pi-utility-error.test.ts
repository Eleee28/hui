import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { isRetryableUtilityError, runPiUtilityPrompt } from "./pi.ts";

function fixtureProvider(dir: string, port: number) {
  return writeFile(join(dir, "agent", "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:" + port, api: "anthropic-messages", apiKey: "***",
    models: [{ id: "mini", name: "Fixture Mini", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
}

test("a utility call that only reasons says so instead of reporting an empty answer", { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-utility-reasoning-"));
  await mkdir(join(dir, "agent"));
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the model request. */ }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "mini", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering the parent candidates at length" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 812 } },
      { type: "message_stop" },
    ]) response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
    response.end();
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
  process.env["PI_CODING_AGENT_DIR"] = join(dir, "agent");
  process.env["XDG_CONFIG_HOME"] = join(dir, "config");
  process.env["HUI_PI_BACKEND"] = "sdk";
  await fixtureProvider(dir, address.port);
  await assert.rejects(
    runPiUtilityPrompt({ cwd: dir, agentDir: join(dir, "agent"), model: "fixture/mini", prompt: "Say hello" }),
    (error) => /returned only reasoning and no answer after \d+s \(812 output tokens\)/u.test(String(error)) && isRetryableUtilityError(error),
  );
});

test("a utility call reports the provider's error instead of an empty answer", { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-utility-error-"));
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the model request. */ }
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Fixture provider refused the request" } }));
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
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: "http://127.0.0.1:" + address.port, api: "anthropic-messages", apiKey: "fixture-key",
    models: [{ id: "mini", name: "Fixture Mini", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await assert.rejects(
    runPiUtilityPrompt({ cwd: dir, agentDir, model: "fixture/mini", prompt: "Say hello" }),
    (error) => /Fixture provider refused the request/u.test(String(error)) && !isRetryableUtilityError(error),
  );
});
