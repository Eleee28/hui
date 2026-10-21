/**
 * Durable composer drafts in this browser's IndexedDB: one per session plus the New Session form. Storage is
 * best effort and bounded by count, age and attachment size, writes to one key are serialised, and draft
 * contents never leave the browser.
 */
import { attachmentBytes, validateAttachmentTotal } from "../attachments.ts";
import type { Attachment } from "../../api/sessions.ts";

export type ComposerDraft = { text: string; attachments: readonly Attachment[] };

export const NEW_SESSION_DRAFT_KEY = "new-session";
const DATABASE = "hui-control-ui";
const STORE = "composerDrafts";
const VERSION = 1;
const MAX_DRAFTS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORED_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const mutations = new Map<string, Promise<unknown>>();

type DraftRecord = ComposerDraft & { key: string; updatedAt: number };

export function sessionDraftKey(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Only the app that renders the launch form may read or write the launch
 * draft; a chat pane owns the `session:<id>` keys alone. A pane switching or
 * unmounting with the launch key would otherwise clobber the shell's text. */
export function mayUseComposerDraftKey(embeddedPane: boolean, key: string): boolean {
  return !embeddedPane || key !== NEW_SESSION_DRAFT_KEY;
}

export function sessionIdFromDraftKey(key: string): string | undefined {
  return key.startsWith("session:") && key.length > "session:".length
    ? key.slice("session:".length)
    : undefined;
}

export function mergeComposerDraft(
  current: ComposerDraft,
  recovered: ComposerDraft,
): ComposerDraft {
  return {
    text: current.text ? `${recovered.text}\n\n${current.text}` : recovered.text,
    attachments: [...recovered.attachments, ...current.attachments],
  };
}

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Attachment>;
  return (item.kind === "image" || item.kind === "file") &&
    typeof item.name === "string" && typeof item.mimeType === "string" && typeof item.dataBase64 === "string";
}

function parseRecord(value: unknown): DraftRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<DraftRecord>;
  if (typeof record.key !== "string" || typeof record.text !== "string" ||
      typeof record.updatedAt !== "number" || !Array.isArray(record.attachments) ||
      !record.attachments.every(isAttachment)) return undefined;
  const parsed = { key: record.key, text: record.text, updatedAt: record.updatedAt, attachments: record.attachments };
  try {
    validateAttachmentTotal(parsed.attachments);
    return parsed;
  } catch {
    return undefined;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}

async function database(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "key" });
    }, { once: true });
    request.addEventListener("success", () => {
      request.result.addEventListener("versionchange", () => request.result.close());
      resolve(request.result);
    }, { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB open failed")), { once: true });
    request.addEventListener("blocked", () => reject(new Error("IndexedDB open was blocked")), { once: true });
  });
}

function afterPendingMutation(key: string): Promise<unknown> {
  return mutations.get(key)?.catch(() => undefined) ?? Promise.resolve();
}

function enqueueMutation<T>(key: string, mutation: () => Promise<T>): Promise<T> {
  const queued = afterPendingMutation(key).then(mutation);
  mutations.set(key, queued);
  const release = () => {
    if (mutations.get(key) === queued) mutations.delete(key);
  };
  void queued.then(release, release);
  return queued;
}

export async function readComposerDraft(key: string): Promise<ComposerDraft> {
  await afterPendingMutation(key);
  const db = await database().catch(() => undefined);
  if (!db) return { text: "", attachments: [] };
  try {
    const transaction = db.transaction(STORE, "readonly");
    const done = transactionDone(transaction);
    const value = await requestResult(transaction.objectStore(STORE).get(key));
    await done;
    const record = parseRecord(value);
    if (!record || record.updatedAt < Date.now() - MAX_AGE_MS) {
      if (value !== undefined) await deleteComposerDraft(key);
      return { text: "", attachments: [] };
    }
    return { text: record.text, attachments: record.attachments };
  } catch {
    return { text: "", attachments: [] };
  } finally {
    db.close();
  }
}

/** Session ids with a durable, non-empty composer draft. Used only to project
 * the pencil indicator in the sidebar; draft contents never leave IndexedDB. */
export async function listComposerDraftSessionIds(): Promise<string[]> {
  await Promise.all([...mutations.values()].map((mutation) => mutation.catch(() => undefined)));
  const db = await database().catch(() => undefined);
  if (!db) return [];
  try {
    const transaction = db.transaction(STORE, "readonly");
    const done = transactionDone(transaction);
    const values = await requestResult(transaction.objectStore(STORE).getAll());
    await done;
    const cutoff = Date.now() - MAX_AGE_MS;
    return values.flatMap((value) => {
      const record = parseRecord(value);
      const sessionId = record ? sessionIdFromDraftKey(record.key) : undefined;
      return record && record.updatedAt >= cutoff && sessionId && (record.text || record.attachments.length)
        ? [sessionId]
        : [];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function writeComposerDraftNow(key: string, draft: ComposerDraft): Promise<"persisted" | "capacity" | "unavailable"> {
  const bytes = draft.attachments.reduce((total, attachment) => total + attachmentBytes(attachment), 0);
  if (bytes > MAX_STORED_ATTACHMENT_BYTES) return "capacity";
  try {
    validateAttachmentTotal(draft.attachments);
  } catch {
    return "capacity";
  }
  if (!draft.text && draft.attachments.length === 0) {
    await deleteComposerDraftNow(key);
    return "persisted";
  }
  const db = await database().catch(() => undefined);
  if (!db) return "unavailable";
  try {
    const read = db.transaction(STORE, "readonly");
    const readDone = transactionDone(read);
    const existing = await requestResult(read.objectStore(STORE).getAll());
    await readDone;
    const now = Date.now();
    const retained = existing
      .map(parseRecord)
      .filter((record): record is DraftRecord => Boolean(record && record.key !== key && record.updatedAt >= now - MAX_AGE_MS))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_DRAFTS - 1);
    const transaction = db.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE);
    store.clear();
    for (const record of retained) store.put(record);
    store.put({ key, text: draft.text, attachments: [...draft.attachments], updatedAt: now } satisfies DraftRecord);
    await done;
    return "persisted";
  } catch {
    return "unavailable";
  } finally {
    db.close();
  }
}

export function writeComposerDraft(key: string, draft: ComposerDraft): Promise<"persisted" | "capacity" | "unavailable"> {
  return enqueueMutation(key, () => writeComposerDraftNow(key, draft));
}

async function deleteComposerDraftNow(key: string): Promise<void> {
  const db = await database().catch(() => undefined);
  if (!db) return;
  try {
    const transaction = db.transaction(STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE).delete(key);
    await done;
  } catch {
    // Draft durability is best-effort; the in-memory composer remains intact.
  } finally {
    db.close();
  }
}

export function deleteComposerDraft(key: string): Promise<void> {
  return enqueueMutation(key, () => deleteComposerDraftNow(key));
}
