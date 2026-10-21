/**
 * The Files view's filesystem side: listing, searching, reading, saving, creating, uploading and deleting inside one
 * conversation's working directory. Every path is relative to that root and is resolved through realpath, so neither
 * `..` nor a symlink reaches outside it. Saves are optimistic: the caller names the version it edited (the content's
 * hash) and a changed file answers with its current content instead of being overwritten.
 *
 * Search and save rules follow AgentsInTheCloud's Files feature (packages/files/src/server, MIT, see
 * THIRD_PARTY_NOTICES.md); HUI does the work with Node's fs instead of a workspace shell.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { FileEntry, FileLocation, FileRead, FileSaved, FilesListing, FilesSearch } from "./api/files.ts";

export const MAX_RESOLVE_PATHS = 100;
export const MAX_RESOLVE_PATH_LENGTH = 1024;
export const MAX_EDITABLE_FILE_BYTES = 2_000_000;
export const MAX_RAW_FILE_BYTES = 64 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

export function fileExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}


export function previewMimeType(name: string): string {
  const extension = fileExtension(name);
  if (extension === "pdf") return "application/pdf";
  return IMAGE_TYPES[extension] ?? "application/octet-stream";
}

/** A refusal with the HTTP status the route answers. */
export class FilesError extends Error {
  status: number;
  code: string | undefined;
  /** For a 409 on save: the file as it is now. */
  current: FileRead | undefined;
  constructor(message: string, status = 400, code?: string, current?: FileRead) {
    super(message);
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

/** One directory listing is cut here; the rest stays reachable through search. */
export const MAX_LISTED_ENTRIES = 2_000;
/** Search answers this many matches at most. */
export const MAX_SEARCH_RESULTS = 100;
/** Outside Git, the fallback walk stops after this many files… */
export const MAX_WALKED_FILES = 20_000;
/** …or this many directories deep. */
const MAX_WALK_DEPTH = 16;
/** Never walked by the fallback search; Git's own ignore rules cover these inside a repository. */
const WALK_SKIPPED = new Set([".git", "node_modules", ".hg", ".svn", ".direnv", ".venv", "__pycache__"]);
const SEARCH_CACHE_MS = 3_000;
const TEMPORARY_PREFIX = ".hui-files-";
/** Never listed: Git's own store, like an editor's default file excludes. */
const HIDDEN_ENTRIES = new Set([".git"]);

/**
 * A relative request path as clean `/`-separated segments. Absolute paths, NUL bytes and `..` are refused before
 * anything touches the disk; `.` and empty segments are dropped, so `""` is the root.
 */
export function normalizeFilesPath(input: string | null | undefined): string {
  const value = input ?? "";
  if (value.includes("\0")) throw new FilesError("Paths cannot contain NUL bytes.", 400);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) throw new FilesError("Use a path relative to the working directory.", 400);
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new FilesError("That path leaves the working directory.", 403, "outside");
    segments.push(segment);
  }
  return segments.join("/");
}

/** A single new file or folder name: no separators, not `.` or `..`. */
export function validEntryName(name: string | null | undefined): string {
  const value = name ?? "";
  if (!value.trim() || value === "." || value === ".." || value.includes("/") || value.includes("\0")) {
    throw new FilesError("Choose a file name without slashes.", 422);
  }
  if (value.length > 255) throw new FilesError("That name is too long.", 422);
  return value;
}

/** The etag of a text file: a hash of its exact bytes. */
export function contentEtag(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 40);
}

/** The etag of a file whose content the view never edits: its modification time and size. */
function metadataEtag(mtimeMs: number, size: number): string {
  return `m${Math.trunc(mtimeMs).toString(36)}-s${size.toString(36)}`;
}

/** Strips the quotes and weak marker an `If-Match` header may carry. */
export function parseIfMatch(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^W\//u, "").replace(/^"(.*)"$/u, "$1");
}

