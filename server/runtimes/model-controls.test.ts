import assert from "node:assert/strict";
import { test } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fitThinking, modelControls, piThinking, withFastMode } from "./model-controls.ts";

const claude = (id: string) => ({ api: "anthropic-messages", id, reasoning: true });
const openai = (id: string) => ({ api: "openai-responses", id, reasoning: true });

test("fast mode is offered to Claude Opus 5 and 4.8 and to OpenAI GPT and o-series models", () => {
  const fast = (model: { api: string; id: string }) => modelControls(model).fast === true;
  for (const model of [claude("anthropic/claude-opus-5-5"), claude("claude-opus-5"), claude("claude-opus-4-8@20260101"), claude("anthropic/claude-opus-4.8"), claude("anthropic/claude-opus-5.5"), openai("openai/gpt-6-luna"), openai("o4-mini"), { api: "openai-codex-responses", id: "gpt-6.1-codex" }]) {
    assert.equal(fast(model), true, model.id);
  }
  for (const model of [claude("claude-opus-4-6"), claude("claude-sonnet-5"), claude("claude-opus-50"), claude("anthropic/claude-opus-5.5-fast"), openai("baseten/deepseek-ai/DeepSeek-V4.1-Flash"), openai("openai/gpt-oss-120b"), { api: "openai-completions", id: "gpt-6-luna" }]) {
    assert.equal(fast(model), false, model.id);
  }
});

test("the levels a model is offered are the ones PI sends it, max included", () => {
  const map = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  assert.deepEqual(modelControls({ ...claude("anthropic/claude-opus-5-5"), thinkingLevelMap: map }).thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(modelControls({ api: "openai-completions", id: "plain", reasoning: false }).thinkingLevels, ["off"]);
});

test("fast mode adds Anthropic's speed and beta, or OpenAI's priority tier, and leaves other models alone", () => {
  assert.deepEqual(withFastMode({ model: "m", betas: ["context-1m-2025-08-07"] }, claude("claude-opus-5-5")),
    { model: "m", speed: "fast", betas: ["context-1m-2025-08-07", "fast-mode-2026-02-01"] });
  assert.deepEqual(withFastMode({ model: "m" }, claude("claude-opus-5-5")), { model: "m", speed: "fast", betas: ["fast-mode-2026-02-01"] });
  assert.deepEqual(withFastMode({ model: "m" }, openai("gpt-6-luna")), { model: "m", service_tier: "priority" });
  assert.deepEqual(withFastMode({ model: "m", service_tier: "flex" }, openai("gpt-6-luna")), { model: "m", service_tier: "flex" });
  const untouched = { model: "m" };
  assert.equal(withFastMode(untouched, claude("claude-sonnet-5")), untouched);
});

test("HUI's ultra is sent as the model's highest level", () => {
  assert.equal(piThinking("ultra"), "max");
  assert.equal(piThinking("high"), "high");
  const upToHigh = { ...claude("claude-opus-4-6"), thinkingLevelMap: { off: null } } as unknown as Model<Api>;
  assert.equal(fitThinking(upToHigh, "ultra"), "high");
});
