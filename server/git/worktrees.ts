/**
 * Git checkout handling for new sessions: listing branches for the checkout picker, switching the selected
 * checkout, and creating an isolated worktree on a fresh prefixed branch under HUI's worktrees directory. Git
 * enforces safety, so HUI never forces, stashes or fetches, and a created worktree comes with a rollback the
 * caller runs if the session is never registered. Also decides which worktrees cleanup may remove and which
 * removal risks the user acknowledged.
 */
import { createHash } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { WORKTREES_DIR } from "../paths.ts";
import type { WorktreeProgress } from "../api/sessions.ts";
import type { WorktreeRow, WorktreeRisk } from "../api/worktrees.ts";
import { worktreeSlug } from "./branch-names.ts";
import type { GitCheckoutInfo } from "../api/local-paths.ts";
export type { GitCheckoutInfo } from "../api/local-paths.ts";

export { worktreeSlug };

export type GitResult = { code: number; stdout: string; stderr: string };
export type GitRunner = (
  cwd: string,
  args: readonly string[],
  onProgress?: (progress: WorktreeProgress) => void,
) => Promise<GitResult>;

export type CreatedSessionWorktree = {
  branch: string;
  path: string;
  cwd: string;
  rollback: () => Promise<void>;
};

const MAX_GIT_OUTPUT = 1_000_000;
/** Large monorepos and corporate checkout filters can take several minutes. */
const GIT_TIMEOUT_MS = 30 * 60_000;

export class WorktreeInputError extends Error {}

/** Read the bounded Git context used by New Session's checkout picker. This is
 * discovery only: it never fetches remotes or changes the selected checkout. */
export async function inspectGitCheckout(
  sourceDirectory: string,
  git: GitRunner = runGit,
): Promise<GitCheckoutInfo> {
  let directory: string;
  try {
    directory = await realpath(sourceDirectory);
  } catch {
    return { available: false, headBranch: "", defaultBranch: "", branches: [] };
  }
  const topLevel = await git(directory, ["rev-parse", "--show-toplevel"]);
  const head = await git(directory, ["rev-parse", "--verify", "HEAD"]);
  if (topLevel.code !== 0 || head.code !== 0) {
    return { available: false, headBranch: "", defaultBranch: "", branches: [] };
  }

  const current = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remoteDefault = await git(directory, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const headBranch = current.code === 0 ? current.stdout.trim() : "";
  const remoteDefaultBranch = remoteDefault.code === 0
    ? remoteDefault.stdout.trim().replace(/^origin\//u, "")
    : "";
  const refs = await git(directory, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (refs.code !== 0) {
    return {
      available: true,
      headBranch,
      defaultBranch: remoteDefaultBranch ? `origin/${remoteDefaultBranch}` : headBranch || "HEAD",
      branches: [],
      branchesUnavailable: true,
    };
  }
  const branches = [...new Set(refs.stdout.split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch && !branch.endsWith("/HEAD")))]
    .sort((left, right) => left.localeCompare(right));
  // Prefer the advertised remote default; without it use a conventional local
  // default before falling back to the current checkout (including detached HEAD).
  const defaultBranch = remoteDefaultBranch
    ? (branches.includes(remoteDefaultBranch) ? remoteDefaultBranch : `origin/${remoteDefaultBranch}`)
    : ["main", "master"].find((branch) => branches.includes(branch)) || headBranch || "HEAD";
  const preferred = [defaultBranch, headBranch].filter(Boolean);
  const ordered = [...new Set([...preferred, ...branches])].slice(0, 80);
  return {
    available: true,
    headBranch,
    defaultBranch,
    branches: ordered,
  };
}

export function parseGitWorktreeProgress(output: string): WorktreeProgress | undefined {
  const matcher = /(?:^|[\r\n])(Updating files|Filtering content):\s+(\d+)%\s+\((\d+)\/(\d+)\)/g;
  let match: RegExpExecArray | null;
  let progress: WorktreeProgress | undefined;
  while ((match = matcher.exec(output)) !== null) {
    const percent = Number(match[2]);
    const completed = Number(match[3]);
    const total = Number(match[4]);
    if (!Number.isFinite(percent) || !Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) continue;
    progress = {
      phase: match[1] === "Filtering content" ? "filtering" : "checkout",
      percent: Math.max(0, Math.min(100, percent)),
      completed,
      total,
    };
  }
  return progress;
}

export const runGit: GitRunner = (cwd, args, onProgress) => new Promise((resolveResult, reject) => {
  const child = spawn("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    ...(onProgress ? {
      env: {
        ...process.env,
        GIT_PROGRESS_DELAY: "0",
        LANG: "C",
        LC_ALL: "C",
      },
    } : {}),
  });
  let stdout = "";
  let stderr = "";
  let progressTail = "";
  let lastProgress = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
  const append = (current: string, chunk: Buffer) => `${current}${chunk.toString("utf8")}`.slice(-MAX_GIT_OUTPUT);
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
    if (!onProgress) return;
    const text = `${progressTail}${chunk.toString("utf8")}`;
    const progress = parseGitWorktreeProgress(text);
    progressTail = text.slice(-512);
    if (!progress) return;
    const key = `${progress.phase}:${progress.completed}:${progress.total}`;
    if (key === lastProgress) return;
    lastProgress = key;
    onProgress(progress);
  });
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("close", (code) => {
    clearTimeout(timeout);
    resolveResult({ code: code ?? 1, stdout, stderr });
  });
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

