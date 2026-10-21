import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectTypeOf, test, type TestContext, vi } from "vitest";
import { ProviderSnapshot, ProviderLogin, ProviderQuota, type ProviderModel, type ProviderSummary } from "../api/providers.ts";
import { expectSchema } from "../test-support/api-schema.ts";


type OriginalProviderModel = { id: string; name: string; contextWindow?: number; maxTokens?: number };
type OriginalProviderSummary = {
  id: string; name: string; methods: { id: "api_key" | "oauth"; label: string }[];
  accounts?: { id: string; name: string; email?: string; authenticated: boolean; cooldownUntil?: number }[];
  configured: boolean; authenticated: boolean; selected: string[]; models: OriginalProviderModel[];
};
type OriginalProviderLogin = {
  id: string; provider: string; phase: "pending" | "complete" | "failed" | "cancelled";
  accountId?: string;
  message?: string; url?: string; code?: string;
  prompt?: { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; options?: { id: string; label: string }[] };
};
type OriginalProviderSnapshot = { providers: OriginalProviderSummary[]; login?: OriginalProviderLogin };
type OriginalProviderQuota = {
  status: "available" | "unsupported" | "unavailable";
  message?: string; checkedAt: number;
  plan?: string; email?: string;
  access?: "available" | "limited";
  windows: { label: string; usedPercent: number; resetAt?: number; scope: "account" | "scoped" | "spend" }[];
};

expectTypeOf<ProviderModel>().toEqualTypeOf<OriginalProviderModel>();
expectTypeOf<ProviderSummary>().toEqualTypeOf<OriginalProviderSummary>();
expectTypeOf<ProviderLogin>().toEqualTypeOf<OriginalProviderLogin>();
expectTypeOf<ProviderSnapshot>().toEqualTypeOf<OriginalProviderSnapshot>();
expectTypeOf<ProviderQuota>().toEqualTypeOf<OriginalProviderQuota>();
import { ProviderService, ProviderInputError } from "./providers.ts";
import { createSessionModelRuntime, readProviderSelections, writeProviderSelections } from "../runtimes/hui-models.ts";
import { filterConfiguredModels } from "../runtimes/pi-models.ts";
import { waitFor } from "../test-support/wait-for.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "hui-provider-test-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return { dir, service: new ProviderService(dir) };
}
async function until<T extends object>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  return waitFor("the provider state", async () => {
    last = await read();
    return predicate(last) ? last : undefined;
  }, { state: () => last });
}

test("built-in API key login stores credentials only in HUI and redacts snapshots", async (t) => {
  const { dir, service } = await fixture(t);
  const first = await service.snapshot();
  expectSchema(ProviderSnapshot, first);
  assert(first.providers.some((provider) => provider.id === "openai-codex" && provider.methods.some((method) => method.id === "oauth")));
  const login = await service.start("openai", "api_key");
  expectSchema(ProviderLogin, login);
  const waiting = await until(() => service.snapshot(), (snapshot) => Boolean(snapshot.login?.prompt));
  expectSchema(ProviderSnapshot, waiting);
  assert.equal(waiting.login?.prompt?.type, "secret");
  assert.throws(() => service.answer(login.id, "stale", "fixture-key"), ProviderInputError);
  service.answer(login.id, waiting.login!.prompt!.id, "hui-fixture-secret-not-real");
  const complete = await until(() => service.snapshot(), (snapshot) => snapshot.login?.phase === "complete");
  assert.equal(complete.providers.find((provider) => provider.id === "openai")?.authenticated, true);
  assert(!JSON.stringify(complete).includes("hui-fixture-secret-not-real"));
  assert.equal(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).openai.key, "hui-fixture-secret-not-real");
  assert.equal((await stat(join(dir, "auth.json"))).mode & 0o777, 0o600);
  const models = complete.providers.find((provider) => provider.id === "openai")!.models.slice(0, 2);
  assert.equal(models.length, 2);
  assert(models.every((model) => (model.contextWindow ?? 0) > 0 && (model.maxTokens ?? 0) > 0));
  await service.save("openai", models.map((model) => model.id));
  assert.deepEqual((await readProviderSelections(dir)).openai?.models, models.map((model) => model.id));
  assert.equal((await service.snapshot()).login, undefined, "saving clears obsolete sign-in instructions");
  const restarted = new ProviderService(dir);
  assert.equal((await restarted.snapshot()).providers.find((provider) => provider.id === "openai")?.selected.length, 2);
  await restarted.disconnect("openai");
  assert.deepEqual(await readProviderSelections(dir), {});
  assert.equal(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).openai, undefined);
});

