/**
 * Transcript search: finds the sessions whose user and assistant messages contain a text, reading each
 * conversation where it is stored (this host's Durable store or a PI session file) without starting a runtime.
 * The gateway runs it for local sessions and each remote worker host for its own.
 */
import { readFile } from "node:fs/promises";
import type { Message } from "@earendil-works/pi-ai";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { CompactionEntry, ResetEntry, SystemEntry, type Cursor, type Harness } from "@earendil-works/pi-durable";
import { durableContext, type DurableHost } from "./durable-host.ts";
import { durableConversationId, textOf } from "./durable.ts";
import { ExtensionMessageEntry, isCustomInput } from "./durable-extensions.ts";
import { restoreAttachmentNames } from "./pi.ts";

export type TranscriptHit = { sessionFile: string; snippet: string; matches: number };

const PAGE = 200;
const SNIPPET_CONTEXT = 60;
const SKILL_BLOCK = /<skill name="[^"]*" location="[^"]*">[\s\S]*?<\/skill>\s*/gu;

/** The text the chat shows for a message: user text without inlined skills and attachment manifests. */
function shownText(message: unknown): string | undefined {
  const role = (message as { role?: unknown } | undefined)?.role;
  if (role === "assistant") return textOf(message as Message);
  if (role !== "user" || isCustomInput(message)) return undefined;
  return restoreAttachmentNames(textOf(message as Message)).text.replace(SKILL_BLOCK, "");
}

/** Newest message first, from the latest reset on: what the session shows. */
async function* durableTexts(harness: Harness, reference: string): AsyncGenerator<string | undefined> {
  const id = durableConversationId(reference);
  const conversation = id === undefined ? undefined : await harness.conversation(id, durableContext);
  if (!conversation) return;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, PAGE, cursor, durableContext);
    for (const entry of page.items) {
      if (ResetEntry.is(entry)) return;
      if (SystemEntry.is(entry) || ExtensionMessageEntry.is(entry) || CompactionEntry.is(entry)) continue;
      for (const message of [...entry.model ?? []].reverse()) yield shownText(message);
    }
    cursor = page.next;
  } while (cursor);
}

async function* piFileTexts(path: string): AsyncGenerator<string | undefined> {
  for (const entry of parseSessionEntries(await readFile(path, "utf8")).reverse()) {
    if (entry.type === "message") yield shownText(entry.message);
  }
}

function snippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(text.length, at + length + SNIPPET_CONTEXT);
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/gu, " ").trim()}${end < text.length ? "…" : ""}`;
}

/** Sessions whose history contains `query`, case-insensitively, with the newest matching message as the snippet.
 * A conversation that cannot be read is left out; an aborted search returns what it found so far. */
export async function searchTranscripts(host: DurableHost, sessionFiles: readonly string[], query: string, signal?: AbortSignal): Promise<TranscriptHit[]> {
  const needle = query.trim();
  const hits: TranscriptHit[] = [];
  if (!needle) return hits;
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu");
  const harness = sessionFiles.some((file) => durableConversationId(file) !== undefined) ? await host.open() : undefined;
  for (const sessionFile of sessionFiles) {
    if (signal?.aborted) break;
    let hit: TranscriptHit | undefined;
    try {
      const texts = harness && durableConversationId(sessionFile) !== undefined ? durableTexts(harness, sessionFile) : piFileTexts(sessionFile);
      for await (const text of texts) {
        const match = text && pattern.exec(text);
        if (!match) continue;
        hit ??= { sessionFile, snippet: snippet(text, match.index, match[0].length), matches: 0 };
        hit.matches++;
      }
    } catch {
      continue;
    }
    if (hit) hits.push(hit);
  }
  return hits;
}
