import assert from "node:assert/strict";
import { test } from "vitest";

import { compactCount, previewErrorLabel } from "./github-previews.ts";

test("formats counts and error reasons", () => {
  assert.deepEqual([compactCount(999), compactCount(1_200), compactCount(46_408), compactCount(2_300_000)], ["999", "1.2k", "46k", "2.3M"]);
  assert.match(previewErrorLabel("signed_out"), /Settings → Integrations/u);
  assert.match(previewErrorLabel("cli_missing"), /gh/u);
});
