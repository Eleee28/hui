/**
 * Resolution and completion for paths the operator types: a new session's working directory and file paths
 * inside a session's workspace. Relative input resolves against home or the session workspace, never the
 * gateway's own cwd, and suggestions are capped.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { LocalPathSuggestion } from "../api/local-paths.ts";
export type { LocalPathSuggestion } from "../api/local-paths.ts";

const MAX_SUGGESTIONS = 40;

/** Resolve shell-like input without leaking the server process cwd into UX. */
export function resolveWorkingDirectory(input: string, home = homedir()): string {
  const value = input.trim() || "~/";
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith(`~${sep}`)) {
    return resolve(home, value.slice(2));
  }
  return isAbsolute(value) ? normalize(value) : resolve(home, value);
}

/** `path` with the home directory shortened to `~/`, for display only. */
export function displayPath(path: string, home = homedir()): string {
  if (path === home) return "~/";
  return path.startsWith(`${home}${sep}`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** Directory-only completion; dot directories appear only for a dot fragment. */
export async function completeWorkingDirectories(input: string, home = homedir()): Promise<string[]> {
  const typed = input || "~/";
  const lastSeparator = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf(sep));
  const parentInput = lastSeparator >= 0 ? typed.slice(0, lastSeparator + 1) : "~/";
  const parent = resolveWorkingDirectory(parentInput, home);
  const fragment = lastSeparator >= 0 ? typed.slice(lastSeparator + 1) : typed;
  const includeHidden = fragment.startsWith(".");

  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    if (!entry.name.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase())) continue;
    const path = join(parent, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      isDirectory = await stat(path).then((info) => info.isDirectory()).catch(() => false);
    }
    if (isDirectory) candidates.push(`${displayPath(path, home)}/`);
  }
  return candidates.sort((a, b) => a.localeCompare(b)).slice(0, MAX_SUGGESTIONS);
}

/** Complete one path segment relative to a session workspace. */
export async function completeLocalPaths(
  input: string,
  cwd: string,
  home = homedir(),
): Promise<LocalPathSuggestion[]> {
  const typed = input;
  const lastSeparator = typed.lastIndexOf("/");
  const parentInput = lastSeparator >= 0 ? typed.slice(0, lastSeparator + 1) : "";
  const fragment = lastSeparator >= 0 ? typed.slice(lastSeparator + 1) : typed;
  const includeHidden = fragment.startsWith(".");
  const parent = parentInput.startsWith("~")
    ? resolveWorkingDirectory(parentInput, home)
    : isAbsolute(parentInput)
      ? normalize(parentInput)
      : resolve(cwd, parentInput || ".");

  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: LocalPathSuggestion[] = [];
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith(".")) continue;
    if (!entry.name.toLocaleLowerCase().startsWith(fragment.toLocaleLowerCase())) continue;
    const path = join(parent, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      isDirectory = await stat(path).then((info) => info.isDirectory()).catch(() => false);
    }
    candidates.push({
      path: `${parentInput}${entry.name}${isDirectory ? "/" : ""}`,
      kind: isDirectory ? "directory" : "file",
    });
  }
  return candidates
    .sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.path.localeCompare(b.path))
    .slice(0, MAX_SUGGESTIONS);
}

/** A browser-entered working directory, resolved (`~/`) and confirmed to be
 * an existing directory. */
export async function existingDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string") throw new Error("Working directory must be text.");
  const cwd = resolveWorkingDirectory(value);
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error(`No such directory: ${cwd}`);
  }
  if (!info.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  return cwd;
}
