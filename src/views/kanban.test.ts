import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("every checkbox menu item hides the native checkmark so only one tick shows", () => {
  const source = readFileSync(new URL("./kanban.ts", import.meta.url), "utf8");
  const items = source.match(/<wa-dropdown-item[^>]*type="checkbox"[^>]*>/gu) ?? [];
  assert.ok(items.length >= 2);
  for (const item of items) assert.match(item, /sidebar-session-sort-menu__item/u, item);
});
