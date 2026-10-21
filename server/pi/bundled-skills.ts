/**
 * The skills HUI ships inside its own package, offered next to the ones PI discovers. Their on/off choice
 * lives in PI's disabledSkills list under stable `hui:skill:` keys rather than file paths, so it survives
 * upgrades, checkout moves and rollbacks.
 */
import { fileURLToPath } from "node:url";

/** Relative to server/ in source and build/server/ in a packaged install. */
export const bundledSkillRoot = fileURLToPath(new URL("../../skills/", import.meta.url));

export const bundledSkills = [{
  name: "create-verification-skill",
  path: fileURLToPath(new URL("../../skills/create-verification-skill/SKILL.md", import.meta.url)),
  // Existing disabledSkills.path accepts opaque strings. Keep the preference
  // stable across archive upgrades, checkout moves and rollback installations.
  preferencePath: "hui:skill:create-verification-skill",
  tags: ["good practices"],
}, {
  name: "git-selective-staging",
  path: fileURLToPath(new URL("../../skills/git-selective-staging/SKILL.md", import.meta.url)),
  preferencePath: "hui:skill:git-selective-staging",
  tags: ["good practices"],
}, {
  name: "visualize",
  path: fileURLToPath(new URL("../../skills/visualize/SKILL.md", import.meta.url)),
  preferencePath: "hui:skill:visualize",
  tags: ["presentation"],
}] as const;

export function isBundledSkillPreference(entry: { path: string }): boolean {
  return bundledSkills.some((skill) => entry.path === skill.preferencePath || entry.path === skill.path);
}

export function enabledBundledSkillPaths(disabled: readonly { path: string }[]): string[] {
  return bundledSkills.filter((skill) => !disabled.some((entry) =>
    entry.path === skill.preferencePath || entry.path === skill.path,
  )).map((skill) => skill.path);
}
