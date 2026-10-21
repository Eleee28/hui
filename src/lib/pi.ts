/** Browser-local skill preferences and PI mutation progress, typed from the published API schema. */
import type { PiSkill, PiMutationKind } from "../api/schema/pi.ts";
export type { PiTool, PiSkill, PiResourceDocument, PiModel, PiSettingsSummary, PiConfiguredResource, PiSnapshot, PiMutationKind, PiMutationResult } from "../api/schema/pi.ts";

export function skillPreferencePath(skill: PiSkill): string {
  return skill.preferencePath ?? skill.path;
}

export function skillIsEnabled(skill: PiSkill, disabled: readonly { path: string }[]): boolean {
  return !disabled.some((entry) => entry.path === skillPreferencePath(skill) || entry.path === skill.path);
}

export type PiMutationState = {
  kind: PiMutationKind;
  target: string;
  status: "running" | "ok" | "error";
  message: string;
};
