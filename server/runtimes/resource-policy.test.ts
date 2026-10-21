import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  configuredResourceId,
  createPolicySettingsManager,
  filterDisabledResources,
} from "./resource-policy.ts";

test("filters disabled packages and direct extensions from an in-memory PI view", () => {
  const settings = {
    packages: ["npm:@acme/enabled", { source: "git:github.com/acme/disabled", skills: [] }],
    extensions: ["extensions/enabled.ts", "extensions/disabled.ts"],
    defaultModel: "fixture",
  };
  const filtered = filterDisabledResources(settings, new Set([
    configuredResourceId("package", "git:github.com/acme/disabled"),
    configuredResourceId("extension", "extensions/disabled.ts"),
  ]));
  assert.deepEqual(filtered.packages, ["npm:@acme/enabled"]);
  assert.deepEqual(filtered.extensions, ["extensions/enabled.ts"]);
  assert.equal(filtered.defaultModel, "fixture");
  assert.deepEqual(settings.packages, ["npm:@acme/enabled", { source: "git:github.com/acme/disabled", skills: [] }]);
});

test("policy settings never rewrite PI's settings file", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "hui-resource-policy-"));
  const settingsPath = join(agentDir, "settings.json");
  const original = JSON.stringify({ packages: ["npm:@acme/disabled"], defaultModel: "fixture" });
  await writeFile(settingsPath, original);
  const manager = createPolicySettingsManager({
    cwd: agentDir,
    agentDir,
    disabledIds: new Set([configuredResourceId("package", "npm:@acme/disabled")]),
  });
  assert.deepEqual(manager.getGlobalSettings().packages, []);
  assert.equal(manager.getDefaultModel(), "fixture");
  assert.equal(await readFile(settingsPath, "utf8"), original);
});
