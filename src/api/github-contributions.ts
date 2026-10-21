/** Browser client for the Contributions page: the gateway's GitHub activity for a year or the last year. */
import type { GitHubContributions } from "./schema/github.ts";
import { fetchJson } from "./request.ts";

/** `year` omitted: the last year. */
export function loadGitHubContributions(year?: number, refresh = false): Promise<GitHubContributions> {
  const query = new URLSearchParams({ ...(year === undefined ? {} : { year: String(year) }), ...(refresh ? { refresh: "1" } : {}) });
  return fetchJson<GitHubContributions>(`/__hui/github/contributions${query.size ? `?${query}` : ""}`, { signal: AbortSignal.timeout(180_000) });
}
