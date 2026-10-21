import assert from "node:assert/strict";
import { test } from "vitest";
import { parseSafeChartSpec } from "./chart-spec.ts";

test("accepts self-contained Vega-Lite JSON with inline values", () => {
  const spec = parseSafeChartSpec(JSON.stringify({
    data: { values: [{ label: "A", value: 3 }] },
    mark: "bar",
    encoding: { x: { field: "label" }, y: { field: "value" } },
  }));
  assert.equal(spec["mark"], "bar");
});

test("rejects remote data, clickable links and malformed chart roots", () => {
  assert.throws(() => parseSafeChartSpec('{"data":{"url":"https://example.com/data.json"}}'), /inline data/u);
  assert.throws(() => parseSafeChartSpec('{"mark":{"href":"https://example.com"}}'), /external URLs/u);
  assert.throws(() => parseSafeChartSpec("[]"), /JSON object/u);
  assert.throws(() => parseSafeChartSpec("not-json"), /JSON/u);
});