test("cancellation and bounded input do not save a pending credential", async (t) => {
  const { dir, service } = await fixture(t);
  await assert.rejects(service.start("custom", "api_key"), /custom providers in PI/);
  await assert.rejects(service.start("openai", "invalid"), ProviderInputError);
  const login = await service.start("openai", "api_key");
  const waiting = await until(() => service.snapshot(), (snapshot) => Boolean(snapshot.login?.prompt));
  await assert.rejects(service.start("anthropic", "api_key"), /Finish or cancel/);
  assert.throws(() => service.answer(login.id, waiting.login!.prompt!.id, "x".repeat(16385)), /valid sign-in/);
  service.cancel(login.id);
  assert.throws(() => service.answer(login.id, waiting.login!.prompt!.id, "unused"), /expired/);
  assert.equal((await service.snapshot()).login?.phase, "cancelled");
  const auth = await readFile(join(dir, "auth.json"), "utf8").catch(() => "{}");
  assert.equal(JSON.parse(auth).openai, undefined);
});

test("selection validation, concurrent saves and empty selection preserve ownership", async (t) => {
  const { dir, service } = await fixture(t);
  await assert.rejects(service.save("__proto__", []), ProviderInputError);
  await assert.rejects(service.save("openai", ["missing-model"]), ProviderInputError);
  await assert.rejects(service.save("openai", "all"), ProviderInputError);
  const snapshot = await service.snapshot();
  const openai = snapshot.providers.find((p) => p.id === "openai")!.models[0]!.id;
  const anthropic = snapshot.providers.find((p) => p.id === "anthropic")!.models[0]!.id;
  await Promise.all([service.save("openai", [openai, openai]), service.save("anthropic", [anthropic])]);
  assert.deepEqual(await readProviderSelections(dir), { openai: { models: [openai] }, anthropic: { models: [anthropic] } });
  await service.save("openai", []);
  assert.deepEqual((await readProviderSelections(dir)).openai?.models, []);
  const broken = join(dir, "models.json"); await writeFile(broken, "{");
  await assert.rejects(service.save("openai", [openai]), /configuration could not be read/);
  assert.equal(await readFile(broken, "utf8"), "{");
});

test("HUI credentials overlay built-ins without changing PI custom configuration", async (t) => {
  const { dir, service } = await fixture(t);
  const agentDir = join(dir, "pi");
  await (await import("node:fs/promises")).mkdir(agentDir);
  const pi = join(agentDir, "models.json");
  const source = JSON.stringify({ providers: { openai: { baseUrl: "https://wrong-account.invalid", apiKey: "wrong-pi-key" }, custom: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "pi-fixture", models: [{ id: "custom/model", name: "Custom", contextWindow: 32000, maxTokens: 2048 }] } } });
  await writeFile(pi, source);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "hui-key" } }), { mode: 0o600 });
  const model = (await service.snapshot()).providers.find((p) => p.id === "openai")!.models[0]!.id;
  await service.save("openai", [model]);
  const runtime = await createSessionModelRuntime(agentDir, dir);
  assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "hui-key");
  assert(!runtime.getModel("openai", model)?.baseUrl.includes("wrong-account"));
  assert.equal((await runtime.getAuth("custom"))?.auth.apiKey, "pi-fixture");
  assert(runtime.getAvailableSnapshot().some((m) => m.provider === "openai"));
  assert.equal(await readFile(pi, "utf8"), source);
  assert.equal(await readFile(join(agentDir, "auth.json"), "utf8").catch(() => "{}"), "{}");
  const catalog = runtime.getAvailableSnapshot().map(({ id, provider, name }) => ({ id, provider, name }));
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: "custom/model" }] } } }));
  const filtered = await filterConfiguredModels(catalog, dir, { openai: { models: [model] } });
  assert.deepEqual(filtered.map((m) => `${m.provider}/${m.id}`).sort(), [`openai/${model}`, "custom/custom/model"].sort());
  assert(!JSON.stringify(filtered).includes("hui-key"));
});

test("empty HUI selection is empty, PI custom selection retains exact namespaced IDs", async (t) => {
  const { dir } = await fixture(t);
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: "a/b" }] } } }));
  const catalog = [{ provider: "openai", id: "one", name: "One" }, { provider: "custom", id: "a/b", name: "Custom" }];
  assert.deepEqual(await filterConfiguredModels(catalog, dir, { openai: { models: [] } }), [catalog[1]]);
  await writeProviderSelections({ openai: { models: ["one"] } }, join(dir, "hui"));
  assert.equal((await stat(join(dir, "hui", "models.json"))).mode & 0o777, 0o600);
});

