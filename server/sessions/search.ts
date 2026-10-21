/**
 * `GET /__hui/sessions/search`'s work: splits the registry's sessions by where their conversation is stored, searches
 * this gateway's own with `runtimes/transcript-search.ts` and asks each remote worker to search its sessions, and
 * names the hosts that could not answer. Bots' chats and subagents are left out, as the Sessions page leaves them.
 */
import type { SessionSearchResult } from "../api/sessions.ts";
import { durableHost } from "../runtimes/durable-host.ts";
import { searchTranscripts, type TranscriptHit } from "../runtimes/transcript-search.ts";
import { workers } from "../workers.ts";
import { readRegistry, type SessionRecord } from "./sessions.ts";

export async function searchSessions(query: string, signal?: AbortSignal): Promise<SessionSearchResult> {
  const byHost = new Map<string, SessionRecord[]>();
  for (const record of await readRegistry()) {
    if (!record.piSessionFile || record.bot || record.subagent) continue;
    const host = record.worker ?? "";
    byHost.set(host, [...byHost.get(host) ?? [], record]);
  }
  const result: SessionSearchResult = { hits: [], unsearched: [] };
  await Promise.all([...byHost].map(async ([worker, records]) => {
    const files = records.map((record) => record.piSessionFile!);
    let hits: TranscriptHit[];
    try {
      hits = worker ? await workers.searchTranscripts(worker, files, query, signal) : await searchTranscripts(durableHost(), files, query, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.unsearched.push({
        worker: worker ? workers.nameOf(worker) ?? worker : "this machine",
        error: message.startsWith("Unsupported remote worker request") ? "it runs an older HUI release; update it to search its sessions." : message,
      });
      return;
    }
    for (const hit of hits) {
      const record = records.find((each) => each.piSessionFile === hit.sessionFile);
      if (record) result.hits.push({ id: record.id, snippet: hit.snippet, matches: hit.matches });
    }
  }));
  return result;
}