/** Text the editor can hold: no NUL byte and valid UTF-8. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Ranks a candidate path for a query: lower is better, `undefined` is no match. Every whitespace-separated word
 * must appear in the path; a name that starts with the query beats one that contains it, which beats a match only
 * in its folders. */
export function searchRank(path: string, query: string): number | undefined {
  const lower = path.toLowerCase();
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length || words.some((word) => !lower.includes(word))) return undefined;
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  const whole = words.join(" ");
  const tier = name.startsWith(whole) ? 0 : name.includes(whole) ? 1 : words.every((word) => name.includes(word)) ? 2 : 3;
  return tier * 10_000 + Math.min(path.length, 9_999);
}

const writeLocks = new Map<string, Promise<unknown>>();
/** Saves and uploads to one file run one at a time, so the version check and the rename cannot interleave. */
async function withWriteLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const settled = run.catch(() => undefined);
  writeLocks.set(path, settled);
  try {
    return await run;
  } finally {
    if (writeLocks.get(path) === settled) writeLocks.delete(path);
  }
}

type CandidateFiles = { paths: string[]; source: "git" | "walk"; truncated: boolean };
const searchCache = new Map<string, { at: number; files: Promise<CandidateFiles> }>();

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function notFound(error: unknown, message: string): never {
  if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw new FilesError(message, 404, "not_found");
  if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") throw new FilesError("Permission denied.", 403, "denied");
  throw error;
}

/** The files of one working directory. Construct it with `FilesRoot.open`, which resolves and checks the root. */
export class FilesRoot {
  /** The root's real path. */
  readonly root: string;
  /** The working directory as the registry records it (absolute, not followed through links). */
  private readonly recorded: string;

  private constructor(root: string, recorded: string) {
    this.root = root;
    this.recorded = recorded;
  }

  static async open(cwd: string): Promise<FilesRoot> {
    let root: string;
    try {
      root = await realpath(cwd);
    } catch (error) {
      notFound(error, "The conversation's working directory no longer exists.");
    }
    const info = await stat(root);
    if (!info.isDirectory()) throw new FilesError("The conversation's working directory is not a folder.", 404, "not_found");
    return new FilesRoot(root, resolve(cwd));
  }

  private inside(path: string): boolean {
    return path === this.root || path.startsWith(this.root.endsWith(sep) ? this.root : `${this.root}${sep}`);
  }

  private relativePath(real: string): string {
    return relative(this.root, real).split(sep).join("/");
  }

  /** An existing entry, followed through symlinks; its real location must stay inside the root. */
  private async existing(path: string): Promise<{ real: string; rel: string }> {
    const rel = normalizeFilesPath(path);
    let real: string;
    try {
      real = await realpath(join(this.root, rel));
    } catch (error) {
      notFound(error, "File or folder not found.");
    }
    if (!this.inside(real)) throw new FilesError("That path leads outside the working directory.", 403, "outside");
    return { real, rel };
  }

  /** Where a new entry would go: its parent must exist inside the root; the entry itself is not followed. */
  private async target(path: string): Promise<{ real: string; rel: string; parent: string }> {
    const rel = normalizeFilesPath(path);
    if (!rel) throw new FilesError("Choose a path inside the working directory.", 422);
    const name = validEntryName(basename(rel));
    let parent: string;
    try {
      parent = await realpath(join(this.root, dirname(rel)));
    } catch (error) {
      notFound(error, "Folder not found.");
    }
    if (!this.inside(parent)) throw new FilesError("That path leads outside the working directory.", 403, "outside");
    if (!(await stat(parent)).isDirectory()) throw new FilesError("Folder not found.", 404, "not_found");
    const real = join(parent, name);
    return { real, rel: this.relativePath(real), parent };
  }

