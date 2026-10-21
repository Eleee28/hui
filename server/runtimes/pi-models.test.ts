import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

// HUI's provider selections resolve at import time and are read with each filter: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-pi-models-home-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
afterAll(() => rm(root, { recursive: true, force: true }));
const { configuredModels, filterConfiguredModels } = await import("./pi-models.ts");

const catalog = [
  { provider: "gateway", id: "anthropic/opus", name: "Opus" },
  { provider: "gateway", id: "openai/fast", name: "Fast" },
  { provider: "override", id: "built-in", name: "Built in" },
  { provider: "other", id: "anthropic/opus", name: "Other Opus" },
];

test("configured model rules retain full IDs and provider-only overrides", () => {
  const rules = configuredModels({ providers: {
    gateway: { models: [{ id: "anthropic/opus" }, { id: "anthropic/opus" }, null, { id: 7 }] },
    override: { baseUrl: "https://example.invalid" },
    empty: { models: [] },
    invalid: { models: [null, { name: "no id" }] },
  } });
  assert.deepEqual(rules?.get("gateway"), new Set(["anthropic/opus"]));
  assert.equal(rules?.get("override"), "all");
  assert.equal(rules?.get("empty"), "all");
  assert.equal(rules?.get("invalid"), "all");
  assert.equal(rules?.has("other"), false);
  assert.deepEqual(configuredModels({ providers: {} }), new Map());
  assert.deepEqual(configuredModels({}), new Map());
});

test("unusable models.json structure does not invent a restrictive list", () => {
  for (const raw of [null, [], 42, "invalid", { providers: "invalid" }, { providers: [] }]) {
    assert.equal(configuredModels(raw), undefined);
  }
});

test("file filtering hides unconfigured models without adding unavailable ones and re-reads changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-model-selection-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  await writeFile(path, JSON.stringify({ providers: {
    gateway: { apiKey: "fixture-secret", models: [{ id: "anthropic/opus" }, { id: "unavailable" }] },
    override: {},
  } }));
  assert.deepEqual(await filterConfiguredModels(catalog, dir), [catalog[0], catalog[2]]);
  assert.deepEqual(catalog.map((model) => model.provider), ["gateway", "gateway", "override", "other"]);
  await writeFile(path, JSON.stringify({ providers: { gateway: { models: [] } } }));
  assert.deepEqual(await filterConfiguredModels(catalog, dir), catalog.slice(0, 2));
  await writeFile(path, JSON.stringify({ providers: {} }));
  assert.deepEqual(await filterConfiguredModels(catalog, dir), []);
});

test("missing, unreadable and malformed config preserve PI's available catalog", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-model-fallback-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await filterConfiguredModels(catalog, dir), catalog);
  const path = join(dir, "models.json");
  await writeFile(path, "{");
  assert.deepEqual(await filterConfiguredModels(catalog, dir), catalog);
  // A file used as a parent directory produces ENOTDIR, even when run as root.
  assert.deepEqual(await filterConfiguredModels(catalog, path), catalog);
  await writeFile(path, JSON.stringify({ providers: false }));
  assert.deepEqual(await filterConfiguredModels(catalog, dir), catalog);
});
