import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

type DisabledSkill = { name: string; path: string };
export function disabledSkillsFrom(raw: string | undefined): DisabledSkill[];
export function disabledSkillNotice(text: string, entries: readonly DisabledSkill[]): string | undefined;
export function filterDisabledSkills(systemPrompt: string, entries: readonly DisabledSkill[]): string;
export function registerSkillPolicy(pi: ExtensionAPI, entries: readonly DisabledSkill[]): void;
declare const skillPolicyExtension: ExtensionFactory;
export default skillPolicyExtension;
