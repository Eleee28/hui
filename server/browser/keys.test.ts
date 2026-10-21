import assert from "node:assert/strict";
import { test } from "vitest";
import { KeyParseError, parseKey } from "./keys.ts";

test("named keys, characters and modifiers map to CDP key events", () => {
  assert.deepEqual(parseKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
  assert.deepEqual(parseKey("esc"), { key: "Escape", code: "Escape", keyCode: 27, modifiers: 0 });
  assert.deepEqual(parseKey("Shift+Tab"), { key: "Tab", code: "Tab", keyCode: 9, modifiers: 8 });
  assert.deepEqual(parseKey("Control+a"), { key: "a", code: "KeyA", keyCode: 65, modifiers: 2 });
  assert.deepEqual(parseKey("Shift+a"), { key: "A", code: "KeyA", keyCode: 65, text: "A", modifiers: 8 });
  assert.deepEqual(parseKey("7"), { key: "7", code: "Digit7", keyCode: 55, text: "7", modifiers: 0 });
  assert.deepEqual(parseKey("F12"), { key: "F12", code: "F12", keyCode: 123, modifiers: 0 });
  assert.deepEqual(parseKey("Meta++"), { key: "+", code: "", keyCode: 0, modifiers: 4 });
  assert.deepEqual(parseKey("Space"), { key: " ", code: "Space", keyCode: 32, text: " ", modifiers: 0 });
});

test("unknown keys and modifiers are rejected with guidance", () => {
  assert.throws(() => parseKey(""), KeyParseError);
  assert.throws(() => parseKey("Hyper+a"), /Unknown modifier "Hyper"/u);
  assert.throws(() => parseKey("Enterprise"), /Unknown key "Enterprise"/u);
  assert.throws(() => parseKey("x".repeat(41)), KeyParseError);
});
