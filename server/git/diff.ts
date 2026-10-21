/**
 * The Diff view's Git side: which comparisons a conversation's working directory offers (uncommitted changes, the
 * last commit, the branch it is stacked on, the default branch) and the changed files with their patches for one of
 * them. Git runs read-only through spawn with argument arrays (no shell), with `--no-ext-diff --no-textconv
 * --no-color`, `core.quotepath=off`, `core.fsmonitor=false`, literal pathspecs, `GIT_OPTIONAL_LOCKS=0` (it never takes
 * the index lock while the agent works), a timeout and output caps. Untracked files join a diff as intent-to-add
 * entries of a throwaway copy of the index, with a throwaway object directory, both in a temporary folder: the
 * repository's index and objects are never written and no hook runs. A ref a client names must be one this module
 * offered. Paths are relative to the conversation's working directory (`--relative`), the Files view's root.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DiffBranch, DiffChanges, DiffComparison, DiffEndpoint, DiffFile, DiffFileStatus, DiffInfo, DiffParentSource } from "../api/diff.ts";

export const DIFF_COMPARISONS: readonly DiffComparison[] = ["uncommitted", "last-commit", "parent", "default"];

export function isDiffComparison(value: unknown): value is DiffComparison {
  return typeof value === "string" && (DIFF_COMPARISONS as readonly string[]).includes(value);
}
import { normalizeFilesPath } from "../files.ts";

/** A refusal with the HTTP status the route answers. */
export class DiffError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One Git command may run this long before it is killed. */
export const GIT_TIMEOUT_MS = 20_000;
/** All patches of one response together; files past it are listed without their patch. */
export const MAX_DIFF_BYTES = 6 * 1024 * 1024;
/** One file's patch stops after this many bytes… */
export const MAX_FILE_PATCH_BYTES = 768 * 1024;
/** …or this many lines. */
export const MAX_FILE_PATCH_LINES = 15_000;
/** Untracked files beyond this many are left out of a diff. */
export const MAX_UNTRACKED_FILES = 2_000;
/** Changed files listed in one response. */
export const MAX_LISTED_FILES = 3_000;
/** Branches offered as the previous branch. */
export const MAX_BRANCHES = 300;
/** Ancestor branches whose distance is counted one by one when Git lacks `%(ahead-behind)` (before 2.41). */
const MAX_COUNTED_ANCESTORS = 40;
const SMALL_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_BYTES = 64 * 1024;
const PATHSPEC_CHUNK = 200;

const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
} as const;

/** Configuration that would run a program or change the output's shape, overridden on every call. */
const SAFE_CONFIG = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "log.showSignature=false"];
/** Every diff: no external diff or textconv program, fixed prefixes, renames found, paths below the working directory. */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--relative", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/"];

export type GitRun = { code: number; stdout: string; stderr: string; truncated: boolean };
export type GitRunOptions = { maxBytes?: number; env?: Record<string, string> };
export type GitRunner = (cwd: string, args: readonly string[], options?: GitRunOptions) => Promise<GitRun>;

/** The environment of every call: this gateway's, minus variables that would point Git elsewhere. */
export function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_PREFIX"]) {
    delete env[key];
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_PAGER: "cat",
    LC_ALL: "C",
    LANG: "C",
    ...extra,
  };
}

/** Runs Git without a shell. Output past `maxBytes` is cut (`truncated`) and the process killed. */
export const runGit: GitRunner = (cwd, args, options = {}) => new Promise((settle) => {
  const maxBytes = options.maxBytes ?? SMALL_OUTPUT_BYTES;
  const child = spawn("git", [...SAFE_CONFIG, ...args], { cwd, env: gitEnvironment(options.env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, GIT_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    if (truncated) return;
    if (size + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
    size += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < STDERR_BYTES) stderr += chunk.toString("utf8"); });
  child.once("error", (error) => {
    clearTimeout(timer);
    settle({ code: -1, stdout: "", stderr: error.message, truncated: false });
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    const stdout = Buffer.concat(chunks).toString("utf8");
    if (timedOut && !truncated) settle({ code: -1, stdout, stderr: "Git took too long and was stopped.", truncated: false });
    else settle({ code: truncated ? 0 : code ?? -1, stdout, stderr, truncated });
  });
});

function gitMessage(run: GitRun, fallback: string): string {
  const line = run.stderr.split("\n").map((text) => text.replace(/^(fatal|error): /u, "").trim()).find(Boolean);
  return line ? line.slice(0, 500) : fallback;
}

/* ── refs ─────────────────────────────────────────────────────────────────── */

export type RefRecord = { ref: string; sha: string; date: number };

/** Short display name of a full ref. */
export function shortRefName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  return ref;
}

