/**
 * Turning browser `File` objects into attachments.
 *
 * Everything travels as base64 because that is what both the HTTP body and pi's
 * `images` field want. Images are also kept as data URLs so the composer can
 * show a thumbnail without a second read.
 */
import type { Attachment } from "../api/sessions.ts";

/** pi accepts these natively as image content. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Files are handed to the agent as paths, so anything readable is allowed;
 * this only guards against something absurd being base64'd into memory. */
export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/** Mirrors the gateway boundary. Display names may contain Unicode and spaces,
 * but never path separators, traversal-only names, or control characters. */
export function isSafeAttachmentName(name: string): boolean {
  const characters = [...name];
  return (
    characters.length > 0 &&
    characters.length <= 128 &&
    name.trim().length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/\p{Cc}]/u.test(name)
  );
}

export function isImageType(mimeType: string): boolean {
  return IMAGE_TYPES.has(mimeType);
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked so a large file cannot blow the argument limit of `fromCharCode`.
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Throws a message worth showing when a file is too big or unreadable. */
export async function readAttachment(file: File): Promise<Attachment> {
  if (!isSafeAttachmentName(file.name)) {
    throw new Error("Attachment names must be 1–128 characters without path separators or controls.");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than 12 MB.`);
  }
  const mimeType = file.type || "application/octet-stream";
  return {
    kind: isImageType(mimeType) ? "image" : "file",
    name: file.name,
    mimeType,
    dataBase64: toBase64(await file.arrayBuffer()),
  };
}

export function attachmentBytes(attachment: Attachment): number {
  const padding = attachment.dataBase64.endsWith("==") ? 2 : attachment.dataBase64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((attachment.dataBase64.length * 3) / 4) - padding);
}

export function validateAttachmentTotal(attachments: readonly Attachment[]): void {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`At most ${MAX_ATTACHMENT_COUNT} attachments may be sent at once.`);
  }
  for (const item of attachments) {
    if (!isSafeAttachmentName(item.name)) {
      throw new Error("Attachment names must be 1–128 characters without path separators or controls.");
    }
    if (attachmentBytes(item) > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${item.name} is larger than 12 MB.`);
    }
  }
  const total = attachments.reduce((sum, item) => sum + attachmentBytes(item), 0);
  if (total > MAX_PROMPT_ATTACHMENT_BYTES) {
    throw new Error("Attachments must be 16 MB or less in total.");
  }
}

/** A data URL for an attachment already in memory, for thumbnails. */
export function attachmentPreview(attachment: Attachment): string | undefined {
  return attachment.kind === "image"
    ? `data:${attachment.mimeType};base64,${attachment.dataBase64}`
    : undefined;
}
