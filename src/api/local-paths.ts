/** Browser client for path completion: the gateway lists the paths that match; the browser never reads the filesystem. */
import type { LocalPathSuggestion, LocalPathsResponse } from "./schema/local-paths.ts";
import { fetchJson } from "./request.ts";

export async function loadLocalPathSuggestions(cwd: string, input: string): Promise<LocalPathSuggestion[]> {
  const body = await fetchJson<LocalPathsResponse>(
    `/__hui/local-paths?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(input)}`,
  );
  return body.paths ?? [];
}