/** Whether `ref` is the current branch itself or a remote-tracking copy of a branch with its name. */
export function isOwnBranch(ref: string, branch: string | undefined, remotes: readonly string[]): boolean {
  if (!branch) return false;
  if (ref === `refs/heads/${branch}`) return true;
  return remotes.some((remote) => ref === `refs/remotes/${remote}/${branch}`);
}

/** The ref a configured branch name (`feature-a`, `refs/heads/feature-a`, `origin/feature-a`) names among `refs`:
 * the local branch first, then the preferred remote's copy, then any remote's. */
export function resolveBranchName(name: string, refs: readonly string[], remotes: readonly string[], preferredRemote = "origin"): string | undefined {
  const value = name.trim();
  if (!value) return undefined;
  if (refs.includes(value)) return value;
  const local = `refs/heads/${value.replace(/^refs\/heads\//u, "")}`;
  if (refs.includes(local)) return local;
  const plain = value.replace(/^refs\/heads\//u, "");
  if (refs.includes(`refs/remotes/${plain}`)) return `refs/remotes/${plain}`;
  for (const remote of [preferredRemote, ...remotes.filter((candidate) => candidate !== preferredRemote)]) {
    const candidate = `refs/remotes/${remote}/${plain}`;
    if (refs.includes(candidate)) return candidate;
  }
  return undefined;
}

export type ParentConfig = { ghMergeBase?: string | undefined; gitTownParent?: string | undefined; upstream?: string | undefined };

/**
 * The previous branch (stack parent) of `branch`. Configuration wins: gh's `branch.<b>.gh-merge-base`, git-town's
 * parent, then the branch's upstream when it is another branch than its own remote copy. Otherwise the nearest
 * ancestor: of the branches whose tip is an ancestor of HEAD (`ancestors`, with the commits HEAD has beyond each),
 * leaving out the branch itself and its remote copies, the one with the fewest commits between; ties go to a local
 * branch, then to one that is not the default branch, then by name.
 */
export function pickParentBranch(options: {
  branch: string;
  refs: readonly string[];
  remotes: readonly string[];
  ancestors: ReadonlyMap<string, number>;
  config: ParentConfig;
  defaultRef?: string | undefined;
  upstreamRemote?: string | undefined;
}): { ref: string; source: DiffParentSource } | undefined {
  const { branch, refs, remotes, ancestors, config } = options;
  const own = (ref: string) => isOwnBranch(ref, branch, remotes);
  const configured: [string | undefined, DiffParentSource][] = [[config.ghMergeBase, "gh-merge-base"], [config.gitTownParent, "git-town"]];
  for (const [name, source] of configured) {
    const ref = name ? resolveBranchName(name, refs, remotes, options.upstreamRemote) : undefined;
    if (ref && !own(ref)) return { ref, source };
  }
  if (config.upstream && refs.includes(config.upstream) && !own(config.upstream)) return { ref: config.upstream, source: "upstream" };
  let best: { ref: string; distance: number } | undefined;
  const rank = (ref: string) => [ref.startsWith("refs/remotes/") ? 1 : 0, ref === options.defaultRef ? 1 : 0] as const;
  for (const [ref, distance] of ancestors) {
    if (own(ref) || !refs.includes(ref)) continue;
    if (!best || distance < best.distance) { best = { ref, distance }; continue; }
    if (distance > best.distance) continue;
    const [remoteA, defaultA] = rank(ref);
    const [remoteB, defaultB] = rank(best.ref);
    if (remoteA !== remoteB ? remoteA < remoteB : defaultA !== defaultB ? defaultA < defaultB : ref < best.ref) best = { ref, distance };
  }
  return best && { ref: best.ref, source: "nearest" };
}

/** The default branch: what `origin/HEAD` points at, else `origin/main`, `origin/master`, `main`, `master`. */
export function pickDefaultBranch(originHead: string | undefined, refs: readonly string[]): string | undefined {
  const candidates = [originHead, "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"];
  return candidates.find((ref): ref is string => Boolean(ref) && refs.includes(ref!));
}

/* ── output parsing ───────────────────────────────────────────────────────── */

/** Undoes Git's C-style quoting of a path (`"a\tb"`, octal escapes for bytes); unquoted text is returned as is. */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[index + 1] ?? "";
    if (/[0-7]/u.test(next)) {
      const octal = /^[0-7]{1,3}/u.exec(body.slice(index + 1))![0];
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export type ListedChange = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  similarity?: number;
  oldMode?: string;
  newMode?: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

const STATUSES = new Set<DiffFileStatus>(["A", "M", "D", "R", "C", "T", "U"]);

/** Parses `git diff --raw --numstat -z`: the raw records (status, modes, paths), then one numstat record each. */
export function parseRawNumstat(output: string): ListedChange[] {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const changes: ListedChange[] = [];
  let index = 0;
  while (index < tokens.length && tokens[index]!.startsWith(":")) {
    const [oldMode = "", newMode = "", , , statusToken = ""] = tokens[index]!.slice(1).split(" ");
    const letter = statusToken[0] as DiffFileStatus | undefined;
    const status: DiffFileStatus = letter && STATUSES.has(letter) ? letter : "M";
    const change: ListedChange = { path: "", status, additions: 0, deletions: 0, binary: false };
    if (status === "R" || status === "C") {
      change.oldPath = tokens[index + 1] ?? "";
      change.path = tokens[index + 2] ?? "";
      const score = Number.parseInt(statusToken.slice(1), 10);
      if (Number.isFinite(score)) change.similarity = score;
      index += 3;
    } else {
      change.path = tokens[index + 1] ?? "";
      index += 2;
    }
    if (oldMode && !/^0+$/u.test(oldMode)) change.oldMode = oldMode;
    if (newMode && !/^0+$/u.test(newMode)) change.newMode = newMode;
    changes.push(change);
  }
  const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const ordered: { additions: number; deletions: number; binary: boolean; path: string }[] = [];
  while (index < tokens.length) {
    const token = tokens[index]!;
    const first = token.indexOf("\t");
    const second = first < 0 ? -1 : token.indexOf("\t", first + 1);
    if (second < 0) { index += 1; continue; }
    const added = token.slice(0, first);
    const deleted = token.slice(first + 1, second);
    let path = token.slice(second + 1);
    if (!path) {
      path = tokens[index + 2] ?? "";
      index += 3;
    } else index += 1;
    const record = { additions: Number(added) || 0, deletions: Number(deleted) || 0, binary: added === "-" && deleted === "-", path };
    ordered.push(record);
    counts.set(path, record);
  }
  changes.forEach((change, position) => {
    const record = ordered[position]?.path === change.path ? ordered[position] : counts.get(change.path);
    if (!record) return;
    change.additions = record.additions;
    change.deletions = record.deletions;
    change.binary = record.binary;
  });
  return changes;
}

export type PatchChunk = {
  /** The new path (the old one for a deletion). */
  path: string;
  oldPath?: string;
  binary: boolean;
  /** From the first `@@` line; `""` when the file has no hunks. */
  body: string;
  truncated: boolean;
};

/** The two paths of a `diff --git a/X b/Y` line, when they can be told apart (always when they are equal). */
export function headerPaths(line: string): { oldPath: string; path: string } | undefined {
  const rest = line.slice("diff --git ".length);
  const quoted = /^("(?:[^"\\]|\\.)*")\s("(?:[^"\\]|\\.)*"|.*)$/u.exec(rest);
  if (quoted) {
    const a = unquoteGitPath(quoted[1]!);
    const b = unquoteGitPath(quoted[2]!);
    if (a.startsWith("a/") && b.startsWith("b/")) return { oldPath: a.slice(2), path: b.slice(2) };
  }
  const endQuoted = /^(.*)\s("(?:[^"\\]|\\.)*")$/u.exec(rest);
  if (endQuoted && endQuoted[1]!.startsWith("a/")) {
    const b = unquoteGitPath(endQuoted[2]!);
    if (b.startsWith("b/")) return { oldPath: endQuoted[1]!.slice(2), path: b.slice(2) };
  }
  if (rest.startsWith("a/") && (rest.length - 5) % 2 === 0) {
    const length = (rest.length - 5) / 2;
    const a = rest.slice(2, 2 + length);
    if (rest.slice(2 + length) === ` b/${a}`) return { oldPath: a, path: a };
  }
  return undefined;
}

function sidePath(line: string, prefix: "--- " | "+++ "): string | undefined {
  const raw = line.slice(prefix.length).replace(/\t$/u, "");
  const value = unquoteGitPath(raw);
  if (value === "/dev/null") return undefined;
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

/**
 * Splits `git diff -p` output into one chunk per file, with its paths read from Git's headers (rename lines, then the
 * `---`/`+++` lines, then the `diff --git` line) and its hunks capped at `maxLines` lines or `maxBytes` bytes. A chunk
 * cut by the end of `output` (`complete: false`, the total cap) is dropped: its file is loaded on its own instead.
 */
export function splitPatch(output: string, options: { complete?: boolean; maxLines?: number; maxBytes?: number } = {}): PatchChunk[] {
  const maxLines = options.maxLines ?? MAX_FILE_PATCH_LINES;
  const maxBytes = options.maxBytes ?? MAX_FILE_PATCH_BYTES;
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const chunks: PatchChunk[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = lines[index]!;
    if (!start.startsWith("diff --git ")) { index += 1; continue; }
    const fromHeader = headerPaths(start);
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let minus: string | undefined;
    let plus: string | undefined;
    let sawMinus = false;
    let sawPlus = false;
    let binary = false;
    index += 1;
    while (index < lines.length && !lines[index]!.startsWith("@@") && !lines[index]!.startsWith("diff --git ")) {
      const line = lines[index]!;
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) renameFrom = unquoteGitPath(line.slice(line.indexOf(" from ") + 6));
      else if (line.startsWith("rename to ") || line.startsWith("copy to ")) renameTo = unquoteGitPath(line.slice(line.indexOf(" to ") + 4));
      else if (line.startsWith("--- ")) { minus = sidePath(line, "--- "); sawMinus = true; }
      else if (line.startsWith("+++ ")) { plus = sidePath(line, "+++ "); sawPlus = true; }
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
      index += 1;
    }
    const body: string[] = [];
    let bytes = 0;
    let truncated = false;
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")) {
      const line = lines[index]!;
      index += 1;
      if (truncated || line.startsWith("* Unmerged path ")) continue;
      if (body.length >= maxLines || bytes + line.length + 1 > maxBytes) { truncated = true; continue; }
      body.push(line);
      bytes += line.length + 1;
    }
    const newPath = renameTo ?? (sawPlus ? plus : undefined) ?? fromHeader?.path;
    const oldPath = renameFrom ?? (sawMinus ? minus : undefined) ?? fromHeader?.oldPath;
    const path = newPath ?? oldPath;
    if (!path) continue;
    const chunk: PatchChunk = { path, binary, body: body.join("\n"), truncated };
    if (oldPath && oldPath !== path) chunk.oldPath = oldPath;
    chunks.push(chunk);
  }
  if (options.complete === false) chunks.pop();
  return chunks;
}

