/**
 * Prompt attachments: the limits on what a prompt may carry, decoding and checking the browser's base64 uploads,
 * and HUI's attachment store under the config directory, where files are written for the agent to read by path
 * and read back only from inside the store.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import { ATTACHMENTS_DIR } from "../paths.ts";
import type { PromptAttachment } from "../runtimes/types.ts";

const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 16 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Browser names remain display metadata; the stored path uses this narrower
 * ASCII form independently. */
const STORAGE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeAttachmentName(name: string): boolean {
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

/** Writes an uploaded file under the config dir and returns its absolute path. */
export async function storeAttachmentFile(
  sessionId: string,
  name: string,
  dataBase64: string,
  root = ATTACHMENTS_DIR,
): Promise<{ path: string; name: string }> {
  const storedName = STORAGE_FILENAME.test(name) ? name : `attachment-${randomUUID().slice(0, 8)}`;
  const dir = join(root, sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
  await mkdir(dir, { recursive: true });
  // The UUID makes the path immutable across repeated uploads with the same
  // browser filename. PI may read it after the HTTP request has returned, so a
  // later prompt must never overwrite its bytes.
  const path = join(dir, `${randomUUID()}-${storedName}`);
  await writeFile(path, Buffer.from(dataBase64, "base64"), { flag: "wx" });
  return { path, name };
}

/** Reads a file `storeAttachmentFile` wrote; any other path, including one
 * a symlink leads out of the store, is refused. */
export async function readStoredAttachment(path: string, root = ATTACHMENTS_DIR): Promise<Buffer | undefined> {
  try {
    const [file, store] = await Promise.all([realpath(path), realpath(root)]);
    if (!file.startsWith(store + sep)) return undefined;
    const info = await stat(file);
    return info.isFile() && info.size <= MAX_ATTACHMENT_BYTES ? await readFile(file) : undefined;
  } catch {
    return undefined;
  }
}

export class AttachmentInputError extends Error {
  override name = "AttachmentInputError";
}

function decodeAttachment(data: unknown): { encoded: string; bytes: Buffer } {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length % 4 !== 0
  ) {
    throw new AttachmentInputError("Attachment data must be canonical base64.");
  }
  const bytes = Buffer.from(data, "base64");
  // A decode/re-encode check rejects stray characters and non-canonical
  // padding without running one giant regular expression over a 12 MB file.
  if (bytes.toString("base64") !== data) {
    throw new AttachmentInputError("Attachment data must be canonical base64.");
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentInputError("Each attachment must be 12 MB or smaller.");
  }
  return { encoded: data, bytes };
}

export type PreparedAttachments = {
  attachments: PromptAttachment[];
  /** Removes only files written for this rejected request. Accepted prompts
   * retain their immutable paths because PI can read them asynchronously. */
  cleanupRejected(): Promise<void>;
};

/**
 * Attachments arrive as base64 because the client already holds the bytes.
 * Images stay in memory and go to the model natively; files are written down
 * and referenced by path, which is what pi's own `read` tool expects. Invalid
 * shapes fail the whole request before any bytes are handed to PI.
 */
export async function readAttachments(
  sessionId: string,
  raw: unknown,
  store: typeof storeAttachmentFile = storeAttachmentFile,
): Promise<PreparedAttachments> {
  if (raw === undefined) return { attachments: [], cleanupRejected: async () => {} };
  if (!Array.isArray(raw)) throw new AttachmentInputError("Attachments must be a list.");
  if (raw.length > MAX_ATTACHMENT_COUNT) {
    throw new AttachmentInputError(`At most ${MAX_ATTACHMENT_COUNT} attachments may be sent at once.`);
  }

  const staged: Array<{
    kind: "image" | "file";
    name: string;
    mimeType: string;
    encoded: string;
    bytes: Buffer;
  }> = [];
  let total = 0;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      throw new AttachmentInputError("Every attachment must be an object.");
    }
    const item = entry as Record<string, unknown>;
    if (item["kind"] !== "image" && item["kind"] !== "file") {
      throw new AttachmentInputError("Attachment kind must be image or file.");
    }
    if (typeof item["name"] !== "string" || !isSafeAttachmentName(item["name"])) {
      throw new AttachmentInputError(
        "Attachment names must be 1–128 characters without path separators or controls.",
      );
    }
    const decoded = decodeAttachment(item["dataBase64"]);
    total += decoded.bytes.byteLength;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new AttachmentInputError("Attachments may total at most 16 MB per prompt.");
    }
    const mimeType = typeof item["mimeType"] === "string" ? item["mimeType"] : "application/octet-stream";
    if (item["kind"] === "image" && !IMAGE_MIME_TYPES.has(mimeType)) {
      throw new AttachmentInputError("Images must be PNG, JPEG, GIF, or WebP.");
    }
    staged.push({ kind: item["kind"], name: item["name"], mimeType, ...decoded });
  }

  const attachments: PromptAttachment[] = [];
  const written: string[] = [];
  const cleanupRejected = async () => {
    await Promise.all(written.map((path) => unlink(path).catch(() => {})));
  };
  try {
    for (const item of staged) {
      if (item.kind === "image") {
        attachments.push({ kind: "image", mimeType: item.mimeType, dataBase64: item.encoded, name: item.name });
      } else {
        const stored = await store(sessionId, item.name, item.encoded);
        written.push(stored.path);
        attachments.push({ kind: "file", ...stored });
      }
    }
  } catch (error) {
    await cleanupRejected();
    throw error;
  }
  return { attachments, cleanupRejected };
}
