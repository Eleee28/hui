import assert from "node:assert/strict";
import { test, type TestContext } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderAccounts, credentialStore } from "../pi/provider-accounts.ts";
import { createSessionModelRuntime, writeProviderSelections } from "./hui-models.ts";
import { quotaFailure, retryAt } from "./provider-account-routing.ts";

type Stream = ReturnType<ModelRuntime["streamSimple"]>;
type Message = Awaited<ReturnType<Stream["result"]>>;
const piAiPackage = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"))!;
const { AssistantMessageEventStream } = await import(new URL("./dist/utils/event-stream.js", pathToFileURL(piAiPackage)).href) as { AssistantMessageEventStream: new() => Stream };
const second = "11111111-1111-4111-8111-111111111111";
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "hui-account-routing-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const accounts = new ProviderAccounts(dir);
  await credentialStore(accounts.authPath()).modify("openai", async () => ({ type: "api_key", key: "first-key" }));
  await credentialStore(accounts.authPath(second)).modify("openai", async () => ({ type: "api_key", key: "second-key" }));
  await accounts.update("openai", () => [{ id: "default", name: "First" }, { id: second, name: "Second" }]);
  await writeProviderSelections({ openai: { models: ["gpt-4o"] } }, dir);
  const runtime = await createSessionModelRuntime(join(dir, "pi"), dir);
  const model = runtime.getModel("openai", "gpt-4o")!;
  assert(model);
  const message = (error?: string): Message => ({ role: "assistant", content: error ? [] : [{ type: "text", text: "OK" }], api: model.api, provider: model.provider, model: model.id, stopReason: error ? "error" : "stop", ...(error ? { errorMessage: error } : {}), timestamp: Date.now(), usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const attempts: string[] = [];
  function install(handler: (key: string, output: Stream, options: Parameters<ModelRuntime["streamSimple"]>[2]) => Promise<void>) {
    const provider = runtime.getProvider("openai")!;
    runtime.registerNativeProvider({ ...provider, streamSimple: (_model, _context, options) => {
      const output = new AssistantMessageEventStream();
      const key = options?.apiKey ?? "missing"; attempts.push(key);
      void handler(key, output, options).catch((error: unknown) => { output.push({ type: "error", reason: "error", error: message(String(error)) }); }).finally(() => output.end());
      return output;
    } });
  }
  return { dir, runtime, model, message, accounts, attempts, install };
}

test("429 fails over in saved order, persists cooldown, resumes preferred account after reset", async (t) => {
  const f = await fixture(t);
  f.install(async (key, out, options) => {
    out.push({ type: "start", partial: { ...f.message(), content: [] } });
    if (key === "first-key") {
      await options?.onResponse?.({ status: 429, headers: { "Retry-After": "120" } }, f.model);
      out.push({ type: "error", reason: "error", error: f.message("quota exceeded") });
    } else out.push({ type: "done", reason: "stop", message: f.message() });
  });
  const before = Date.now();
  const stream = f.runtime.streamSimple(f.model, { messages: [] });
  const events = []; for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ["start", "done"]);
  assert.equal((await stream.result()).stopReason, "stop");
  assert.deepEqual(f.attempts, ["first-key", "second-key"]);
  assert((await new ProviderAccounts(f.dir).list("openai"))[0]!.cooldownUntil! >= before + 120_000);
  await f.runtime.completeSimple(f.model, { messages: [] });
  assert.deepEqual(f.attempts, ["first-key", "second-key", "second-key"]);
  await f.accounts.update("openai", (entries) => entries.map((a) => ({ ...a, cooldownUntil: 1 })));
  f.attempts.length = 0;
  await f.runtime.completeSimple(f.model, { messages: [] });
  assert.deepEqual(f.attempts, ["first-key", "second-key"]);
  assert(!JSON.stringify(await f.accounts.all()).includes("-key"));
});

test("non-quota errors, partial content and abort never replay the request", async (t) => {
  for (const scenario of ["server", "partial", "abort"]) {
    const f = await fixture(t);
    const controller = new AbortController();
    f.install(async (_key, out, options) => {
      if (scenario === "partial") out.push({ type: "text_delta", contentIndex: 0, delta: "already visible", partial: f.message() });
      if (scenario === "abort") controller.abort();
      await options?.onResponse?.({ status: scenario === "server" ? 500 : 429, headers: {} }, f.model);
      out.push({ type: "error", reason: scenario === "abort" ? "aborted" : "error", error: f.message("failed") });
    });
    const result = await f.runtime.completeSimple(f.model, { messages: [] }, { signal: controller.signal });
    assert.equal(result.stopReason, "error");
    assert.deepEqual(f.attempts, ["first-key"], scenario);
  }
});

