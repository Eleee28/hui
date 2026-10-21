import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { parseGitHubUrl } from "../lib/markdown/github-links.ts";
import { fetchGitHubPreviews } from "./github-previews.ts";

test("one request carries every reference of the message", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { urls.push(url); return Response.json({ previews: [{ url: "https://github.com/a/b", error: "not_found" }] }); });
  const results = await fetchGitHubPreviews([parseGitHubUrl("https://github.com/a/b")!, parseGitHubUrl("https://github.com/a/b/pull/2")!]);
  assert.deepEqual(results, [{ url: "https://github.com/a/b", error: "not_found" }]);
  assert.deepEqual(urls.map((url) => new URL(url, "http://hui").searchParams.getAll("url")), [["https://github.com/a/b", "https://github.com/a/b/pull/2"]]);
});
