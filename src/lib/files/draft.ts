/**
 * A File draft: one file's working text and save state, shared by every Files view showing that file in this page.
 * One writer serializes saves so each uses the version the previous save produced; failed or conflicting saves
 * keep the unsaved text; a copy of unsaved text survives a reload in localStorage until it reaches the disk.
 *
 * Ported from AgentsInTheCloud (packages/files/src/file-draft.ts and the draft registry in
 * src/client/file-editor.ts, MIT, see THIRD_PARTY_NOTICES.md). HUI's versions are the gateway's etags, and an
 * explicit overwrite names the version shown in the conflict instead of forcing past every check.
 */
import type { FileRead } from "../../api/schema/files.ts";

/** The part of a read a draft needs. */
export type DraftFile = Pick<FileRead, "content" | "etag" | "writable"> & { content: string };
export type SaveRequest = { content: string; etag: string };
export type SaveResult = { etag: string } | { conflict: DraftFile };
type SaveFile = (request: SaveRequest) => Promise<SaveResult>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FileDraft {
  content: string;
  savedContent: string;
  etag: string;
  writable: boolean;
  /** The file as it is on disk when it changed under unsaved edits. */
  conflict: DraftFile | undefined;
  error: string | undefined;
  /** Set when the localStorage copy of unsaved text could not be written. */
  backupError: string | undefined;
  saving = false;
  readonly listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private readonly write: SaveFile;

  constructor(file: DraftFile, write: SaveFile) {
    this.content = this.savedContent = file.content;
    this.etag = file.etag;
    this.writable = file.writable;
    this.write = write;
  }

  get dirty(): boolean { return this.content !== this.savedContent; }

  edit(content: string): void {
    this.content = content;
    this.notify();
  }

  /** Takes the disk's version, dropping unsaved text (Reload, or a clean draft following the disk). */
  accept(file: DraftFile): void {
    this.content = this.savedContent = file.content;
    this.etag = file.etag;
    this.writable = file.writable;
    this.conflict = undefined;
    this.error = undefined;
    this.notify();
  }

  /** A fresh read of the file. A clean draft follows it; unsaved text that differs becomes a conflict. */
  changedOnDisk(file: DraftFile): void {
    if (this.saving || file.etag === this.etag) return;
    if (!this.dirty || file.content === this.content) this.accept(file);
    else {
      this.conflict = file;
      this.notify();
    }
  }

  /** Saves now. `overwrite` replaces the conflicting disk version with this text. */
  flush(overwrite = false): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.save(overwrite).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async save(overwrite: boolean): Promise<void> {
    this.error = undefined;
    if (overwrite && this.conflict) {
      this.etag = this.conflict.etag;
      this.conflict = undefined;
    }
    if (this.conflict || !this.writable) return;
    this.saving = true;
    this.notify();
    try {
      let force = overwrite;
      while (force || this.dirty) {
        const content = this.content;
        const result = await this.write({ content, etag: this.etag });
        if ("conflict" in result) {
          this.conflict = result.conflict;
          break;
        }
        this.etag = result.etag;
        this.savedContent = content;
        force = false;
        this.notify();
      }
    } catch (error) {
      this.error = message(error);
    } finally {
      this.saving = false;
      this.notify();
    }
  }

  notify(): void { for (const listener of this.listeners) listener(); }
}

export type DraftStatus = { state: "saved" | "saving" | "conflict" | "error" | "read-only"; text: string };

/** What the save indicator says. A debounced save that has not started yet already reads Saving. */
export function draftStatus(draft: FileDraft): DraftStatus {
  if (draft.conflict) return { state: "conflict", text: "Conflict" };
  if (draft.error) return { state: "error", text: `Not saved: ${draft.error}` };
  if (draft.backupError) return { state: "error", text: draft.backupError };
  if (!draft.writable) return { state: "read-only", text: "Read only" };
  if (draft.dirty || draft.saving) return { state: "saving", text: "Saving…" };
  return { state: "saved", text: "Saved" };
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const BACKUP_PREFIX = "hui.file-draft.v1:";
const drafts = new Map<string, FileDraft>();

export function draftKey(sessionId: string, path: string): string {
  return `${sessionId}\n${path}`;
}

function defaultStorage(): DraftStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readBackup(storage: DraftStorage | undefined, key: string): { base: DraftFile; content: string } | undefined {
  try {
    const raw = storage?.getItem(BACKUP_PREFIX + key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as { base?: { content?: unknown; etag?: unknown }; content?: unknown };
    if (typeof value.base?.content !== "string" || typeof value.base.etag !== "string" || typeof value.content !== "string") return undefined;
    return { base: { content: value.base.content, etag: value.base.etag, writable: true }, content: value.content };
  } catch {
    return undefined;
  }
}

/**
 * The page's draft of a file, created from `file` the first time and refreshed by it afterwards. A draft restored
 * from an unsaved localStorage copy saves again by itself, or becomes a conflict if the file moved on meanwhile.
 */
export function openDraft(key: string, file: DraftFile, write: SaveFile, storage: DraftStorage | undefined = defaultStorage()): FileDraft {
  const existing = drafts.get(key);
  if (existing) {
    existing.changedOnDisk(file);
    return existing;
  }
  const backup = readBackup(storage, key);
  const draft = new FileDraft(backup ? { ...backup.base, writable: file.writable } : file, write);
  if (backup) draft.edit(backup.content);
  draft.listeners.add(() => {
    try {
      if (draft.dirty) storage?.setItem(BACKUP_PREFIX + key, JSON.stringify({ base: { content: draft.savedContent, etag: draft.etag }, content: draft.content }));
      else storage?.removeItem(BACKUP_PREFIX + key);
      draft.backupError = undefined;
    } catch (error) {
      // A full or disabled storage must not stop saves to disk.
      draft.backupError = `Draft backup failed: ${message(error)}. Keep this tab open until saved.`;
    }
  });
  drafts.set(key, draft);
  draft.changedOnDisk(file);
  return draft;
}

/** Stops one view following a draft. The last view flushes it, and a draft with nothing left to save is forgotten. */
export function releaseDraft(key: string, draft: FileDraft, listener: () => void): Promise<void> {
  draft.listeners.delete(listener);
  return draft.flush().then(() => {
    // The registry's own backup listener is the one left.
    if (!draft.dirty && draft.listeners.size <= 1 && drafts.get(key) === draft) drafts.delete(key);
  });
}

/** Forgets a file's draft after the file itself was deleted. */
export function forgetDraft(key: string, storage: DraftStorage | undefined = defaultStorage()): void {
  drafts.delete(key);
  try { storage?.removeItem(BACKUP_PREFIX + key); } catch { /* nothing to clean */ }
}

export function existingDraft(key: string): FileDraft | undefined {
  return drafts.get(key);
}

/** True while any draft in this page holds text that has not reached the disk. */
export function hasUnsavedDrafts(): boolean {
  return [...drafts.values()].some((draft) => draft.dirty);
}