  private async entry(directory: string, name: string, kind: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Promise<FileEntry> {
    const full = join(directory, name);
    const path = this.relativePath(full);
    if (kind.isSymbolicLink()) {
      try {
        const real = await realpath(full);
        if (this.inside(real)) {
          const info = await stat(real);
          if (info.isDirectory()) return { name, path, kind: "directory", size: 0, symlink: true };
          if (info.isFile()) return { name, path, kind: "file", size: info.size, symlink: true };
        }
      } catch {
        // A dangling link stays a link.
      }
      return { name, path, kind: "symlink", size: 0 };
    }
    if (kind.isDirectory()) return { name, path, kind: "directory", size: 0 };
    if (kind.isFile()) {
      const size = await lstat(full).then((info) => info.size, () => 0);
      return { name, path, kind: "file", size };
    }
    return { name, path, kind: "other", size: 0 };
  }

  /**
   * Where a path the agent wrote in the chat points, when that is an existing file or folder inside the root: a
   * relative path (`./` and inner `..` resolved lexically, never above the root), an absolute one under the root as
   * either its real or its recorded location, or one under `~/` that lands there. Anything else is `undefined`
   * without touching the disk outside the root; inside it, `existing` applies the same realpath rule every route does.
   */
  async locate(input: string): Promise<FileLocation | undefined> {
    let value = input.trim().replace(/\/+$/u, "") || input.trim();
    if (!value || value.length > MAX_RESOLVE_PATH_LENGTH || value.includes("\0")) return undefined;
    if (value === "~" || value.startsWith("~/")) value = join(homedir(), value.slice(1));
    let rel: string;
    if (isAbsolute(value)) {
      const base = [this.root, this.recorded].find((candidate) => value === candidate || value.startsWith(candidate.endsWith(sep) ? candidate : `${candidate}${sep}`));
      if (!base) return undefined;
      rel = relative(base, value).split(sep).join("/");
    } else {
      rel = value;
    }
    rel = posix.normalize(rel || ".");
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return undefined;
    if (rel === ".") rel = "";
    try {
      const { real, rel: clean } = await this.existing(rel);
      const info = await stat(real);
      if (info.isDirectory()) return { path: clean, kind: "directory" };
      if (info.isFile()) return { path: clean, kind: "file" };
      return undefined;
    } catch (error) {
      if (error instanceof FilesError || errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(path: string): Promise<FilesListing> {
    const { real, rel } = await this.existing(path);
    if (!(await stat(real)).isDirectory()) throw new FilesError("That is a file, not a folder.", 422);
    let dirents;
    try {
      dirents = await readdir(real, { withFileTypes: true });
    } catch (error) {
      notFound(error, "Folder not found.");
    }
    const sorted = dirents
      .filter((dirent) => !dirent.name.startsWith(TEMPORARY_PREFIX) && !HIDDEN_ENTRIES.has(dirent.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = sorted.slice(0, MAX_LISTED_ENTRIES);
    const entries = await Promise.all(shown.map((dirent) => this.entry(real, dirent.name, dirent)));
    // Symlinked folders sort with folders once their target is known.
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    return { path: rel, entries, truncated: sorted.length > shown.length };
  }

  private gitFiles(): Promise<string[] | undefined> {
    return new Promise((resolve) => {
      execFile("git", ["-C", this.root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10_000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }, (error, stdout) => {
        if (error) resolve(undefined);
        else resolve([...new Set(stdout.split("\0").filter(Boolean))]);
      });
    });
  }

  private async walkFiles(): Promise<{ paths: string[]; truncated: boolean }> {
    const paths: string[] = [];
    const queue: { directory: string; depth: number }[] = [{ directory: this.root, depth: 0 }];
    while (queue.length) {
      const { directory, depth } = queue.shift()!;
      const dirents = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(directory, dirent.name);
        if (dirent.isDirectory()) {
          if (!WALK_SKIPPED.has(dirent.name) && depth + 1 < MAX_WALK_DEPTH) queue.push({ directory: full, depth: depth + 1 });
        } else if (dirent.isFile() || dirent.isSymbolicLink()) {
          paths.push(this.relativePath(full));
          if (paths.length >= MAX_WALKED_FILES) return { paths, truncated: true };
        }
      }
    }
    return { paths, truncated: false };
  }

  private candidateFiles(): Promise<CandidateFiles> {
    const cached = searchCache.get(this.root);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.files;
    const files = (async (): Promise<CandidateFiles> => {
      const git = await this.gitFiles();
      if (git) return { paths: git, source: "git", truncated: false };
      return { ...(await this.walkFiles()), source: "walk" };
    })();
    searchCache.set(this.root, { at: Date.now(), files });
    files.catch(() => searchCache.delete(this.root));
    return files;
  }

  /** Files whose path matches every word of the query: Git's tracked and unignored files inside a repository, a
   * bounded walk elsewhere. */
  async search(query: string): Promise<FilesSearch> {
    const trimmed = query.trim().slice(0, 200);
    if (!trimmed) return { query: trimmed, entries: [], truncated: false, source: "walk" };
    const { paths, source, truncated: walkTruncated } = await this.candidateFiles();
    const ranked: { path: string; rank: number }[] = [];
    for (const path of paths) {
      const rank = searchRank(path, trimmed);
      if (rank !== undefined) ranked.push({ path, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
    const entries: FileEntry[] = [];
    // Git still lists a tracked file the agent just deleted; only existing files are answered.
    for (const { path } of ranked) {
      if (entries.length >= MAX_SEARCH_RESULTS) break;
      const full = join(this.root, ...path.split("/"));
      const info = await stat(full).catch(() => undefined);
      if (!info?.isFile()) continue;
      const real = await realpath(full).catch(() => undefined);
      if (!real || !this.inside(real)) continue;
      entries.push({ name: basename(full), path, kind: "file", size: info.size });
    }
    return { query: trimmed, entries, truncated: walkTruncated || ranked.length > entries.length, source };
  }

  private async writable(real: string): Promise<boolean> {
    try {
      await access(real, constants.W_OK);
      await access(dirname(real), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async read(path: string): Promise<FileRead> {
    const { real, rel } = await this.existing(path);
    const info = await stat(real);
    if (info.isDirectory()) throw new FilesError("That is a folder, not a file.", 422);
    if (!info.isFile()) throw new FilesError("Only regular files can be opened.", 422);
    const name = basename(rel);
    const base = { path: rel, name, size: info.size, mtime: info.mtime.toISOString(), writable: await this.writable(real) };
    const mimeType = previewMimeType(name);
    const unedited = { etag: metadataEtag(info.mtimeMs, info.size), writable: false };
    if (mimeType.startsWith("image/")) return { ...base, ...unedited, kind: "image", mimeType };
    if (fileExtension(name) === "pdf") return { ...base, ...unedited, kind: "pdf", mimeType };
    if (info.size > MAX_EDITABLE_FILE_BYTES) return { ...base, ...unedited, kind: "too-large", mimeType: "application/octet-stream" };
    let bytes: Buffer;
    try {
      bytes = await readFile(real);
    } catch (error) {
      notFound(error, "File not found.");
    }
    const content = decodeText(bytes);
    if (content === undefined) return { ...base, ...unedited, kind: "binary", mimeType: "application/octet-stream" };
    return { ...base, size: bytes.length, kind: "text", mimeType: "text/plain; charset=utf-8", etag: contentEtag(bytes), content };
  }

  /** The bytes of a file for an image or PDF preview, or a download. */
  async raw(path: string): Promise<{ name: string; mimeType: string; data: Buffer }> {
    const { real, rel } = await this.existing(path);
    const info = await stat(real);
    if (!info.isFile()) throw new FilesError("Only regular files can be opened.", 422);
    if (info.size > MAX_RAW_FILE_BYTES) throw new FilesError("That file is too large to preview here.", 413);
    const name = basename(rel);
    return { name, mimeType: previewMimeType(name), data: await readFile(real) };
  }

  private async replace(real: string, data: Uint8Array, mode: number | undefined): Promise<void> {
    const temporary = join(dirname(real), `${TEMPORARY_PREFIX}${randomUUID()}`);
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o644 });
      if (mode !== undefined) await chmod(temporary, mode & 0o7777);
      await rename(temporary, real);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Replaces a text file's content when it still is the version the caller edited (`ifMatch`, the etag it read).
   * Otherwise it refuses with 409 and the file as it is now, so the caller can choose between the two.
   */
  async write(path: string, content: string, ifMatch: string | undefined): Promise<FileSaved> {
    if (ifMatch === undefined) throw new FilesError("Say which version you edited with If-Match.", 428);
    if (content.includes("\0")) throw new FilesError("Only text files can be edited here.", 415);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > MAX_EDITABLE_FILE_BYTES) throw new FilesError("Files larger than 2 MB cannot be edited here.", 413);
    const { real, rel } = await this.existing(path);
    return withWriteLock(real, async () => {
      const info = await stat(real).catch((error: unknown) => notFound(error, "File not found."));
      if (!info.isFile()) throw new FilesError("Only regular files can be edited.", 422);
      if (!(await this.writable(real))) throw new FilesError("This file is read-only.", 403, "read_only");
      const current = await this.read(rel);
      if (current.kind !== "text") throw new FilesError("Only text files can be edited here.", 415);
      if (current.etag !== ifMatch) throw new FilesError("The file changed on disk.", 409, "conflict", current);
      await this.replace(real, bytes, info.mode);
      const saved = await stat(real);
      return { path: rel, etag: contentEtag(bytes), size: bytes.length, mtime: saved.mtime.toISOString() };
    });
  }

  /** A new empty file or folder. An existing name is refused, never replaced. */
  async create(path: string, kind: "file" | "directory"): Promise<FileEntry> {
    const { real, rel } = await this.target(path);
    try {
      if (kind === "directory") await mkdir(real);
      else await (await open(real, "wx", 0o644)).close();
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new FilesError("Something with that name already exists.", 409, "exists");
      notFound(error, "Folder not found.");
    }
    searchCache.delete(this.root);
    return { name: basename(real), path: rel, kind, size: 0 };
  }

  /** Writes an uploaded file into a folder. An existing file is replaced only with `overwrite`; a folder or symlink
   * with that name never is. */
  async upload(directory: string, name: string, data: Uint8Array, overwrite: boolean): Promise<FileEntry> {
    const folder = normalizeFilesPath(directory);
    const file = validEntryName(name);
    const { real, rel } = await this.target(folder ? `${folder}/${file}` : file);
    if (data.length > MAX_RAW_FILE_BYTES) throw new FilesError("Uploads are limited to 64 MB.", 413);
    return withWriteLock(real, async () => {
      const existing = await lstat(real).catch(() => undefined);
      if (existing && !existing.isFile()) throw new FilesError("A folder or link already uses that name.", 422);
      if (existing && !overwrite) throw new FilesError("A file with that name already exists.", 409, "exists");
      await this.replace(real, data, existing?.mode);
      searchCache.delete(this.root);
      return { name: basename(real), path: rel, kind: "file" as const, size: data.length };
    });
  }

  /**
   * Deletes a file, a link (not its target) or a folder. A folder with anything inside is deleted only with
   * `recursive`, the risk the operator confirmed; the root itself never is.
   */
  async remove(path: string, recursive: boolean): Promise<{ path: string; kind: "file" | "directory" | "symlink" | "other" }> {
    const rel = normalizeFilesPath(path);
    if (!rel) throw new FilesError("The working directory itself cannot be deleted.", 422);
    const { real } = await this.target(rel);
    let info;
    try {
      info = await lstat(real);
    } catch (error) {
      notFound(error, "File or folder not found.");
    }
    searchCache.delete(this.root);
    if (info.isDirectory()) {
      const children = await readdir(real);
      if (children.length && !recursive) {
        throw new FilesError(`That folder holds ${children.length} item${children.length === 1 ? "" : "s"}.`, 409, "not_empty");
      }
      await rm(real, { recursive: true });
      return { path: this.relativePath(real), kind: "directory" };
    }
    await unlink(real);
    return { path: this.relativePath(real), kind: info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : "other" };
  }
}
