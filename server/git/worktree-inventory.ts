/**
 * Git worktree inventory and guarded cleanup.
 *
 * Repositories are discovered from registered session directories and from
 * HUI's own `~/.config/hui/worktrees/` root, so a worktree whose sessions were
 * deleted is still found. Git facts are read per request; local changes, disk
 * usage and GitHub pull requests are cached stale-while-revalidate so the page
 * never waits on a large checkout or the network.
 *
 * The repository's main checkout is not listed. A manual removal may force
 * past local changes or a lock and stops a running linked session, but only
 * for risks the user confirmed. The bulk merged cleanup is deliberately narrow:
 * HUI-created, merged, clean and with no active session, always without `--force`. The
 * local branch is deleted only when GitHub reports a merged pull request whose
 * head is exactly the branch's current commit.
 */
import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { PullRequestState, SessionPullRequest } from "../api/github.ts";
import { isMergedCleanupCandidate, riskAcknowledged } from "./worktrees.ts";
import type { WorktreeInventory, WorktreeRemovalMode, WorktreeRisk, WorktreeRemovalResult, WorktreeRow, WorktreeSessionRef } from "../api/worktrees.ts";
import { WORKTREES_DIR } from "../paths.ts";
import { pullRequestBodyPreview } from "../integrations/pull-requests.ts";
import type { SessionRecord } from "../sessions/sessions.ts";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<CommandResult>;

const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_PULL_REQUESTS = 20;
const MAX_MANAGED_ENTRIES = 500;

export const runCommand: CommandRunner = (file, args, options = {}) => new Promise((resolveResult) => {
  execFile(file, [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: MAX_OUTPUT,
    encoding: "utf8",
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", LC_ALL: "C" },
  }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
    resolveResult({ code, stdout: stdout ?? "", stderr: stderr ?? (error?.message ?? "") });
  });
});

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function canonical(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function firstLine(result: CommandResult, fallback: string): string {
  return (result.stderr || result.stdout).trim().split("\n", 1)[0] || fallback;
}

const RISK_WORDS: Record<WorktreeRisk, string> = {
  dirty: "it has uncommitted or untracked files",
  unknown: "its local changes could not be read",
  locked: "Git has it locked",
  running: "a linked session is running",
  missing: "its directory is missing",
  external: "HUI did not create it",
};

/** Git's refusal names the flag HUI never passes; say what the user can do. */
function explainRemoveFailure(result: CommandResult): string {
  const detail = firstLine(result, "");
  if (/modified or untracked files/u.test(detail)) return "It has uncommitted or untracked files. Remove it from its row to confirm deleting them.";
  if (/is locked/u.test(detail)) return "Git has it locked. Remove it from its row to confirm overriding the lock.";
  return detail ? `Git refused: ${detail.replace(/^fatal:\s*/u, "")}` : "Git refused to remove it.";
}

type GitWorktree = {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
};

/** Parses `git worktree list --porcelain -z`; the first record is the main checkout. */
export function parseWorktreeList(source: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  for (const block of source.split("\0\0")) {
    const lines = block.split("\0").filter(Boolean);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? "";
    if (!path) continue;
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice(7) ?? "";
    records.push({
      path,
      branch: branchRef.replace(/^refs\/heads\//u, ""),
      head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "",
      bare: lines.includes("bare"),
      detached: lines.includes("detached"),
      locked: lines.some((line) => line === "locked" || line.startsWith("locked ")),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    });
  }
  return records;
}

type PullRequestFact = SessionPullRequest & { headRefOid: string };

export function parseGhPullRequestList(stdout: string): PullRequestFact[] {
  const raw = JSON.parse(stdout) as unknown;
  if (!Array.isArray(raw)) throw new Error("GitHub returned an invalid pull request list.");
  return raw.slice(0, MAX_PULL_REQUESTS).flatMap((item): PullRequestFact[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const url = typeof record["url"] === "string" ? record["url"] : "";
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/u.exec(url);
    const number = record["number"];
    if (!match || typeof number !== "number" || Number(match[2]) !== number) return [];
    const rawState = record["state"];
    const state: PullRequestState | undefined = rawState === "MERGED"
      ? "merged"
      : rawState === "CLOSED"
        ? "closed"
        : rawState === "OPEN"
          ? (record["isDraft"] === true ? "draft" : "open")
          : undefined;
    if (!state) return [];
    return [{
      repository: match[1]!,
      number,
      url,
      state,
      title: typeof record["title"] === "string" ? record["title"].trim().slice(0, 300) : "",
      body: typeof record["body"] === "string" ? pullRequestBodyPreview(record["body"]) : "",
      headRefOid: typeof record["headRefOid"] === "string" ? record["headRefOid"] : "",
    }];
  });
}

type Fact<T> = { value?: T; freshUntil: number; running?: Promise<void> };

/** Stale-while-revalidate facts. `get` never waits; `fresh` always recomputes. */
class FactCache<T> {
  readonly #entries = new Map<string, Fact<T>>();
  readonly #ttl: (value: T) => number;
  readonly #failureTtl: number;
  readonly #now: () => number;

  constructor(ttl: (value: T) => number, failureTtl: number, now: () => number) {
    this.#ttl = ttl;
    this.#failureTtl = failureTtl;
    this.#now = now;
  }

  get(key: string, compute: () => Promise<T>): { value?: T; pending: boolean } {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { freshUntil: 0 };
      this.#entries.set(key, entry);
    }
    if (!entry.running && entry.freshUntil <= this.#now()) this.#refresh(entry, compute);
    return { ...(entry.value !== undefined ? { value: entry.value } : {}), pending: entry.value === undefined && entry.running !== undefined };
  }

  async fresh(key: string, compute: () => Promise<T>): Promise<T> {
    const value = await compute();
    this.#entries.set(key, { value, freshUntil: this.#now() + this.#ttl(value) });
    return value;
  }

  /** Resolves once every refresh started so far has settled. Test helper. */
  async settled(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => entry.running));
  }

  /** The last confirmed value, without starting a refresh. */
  peek(key: string): T | undefined {
    return this.#entries.get(key)?.value;
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  #refresh(entry: Fact<T>, compute: () => Promise<T>): void {
    entry.running = compute().then(
      (value) => {
        entry.value = value;
        entry.freshUntil = this.#now() + this.#ttl(value);
      },
      () => {
        // Keep the last confirmed value; never invent one for a failure.
        entry.freshUntil = this.#now() + this.#failureTtl;
      },
    ).finally(() => {
      entry.running = undefined;
    });
  }
}

