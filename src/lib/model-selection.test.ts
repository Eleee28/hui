import assert from "node:assert/strict";
import { test } from "vitest";
import { matchesModelSearch, modelSearchText, resolveLaunchModel } from "./model-selection.ts";

const models = [
  { provider: "gateway", id: "anthropic/opus", name: "Claude Opus" },
  { provider: "local", id: "fast", name: "Quick" },
];

test("model search matches every word across name, provider and full reference", () => {
  const text = modelSearchText(models[0]!);
  for (const query of ["", "   ", "OPUS  gateway", "gateway/anthropic/opus", "claude anthropic"]) {
    assert.equal(matchesModelSearch(text, query), true, query);
  }
  assert.equal(matchesModelSearch(text, "opus missing"), false);
  assert.equal(matchesModelSearch(modelSearchText(models[1]!), "opus"), false);
});

test("launch selection prefers a valid choice then default then first configured model", () => {
  assert.equal(resolveLaunchModel(models, "local/fast", "gateway/anthropic/opus"), models[1]);
  assert.equal(resolveLaunchModel(models, "removed/id", "local/fast"), models[1]);
  assert.equal(resolveLaunchModel(models, "", "excluded/default"), models[0]);
  assert.equal(resolveLaunchModel([], "local/fast", "gateway/anthropic/opus"), undefined);
});
