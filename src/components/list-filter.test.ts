import assert from "node:assert/strict";
import { test } from "vitest";
import { isListFilterShortcut } from "./list-filter.ts";

test("Cmd+F on Apple and Ctrl+F elsewhere focus the list filter; Ctrl+F on a Mac stays a cursor move", () => {
  const key = (init: Partial<KeyboardEvent>) => ({ altKey: false, ctrlKey: false, defaultPrevented: false, isComposing: false, key: "f", metaKey: false, shiftKey: false, ...init });
  assert.equal(isListFilterShortcut(key({ metaKey: true }), true), true);
  assert.equal(isListFilterShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(isListFilterShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isListFilterShortcut(key({ metaKey: true, shiftKey: true }), true), false);
  assert.equal(isListFilterShortcut(key({ metaKey: true, defaultPrevented: true }), true), false);
});