/** Joins the listed changes with their patches. A listed file without a patch was cut by the response limit when
 * `truncated`, else it changed only in name or mode. */
export function mergeChanges(listed: readonly ListedChange[], chunks: readonly PatchChunk[], truncated: boolean): DiffFile[] {
  const byPath = new Map(chunks.map((chunk) => [chunk.path, chunk]));
  return listed.map((change) => {
    const file: DiffFile = { ...change };
    const chunk = byPath.get(change.path);
    if (chunk) {
      if (chunk.binary) file.binary = true;
      else file.patch = chunk.body;
      if (chunk.truncated) file.truncated = "file";
    } else if (truncated && !change.binary) file.truncated = "total";
    else if (!change.binary) file.patch = "";
    return file;
  });
}

/* ── the repository ───────────────────────────────────────────────────────── */

type Repository = {
  root: string;
  subdirectory: string;
  objectFormat: "sha1" | "sha256";
  indexPath: string;
  objectsPath: string;
  head?: string;
  branch?: string;
  unborn: boolean;
};

async function openRepository(git: GitRunner, root: string): Promise<Repository> {
  const [paths, symbolic, head] = await Promise.all([
    git(root, ["rev-parse", "--show-prefix", "--show-object-format", "--git-path", "index", "--git-path", "objects"]),
    git(root, ["symbolic-ref", "-q", "HEAD"]),
    git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]),
  ]);
  if (paths.code !== 0) {
    if (/not a git repository/iu.test(paths.stderr)) throw new DiffError("The conversation's working directory is not inside a Git repository.", 404, "not-repo");
    throw new DiffError(gitMessage(paths, "Git could not read this repository."), 500, "git");
  }
  const [prefix = "", format = "", index = "", objects = ""] = paths.stdout.split("\n");
  const branchRef = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  const sha = head.code === 0 ? head.stdout.trim() : "";
  const repository: Repository = {
    root,
    subdirectory: prefix.replace(/\/$/u, ""),
    objectFormat: format.trim() === "sha256" ? "sha256" : "sha1",
    indexPath: resolve(root, index.trim()),
    objectsPath: resolve(root, objects.trim()),
    unborn: !sha,
  };
  if (sha) repository.head = sha;
  if (branchRef.startsWith("refs/heads/")) repository.branch = branchRef.slice("refs/heads/".length);
  return repository;
}

