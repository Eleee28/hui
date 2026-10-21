import assert from "node:assert/strict";
import { test } from "vitest";
import { visibleContext } from "../../server/pi/model-routing.ts";
import { sessionDigest } from "../../server/sessions/digest.ts";
import { DRAFT_CASES } from "./cases.ts";
import { gradeDraft } from "./grade.ts";

const body = "## Context\n\nWhy.\n\n## Scope\n\n- Work.\n\n## Acceptance criteria\n\n- Done.";

test("every eval case is internally consistent", () => {
  assert.equal(new Set(DRAFT_CASES.map((item) => item.id)).size, DRAFT_CASES.length);
  for (const item of DRAFT_CASES) {
    for (const key of item.expect.parent) {
      assert.ok(key === "" || item.parents.some((parent) => parent.key === key), item.id + ": unknown parent " + key);
    }
    assert.ok(sessionDigest(item.entries).goal, item.id + ": the session has a goal");
  }
});

test("the long-tail case pushes its goal out of the legacy tail slice", () => {
  const item = DRAFT_CASES.find((entry) => entry.id === "webhook-retries-lint-tail")!;
  const goal = sessionDigest(item.entries).goal;
  assert.ok(!visibleContext(item.entries).includes(goal.slice(0, 80)));
  assert.ok(sessionDigest(item.entries).text.includes(goal));
});

test("the grader accepts a goal-anchored draft and names each failure", () => {
  const item = DRAFT_CASES.find((entry) => entry.id === "webhook-retries-lint-tail")!;
  const base = { project: "REL", parents: item.parents, model: "m/x" };
  const good = gradeDraft({ ...base, parentChoice: "suggested", summary: "Retry failed webhook deliveries with backoff", description: body + "\n\nDead-letter table.", parent: "REL-4" }, item.expect);
  assert.deepEqual(good, { pass: true, failures: [] });
  const bad = gradeDraft({ project: "REL", parents: item.parents, summary: "Fix ESLint errors", description: "Lint.", parent: "REL-9", note: "fallback" }, item.expect);
  assert.equal(bad.pass, false);
  const drifted = gradeDraft({ ...base, parentChoice: "suggested", summary: "Webhook の retries を追加する", description: body + "\n\nDead-letter.", parent: "REL-4" }, item.expect);
  const invented = gradeDraft({ ...base, parentChoice: "unmatched", rejectedParent: "REL-99", summary: "Retry failed webhook deliveries", description: body + "\n\nDead-letter.", parent: "" }, item.expect);
  assert.ok(invented.failures.includes("parent not a deliberate choice (unmatched: REL-99)"));
  assert.deepEqual(drifted.failures, ["draft is not in the session's language (English)"]);
  for (const expected of [/fallback/u, /summary misses/u, /tail topic/u, /description misses/u, /lacks ## Scope/u, /parent REL-9/u]) {
    assert.ok(bad.failures.some((failure) => expected.test(failure)), String(expected));
  }
});