test("all exhausted is bounded; cooldown survives restart; order changes apply to next call", async (t) => {
  const f = await fixture(t);
  f.install(async (_key, out) => { out.push({ type: "error", reason: "error", error: f.message("usage_limit_reached") }); });
  assert.equal((await f.runtime.completeSimple(f.model, { messages: [] })).stopReason, "error");
  assert.deepEqual(f.attempts, ["first-key", "second-key"]);
  await f.runtime.completeSimple(f.model, { messages: [] });
  assert.equal(f.attempts.length, 2);
  await f.accounts.update("openai", (entries) => entries.reverse().map(({ cooldownUntil: _until, ...a }) => a));
  f.install(async (_key, out) => { out.push({ type: "done", reason: "stop", message: f.message() }); });
  await f.runtime.completeSimple(f.model, { messages: [] });
  assert.equal(f.attempts.at(-1), "second-key");
  await f.accounts.update("openai", () => []);
  assert.match((await f.runtime.completeSimple(f.model, { messages: [] })).errorMessage!, /No provider accounts/);
});

test("in-flight requests pin credentials while another request uses reordered accounts", async (t) => {
  const f = await fixture(t);
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  f.install(async (key, out) => {
    if (key === "first-key") { entered(); await gate; }
    out.push({ type: "done", reason: "stop", message: f.message() });
  });
  const first = f.runtime.completeSimple(f.model, { messages: [] });
  await started;
  await f.accounts.update("openai", (entries) => entries.reverse());
  const next = await f.runtime.completeSimple(f.model, { messages: [] });
  release(); await first;
  assert.equal(next.stopReason, "stop");
  assert.deepEqual(f.attempts, ["first-key", "second-key"]);
  assert.match(await readFile(f.accounts.authPath(), "utf8"), /first-key/);
  assert.match(await readFile(f.accounts.authPath(second), "utf8"), /second-key/);
});

test("quota classification and provider reset headers are conservative", () => {
  assert(quotaFailure(429)); assert(quotaFailure(undefined, "insufficient_quota"));
  assert(!quotaFailure(401, "Unauthorized")); assert(!quotaFailure(500, "overloaded"));
  assert.equal(retryAt({ "retry-after": "120" }, 1000), 121000);
  assert.equal(retryAt({ "retry-after-ms": "50" }, 1000), 1050);
  assert.equal(retryAt({ "retry-after": "nonsense" }, 1000), 61000);
});

test("real PI OpenAI HTTP adapter rotates credentials after 429 and streams the second response", async (t) => {
  const f = await fixture(t);
  const { createServer } = await import("node:http");
  const keys: string[] = [];
  const server = createServer((request, response) => {
    keys.push(request.headers.authorization ?? "");
    request.resume();
    if (request.headers.authorization === "Bearer first-key") {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "180" });
      response.end(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "Quota exceeded" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id: "fixture" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg-fixture", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Second account response" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg-fixture", role: "assistant", content: [{ type: "output_text", text: "Second account response", annotations: [] }] } },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [{ type: "message", id: "msg-fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Second account response", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 } } })}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.onTestFinished(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert(address && typeof address === "object");
  const result = await f.runtime.completeSimple(f.model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}/`, init) });
  assert.equal(result.stopReason, "stop", result.errorMessage ?? "Expected successful completion");
  assert.equal(result.content.filter((c) => c.type === "text").map((c) => c.text).join(""), "Second account response");
  assert.deepEqual(keys, ["Bearer first-key", "Bearer second-key"]);
});

test("OAuth refresh writes back only to the pinned account during concurrent requests", async (t) => {
  const f = await fixture(t);
  for (const [id, refresh] of [["default", "first"], [second, "second"]] as const) {
    await credentialStore(f.accounts.authPath(id)).modify("openai", async () => ({ type: "oauth", access: `${refresh}-expired`, refresh, expires: 1 }));
  }
  let entered!: () => void; const refreshing = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = f.runtime.getProvider("openai")!;
  f.runtime.registerNativeProvider({ ...provider, auth: { oauth: {
    name: "Fixture accounts", async login() { throw new Error("Not used"); },
    async refresh(credential) {
      if (credential.refresh === "first") { entered(); await gate; }
      return { ...credential, access: `${credential.refresh}-fresh`, expires: Date.now() + 3600_000 };
    },
    async toAuth(credential) { return { apiKey: credential.access }; },
  } } });
  f.install(async (_key, out) => { out.push({ type: "done", reason: "stop", message: f.message() }); });
  const first = f.runtime.completeSimple(f.model, { messages: [] });
  await refreshing;
  await f.accounts.update("openai", (entries) => entries.reverse());
  const secondRequest = await f.runtime.completeSimple(f.model, { messages: [] });
  release(); await first;
  assert.equal(secondRequest.stopReason, "stop");
  assert.deepEqual(f.attempts, ["second-fresh", "first-fresh"]);
  const a = await credentialStore(f.accounts.authPath()).read("openai");
  const b = await credentialStore(f.accounts.authPath(second)).read("openai");
  assert(a?.type === "oauth" && b?.type === "oauth");
  assert.equal(a.access, "first-fresh"); assert.equal(b.access, "second-fresh");
  await f.runtime.refresh({ allowNetwork: false });
});
