import assert from "node:assert/strict";
import { test } from "vitest";
import { skillIsEnabled, skillPreferencePath, type PiSkill } from "./pi.ts";

test("bundled skill opt-out survives install moves without disabling user overrides", () => {
  const bundle: PiSkill = { id: "bundle", name: "create-verification-skill", description: "Generator", path: "/v1/skills/generator/SKILL.md",
    root: "/v1/skills", origin: "hui", preferencePath: "hui:skill:create-verification-skill" };
  const disabled = [{ name: bundle.name, path: skillPreferencePath(bundle) }];
  assert.equal(skillIsEnabled(bundle, []), true);
  assert.equal(skillIsEnabled(bundle, disabled), false);
  assert.equal(skillIsEnabled({ ...bundle, path: "/v2/skills/generator/SKILL.md" }, disabled), false);
  const user: PiSkill = { id: "user", name: bundle.name, description: "Override", path: "/user/skills/generator/SKILL.md", root: "/user/skills" };
  assert.equal(skillIsEnabled(user, disabled), true);
  assert.equal(skillPreferencePath(user), user.path);
  assert.equal(skillIsEnabled(user, [{ path: user.path }]), false);
});
