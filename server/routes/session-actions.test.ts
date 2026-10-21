import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expectTypeOf, test } from "vitest";
import { waitFor } from "../test-support/wait-for.ts";
import { RuntimeInspection, SessionTools } from "../api/tools.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { SessionClearResponse, SessionCommandsResponse, SessionModelResponse, SessionModelsResponse, SessionOpenResponse, SessionStreamFrame, SessionThinkingResponse, SideQuestionResult } from "../api/session-events.ts";

// One isolated gateway on Pi Durable: its home, HUI's directory, PI's agent directory and a deterministic provider,
// all temporary.
const dir = await mkdtemp(join(tmpdir(), "hui-prompt-routes-"));
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
  baseUrl: providerUrl, api: "anthropic-messages", apiKey: "***", models: [{
    id: "fixture", name: "fixture", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
} } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "hui-e2e", defaultModel: "fixture" }));

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
  // A finished turn saves its unread and run flags in the background; one may land while this deletes.
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function call(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin + path, {
    method,
    headers: { "x-hui": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** The prompts the session holds with `text` in them. */
const prompts = (id: string, text: string) => liveSessions.transcript(id)
  .filter((entry) => entry.kind === "message" && entry.role === "user" && entry.text.includes(text)).length;

/** Until the session is idle with a reply after the latest prompt holding `text`: that turn is over. */
async function answered(id: string, text: string): Promise<void> {
  await waitFor(`the reply to ${text}`, () => {
    const entries = liveSessions.transcript(id);
    const prompt = entries.findLastIndex((entry) => entry.kind === "message" && entry.role === "user" && entry.text.includes(text));
    const replied = prompt >= 0 && entries.slice(prompt + 1).some((entry) => entry.kind === "message" && entry.role === "assistant");
    return replied && liveSessions.status(id) === "idle";
  }, { state: () => ({ status: liveSessions.status(id), transcript: liveSessions.transcript(id) }) });
}

test("a resent request id is answered with the first send's outcome and never runs twice, whichever route it comes back through", { timeout: 60_000 }, async () => {
  const created = await call("/__hui/sessions", "POST", { cwd: workspace, title: "Resends" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = (created.body["session"] as { id: string; tool: string }).id;
  assert.equal((created.body["session"] as { tool: string }).tool, "durable");
  const cold = await call(`/__hui/sessions/${id}/tools`);
  assert.equal(cold.status, 200);
  expectSchema(SessionTools, cold.body);
  assert.deepEqual(cold.body, { status: "cold" });
  assert.equal((await call(`/__hui/sessions/${id}/open`, "POST", {})).status, 200);
  // Opening answers before the runtime is up; a prompt meanwhile is refused as still starting.
  await liveSessions.booted(id);
  await waitFor("the session's runtime", () => liveSessions.hasRuntime(id), { state: () => liveSessions.status(id) });

  const inspection = await call(`/__hui/sessions/${id}/tools`);
  assert.equal(inspection.status, 200);
  expectSchema(RuntimeInspection, inspection.body);

  const first = await call(`/__hui/sessions/${id}/prompt`, "POST", { text: "RESEND_ONE", requestId: "req-1" });
  assert.deepEqual(first, { status: 200, body: { ok: true } });
  await answered(id, "RESEND_ONE");
  // The browser gave up waiting, so the composer sends it again; with the run over it would have started another.
  const resent = await call(`/__hui/sessions/${id}/follow-up`, "POST", { text: "RESEND_ONE", requestId: "req-1" });
  assert.deepEqual(resent, { status: 200, body: { ok: true, duplicate: true } });
  assert.equal(liveSessions.status(id), "idle", "nothing started");
  assert.equal(prompts(id, "RESEND_ONE"), 1);

  // Both on their way at once: one runs, the other waits for it instead of hitting "already working".
  const together = await Promise.all([
    call(`/__hui/sessions/${id}/prompt`, "POST", { text: "RESEND_TWO", requestId: "req-2" }),
    call(`/__hui/sessions/${id}/prompt`, "POST", { text: "RESEND_TWO", requestId: "req-2" }),
  ]);
  assert.deepEqual(together.map((reply) => reply.status), [200, 200], JSON.stringify(together));
  assert.deepEqual(together.map((reply) => reply.body["duplicate"] === true).sort(), [false, true]);
  await answered(id, "RESEND_TWO");
  assert.equal(prompts(id, "RESEND_TWO"), 1);

  // Without an id every send runs, as before; a malformed id is refused before anything runs.
  const plain = await call(`/__hui/sessions/${id}/prompt`, "POST", { text: "RESEND_THREE" });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  await answered(id, "RESEND_THREE");
  const again = await call(`/__hui/sessions/${id}/prompt`, "POST", { text: "RESEND_THREE" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  await answered(id, "RESEND_THREE");
  assert.equal(prompts(id, "RESEND_THREE"), 2);
  const refused = await call(`/__hui/sessions/${id}/prompt`, "POST", { text: "RESEND_FOUR", requestId: "has spaces" });
  assert.equal(refused.status, 400);
  assert.equal(prompts(id, "RESEND_FOUR"), 0);
});

test("writing to an archived conversation restores it", { timeout: 60_000 }, async () => {
  const { readRegistry } = await import("../sessions/sessions.ts");
  const created = await call("/__hui/sessions", "POST", { cwd: workspace, title: "Archived" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = (created.body["session"] as { id: string }).id;
  assert.equal((await call(`/__hui/sessions/${id}`, "PATCH", { archived: true })).status, 200);
  assert.equal((await call(`/__hui/sessions/${id}/open`, "POST", {})).status, 200);
  await liveSessions.booted(id);
  await waitFor("the session's runtime", () => liveSessions.hasRuntime(id), { state: () => liveSessions.status(id) });

  const sent = await call(`/__hui/sessions/${id}/prompt`, "POST", { text: "BACK_AGAIN" });
  assert.deepEqual(sent, { status: 200, body: { ok: true } });
  assert.equal((await readRegistry()).find((record) => record.id === id)?.archived, undefined);
  await answered(id, "BACK_AGAIN");
});

test("session catalogs, preferences and side answers match their published schemas", { timeout: 60_000 }, async () => {
  expectTypeOf<{ question: string; answer: string; model: string }>().toEqualTypeOf<SideQuestionResult>();
  const created = await call("/__hui/sessions", "POST", { cwd: workspace, title: "Catalogs" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = (created.body["session"] as { id: string }).id;
  const cold = await call(`/__hui/sessions/${id}/thinking`);
  assert.equal(cold.status, 200);
  expectSchema(SessionThinkingResponse, cold.body);
  assert.equal((await call(`/__hui/sessions/${id}/open`, "POST", {})).status, 200);
  await liveSessions.booted(id);

  for (const [action, schema] of [["models", SessionModelsResponse], ["commands", SessionCommandsResponse]] as const) {
    const result = await call(`/__hui/sessions/${id}/${action}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    expectSchema(schema, result.body);
  }
  const model = await call(`/__hui/sessions/${id}/model`, "POST", { provider: "hui-e2e", modelId: "fixture" });
  assert.equal(model.status, 200, JSON.stringify(model.body));
  expectSchema(SessionModelResponse, model.body);
  const thinking = await call(`/__hui/sessions/${id}/thinking`, "POST", { level: "low" });
  assert.equal(thinking.status, 200, JSON.stringify(thinking.body));
  expectSchema(SessionThinkingResponse, thinking.body);
  assert.equal(thinking.body.level, "low");
  assert.equal((await call("/__hui/settings", "PUT", { models: { utility: "hui-e2e/fixture" } })).status, 200);
  const side = await call(`/__hui/sessions/${id}/btw`, "POST", { question: "What is this session about?" });
  assert.equal(side.status, 200, JSON.stringify(side.body));
  expectSchema(SideQuestionResult, side.body);
  assert.equal(side.body.question, "What is this session about?");
});

test("a session's open, event stream and clear payloads match their published schemas", { timeout: 60_000 }, async () => {
  const created = await call("/__hui/sessions", "POST", { cwd: workspace, title: "Streamed" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = (created.body["session"] as { id: string }).id;
  const opened = await call(`/__hui/sessions/${id}/open`, "POST", {});
  assert.equal(opened.status, 200);
  expectSchema(SessionOpenResponse, opened.body);
  await liveSessions.booted(id);
  await waitFor("the session's runtime", () => liveSessions.hasRuntime(id), { state: () => liveSessions.status(id) });

  const stream = new AbortController();
  const response = await fetch(`${origin}/__hui/sessions/${id}/events`, { headers: { "x-hui": "1" }, signal: stream.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const frames: unknown[] = [];
  let buffered = "";
  const settled = () => frames.some((frame) => (frame as { data: { type?: string } }).data.type === "settled");
  const reading = (async () => {
    while (!settled()) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += value;
      for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const event = block.match(/^event: (.+)$/mu)?.[1];
        const data = block.match(/^data: (.+)$/mu)?.[1];
        if (event && data) frames.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  await waitFor("the first snapshot", () => frames.length > 0, { state: () => frames });
  assert.deepEqual((await call(`/__hui/sessions/${id}/prompt`, "POST", { text: "STREAMED_ONE" })).status, 200);
  await reading;
  stream.abort();
  const kinds = new Set(frames.map((frame) => (frame as { event: string }).event));
  assert.ok(["snapshot", "status", "event"].every((kind) => kinds.has(kind)), [...kinds].join());
  for (const frame of frames) expectSchema(SessionStreamFrame, frame);
  await answered(id, "STREAMED_ONE");

  const cleared = await call(`/__hui/sessions/${id}/clear`, "POST", {});
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  expectSchema(SessionClearResponse, cleared.body);
});
