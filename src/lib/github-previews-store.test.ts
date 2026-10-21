import assert from "node:assert/strict";
import { test } from "vitest";

import { parseGitHubUrl } from "./markdown/github-links.ts";
import type { GitHubPreviewResult } from "../api/schema/github.ts";
import type { GitHubRef } from "./markdown/github-links.ts";
import { clearGitHubPreviewCache, loadGitHubPreviews, settledGitHubPreview } from "./github-previews-store.ts";

const ref = (url: string) => parseGitHubUrl(url)!;

test("batches one request per message and reuses results across renders", async () => {
  clearGitHubPreviewCache();
  const requests: string[][] = [];
  const fetcher = async (batch: readonly GitHubRef[]): Promise<GitHubPreviewResult[]> => {
    requests.push(batch.map((item) => item.url));
    return batch.map((item): GitHubPreviewResult => ({ url: item.url, error: "not_found" }));
  };
  const refs = [ref("https://github.com/a/b"), ref("https://github.com/a/b/pull/2"), ref("https://github.com/a/c"), ref("https://github.com/a/d")];
  const first = await loadGitHubPreviews(refs, 0, fetcher);
  assert.equal(first.length, 3, "at most three embeds");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.length, 3);
  await loadGitHubPreviews(refs, 1_000, fetcher);
  assert.equal(requests.length, 1, "fresh results are not refetched");
  await loadGitHubPreviews(refs, 31_000, fetcher);
  assert.equal(requests.length, 2, "failures retry after 30 seconds");
});

test("an answer stays readable at once while a stale one is fetched again", async () => {
  clearGitHubPreviewCache();
  const pull = ref("https://github.com/a/b/pull/2");
  assert.equal(settledGitHubPreview(pull), undefined, "nothing before the first answer");
  const fetcher = async (): Promise<GitHubPreviewResult[]> => [{ url: pull.url, error: "not_found" }];
  await loadGitHubPreviews([pull], 0, fetcher);
  assert.deepEqual(settledGitHubPreview(pull), { url: pull.url, error: "not_found" });
  const refetch = loadGitHubPreviews([pull], 120_000, fetcher);
  assert.deepEqual(settledGitHubPreview(pull), { url: pull.url, error: "not_found" }, "kept while the refetch runs");
  await refetch;
});

test("a failed request becomes unavailable instead of rejecting", async () => {
  clearGitHubPreviewCache();
  const results = await loadGitHubPreviews([ref("https://github.com/a/b")], 0, async () => { throw new Error("offline"); });
  assert.deepEqual(results, [{ url: "https://github.com/a/b", error: "unavailable" }]);
});
