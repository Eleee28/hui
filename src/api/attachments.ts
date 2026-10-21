/** Reading a sent message's attachments back from the gateway into composer attachments. */
import { readAttachment } from "../lib/attachments.ts";
import type { Attachment, TranscriptAttachment } from "./sessions.ts";

/** Reads a sent message's attachments back into composer attachments.
 * Unreadable ones are skipped. */
export async function readTranscriptAttachments(items: readonly (string | TranscriptAttachment)[] = []): Promise<Attachment[]> {
  const readable = items.filter((item): item is TranscriptAttachment & { url: string } =>
    typeof item !== "string" && Boolean(item.url));
  const read = await Promise.allSettled(readable.map(async (item) => {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`Could not read ${item.name}.`);
    const blob = await response.blob();
    return readAttachment(new File([blob], item.name, { type: item.mimeType || blob.type }));
  }));
  return read.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}
