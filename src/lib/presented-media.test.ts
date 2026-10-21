import assert from "node:assert/strict";
import { test } from "vitest";

import { mediaSizeLabel, presentedMediaFromDetails } from "./presented-media.ts";

const item = {
  id: "12345678-1234-4123-8123-123456789abc",
  name: "demo.mp4",
  kind: "video",
  mimeType: "video/mp4",
  size: 1_500_000,
  url: "/__hui/media/12345678-1234-4123-8123-123456789abc/demo.mp4",
};

test("accepts only bounded same-origin media capabilities", () => {
  assert.deepEqual(presentedMediaFromDetails({ media: [item] }), [item]);
  assert.deepEqual(presentedMediaFromDetails({ media: [{ ...item, url: "https://example.com/demo.mp4" }] }), []);
  assert.deepEqual(presentedMediaFromDetails({ media: Array(9).fill(item) }), []);
});

test("formats media sizes for transcript metadata", () => {
  assert.equal(mediaSizeLabel(12), "12 B");
  assert.equal(mediaSizeLabel(2048), "2 KB");
  assert.equal(mediaSizeLabel(1_500_000), "1.4 MB");
});
