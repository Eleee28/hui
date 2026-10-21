/**
 * Directory suggestions for choosing a session's working directory, locally or on a worker. The gateway
 * lists the directories; the browser never touches the filesystem.
 */
import { fetchJson } from "./request.ts";
import type { DirectoriesResponse } from "./schema/local-paths.ts";

export async function loadWorkingDirectorySuggestions(input: string, worker?: string): Promise<string[]> {
  const body = await fetchJson<DirectoriesResponse>(
    `/__hui/directories?q=${encodeURIComponent(input || "~/")}${worker ? `&worker=${encodeURIComponent(worker)}` : ""}`,
  );
  return body.directories ?? [];
}