test("OAuth interaction forwards device links and prompts but never returned tokens", async (t) => {
  const { service } = await fixture(t);
  const runtime = await service.runtime();
  const base = runtime.getProvider("openai")!;
  runtime.registerNativeProvider({ ...base, id: "fixture-oauth", name: "Fixture OAuth", auth: { oauth: {
    name: "Fixture subscription",
    async login(interaction) {
      interaction.notify({ type: "device_code", userCode: "FIXTURE", verificationUri: "https://example.invalid/verify" });
      const answer = await interaction.prompt({ type: "manual_code", message: "Paste the callback" });
      assert.equal(answer, "fixture-callback");
      return { type: "oauth", access: "private-access", refresh: "private-refresh", expires: Date.now() + 3600_000 };
    },
    async refresh(credential) { return credential; },
    async toAuth(credential) { return { apiKey: credential.access }; },
  } } });
  const login = await service.start("fixture-oauth", "oauth");
  const pending = await until(() => service.snapshot(), (snapshot) => Boolean(snapshot.login?.prompt));
  assert.equal(pending.login?.url, "https://example.invalid/verify");
  assert.equal(pending.login?.code, "FIXTURE");
  service.answer(login.id, pending.login!.prompt!.id, "fixture-callback");
  const complete = await until(() => service.snapshot(), (snapshot) => snapshot.login?.phase === "complete");
  assert(!JSON.stringify(complete).includes("private-"));
  assert.equal(complete.login?.url, undefined);
  assert.equal(complete.login?.code, undefined);
});

test("the removed Claude Code CLI connection is not offered or accepted", async (t) => {
  const { service } = await fixture(t);
  assert.equal((await service.snapshot()).providers.some((provider) => provider.id === "claude-code"), false);
  await assert.rejects(service.save("claude-code", ["sonnet"]), ProviderInputError);
});

test("multiple accounts preserve legacy credentials, persist priority and isolate removal", async (t) => {
  const { dir, service } = await fixture(t);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "legacy-key" } }), { mode: 0o600 });
  await service.save("openai", []);
  const login = await service.start("openai", "api_key", { name: "Backup" });
  const waiting = await until(() => service.snapshot(), (s) => Boolean(s.login?.prompt));
  service.answer(login.id, waiting.login!.prompt!.id, "backup-key");
  const complete = await until(() => service.snapshot(), (s) => s.login?.phase === "complete");
  const accounts = complete.providers.find((p) => p.id === "openai")!.accounts!;
  assert.deepEqual(accounts.map((a) => a.name), ["Account 1", "Backup"]);
  assert.equal(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).openai.key, "legacy-key");
  assert(!JSON.stringify(complete).includes("backup-key"));
  assert.equal((await stat(join(dir, "accounts.json"))).mode & 0o777, 0o600);
  await service.reorder("openai", accounts.map((a) => a.id).reverse());
  const restarted = new ProviderService(dir);
  assert.equal((await restarted.accounts.list("openai"))[0]!.name, "Backup");
  await assert.rejects(service.reorder("openai", ["default", "default"]), ProviderInputError);
  await assert.rejects(service.start("openai", "api_key", { accountId: "../../bad" }), ProviderInputError);
  await assert.rejects(service.quota("openai", "missing"), ProviderInputError);
  await service.removeAccount("openai", "default");
  const runtime = await createSessionModelRuntime(join(dir, "pi"), dir);
  assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "backup-key");
  assert(runtime.getAvailableSnapshot().some((m) => m.provider === "openai"));
  assert.deepEqual((await readProviderSelections(dir)).openai?.models, []);
  await service.disconnect("openai");
  assert.deepEqual(await service.accounts.list("openai"), []);
});

test("cancelled extra login leaves existing account and priority unchanged", async (t) => {
  const { dir, service } = await fixture(t);
  await writeFile(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "legacy-key" } }));
  const login = await service.start("openai", "api_key", { name: "Cancelled" });
  await until(() => service.snapshot(), (s) => Boolean(s.login?.prompt));
  service.cancel(login.id);
  await until(() => service.snapshot(), (s) => s.login?.phase === "cancelled");
  assert.deepEqual(await service.accounts.list("openai"), [{ id: "default", name: "Account 1" }]);
  assert.equal(JSON.parse(await readFile(join(dir, "auth.json"), "utf8")).openai.key, "legacy-key");
});


