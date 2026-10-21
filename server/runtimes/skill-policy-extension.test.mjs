import assert from "node:assert/strict";
import { test } from "vitest";

import { disabledSkillsFrom, filterDisabledSkills, registerSkillPolicy } from "./skill-policy-extension.mjs";

test("disabled skill preferences tolerate missing and malformed environment data", () => {
  assert.deepEqual(disabledSkillsFrom(undefined), []);
  assert.deepEqual(disabledSkillsFrom("{"), []);
  assert.deepEqual(disabledSkillsFrom(JSON.stringify([
    { name: "review", path: "/skills/review/SKILL.md" },
    { name: "missing-path" },
  ])), [{ name: "review", path: "/skills/review/SKILL.md" }]);
});

test("filters matching PI skill XML without touching enabled skills", () => {
  const prompt = `Before\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>review</name>\n    <description>Review code</description>\n    <location>/skills/review/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>deploy</name>\n    <description>Deploy code</description>\n    <location>/skills/deploy/SKILL.md</location>\n  </skill>\n</available_skills>\nAfter`;
  const filtered = filterDisabledSkills(prompt, [{ name: "review", path: "/skills/review/SKILL.md" }]);
  assert.doesNotMatch(filtered, /<name>review<\/name>/u);
  assert.match(filtered, /<name>deploy<\/name>/u);
  assert.match(filtered, /Before/u);
  assert.match(filtered, /After/u);
});

test("removes the complete skill section when every skill is disabled", () => {
  const prompt = `Before\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>review</name>\n    <description>Review code</description>\n    <location>/skills/review/SKILL.md</location>\n  </skill>\n</available_skills>\nAfter`;
  assert.equal(
    filterDisabledSkills(prompt, [{ name: "review", path: "/skills/review/SKILL.md" }]),
    "Before\nAfter",
  );
});

test("blocks direct commands for disabled skills and leaves enabled commands alone", () => {
  const handlers = new Map();
  registerSkillPolicy({ on: (event, handler) => handlers.set(event, handler) }, [
    { name: "review", path: "/skills/review/SKILL.md" },
  ]);
  const notices = [];
  const context = { ui: { notify: (message) => notices.push(message) } };
  assert.deepEqual(handlers.get("input")?.({ text: "/skill:testing" }, context), { action: "continue" });
  assert.deepEqual(handlers.get("input")?.({ text: "/skill:review now" }, context), { action: "handled" });
  assert.deepEqual(handlers.get("input")?.({ text: "$review now" }, context), { action: "handled" });
  assert.deepEqual(handlers.get("input")?.({ text: "$testing now" }, context), { action: "continue" });
  assert.deepEqual(notices, ["Skill “review” is disabled for HUI sessions.", "Skill “review” is disabled for HUI sessions."]);
});
