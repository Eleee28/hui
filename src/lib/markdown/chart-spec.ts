/**
 * Guards chart specifications from Markdown fences before they reach the chart renderer. A spec must be a
 * bounded JSON object carrying inline data only, so a chart in a transcript can never load an external URL.
 */
const CHART_MAX_SOURCE_CHARS = 100_000;
const CHART_MAX_DEPTH = 32;

function assertSelfContained(value: unknown, depth = 0): void {
  if (depth > CHART_MAX_DEPTH) throw new Error("Chart specification is too deeply nested.");
  if (Array.isArray(value)) {
    for (const item of value) assertSelfContained(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["url", "href"].includes(key.toLowerCase())) {
      throw new Error("Charts must use inline data and cannot load external URLs.");
    }
    assertSelfContained(child, depth + 1);
  }
}

export function parseSafeChartSpec(source: string): Record<string, unknown> {
  if (source.length > CHART_MAX_SOURCE_CHARS) throw new Error("Chart specification exceeds 100 KB.");
  const parsed: unknown = JSON.parse(source);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Chart specification must be a JSON object.");
  }
  assertSelfContained(parsed);
  return parsed as Record<string, unknown>;
}