/** Bounds concurrent disk walks; `du` over several large checkouts is heavy. */
function limiter(concurrency: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) await new Promise<void>((resolveSlot) => waiting.push(resolveSlot));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

type Repository = { commonDir: string; worktrees: GitWorktree[] };

export type WorktreeServiceOptions = {
  run?: CommandRunner;
  root?: string;
  now?: () => number;
  /** Whether a session currently owns a live runtime. */
  isRunning?: (sessionId: string) => boolean;
  /** Shortened to `~` in display paths. */
  home?: string;
  /** Stops a linked session's runtime before its directory disappears. */
  stopSession?: (sessionId: string) => void;
};

export class WorktreeService {
  readonly #run: CommandRunner;
  readonly #root: string;
  readonly #isRunning: (sessionId: string) => boolean;
  readonly #home: string;
  readonly #stopSession: (sessionId: string) => void;
  readonly #dirty: FactCache<boolean>;
  readonly #bytes: FactCache<number>;
  /** Disk usage left in a tree Git is deleting, for removal progress. */
  readonly #remaining: FactCache<number>;
  readonly #pullRequests: FactCache<PullRequestFact[]>;
  readonly #diskWalk = limiter(2);
  #removal: Promise<unknown> = Promise.resolve();
  /** Requested paths still waiting for or undergoing removal. */
  readonly #removals = new Map<string, "queued" | "removing">();

