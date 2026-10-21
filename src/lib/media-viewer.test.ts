import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  centeredTransform,
  clampScale,
  constrainTransform,
  dataUrlMime,
  downloadFilename,
  fitScale,
  formatZoom,
  svgIntrinsicSize,
  wheelZoomFactor,
  zoomAround,
} from "./media-viewer.ts";

test("clamps zoom to the supported range and rejects invalid scales", () => {
  assert.equal(clampScale(0.001), MIN_SCALE);
  assert.equal(clampScale(1000), MAX_SCALE);
  assert.equal(clampScale(Number.NaN), 1);
  assert.equal(clampScale(-2), 1);
  assert.equal(clampScale(2), 2);
});

test("fits content inside the padded viewport without upscaling rasters by default", () => {
  assert.equal(fitScale({ width: 2000, height: 1000 }, { width: 1048, height: 800 }), 0.5);
  assert.equal(fitScale({ width: 100, height: 50 }, { width: 1000, height: 800 }), 1);
  assert.equal(fitScale({ width: 100, height: 50 }, { width: 1000, height: 800 }, { maxScale: 2 }), 2);
  assert.equal(fitScale({ width: 0, height: 50 }, { width: 1000, height: 800 }), 1);
});

test("centres content at a scale", () => {
  assert.deepEqual(centeredTransform({ width: 200, height: 100 }, { width: 1000, height: 600 }, 2), { scale: 2, x: 300, y: 200 });
});

test("zooming keeps the anchored content point fixed on screen", () => {
  const start = { scale: 1, x: 100, y: 50 };
  const anchor = { x: 300, y: 250 };
  const next = zoomAround(start, 2, anchor);
  assert.equal(next.scale, 2);
  // Content point under the anchor before and after the zoom is identical.
  assert.equal((anchor.x - start.x) / start.scale, (anchor.x - next.x) / next.scale);
  assert.equal((anchor.y - start.y) / start.scale, (anchor.y - next.y) / next.scale);
  assert.equal(zoomAround(start, 10_000, anchor).scale, MAX_SCALE);
});

test("wheel deltas map to bounded symmetric zoom factors across delta modes", () => {
  assert.ok(wheelZoomFactor(-100) > 1);
  assert.ok(wheelZoomFactor(100) < 1);
  assert.equal(wheelZoomFactor(0), 1);
  assert.ok(Math.abs(wheelZoomFactor(100) * wheelZoomFactor(-100) - 1) < 1e-12);
  assert.equal(wheelZoomFactor(3, 1), wheelZoomFactor(48));
  assert.equal(wheelZoomFactor(10_000), wheelZoomFactor(120));
});

test("panning cannot push the content fully out of view", () => {
  const content = { width: 400, height: 300 };
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(constrainTransform({ scale: 1, x: 5000, y: -5000 }, content, viewport), { scale: 1, x: 752, y: -252 });
  assert.deepEqual(constrainTransform({ scale: 1, x: 10, y: 20 }, content, viewport), { scale: 1, x: 10, y: 20 });
  // Content smaller than the margin stays entirely visible.
  assert.deepEqual(constrainTransform({ scale: 0.1, x: -100, y: 900 }, content, viewport), { scale: 0.1, x: 0, y: 570 });
});

test("formats the zoom level as a whole percentage", () => {
  assert.equal(formatZoom(1), "100%");
  assert.equal(formatZoom(0.333), "33%");
});

test("builds safe download names with the right extension", () => {
  assert.equal(downloadFilename("chart", "image/svg+xml"), "chart.svg");
  assert.equal(downloadFilename("photo.jpeg", "image/jpeg"), "photo.jpeg");
  assert.equal(downloadFilename("shot.PNG", "image/png"), "shot.PNG");
  assert.equal(downloadFilename("../../etc/passwd", "image/png"), "passwd.png");
  assert.equal(downloadFilename("a<b>:c?.png", "image/png"), "abc.png");
  assert.equal(downloadFilename("  ", "image/webp"), "image.webp");
  assert.equal(downloadFilename("...", undefined, "diagram"), "diagram");
  assert.equal(downloadFilename("notes", "application/octet-stream"), "notes");
});

test("reads the mime type declared by data URLs", () => {
  assert.equal(dataUrlMime("data:image/PNG;base64,AAAA"), "image/png");
  assert.equal(dataUrlMime("data:image/svg+xml,<svg/>"), "image/svg+xml");
  assert.equal(dataUrlMime("/__hui/media/id/a.png"), undefined);
});

test("derives an SVG's intrinsic size from its viewBox before numeric attributes", () => {
  assert.deepEqual(svgIntrinsicSize("-8 -8 812.5 400", "100%", null), { width: 812.5, height: 400 });
  assert.deepEqual(svgIntrinsicSize("0,0,120,80", null, null), { width: 120, height: 80 });
  assert.deepEqual(svgIntrinsicSize(null, "640", "280px"), { width: 640, height: 280 });
  assert.equal(svgIntrinsicSize("0 0 0 10", "100%", "auto"), undefined);
  assert.equal(svgIntrinsicSize(null, null, null), undefined);
});
