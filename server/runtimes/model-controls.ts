/**
 * What the composer may offer for one model: the reasoning levels PI sends it
 * and whether its provider has a fast mode, plus the request change that turns
 * fast mode on. Claude Opus 5 and 4.8 take Anthropic's `speed: "fast"` with its
 * beta; OpenAI GPT and o-series models take the priority service tier. Also
 * maps HUI's `ultra` to the level PI sends, the model's highest.
 */
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

type ControlledModel = { api: string; id: string; reasoning?: boolean; thinkingLevelMap?: object };

const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";
const OPENAI_APIS: ReadonlySet<string> = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);
// ponytail: model-id patterns, as OpenClaw's; widen them when a provider adds fast mode to another family.
const CLAUDE_FAST = /(?:^|[-/.])claude-opus-(?:5|4[-.]8)(?![0-9])/;
const OPENAI_FAST = /(?:^|\/)(?:gpt-(?!oss)|o\d)/;

function fastMode(model: ControlledModel): boolean {
  const id = model.id.toLowerCase();
  // A gateway's `…-fast` variant is already its fast mode.
  if (id.endsWith("-fast")) return false;
  if (model.api === "anthropic-messages") return CLAUDE_FAST.test(id);
  return OPENAI_APIS.has(model.api) && OPENAI_FAST.test(id);
}

/** The `RuntimeModel` fields that say which reasoning levels and speeds it has. */
export function modelControls(model: ControlledModel): { thinkingLevels: string[]; fast?: true } {
  return {
    thinkingLevels: getSupportedThinkingLevels(model as unknown as Model<Api>),
    ...(fastMode(model) ? { fast: true as const } : {}),
  };
}

/** The level PI is given for a HUI level: `ultra` asks for `max`, which PI clamps to the model's highest. */
export function piThinking(level: string): string {
  return level === "ultra" ? "max" : level;
}

/** The level a model is sent for a HUI level, as PI clamps it. */
export function fitThinking(model: Model<Api>, level: string): ModelThinkingLevel {
  return clampThinkingLevel(model, piThinking(level) as ModelThinkingLevel);
}

/** The provider payload asking for fast mode; unchanged for a model without one. */
export function withFastMode(payload: unknown, model: ControlledModel): unknown {
  if (typeof payload !== "object" || payload === null || !fastMode(model)) return payload;
  const body = payload as Record<string, unknown>;
  if (model.api !== "anthropic-messages") return { ...body, service_tier: body["service_tier"] ?? "priority" };
  const betas = Array.isArray(body["betas"]) ? body["betas"] : [];
  return { ...body, speed: "fast", betas: betas.includes(ANTHROPIC_FAST_BETA) ? betas : [...betas, ANTHROPIC_FAST_BETA] };
}
