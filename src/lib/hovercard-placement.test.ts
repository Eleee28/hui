import assert from "node:assert/strict";
import { test } from "vitest";

import { HOVERCARD_GAP, hovercardPlacement } from "./hovercard-placement.ts";

const viewport = { width: 1440, height: 900 };
const badge = { left: 220, top: 100, right: 240, bottom: 120 };

test("opens directly below the trigger, with its icon under the trigger", () => {
  assert.deepEqual(hovercardPlacement(badge, { width: 340, height: 300 }, viewport), {
    left: 208, top: 120 + HOVERCARD_GAP, side: "bottom",
  });
});

test("flips above when only the space above fits", () => {
  const low = { left: 220, top: 700, right: 240, bottom: 720 };
  assert.deepEqual(hovercardPlacement(low, { width: 340, height: 300 }, viewport), {
    left: 208, top: 700 - HOVERCARD_GAP - 300, side: "top",
  });
});

test("an oversized card takes the roomier side and scrolls within it", () => {
  const placement = hovercardPlacement(badge, { width: 340, height: 2_000 }, viewport);
  assert.equal(placement.side, "bottom");
  assert.equal(placement.top, 120 + HOVERCARD_GAP);
  assert.equal(placement.maxHeight, 900 - 120 - HOVERCARD_GAP - 12);
});

test("stays inside the viewport horizontally", () => {
  const edge = { left: 380, top: 100, right: 400, bottom: 120 };
  assert.equal(hovercardPlacement(edge, { width: 340, height: 200 }, { width: 390, height: 844 }).left, 390 - 340 - 12);
  assert.equal(hovercardPlacement({ ...badge, left: 4, right: 24 }, { width: 340, height: 200 }, viewport).left, 12);
});