  constructor(options: WorktreeServiceOptions = {}) {
    const now = options.now ?? Date.now;
    this.#run = options.run ?? runCommand;
    this.#root = options.root ?? WORKTREES_DIR;
    this.#isRunning = options.isRunning ?? (() => false);
    this.#home = options.home ?? homedir();
    this.#stopSession = options.stopSession ?? (() => undefined);
    this.#dirty = new FactCache(() => 10_000, 30_000, now);
    this.#bytes = new FactCache(() => 5 * 60_000, 5 * 60_000, now);
    this.#remaining = new FactCache(() => 3_000, 3_000, now);
    this.#pullRequests = new FactCache(
      (list) => (list.some((pr) => pr.state === "open" || pr.state === "draft") ? 60_000 : 15 * 60_000),
      5 * 60_000,
      now,
    );
  }

  async inventory(sessions: readonly SessionRecord[]): Promise<WorktreeInventory> {
    const { rows, diagnostics } = await this.#rows(sessions);
    let pending = false;
    const worktrees = rows.map((row) => {
      const removal = this.#removals.get(row.base.path);
      if (removal) {
        // Git is deleting it: a fresh `git status` would only see a
        // half-deleted tree. Keep what was known; measure only what is left.
        pending = true;
        const { path } = row.base;
        const finished = { ...this.#finish(row.base, this.#dirty.peek(path), this.#bytes.peek(path), this.#pullRequests.peek(this.#prKey(row))), removal };
        const left = removal === "removing" && finished.bytes !== undefined
          ? this.#remaining.get(path, () => this.#diskWalk(() => this.#readRemaining(path))).value
          : undefined;
        return left === undefined ? finished : { ...finished, remainingBytes: left };
      }
      if (row.missing) return this.#finish(row.base, undefined, undefined, undefined);
      const dirty = this.#dirty.get(row.base.path, () => this.#readDirty(row.base.path));
      const bytes = this.#bytes.get(row.base.path, () => this.#diskWalk(() => this.#readBytes(row.base.path)));
      const prs = !row.base.branch
        ? { value: [] as PullRequestFact[], pending: false }
        : this.#pullRequests.get(this.#prKey(row), () => this.#readPullRequests(row.base.repository, row.base.branch));
      pending ||= dirty.pending || bytes.pending || prs.pending;
      const unavailable = ([["dirty", dirty], ["bytes", bytes], ["pullRequests", prs]] as const)
        .filter(([, fact]) => fact.value === undefined && !fact.pending)
        .map(([name]) => name);
      const finished = this.#finish(row.base, dirty.value, bytes.value, prs.value, dirty.pending);
      return unavailable.length ? { ...finished, unavailable } : finished;
    });
    return { worktrees, diagnostics, pending };
  }

  /** Test helper: resolves once background facts started so far are known. */
  async settled(): Promise<void> {
    await Promise.all([this.#dirty.settled(), this.#bytes.settled(), this.#remaining.settled(), this.#pullRequests.settled()]);
  }

  /** Removes the requested worktrees one at a time, re-validating each path
   * against a fresh inventory. Removals are serialized across requests. */
  remove(
    sessions: readonly SessionRecord[],
    paths: readonly string[],
    mode: WorktreeRemovalMode,
    acknowledged: readonly WorktreeRisk[] = [],
  ): Promise<WorktreeRemovalResult[]> {
    for (const path of paths) this.#removals.set(resolve(path), "queued");
    const next = this.#removal
      .then(() => this.#removeAll(sessions, paths, mode, acknowledged))
      .finally(() => { for (const path of paths) this.#removals.delete(resolve(path)); });
    this.#removal = next.catch(() => undefined);
    return next;
  }

  async #removeAll(
    sessions: readonly SessionRecord[],
    paths: readonly string[],
    mode: WorktreeRemovalMode,
    acknowledged: readonly WorktreeRisk[],
  ): Promise<WorktreeRemovalResult[]> {
    const { rows } = await this.#rows(sessions);
    const results: WorktreeRemovalResult[] = [];
    for (const requested of paths) {
      const path = (await canonical(requested)) ?? resolve(requested);
      const row = rows.find((candidate) => candidate.base.path === path);
      if (!row) {
        results.push({ path: requested, label: basename(requested), removed: false, branchDeleted: false, error: "It is no longer listed; refresh the page." });
        continue;
      }
      this.#removals.set(resolve(requested), "removing");
      results.push(await this.#removeOne(row, mode, acknowledged));
      this.#removals.delete(resolve(requested));
      this.#remaining.delete(row.base.path);
    }
    return results;
  }

  async #removeOne(row: RawRow, mode: WorktreeRemovalMode, acknowledged: readonly WorktreeRisk[]): Promise<WorktreeRemovalResult> {
    const { path, repository, branch } = row.base;
    const label = branch || basename(path);
    const fail = (error: string): WorktreeRemovalResult => ({ path, label, removed: false, branchDeleted: false, error });
    const dirty = row.missing ? undefined : await this.#dirty.fresh(path, () => this.#readDirty(path)).catch(() => undefined);
    const prs = !branch
      ? []
      : await this.#pullRequests.fresh(this.#prKey(row), () => this.#readPullRequests(repository, branch)).catch(() => undefined);
    const current = this.#finish(row.base, dirty, undefined, prs);
    if (mode === "merged" && !isMergedCleanupCandidate(current)) {
      return fail(current.managed
        ? "No longer eligible: it needs a merged pull request, no active session and no local changes."
        : "Clean up merged only removes worktrees HUI created; remove this one from its row.");
    }
    // Force only what the user saw and confirmed; anything new since then
    // (for example files written after the dialog opened) stops the removal.
    const unconfirmed = current.risks.filter((risk) => !riskAcknowledged(risk, acknowledged));
    if (mode === "single" && unconfirmed.length) {
      return fail(`Not removed: ${unconfirmed.map((risk) => RISK_WORDS[risk]).join(" and ")} since you confirmed. Review it and try again.`);
    }
    for (const session of row.base.sessions) {
      if (this.#isRunning(session.id)) this.#stopSession(session.id);
    }
    // Only confirmed risks are forced; a clean, unlocked worktree still goes
    // through Git's normal safety check.
    const needsForce = current.risks.some((risk) => risk === "dirty" || risk === "unknown" || risk === "missing");
    const force = mode !== "single"
      ? []
      : current.risks.includes("locked")
        ? ["--force", "--force"]
        : needsForce ? ["--force"] : [];
    const removed = await this.#run("git", ["-C", repository, "worktree", "remove", ...force, "--", path], { timeoutMs: 10 * 60_000 });
    if (removed.code !== 0) return fail(explainRemoveFailure(removed));
    this.#dirty.delete(path);
    this.#bytes.delete(path);

    const mergedHead = (prs ?? []).some((pr) => pr.state === "merged" && pr.headRefOid && pr.headRefOid === row.base.head);
    if (!branch || !current.merged || !mergedHead) return { path, label, removed: true, branchDeleted: false };
    const deleted = await this.#run("git", ["-C", repository, "branch", "-D", "--", branch]);
    this.#pullRequests.delete(this.#prKey(row));
    return deleted.code === 0
      ? { path, label, removed: true, branchDeleted: true }
      : { path, label, removed: true, branchDeleted: false, error: `The worktree was removed but its branch was kept: ${firstLine(deleted, "git branch failed")}` };
  }

  #prKey(row: RawRow): string {
    return `${row.base.repository}\0${row.base.branch}`;
  }

  #finish(
    base: BaseRow,
    dirty: boolean | undefined,
    bytes: number | undefined,
    prs: readonly PullRequestFact[] | undefined,
    dirtyPending = false,
  ): WorktreeRow {
    const pullRequests = prs?.map(({ headRefOid: _head, ...pr }) => pr);
    const merged = Boolean(pullRequests?.some((pr) => pr.state === "merged"))
      && !pullRequests?.some((pr) => pr.state === "open" || pr.state === "draft");
    const running = base.sessions.some((session) => this.#isRunning(session.id));
    const risks: WorktreeRisk[] = [];
    if (base.missing) risks.push("missing");
    else if (dirty === true) risks.push("dirty");
    else if (dirty === undefined && !dirtyPending) risks.push("unknown");
    if (base.locked) risks.push("locked");
    if (running) risks.push("running");
    if (!base.managed) risks.push("external");
    return {
      repository: base.repository,
      path: base.path,
      displayPath: isWithin(this.#home, base.path) && this.#home !== sep
        ? `~${base.path.slice(this.#home.replace(/\/+$/u, "").length)}`
        : base.path,
      branch: base.branch,
      head: base.head,
      detached: base.detached,
      managed: base.managed,
      sessions: base.sessions,
      ...(pullRequests ? { pullRequests } : {}),
      ...(dirty !== undefined ? { dirty } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      merged,
      risks,
    };
  }

  async #rows(sessions: readonly SessionRecord[]): Promise<{ rows: RawRow[]; diagnostics: string[] }> {
    const diagnostics: string[] = [];
    const root = (await canonical(this.#root)) ?? resolve(this.#root);
    const candidates = new Set<string>();
    const sessionPaths: { session: WorktreeSessionRef; cwd: string }[] = [];
    for (const session of sessions) {
      // Remote sessions' directories are on another machine.
      if (session.worker) continue;
      const cwd = await canonical(session.cwd);
      if (!cwd) continue;
      candidates.add(cwd);
      sessionPaths.push({ session: { id: session.id, title: session.title, archived: Boolean(session.archived) }, cwd });
    }
    for (const path of await this.#managedDirectories(root)) candidates.add(path);

    const repositories = new Map<string, Repository>();
    for (const directory of candidates) {
      const common = await this.#run("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      if (common.code !== 0) continue;
      const commonDir = (await canonical(common.stdout.trim())) ?? common.stdout.trim();
      if (!commonDir || repositories.has(commonDir)) continue;
      const listed = await this.#run("git", ["-C", directory, "worktree", "list", "--porcelain", "-z"]);
      if (listed.code !== 0) {
        diagnostics.push(`Could not list worktrees for ${basename(dirname(commonDir))}: ${firstLine(listed, "git failed")}`);
        continue;
      }
      repositories.set(commonDir, { commonDir, worktrees: parseWorktreeList(listed.stdout) });
    }

    const rows: RawRow[] = [];
    for (const repository of [...repositories.values()].toSorted((a, b) => a.commonDir.localeCompare(b.commonDir))) {
      const mainPath = repository.worktrees[0]?.path ?? dirname(repository.commonDir);
      const mainCanonical = (await canonical(mainPath)) ?? resolve(mainPath);
      for (const [index, worktree] of repository.worktrees.entries()) {
        if (worktree.bare) continue;
        const path = (await canonical(worktree.path)) ?? resolve(worktree.path);
        const missing = worktree.prunable || !(await stat(path).then((info) => info.isDirectory(), () => false));
        rows.push({
          missing,
          base: {
            repository: mainCanonical,
            path,
            branch: worktree.branch,
            head: worktree.head,
            detached: worktree.detached,
            main: index === 0,
            managed: index !== 0 && path !== root && isWithin(root, path),
            locked: worktree.locked,
            missing,
            sessions: [],
          },
        });
      }
    }
    // Each session belongs to the deepest worktree that contains its directory,
    // so a worktree nested inside the main checkout does not count twice.
    for (const { session, cwd } of sessionPaths) {
      const owner = rows
        .filter((row) => isWithin(row.base.path, cwd))
        .toSorted((a, b) => b.base.path.length - a.base.path.length)[0];
      if (owner) owner.base.sessions = [...owner.base.sessions, session];
    }
    // The main checkout is Git's first "worktree" record but not a worktree the
    // user created. It stays above only so sessions there are not attributed
    // to a nested worktree, and is never listed or removable.
    return { rows: rows.filter((row) => !row.base.main), diagnostics };
  }

  /** HUI-created worktrees live at `<root>/<repository-key>/<branch>`. */
  async #managedDirectories(root: string): Promise<string[]> {
    const found: string[] = [];
    const repositories = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const repository of repositories.slice(0, MAX_MANAGED_ENTRIES)) {
      if (!repository.isDirectory()) continue;
      const entries = await readdir(join(root, repository.name), { withFileTypes: true }).catch(() => []);
      for (const entry of entries.slice(0, MAX_MANAGED_ENTRIES)) {
        if (entry.isDirectory()) found.push(join(root, repository.name, entry.name));
      }
    }
    return found;
  }

  async #readDirty(path: string): Promise<boolean> {
    const result = await this.#run("git", ["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(firstLine(result, "git status failed"));
    return result.stdout.length > 0;
  }

  async #readBytes(path: string): Promise<number> {
    const result = await this.#run("du", ["-sk", "--", path], { timeoutMs: 5 * 60_000 });
    const kib = Number(result.stdout.trim().split(/\s+/u, 1)[0]);
    if (result.code !== 0 || !Number.isFinite(kib)) throw new Error(firstLine(result, "du failed"));
    return kib * 1024;
  }

  /** Files vanish while `du` walks a tree Git is deleting, so it exits 1;
   * its total still holds. A tree that is gone has nothing left. */
  async #readRemaining(path: string): Promise<number> {
    const result = await this.#run("du", ["-sk", "--", path], { timeoutMs: 60_000 });
    const total = result.stdout.trim().split("\n").pop()?.split(/\s+/u, 1)[0] ?? "";
    if (/^\d+$/u.test(total)) return Number(total) * 1024;
    if (!(await stat(path).then(() => true, () => false))) return 0;
    throw new Error(firstLine(result, "du failed"));
  }

  async #readPullRequests(repository: string, branch: string): Promise<PullRequestFact[]> {
    const result = await this.#run("gh", [
      "pr", "list", "--head", branch, "--state", "all", "--limit", String(MAX_PULL_REQUESTS),
      "--json", "number,state,isDraft,title,url,body,headRefOid",
    ], { cwd: repository, timeoutMs: 20_000 });
    if (result.code !== 0) throw new Error(firstLine(result, "gh pr list failed"));
    return parseGhPullRequestList(result.stdout);
  }
}

type BaseRow = {
  repository: string;
  path: string;
  branch: string;
  head: string;
  detached: boolean;
  main: boolean;
  managed: boolean;
  locked: boolean;
  missing: boolean;
  sessions: WorktreeSessionRef[];
};

type RawRow = { base: BaseRow; missing: boolean };
