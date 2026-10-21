import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "vitest";
import { sessionTreeIds } from "./tree.ts";

test("subtree traversal includes nested descendants regardless of order, without looping on cycles", () => {
  const sessions = [
    { id: "grandchild", parentId: "child" }, { id: "outside" },
    { id: "child", parentId: "root" }, { id: "root", parentId: "grandchild" },
  ];
  assert.deepEqual([...sessionTreeIds(sessions, "root")].sort(), ["child", "grandchild", "root"]);
  assert.deepEqual([...sessionTreeIds(sessions, "outside")], ["outside"]);
});

const fixtures: { input: { sessions: Parameters<typeof sessionTreeIds>[0]; rootId: string }; expected: string[] }[] = JSON.parse(readFileSync(new URL("./tree.fixture.json", import.meta.url), "utf8"));

test("session-tree preserves the shared runtime fixtures", () => {
  for (const fixture of fixtures) {
    assert.deepEqual([...sessionTreeIds(fixture.input.sessions, fixture.input.rootId)], fixture.expected);
  }
});