function gitFailure(action: string, result: GitResult): WorktreeInputError {
  // Git prints progress before the actual failure.
  const lines = (result.stderr || result.stdout).trim().split("\n");
  const detail = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0];
  return new WorktreeInputError(detail ? `${action}: ${detail}` : `${action} failed.`);
}

/** Switches the selected repository checkout before a non-worktree session
 * starts. Git owns safety here: dirty checkouts that would be overwritten fail
 * with Git's normal message instead of HUI forcing or stashing anything. */
export async function checkoutSessionRef(
  sourceDirectory: string,
  ref: string,
  git: GitRunner = runGit,
): Promise<void> {
  const source = await realpath(sourceDirectory);
  const topLevel = await git(source, ["rev-parse", "--show-toplevel"]);
  if (topLevel.code !== 0) throw new WorktreeInputError("Changing checkout requires a Git repository.");
  const selected = ref.trim();
  if (!selected) return;
  const resolved = await git(source, ["rev-parse", "--verify", "--end-of-options", `${selected}^{commit}`]);
  if (resolved.code !== 0) throw new WorktreeInputError(`Git could not resolve the branch or commit: ${selected}`);
  const checkedOut = await git(source, ["checkout", selected]);
  if (checkedOut.code !== 0) throw gitFailure("Could not change Git checkout", checkedOut);
}

/** Creates an isolated checkout from the selected directory and base ref.
 * The caller owns rollback until its session registry write commits. */
export async function createSessionWorktree(options: {
  sourceDirectory: string;
  title: string;
  branchName?: string;
  baseRef?: string;
  branchPrefix: string;
  root?: string;
  git?: GitRunner;
  onProgress?: (progress: WorktreeProgress) => void;
}): Promise<CreatedSessionWorktree> {
  const git = options.git ?? runGit;
  const sourceDirectory = await realpath(options.sourceDirectory);
  const topLevel = await git(sourceDirectory, ["rev-parse", "--show-toplevel"]);
  if (topLevel.code !== 0) throw new WorktreeInputError("Create in workspace requires a Git repository.");
  const repoRoot = await realpath(topLevel.stdout.trim());
  const sourceRelative = relative(repoRoot, sourceDirectory);
  if (sourceRelative === ".." || sourceRelative.startsWith(`..${sep}`) || resolve(repoRoot, sourceRelative) !== sourceDirectory) {
    throw new WorktreeInputError("The selected directory is outside its Git repository.");
  }
  const baseRef = options.baseRef?.trim() || "HEAD";
  const base = await git(sourceDirectory, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
  if (base.code !== 0) throw new WorktreeInputError(`Git could not resolve the base branch or commit: ${baseRef}`);

  const repositoryKey = `${basename(repoRoot)}-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 12)}`;
  const worktreesRoot = join(options.root ?? WORKTREES_DIR, repositoryKey);
  await mkdir(worktreesRoot, { recursive: true });
  const baseSlug = worktreeSlug(options.branchName ?? options.title);

  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const suffix = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
    const branch = `${options.branchPrefix}${suffix}`;
    const valid = await git(repoRoot, ["check-ref-format", "--branch", branch]);
    if (valid.code !== 0) throw new WorktreeInputError("The configured branch prefix does not form a valid Git branch.");
    const branchLookup = await git(repoRoot, ["show-ref", "--quiet", "--verify", `refs/heads/${branch}`]);
    if (branchLookup.code === 0) continue;
    if (branchLookup.code !== 1) throw gitFailure("Could not inspect Git branches", branchLookup);

    const path = join(worktreesRoot, branch.replaceAll("/", "--"));
    if (await exists(path)) continue;
    options.onProgress?.({ phase: "preparing" });
    const added = await git(
      repoRoot,
      ["worktree", "add", "-b", branch, "--", path, base.stdout.trim()],
      options.onProgress,
    );
    if (added.code !== 0) {
      const raced = await git(repoRoot, ["show-ref", "--quiet", "--verify", `refs/heads/${branch}`]);
      // A parallel creation took this name first (git runs with LC_ALL=C).
      if (raced.code === 0 && /already exists|File exists/.test(added.stderr)) continue;
      throw gitFailure("Could not create Git workspace", added);
    }
    options.onProgress?.({ phase: "finalizing" });

    let rolledBack = false;
    const rollback = async () => {
      if (rolledBack) return;
      rolledBack = true;
      const removed = await git(repoRoot, ["worktree", "remove", "--force", "--", path]);
      const deleted = await git(repoRoot, ["branch", "-D", "--", branch]);
      if (removed.code !== 0 || deleted.code !== 0) {
        throw gitFailure("Could not roll back Git workspace", removed.code !== 0 ? removed : deleted);
      }
    };
    const cwd = join(path, sourceRelative);
    try {
      await mkdir(cwd, { recursive: true });
      return { branch, path, cwd, rollback };
    } catch (error) {
      await rollback().catch(() => undefined);
      throw error;
    }
  }
  throw new WorktreeInputError(`Could not find an available branch name for ${options.branchPrefix}${baseSlug}.`);
}

export function isMergedCleanupCandidate(row: WorktreeRow): boolean {
  return row.managed && row.merged && row.sessions.every((session) => session.archived) && row.dirty === false && row.risks.length === 0;
}

/** A risk the user acknowledged covers the risk the server now sees. */
export function riskAcknowledged(risk: WorktreeRisk, acknowledged: readonly WorktreeRisk[]): boolean {
  return acknowledged.includes(risk) || (risk === "dirty" && acknowledged.includes("unknown"));
}
