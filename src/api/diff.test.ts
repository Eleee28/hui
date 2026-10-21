import assert from "node:assert/strict";
import { test } from "vitest";
import { diffQuery } from "./diff.ts";

test("the query sends a picked branch and the uncommitted choice only where they apply", () => {
  assert.equal(diffQuery({ comparison: "uncommitted", parent: "refs/heads/main", uncommitted: false }), "compare=uncommitted");
  assert.equal(diffQuery({ comparison: "last-commit", uncommitted: false }), "compare=last-commit");
  assert.equal(diffQuery({ comparison: "parent", parent: "refs/heads/feature-a", uncommitted: true }), "compare=parent&parent=refs%2Fheads%2Ffeature-a");
  assert.equal(diffQuery({ comparison: "default", uncommitted: false }), "compare=default&uncommitted=0");
  assert.equal(diffQuery({ comparison: "uncommitted", uncommitted: true }, { path: "a b.ts", from: "c.ts" }), "compare=uncommitted&path=a+b.ts&from=c.ts");
});
