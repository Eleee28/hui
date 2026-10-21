import assert from "node:assert/strict";
import { test } from "vitest";
import { documentTitle } from "./document-title.ts";

test("the document title names the selected session and HUI", () => {
  assert.equal(documentTitle("Fix command palette"), "Fix command palette · HUI");
});

test("the document title falls back to HUI without a selected session", () => {
  assert.equal(documentTitle(), "HUI");
  assert.equal(documentTitle("   "), "HUI");
});
