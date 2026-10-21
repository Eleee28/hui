import assert from "node:assert/strict";
import { test } from "vitest";

import { stripOverflow, stripWheelScroll } from "./pull-request-strip.ts";

// Five 20px marks with 1px gaps (104px) in a strip showing one and a half (31px).
const width = 104;
const client = 31;
const max = width - client;

test("a single mark or a fitting strip has no fade", () => {
  assert.deepEqual(stripOverflow(0, 20, 20), { before: false, after: false });
  assert.deepEqual(stripOverflow(0, 31.4, 31), { before: false, after: false });
});

test("at rest the newest mark is whole and older marks fade on the leading side", () => {
  assert.deepEqual(stripOverflow(0, width, client), { before: true, after: false });
  assert.deepEqual(stripOverflow(-30, width, client), { before: true, after: true });
  assert.deepEqual(stripOverflow(-max, width, client), { before: false, after: true });
  assert.deepEqual(stripOverflow(max, width, client), { before: false, after: true }, "positive legacy offsets");
});

test("wheel down reveals older marks and yields to the sidebar at either end", () => {
  assert.equal(stripWheelScroll(0, width, client, 40), -40);
  assert.equal(stripWheelScroll(-40, width, client, 100), -max);
  assert.equal(stripWheelScroll(-max, width, client, 10), undefined);
  assert.equal(stripWheelScroll(-40, width, client, -100), -0);
  assert.equal(stripWheelScroll(0, width, client, -10), undefined);
  assert.equal(stripWheelScroll(0, 20, 20, 50), undefined, "nothing to scroll");
});
