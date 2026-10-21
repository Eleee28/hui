/** Reasoning levels, labels and guards used by session and bot controls. */
import type { ThinkingLevel } from "../api/schema/sessions.ts";
export type { ThinkingLevel } from "../api/schema/sessions.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** The levels PI itself has: every one but `ultra`. */
export const PI_THINKING_LEVELS = THINKING_LEVELS.filter((level) => level !== "ultra");

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
};

export function isThinkingLevel(level: string): level is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(level);
}
