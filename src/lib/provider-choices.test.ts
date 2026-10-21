import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderSummary } from "../api/schema/providers.ts";
import { connectionMethods, connectionName, providerBrand, providerBrands } from "./provider-choices.ts";

const provider = (id: string, methods: ("oauth" | "api_key")[]): ProviderSummary => ({
  id, name: id, configured: false, authenticated: false, selected: [], models: [],
  methods: methods.map((id) => ({ id, label: id })),
});

test("OpenAI groups account and API-key auth without changing runtime identities", () => {
  const methods = connectionMethods("openai", [provider("openai", ["api_key"]), provider("openai-codex", ["oauth"])]);
  assert.deepEqual(methods.map(({ provider, method, label }) => [provider.id, method, label]), [
    ["openai-codex", "oauth", "ChatGPT account"], ["openai", "api_key", "API key"],
  ]);
  assert.equal(providerBrand("openai-codex")?.id, "openai");
  assert.notEqual(connectionName(methods[0]!.provider), connectionName(methods[1]!.provider));
});

test("Claude offers only PI-owned subscription and API-key auth", () => {
  const methods = connectionMethods("anthropic", [provider("anthropic", ["oauth", "api_key"]), provider("claude-code", [])]);
  assert.deepEqual(methods.map(({ provider, method }) => [provider.id, method]), [["anthropic", "oauth"], ["anthropic", "api_key"]]);
  assert.equal(providerBrand("anthropic")?.name, "Claude");
  assert.equal(providerBrand("claude-code"), undefined);
});

test("add flow exposes only the three requested brands and available SDK methods", () => {
  assert.deepEqual(providerBrands.map((brand) => brand.name), ["OpenCode Go", "OpenAI", "Claude"]);
  assert.deepEqual(connectionMethods("openai", []), []);
  const go = connectionMethods("opencode-go", [provider("opencode-go", ["api_key"]), provider("opencode", ["api_key"])]);
  assert.equal(go.length, 1);
  assert.equal(go[0]!.provider.id, "opencode-go");
  assert.equal(providerBrand("custom-provider"), undefined);
  assert.deepEqual(connectionMethods("opencode", [provider("opencode", ["api_key"])]), []);
});


test("existing legacy connections can reconnect without adding another brand to the picker", () => {
  const legacy = { ...provider("opencode", ["api_key"]), configured: true };
  assert.equal(connectionMethods("opencode", [legacy])[0]?.provider.id, "opencode");
  assert.equal(providerBrand("opencode"), undefined);
});