type RefState = {
  refs: RefRecord[];
  remotes: string[];
  /** Ancestor ref → commits on HEAD beyond it. */
  ancestors: Map<string, number>;
  defaultRef?: string;
  parent?: { ref: string; source: DiffParentSource };
};

async function configValue(git: GitRunner, root: string, key: string): Promise<string | undefined> {
  const run = await git(root, ["config", "--get", key]);
  return run.code === 0 ? run.stdout.trim() || undefined : undefined;
}

async function ancestorDistances(git: GitRunner, root: string, refs: readonly RefRecord[]): Promise<Map<string, number>> {
  const distances = new Map<string, number>();
  const fast = await git(root, ["for-each-ref", "--merged=HEAD", "--format=%(refname)%00%(ahead-behind:HEAD)", "refs/heads", "refs/remotes"]);
  if (fast.code === 0) {
    for (const line of fast.stdout.split("\n")) {
      const [ref, counts] = line.split("\0");
      const behind = Number(counts?.split(" ")[1]);
      if (ref && Number.isFinite(behind)) distances.set(ref, behind);
    }
    return distances;
  }
  // Git before 2.41: list the ancestors, then count the most recent ones.
  const merged = await git(root, ["for-each-ref", "--merged=HEAD", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  if (merged.code !== 0) return distances;
  const names = new Set(merged.stdout.split("\n").filter(Boolean));
  const recent = refs.filter((record) => names.has(record.ref)).slice(0, MAX_COUNTED_ANCESTORS);
  for (let start = 0; start < recent.length; start += 6) {
    await Promise.all(recent.slice(start, start + 6).map(async (record) => {
      const count = await git(root, ["rev-list", "--count", `${record.sha}..HEAD`, "--"]);
      const value = Number(count.stdout.trim());
      if (count.code === 0 && Number.isFinite(value)) distances.set(record.ref, value);
    }));
  }
  return distances;
}

async function readRefs(git: GitRunner, repository: Repository): Promise<RefState> {
  const { root } = repository;
  const [list, remoteList, originHead] = await Promise.all([
    git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(symref)", "refs/heads", "refs/remotes"]),
    git(root, ["remote"]),
    git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]),
  ]);
  const refs: RefRecord[] = [];
  for (const line of list.code === 0 ? list.stdout.split("\n") : []) {
    const [ref, sha, date, symref] = line.split("\0");
    if (!ref || !sha || symref) continue;
    refs.push({ ref, sha, date: Number(date) || 0 });
  }
  const remotes = remoteList.code === 0 ? remoteList.stdout.split("\n").map((name) => name.trim()).filter(Boolean) : [];
  const names = refs.map((record) => record.ref);
  const defaultRef = pickDefaultBranch(originHead.code === 0 ? originHead.stdout.trim() : undefined, names);
  const state: RefState = { refs, remotes, ancestors: new Map() };
  // On the default branch itself the comparison would be empty; its remote copy (unpushed commits) stays.
  if (defaultRef && !isOwnBranch(defaultRef, repository.branch, [])) state.defaultRef = defaultRef;
  if (!repository.head) return state;
  state.ancestors = await ancestorDistances(git, root, refs);
  const branch = repository.branch;
  if (!branch) return state;
  const [ghMergeBase, gitTownParent, upstream, upstreamRemote] = await Promise.all([
    configValue(git, root, `branch.${branch}.gh-merge-base`),
    configValue(git, root, `git-town-branch.${branch}.parent`),
    git(root, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`]).then((run) => run.code === 0 ? run.stdout.trim() || undefined : undefined),
    configValue(git, root, `branch.${branch}.remote`),
  ]);
  const parent = pickParentBranch({
    branch,
    refs: names,
    remotes,
    ancestors: state.ancestors,
    config: { ghMergeBase, gitTownParent, upstream },
    defaultRef,
    upstreamRemote: upstreamRemote && upstreamRemote !== "." ? upstreamRemote : undefined,
  });
  if (parent) state.parent = parent;
  return state;
}

/** Branches to offer: ancestors of HEAD first (nearest first), then the rest by recency; never the branch itself. */
export function offeredBranches(state: Pick<RefState, "refs" | "remotes" | "ancestors">, branch: string | undefined): DiffBranch[] {
  const branches = state.refs
    .filter((record) => !isOwnBranch(record.ref, branch, state.remotes))
    .map((record): DiffBranch => {
      const item: DiffBranch = { ref: record.ref, name: shortRefName(record.ref), remote: record.ref.startsWith("refs/remotes/") };
      const distance = state.ancestors.get(record.ref);
      if (distance !== undefined) item.distance = distance;
      return item;
    });
  const ancestors = branches.filter((item) => item.distance !== undefined).sort((a, b) => a.distance! - b.distance! || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
  const others = branches.filter((item) => item.distance === undefined);
  return [...ancestors, ...others].slice(0, MAX_BRANCHES);
}

async function uncommittedCount(git: GitRunner, root: string): Promise<number> {
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--", "."]);
  if (status.code !== 0) return 0;
  return status.stdout.split("\0").filter(Boolean).length;
}

/** What a Diff view of `root` (the conversation's real working directory) can compare. */
export async function diffInfo(root: string, displayRoot: string, git: GitRunner = runGit): Promise<DiffInfo> {
  let repository: Repository;
  try {
    repository = await openRepository(git, root);
  } catch (error) {
    if (error instanceof DiffError) return { available: false, reason: error.message, code: error.code === "not-repo" ? "not-repo" : "git" };
    throw error;
  }
  const [state, uncommitted, last] = await Promise.all([
    readRefs(git, repository),
    uncommittedCount(git, root),
    repository.head ? git(root, ["log", "-1", "--no-show-signature", "--format=%h%x00%s", "HEAD", "--"]) : Promise.resolve(undefined),
  ]);
  const branches = offeredBranches(state, repository.branch);
  const info: Extract<DiffInfo, { available: true }> = {
    available: true,
    root: displayRoot,
    subdirectory: repository.subdirectory,
    detached: !repository.branch,
    unborn: repository.unborn,
    uncommitted,
    branches,
    comparisons: ["uncommitted"],
  };
  if (repository.branch) info.branch = repository.branch;
  if (repository.head) {
    info.head = repository.head.slice(0, 7);
    info.comparisons.push("last-commit");
    const [sha = "", subject = ""] = last?.code === 0 ? last.stdout.replace(/\n$/u, "").split("\0") : [];
    if (sha) info.lastCommit = { sha, subject };
  }
  if (repository.head && repository.branch && state.parent) {
    const distance = state.ancestors.get(state.parent.ref);
    info.parent = { ref: state.parent.ref, name: shortRefName(state.parent.ref), remote: state.parent.ref.startsWith("refs/remotes/"), source: state.parent.source, ...(distance !== undefined ? { distance } : {}) };
    info.comparisons.push("parent");
  }
  if (repository.head && state.defaultRef) {
    info.defaultBranch = { ref: state.defaultRef, name: shortRefName(state.defaultRef) };
    info.comparisons.push("default");
  }
  return info;
}

/* ── changes ──────────────────────────────────────────────────────────────── */

export type DiffRequest = {
  comparison: DiffComparison;
  /** For `parent`: the full ref the operator picked instead of the detected one. Must be an offered branch. */
  parent?: string | undefined;
  /** For `parent` and `default`: the working tree is the head side instead of HEAD. */
  uncommitted: boolean;
};

type Plan = { base: string; head?: string; worktree: boolean; baseEndpoint: DiffEndpoint; headEndpoint: DiffEndpoint };

async function mergeBase(git: GitRunner, root: string, ref: string, name: string): Promise<string> {
  const run = await git(root, ["merge-base", "HEAD", ref]);
  const sha = run.stdout.trim().split("\n")[0] ?? "";
  if (run.code !== 0 || !/^[0-9a-f]{40,64}$/u.test(sha)) throw new DiffError(`${name} and HEAD have no common history.`, 422, "no-merge-base");
  return sha;
}

async function plan(git: GitRunner, repository: Repository, request: DiffRequest): Promise<Plan> {
  const { root } = repository;
  const emptyTree = EMPTY_TREE[repository.objectFormat];
  const headEndpoint = (worktree: boolean): DiffEndpoint => worktree
    ? { label: "Working tree" }
    : { label: repository.branch ?? "HEAD", ...(repository.head ? { sha: repository.head } : {}) };
  if (request.comparison === "uncommitted") {
    return { base: repository.head ?? emptyTree, worktree: true, baseEndpoint: { label: "HEAD", ...(repository.head ? { sha: repository.head } : {}) }, headEndpoint: headEndpoint(true) };
  }
  if (!repository.head) throw new DiffError("This branch has no commits yet.", 409, "unborn");
  if (request.comparison === "last-commit") {
    const parent = await git(root, ["rev-parse", "-q", "--verify", "HEAD^1^{commit}"]);
    const base = parent.code === 0 ? parent.stdout.trim() : emptyTree;
    return { base, head: repository.head, worktree: false, baseEndpoint: parent.code === 0 ? { label: "HEAD~1", sha: base } : { label: "Nothing (first commit)" }, headEndpoint: headEndpoint(false) };
  }
  const state = await readRefs(git, repository);
  let ref: string;
  if (request.comparison === "parent") {
    if (!repository.branch) throw new DiffError("A detached HEAD has no previous branch.", 409, "detached");
    if (request.parent) {
      const offered = new Set(offeredBranches(state, repository.branch).map((branch) => branch.ref));
      if (state.parent) offered.add(state.parent.ref);
      if (!offered.has(request.parent)) throw new DiffError("Choose the previous branch from the list.", 400, "unknown-ref");
      ref = request.parent;
    } else if (state.parent) ref = state.parent.ref;
    else throw new DiffError("No previous branch was found; choose one from the list.", 409, "no-parent");
  } else {
    if (!state.defaultRef) throw new DiffError("No default branch was found (origin/HEAD, origin/main, main or master).", 409, "no-default");
    ref = state.defaultRef;
  }
  const name = shortRefName(ref);
  const base = await mergeBase(git, root, ref, name);
  return { base, head: request.uncommitted ? undefined : repository.head, worktree: request.uncommitted, baseEndpoint: { label: name, sha: base }, headEndpoint: headEndpoint(request.uncommitted) };
}

/** Quotes a path for `GIT_ALTERNATE_OBJECT_DIRECTORIES` when it holds the list separator or a quote. */
function alternatePath(path: string): string {
  const separator = process.platform === "win32" ? ";" : ":";
  return path.includes(separator) || path.includes('"') ? `"${path.replace(/["\\]/gu, "\\$&")}"` : path;
}