test("a disconnected preferred account does not hide a connected backup from the catalog", async (t) => {
  const { dir, service } = await fixture(t);
  const { credentialStore } = await import("./provider-accounts.ts");
  const backup = "22222222-2222-4222-8222-222222222222";
  await service.accounts.update("openai", () => [{ id: "default", name: "Missing" }, { id: backup, name: "Backup" }]);
  await credentialStore(service.accounts.authPath(backup)).modify("openai", async () => ({ type: "api_key", key: "backup-only" }));
  await service.save("openai", ["gpt-4o"]);
  const snapshot = (await service.snapshot()).providers.find((p) => p.id === "openai")!;
  assert(snapshot.authenticated);
  assert.deepEqual(snapshot.accounts?.map((a) => a.authenticated), [false, true]);
  const runtime = await createSessionModelRuntime(join(dir, "pi"), dir);
  assert.equal((await runtime.getAuth("openai"))?.auth.apiKey, "backup-only");
  assert(runtime.getAvailableSnapshot().some((m) => m.provider === "openai"));
});


test("quota cooldown uses account scope, never model, feature or spending budgets", async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  let globalPercent = 12;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    rate_limit: { primary_window: { used_percent: globalPercent, reset_at: reset } },
    additional_rate_limits: [{ limit_name: "New model", rate_limit: { primary_window: { used_percent: 100, reset_at: reset + 5000 } } }],
    code_review_rate_limit: { primary_window: { used_percent: 100, reset_at: reset + 10000 } },
    individual_limit: { limit: 100, used: 100, reset_at: reset + 20000 },
  })));
  for (const exhausted of [false, true]) {
    globalPercent = exhausted ? 100 : 12;
    const { dir, service } = await fixture(t);
    await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600000 } }), { mode: 0o600 });
    const quota = await service.quota("openai-codex");
    expectSchema(ProviderQuota, quota);
    assert.equal(quota.status, "available");
    assert.equal(quota.windows.length, 4);
    assert.equal((await service.accounts.list("openai-codex"))[0]?.cooldownUntil, exhausted ? reset * 1000 : undefined);
  }
});

test("same-email accounts retain separate IDs and refresh their display identity without persistence changes", async (t) => {
  const { service } = await fixture(t);
  const { credentialStore } = await import("./provider-accounts.ts");
  const backup = "33333333-3333-4333-8333-333333333333";
  const credential = (email: string) => ({ type: "oauth" as const, access: `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email } })).toString("base64url")}.c`, refresh: "private-refresh", expires: Date.now() + 3600000 });
  await service.accounts.update("openai-codex", () => [{ id: "default", name: "Personal" }, { id: backup, name: "Work" }]);
  for (const id of ["default", backup]) await credentialStore(service.accounts.authPath(id)).modify("openai-codex", async () => credential("same@example.com"));
  const accounts = (await service.snapshot()).providers.find((p) => p.id === "openai-codex")!.accounts!;
  assert.deepEqual(accounts.map((a) => [a.id, a.email]), [["default", "same@example.com"], [backup, "same@example.com"]]);
  assert(!JSON.stringify(accounts).includes("private-refresh"));
  await credentialStore(service.accounts.authPath(backup)).modify("openai-codex", async () => credential("new@example.com"));
  assert.equal((await service.snapshot()).providers.find((p) => p.id === "openai-codex")!.accounts![1]!.email, "new@example.com");
  assert.deepEqual((await service.accounts.list("openai-codex")).map((a) => a.name), ["Personal", "Work"]);
});

test("Go quota uses and caches each HUI account key independently, with monthly cooldown", async (t) => {
  const { service } = await fixture(t);
  const { credentialStore } = await import("./provider-accounts.ts");
  const backup = "44444444-4444-4444-8444-444444444444";
  await service.accounts.update("opencode-go", () => [{ id: "default", name: "Personal" }, { id: backup, name: "Backup" }]);
  for (const id of ["default", backup]) await credentialStore(service.accounts.authPath(id)).modify("opencode-go", async () => ({ type: "api_key", key: `synthetic-${id}` }));
  const calls: string[] = [];
  const reset = new Date(Date.now() + 3600000).toISOString();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
    const key = (init.headers as Record<string, string>).Authorization!; calls.push(key);
    return new Response(JSON.stringify({ usage: { rolling: { percent: 1 }, weekly: { percent: 2 }, monthly: { percent: key.endsWith("default") ? 100 : 3, resetsAt: reset } } }));
  });
  const quota = await service.quota("opencode-go", "default");
  assert.equal(quota.windows.length, 3);
  await service.quota("opencode-go", "default");
  await service.quota("opencode-go", backup);
  assert.deepEqual(calls, ["Bearer synthetic-default", `Bearer synthetic-${backup}`]);
  assert.equal((await service.accounts.list("opencode-go"))[0]?.cooldownUntil, Date.parse(reset));
  assert.equal((await service.accounts.list("opencode-go"))[1]?.cooldownUntil, undefined);
});
