/** Reasoning levels accepted by gateway session controls. */
import type { ThinkingLevel } from "../api/sessions.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function isThinkingLevel(level: string): level is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(level);
}
