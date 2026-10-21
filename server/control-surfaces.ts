/**
 * Read-only inspection behind the gateway health and workspace views: session counts by live status, the
 * context and memory files in each local session's workspace, and the Git worktrees of their repositories. It
 * never writes; symlinked memory files and anything under OpenClaw's own ~/.openclaw directory are left out.
 */
import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { liveSessions } from "./sessions/live-sessions.ts";
import type { MemorySource, WorktreeView, WorkspaceInspection } from "./api/worktrees.ts";
import { readRegistry, type SessionRecord } from "./sessions/sessions.ts";
import type { GatewayHealth } from "./api/diagnostics.ts";
export type { GatewayHealth } from "./api/diagnostics.ts";
export type { MemorySource, WorktreeView, WorkspaceInspection } from "./api/worktrees.ts";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT = 512 * 1024;
const MAX_MEMORY_FILES = 200;

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

const runCommand: CommandRunner = async (file, args) => {
  const result = await execFileAsync(file, [...args], {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

async function safeMemoryFile(
  workspace: string,
  candidate: string,
  kind: MemorySource["kind"],
): Promise<MemorySource | undefined> {
  try {
    const link = await lstat(candidate);
    if (link.isSymbolicLink() || !link.isFile()) return undefined;
    const canonical = await realpath(candidate);
    if (!isWithin(workspace, canonical)) return undefined;
    const info = await stat(canonical);
    return {
      workspace,
      path: canonical,
      relativePath: relative(workspace, canonical),
      kind,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function memorySources(workspace: string): Promise<MemorySource[]> {
  const direct = [
    ["AGENTS.md", "context"],
    ["CLAUDE.md", "context"],
    [join(".pi", "SYSTEM.md"), "context"],
    [join(".pi", "APPEND_SYSTEM.md"), "context"],
    ["MEMORY.md", "memory"],
  ] as const;
  const found = (
    await Promise.all(
      direct.map(([path, kind]) => safeMemoryFile(workspace, join(workspace, path), kind)),
    )
  ).filter((item): item is MemorySource => item !== undefined);

  const memoryDir = join(workspace, "memory");
  let entries: string[] = [];
  try {
    entries = (await readdir(memoryDir))
      .filter((name) => name.endsWith(".md") && !name.startsWith("."))
      .toSorted()
      .slice(0, MAX_MEMORY_FILES);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const source = await safeMemoryFile(workspace, join(memoryDir, entry), "memory");
    if (source) found.push(source);
  }
  return found;
}

export function parseWorktreePorcelain(source: string): Omit<WorktreeView, "repository" | "sessionIds">[] {
  const records: Omit<WorktreeView, "repository" | "sessionIds">[] = [];
  const blocks = source.includes("\0") ? source.split("\0\0") : source.trim().split(/\n\n+/u);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(source.includes("\0") ? "\0" : "\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? "";
    if (!path) continue;
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice(7) ?? "";
    records.push({
      path,
      branch: branchRef.replace(/^refs\/heads\//u, ""),
      head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "",
      bare: lines.includes("bare"),
      detached: lines.includes("detached"),
    });
  }
  return records;
}

async function repositoryFor(workspace: string, run: CommandRunner): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["-C", workspace, "rev-parse", "--show-toplevel"]);
    return canonicalDirectory(stdout.trim());
  } catch {
    return undefined;
  }
}

type SessionDirectory = { id: string; cwd: string };

function associatedSessions(path: string, sessions: readonly SessionDirectory[]): string[] {
  return sessions
    .filter(({ cwd }) => isWithin(path, cwd) || isWithin(cwd, path))
    .map(({ id }) => id);
}

export async function inspectWorkspaces(
  sessions: readonly SessionRecord[],
  run: CommandRunner = runCommand,
  home = homedir(),
): Promise<WorkspaceInspection> {
  const diagnostics: string[] = [];
  // Remote sessions' directories are on another machine.
  sessions = sessions.filter((session) => !session.worker);
  const cwds = [...new Set(sessions.map((session) => session.cwd))];
  const canonicalByCwd = new Map(await Promise.all(cwds.map(async (cwd) => [cwd, await canonicalDirectory(cwd)] as const)));
  const workspaces = [...new Set(canonicalByCwd.values())].filter((path): path is string => path !== undefined).toSorted();
  // Git reports worktree paths resolved, so compare session cwds resolved too:
  // a session's cwd may go through a symlink (macOS /var or /tmp, a linked home).
  const sessionDirectories: SessionDirectory[] = sessions.map((session) => ({
    id: session.id,
    cwd: canonicalByCwd.get(session.cwd) ?? resolve(session.cwd),
  }));
  const configuredOpenClawRoot = resolve(home, ".openclaw");
  const openClawRoot = (await canonicalDirectory(configuredOpenClawRoot)) ?? configuredOpenClawRoot;
  const memory: MemorySource[] = [];
  for (const workspace of workspaces) {
    if (isWithin(openClawRoot, workspace)) {
      diagnostics.push(`OpenClaw-owned memory was excluded from ${workspace}.`);
      continue;
    }
    memory.push(...(await memorySources(workspace)));
  }

  const repositories = new Set<string>();
  for (const workspace of workspaces) {
    const repository = await repositoryFor(workspace, run);
    if (repository) repositories.add(repository);
  }
  const worktrees: WorktreeView[] = [];
  for (const repository of [...repositories].toSorted()) {
    try {
      const { stdout } = await run("git", ["-C", repository, "worktree", "list", "--porcelain", "-z"]);
      for (const record of parseWorktreePorcelain(stdout)) {
        const canonicalPath = (await canonicalDirectory(record.path)) ?? resolve(record.path);
        worktrees.push({
          ...record,
          repository,
          path: canonicalPath,
          sessionIds: associatedSessions(canonicalPath, sessionDirectories),
        });
      }
    } catch (error) {
      diagnostics.push(
        `Could not inspect worktrees for ${basename(repository)}: ${
          isRecord(error) && typeof error["message"] === "string" ? error["message"] : "git failed"
        }`,
      );
    }
  }
  return { workspaces, memory, worktrees, diagnostics };
}

export async function readWorkspaceInspection(): Promise<WorkspaceInspection> {
  return inspectWorkspaces(await readRegistry());
}

export async function readGatewayHealth(): Promise<GatewayHealth> {
  const records = await readRegistry();
  const sessions: GatewayHealth["sessions"] = {
    registered: records.length,
    starting: 0,
    idle: 0,
    running: 0,
    waiting: 0,
    error: 0,
    reconnecting: 0,
    disconnected: 0,
    processes: 0,
  };
  for (const record of records) {
    if (liveSessions.isLive(record.id)) sessions[liveSessions.status(record.id)] += 1;
    if (liveSessions.hasRuntime(record.id)) sessions.processes += 1;
  }
  return {
    status: "online",
    transport: "HTTP + SSE",
    uptimeSeconds: Math.floor(process.uptime()),
    access: "Full Access",
    sessions,
  };
}