/** Runs `task` with an environment whose index (a temporary copy) also holds the untracked files under the root as
 * intent-to-add entries; their empty blob goes to a temporary object directory. The repository is not written. */
async function withUntracked<T>(git: GitRunner, repository: Repository, only: readonly string[] | undefined, task: (env: Record<string, string>, omitted: number) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), "hui-diff-"));
  try {
    await mkdir(join(temporary, "objects"));
    const index = join(temporary, "index");
    try {
      // The copy keeps the index's own modification time. Git trusts an entry's cached stat only when the file is
      // older than the index ("racy Git"); a fresh mtime on the copy would hide a same-size edit made in the same
      // second as the last index write. The time is read before copying, so a concurrent rewrite only makes more
      // entries racy (compared by content), never fewer.
      const before = await stat(repository.indexPath);
      await copyFile(repository.indexPath, index);
      await utimes(index, before.atime, before.mtime);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const env = { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: join(temporary, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatePath(repository.objectsPath) };
    const listed = await git(repository.root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...(only ?? [])]);
    const untracked = listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [];
    const added = untracked.slice(0, MAX_UNTRACKED_FILES);
    for (let start = 0; start < added.length; start += PATHSPEC_CHUNK) {
      const chunk = added.slice(start, start + PATHSPEC_CHUNK);
      const run = await git(repository.root, ["add", "--intent-to-add", "--", ...chunk], { env });
      // One path Git refuses (outside a sparse checkout, inside a nested repository) must not hide the others.
      if (run.code !== 0) for (const path of chunk) await git(repository.root, ["add", "--intent-to-add", "--", path], { env });
    }
    return await task(env, untracked.length - added.length);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function revisions(plan: Plan): string[] {
  return plan.head ? [plan.base, plan.head] : [plan.base];
}

/** The changed files of one comparison with their patches, within the response limits. */
export async function diffChanges(root: string, request: DiffRequest, git: GitRunner = runGit): Promise<DiffChanges> {
  const repository = await openRepository(git, root);
  const steps = await plan(git, repository, request);
  const run = async (env: Record<string, string> | undefined, untrackedOmitted: number): Promise<DiffChanges> => {
    const options = env ? { env } : {};
    const [list, patch] = await Promise.all([
      git(root, ["diff", ...DIFF_FLAGS, "--raw", "--numstat", "-z", ...revisions(steps), "--"], options),
      git(root, ["diff", ...DIFF_FLAGS, ...revisions(steps), "--"], { ...options, maxBytes: MAX_DIFF_BYTES }),
    ]);
    if (list.code !== 0) throw new DiffError(gitMessage(list, "Git could not compare these versions."), 500, "git");
    if (patch.code !== 0) throw new DiffError(gitMessage(patch, "Git could not compare these versions."), 500, "git");
    const listed = parseRawNumstat(list.stdout);
    const files = mergeChanges(listed.slice(0, MAX_LISTED_FILES), splitPatch(patch.stdout, { complete: !patch.truncated }), patch.truncated);
    return {
      comparison: request.comparison,
      base: steps.baseEndpoint,
      head: steps.headEndpoint,
      includesUncommitted: steps.worktree,
      files,
      additions: listed.reduce((sum, file) => sum + file.additions, 0),
      deletions: listed.reduce((sum, file) => sum + file.deletions, 0),
      truncated: files.some((file) => file.truncated === "total"),
      filesOmitted: Math.max(0, listed.length - MAX_LISTED_FILES),
      untrackedOmitted,
    };
  };
  return steps.worktree ? withUntracked(git, repository, undefined, run) : run(undefined, 0);
}

/** One file of a comparison (and the path it was renamed from), for a file the full response left out. */
export async function diffFile(root: string, request: DiffRequest, path: string, from: string | undefined, git: GitRunner = runGit): Promise<DiffFile | null> {
  const target = normalizeFilesPath(path);
  const source = from ? normalizeFilesPath(from) : undefined;
  if (!target) throw new DiffError("Name a file.", 400);
  const pathspec = source && source !== target ? [source, target] : [target];
  const repository = await openRepository(git, root);
  const steps = await plan(git, repository, request);
  const run = async (env: Record<string, string> | undefined): Promise<DiffFile | null> => {
    const options = env ? { env } : {};
    const [list, patch] = await Promise.all([
      git(root, ["diff", ...DIFF_FLAGS, "--raw", "--numstat", "-z", ...revisions(steps), "--", ...pathspec], options),
      git(root, ["diff", ...DIFF_FLAGS, ...revisions(steps), "--", ...pathspec], { ...options, maxBytes: MAX_FILE_PATCH_BYTES + 64 * 1024 }),
    ]);
    if (list.code !== 0 || patch.code !== 0) throw new DiffError(gitMessage(list.code !== 0 ? list : patch, "Git could not compare this file."), 500, "git");
    const listed = parseRawNumstat(list.stdout).filter((change) => change.path === target);
    const chunks = splitPatch(patch.stdout);
    if (patch.truncated) {
      // The cap cut this one file: keep what fits and say so.
      const last = chunks.at(-1);
      if (last) last.truncated = true;
    }
    return mergeChanges(listed, chunks, false)[0] ?? null;
  };
  return steps.worktree ? withUntracked(git, repository, pathspec, (env) => run(env)) : run(undefined);
}
