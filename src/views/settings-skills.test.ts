import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const source = readFileSync(new URL("./settings.ts", import.meta.url), "utf8");

test("Skills settings toggles HUI runtime availability by stable path", () => {
  assert.match(source, /skillIsEnabled\(skill, props\.settings\.disabledSkills\)/);
  assert.match(source, /renderSettingsToggle\(/);
  assert.match(source, /Changes apply when a session runtime next starts/);
  assert.match(source, /props\.onSetSkillEnabled\(skill, checked\)/);
});
