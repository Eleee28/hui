import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { parseDatadogUrl } from "../lib/markdown/datadog-links.ts";
import { fetchDatadogPreviews } from "./datadog.ts";

test("one previews request carries every link of the message", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { urls.push(url); return Response.json({ previews: [{ url: "https://app.datadoghq.com/s/a/b", error: "not_found" }] }); });
  const results = await fetchDatadogPreviews(["b", "c"].map((id) => parseDatadogUrl(`https://app.datadoghq.com/s/a/${id}`)!));
  assert.deepEqual(results, [{ url: "https://app.datadoghq.com/s/a/b", error: "not_found" }]);
  assert.equal(new URL(urls[0]!, "http://hui").pathname, "/__hui/datadog/previews");
  assert.deepEqual(urls.map((url) => new URL(url, "http://hui").searchParams.getAll("url")), [["https://app.datadoghq.com/s/a/b", "https://app.datadoghq.com/s/a/c"]]);
  vi.unstubAllGlobals();
});
