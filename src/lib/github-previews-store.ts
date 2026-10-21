/** Browser half of GitHub chat embeds: one request per message for its (at
 * most three) references through src/api/github-previews.ts, remembered per URL
 * for the page lifetime so re-renders and streaming updates do not refetch. */
import type { GitHubPreviewResult } from "../api/schema/github.ts";
import type { GitHubRef } from "./markdown/github-links.ts";
import { MAX_GITHUB_EMBEDS } from "./markdown/github-links.ts";
import { fetchGitHubPreviews } from "../api/github-previews.ts";

/** Page-lifetime cache: settled results stay; failures retry after this long. */
const FAILURE_RETRY_MS = 30_000;
const SUCCESS_TTL_MS = 60_000;

type Entry = { at: number; result: Promise<GitHubPreviewResult> };
const cache = new Map<string, Entry>();
/** The latest answer per URL, kept past its TTL: a card shown again draws at once and refreshes in place. */
const settled = new Map<string, GitHubPreviewResult>();

export function settledGitHubPreview(ref: GitHubRef): GitHubPreviewResult | undefined {
  return settled.get(ref.url.toLowerCase());
}

function fresh(entry: Entry | undefined, now: number): entry is Entry {
  return Boolean(entry) && now - entry!.at < SUCCESS_TTL_MS;
}

/** Previews in the order of `refs`. Never rejects: a failed request becomes `unavailable`. */
export function loadGitHubPreviews(refs: readonly GitHubRef[], now = Date.now(), fetcher = fetchGitHubPreviews): Promise<GitHubPreviewResult[]> {
  const wanted = refs.slice(0, MAX_GITHUB_EMBEDS);
  const missing = wanted.filter((ref) => !fresh(cache.get(ref.url.toLowerCase()), now));
  if (missing.length) {
    const batch = fetcher(missing)
      .catch((): GitHubPreviewResult[] => missing.map((ref) => ({ url: ref.url, error: "unavailable" })));
    missing.forEach((ref, index) => {
      const key = ref.url.toLowerCase();
      const entry: Entry = {
        at: now,
        result: batch.then((results) => results[index] ?? { url: ref.url, error: "unavailable" }),
      };
      cache.set(key, entry);
      void entry.result.then((result) => { if (cache.get(key) === entry) settled.set(key, result); });
      // Failures age out sooner so a later render retries once the cause is fixed.
      void entry.result.then((result) => { if (result.error && cache.get(key) === entry) entry.at = now - SUCCESS_TTL_MS + FAILURE_RETRY_MS; });
    });
  }
  return Promise.all(wanted.map((ref) => cache.get(ref.url.toLowerCase())!.result));
}

/** Test helper. */
export function clearGitHubPreviewCache(): void {
  cache.clear();
  settled.clear();
}
