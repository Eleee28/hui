import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { isMergedCleanupCandidate, riskAcknowledged } from "./worktrees.ts";

import type { SessionRecord } from "../sessions/sessions.ts";
import {
  parseGhPullRequestList,
  parseWorktreeList,
  runCommand,
  WorktreeService,
  type CommandRunner,
} from "./worktree-inventory.ts";

function session(id: string, cwd: string, archived = false): SessionRecord {
  return {
    id, cwd, title: `Session ${id}`, group: "tests", tool: "pi",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...(archived ? { archived: true } : {}),
  };
}

async function git(cwd: string, ...args: string[]) {
  const result = await runCommand("git", ["-C", cwd, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

/** A real repository with HUI-managed and external worktrees. */
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hui-worktree-inventory-")));
  const repo = join(base, "repo");
  const root = join(base, "hui-worktrees");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "hui@example.invalid");
  await git(repo, "config", "user.name", "HUI tests");
  await writeFile(join(repo, "README.md"), "test\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "initial");
  const managed = (name: string) => join(root, "repo-abc", name);
  await mkdir(join(root, "repo-abc"), { recursive: true });
  for (const name of ["merged", "open", "dirty", "used"]) {
    await git(repo, "worktree", "add", "-q", "-b", `hui/${name}`, managed(name), "HEAD");
  }
  const external = join(base, "external");
  await git(repo, "worktree", "add", "-q", "-b", "external", external, "HEAD");
  await writeFile(join(managed("dirty"), "scratch.txt"), "unsaved\n");
  const head = await git(repo, "rev-parse", "HEAD");
  return { base, repo, root, managed, external, head };
}

/** Real git; fake `gh` answers per branch; `du` is real. */
function runner(prs: Record<string, unknown[]>, calls: string[][] = []): CommandRunner {
  return async (file, args, options) => {
    calls.push([file, ...args]);
    if (file === "gh") {
      const branch = args[args.indexOf("--head") + 1] ?? "";
      return { code: 0, stdout: JSON.stringify(prs[branch] ?? []), stderr: "" };
    }
    return runCommand(file, args, options);
  };
}

function pr(number: number, state: string, headRefOid: string, isDraft = false) {
  return { number, state, isDraft, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, body: "", headRefOid };
}

test("parses NUL worktree porcelain including locked and prunable records", () => {
  const records = parseWorktreeList("worktree /r\0HEAD a\0branch refs/heads/main\0\0worktree /w\0HEAD b\0detached\0locked\0prunable gitdir file points to non-existent location\0\0");
  assert.deepEqual(records.map((record) => [record.path, record.branch, record.detached, record.locked, record.prunable]), [
    ["/r", "main", false, false, false],
    ["/w", "", true, true, true],
  ]);
});

test("parses gh pr list states and rejects mismatched URLs", () => {
  const list = parseGhPullRequestList(JSON.stringify([
    pr(1, "MERGED", "abc"),
    pr(2, "OPEN", "abc", true),
    { ...pr(3, "OPEN", "abc"), url: "https://github.com/o/r/pull/4" },
    pr(5, "WEIRD", "abc"),
  ]));
  assert.deepEqual(list.map((item) => [item.number, item.state]), [[1, "merged"], [2, "draft"]]);
});

test("inventories sessions, PR state, local changes, size and removal risks", async () => {
  const f = await fixture();
  const service = new WorktreeService({
    root: f.root,
    run: runner({ "hui/merged": [pr(1, "MERGED", f.head)], "hui/open": [pr(2, "OPEN", f.head)], "hui/dirty": [pr(3, "MERGED", f.head)] }),
  });
  const sessions = [session("a", f.managed("used")), session("b", join(f.repo))];
  const shortened = new WorktreeService({ root: f.root, run: runner({}), home: f.base });
  assert.equal((await shortened.inventory([])).worktrees.find((row) => row.branch === "external")?.displayPath, "~/external");
  const first = await service.inventory(sessions);
  assert.equal(first.pending, true);
  await service.settled();
  const { worktrees, pending } = await service.inventory(sessions);
  assert.equal(pending, false);
  const byBranch = new Map(worktrees.map((row) => [row.branch, row]));

  // The main checkout is not a worktree: never listed, and its session is not
  // attributed to any linked worktree.
  assert.equal(byBranch.has("main"), false);
  assert.equal(worktrees.some((row) => row.sessions.some((s) => s.id === "b")), false);

  const merged = byBranch.get("hui/merged")!;
  assert.equal(merged.managed, true);
  assert.equal(merged.merged, true);
  assert.equal(merged.dirty, false);
  assert.equal(typeof merged.bytes, "number");
  assert.deepEqual(merged.pullRequests?.map((item) => item.state), ["merged"]);
  assert.equal(isMergedCleanupCandidate(merged), true);

  assert.equal(byBranch.get("hui/open")!.merged, false);
  assert.equal(byBranch.get("hui/dirty")!.dirty, true);
  assert.equal(isMergedCleanupCandidate(byBranch.get("hui/dirty")!), false);
  assert.deepEqual(byBranch.get("hui/used")!.sessions.map((s) => s.id), ["a"]);
  assert.equal(isMergedCleanupCandidate(byBranch.get("hui/used")!), false);

  const external = byBranch.get("external")!;
  assert.equal(external.managed, false);
  assert.deepEqual(external.risks, ["external"]);
  assert.equal(isMergedCleanupCandidate(external), false);
  assert.deepEqual(byBranch.get("hui/dirty")!.risks, ["dirty"]);
  assert.deepEqual(merged.risks, []);
});

test("merged cleanup removes only eligible worktrees and deletes the branch at the merged head", async () => {
  const f = await fixture();
  const calls: string[][] = [];
  const service = new WorktreeService({
    root: f.root,
    run: runner({ "hui/merged": [pr(1, "MERGED", f.head)], "hui/open": [pr(2, "OPEN", f.head)], "hui/dirty": [pr(3, "MERGED", f.head)] }, calls),
  });
  const sessions = [session("a", f.managed("used"))];
  const results = await service.remove(sessions, [f.managed("merged"), f.managed("open"), f.managed("dirty"), f.external, f.repo], "merged");
  assert.deepEqual(results.map((r) => [r.removed, r.branchDeleted]), [[true, true], [false, false], [false, false], [false, false], [false, false]]);
  assert.equal(await stat(join(f.repo, "README.md")).then(() => true, () => false), true);
  assert.equal(await stat(f.managed("merged")).then(() => true, () => false), false);
  assert.equal(await stat(f.managed("dirty")).then(() => true, () => false), true);
  assert.equal(await stat(f.external).then(() => true, () => false), true);
  assert.equal((await runCommand("git", ["-C", f.repo, "show-ref", "--verify", "refs/heads/hui/merged"])).code !== 0, true);
  assert.equal(calls.some((args) => args.includes("--force") || args.includes("-f")), false);
});

test("single removal refuses unconfirmed local changes and deletes them once confirmed", async () => {
  const f = await fixture();
  const calls: string[][] = [];
  const service = new WorktreeService({ root: f.root, run: runner({}, calls) });
  const [open, dirty] = await service.remove([], [f.managed("open"), f.managed("dirty")], "single");
  assert.deepEqual([open?.removed, open?.branchDeleted], [true, false]);
  assert.equal((await runCommand("git", ["-C", f.repo, "show-ref", "--verify", "refs/heads/hui/open"])).code, 0);
  assert.equal(calls.some((args) => args.includes("remove") && args.includes("--force") && args.includes(f.managed("open"))), false);
  assert.equal(dirty?.removed, false);
  assert.match(dirty?.error ?? "", /uncommitted or untracked files since you confirmed/u);
  assert.equal(dirty?.label, "hui/dirty");
  assert.equal(await stat(join(f.managed("dirty"), "scratch.txt")).then(() => true, () => false), true);

  const [confirmed] = await service.remove([], [f.managed("dirty")], "single", ["dirty"]);
  assert.equal(confirmed?.removed, true);
  assert.equal(await stat(f.managed("dirty")).then(() => true, () => false), false);
  assert.equal((await runCommand("git", ["-C", f.repo, "show-ref", "--verify", "refs/heads/hui/dirty"])).code, 0);
});

test("a locked worktree is removed only after the lock override is confirmed", async () => {
  const f = await fixture();
  await git(f.repo, "worktree", "lock", f.managed("open"));
  const service = new WorktreeService({ root: f.root, run: runner({}) });
  assert.deepEqual((await service.inventory([])).worktrees.find((row) => row.branch === "hui/open")?.risks.includes("locked"), true);
  const [refused] = await service.remove([], [f.managed("open")], "single");
  assert.equal(refused?.removed, false);
  const [removed] = await service.remove([], [f.managed("open")], "single", ["locked"]);
  assert.equal(removed?.removed, true);
});

test("a merged PR whose head differs from the branch keeps the branch", async () => {
  const f = await fixture();
  await writeFile(join(f.managed("merged"), "later.txt"), "after merge\n");
  await git(f.managed("merged"), "add", ".");
  await git(f.managed("merged"), "commit", "-q", "-m", "after merge");
  const service = new WorktreeService({ root: f.root, run: runner({ "hui/merged": [pr(1, "MERGED", f.head)] }) });
  const [result] = await service.remove([], [f.managed("merged")], "single");
  assert.deepEqual([result?.removed, result?.branchDeleted], [true, false]);
  assert.equal((await runCommand("git", ["-C", f.repo, "show-ref", "--verify", "refs/heads/hui/merged"])).code, 0);
});

test("a running linked session is stopped only after the user confirms", async () => {
  const f = await fixture();
  const stopped: string[] = [];
  const service = new WorktreeService({ root: f.root, run: runner({}), isRunning: (id) => id === "a", stopSession: (id) => stopped.push(id) });
  const sessions = [session("a", f.managed("used"))];
  const [refused] = await service.remove(sessions, [f.managed("used")], "single");
  assert.equal(refused?.removed, false);
  assert.match(refused?.error ?? "", /running/u);
  assert.deepEqual(stopped, []);
  const [removed] = await service.remove(sessions, [f.managed("used")], "single", ["running"]);
  assert.equal(removed?.removed, true);
  assert.deepEqual(stopped, ["a"]);
});

test("merged cleanup never removes a worktree with a running session", async () => {
  const f = await fixture();
  const service = new WorktreeService({ root: f.root, run: runner({ "hui/used": [pr(9, "MERGED", f.head)] }), isRunning: (id) => id === "a" });
  const [result] = await service.remove([session("a", f.managed("used"))], [f.managed("used")], "merged");
  assert.equal(result?.removed, false);
  assert.equal(await stat(f.managed("used")).then(() => true, () => false), true);
});

test("a GitHub failure never marks a worktree merged", async () => {
  const f = await fixture();
  const failing: CommandRunner = async (file, args, options) =>
    file === "gh" ? { code: 1, stdout: "", stderr: "offline" } : runCommand(file, args, options);
  const service = new WorktreeService({ root: f.root, run: failing });
  await service.inventory([]);
  await service.settled();
  const row = (await service.inventory([])).worktrees.find((item) => item.branch === "hui/merged")!;
  assert.equal(row.pullRequests, undefined);
  assert.deepEqual(row.unavailable, ["pullRequests"]);
  assert.equal(row.merged, false);
  const [result] = await service.remove([], [f.managed("merged")], "merged");
  assert.equal(result?.removed, false);
});

test("a worktree created outside HUI is removable once confirmed, without --force when clean", async () => {
  const f = await fixture();
  const calls: string[][] = [];
  const service = new WorktreeService({ root: f.root, run: runner({}, calls) });
  const [refused] = await service.remove([], [f.external], "single");
  assert.match(refused?.error ?? "", /HUI did not create it/u);
  const [result] = await service.remove([], [f.external], "single", ["external"]);
  assert.deepEqual([result?.removed, result?.branchDeleted], [true, false]);
  assert.equal(await stat(f.external).then(() => true, () => false), false);
  assert.equal((await runCommand("git", ["-C", f.repo, "show-ref", "--verify", "refs/heads/external"])).code, 0);
  assert.equal(calls.some((args) => args.includes("--force")), false);
});

test("the inventory shows which worktree is being removed, how much of it is left and which wait", async () => {
  const f = await fixture();
  const calls: string[][] = [];
  let release!: () => void;
  let deleting = false;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let started!: () => void;
  const removing = new Promise<void>((resolveStarted) => { started = resolveStarted; });
  const base = runner({}, calls);
  const service = new WorktreeService({
    root: f.root,
    run: async (file, args, options) => {
      if (args.includes("remove") && args.includes(f.managed("open"))) {
        deleting = true;
        started();
        await gate;
        deleting = false;
      }
      // `du` over a tree Git is deleting exits 1 for vanished files; its total holds.
      if (file === "du" && args.includes(f.managed("open")) && deleting) {
        calls.push([file, ...args]);
        return { code: 1, stdout: `8\t${f.managed("open")}\n`, stderr: "du: cannot access 'x': No such file or directory" };
      }
      return base(file, args, options);
    },
  });
  await service.inventory([]);
  await service.settled();
  const removal = service.remove([], [f.managed("open"), f.managed("merged")], "single");
  // The first removal reached Git, which holds it until released.
  await removing;
  calls.length = 0;
  await service.inventory([]);
  await service.settled();
  const during = await service.inventory([]);
  const byBranch = new Map(during.worktrees.map((row) => [row.branch, row]));
  assert.equal(byBranch.get("hui/open")?.removal, "removing");
  assert.equal(typeof byBranch.get("hui/open")?.bytes, "number");
  assert.equal(byBranch.get("hui/open")?.remainingBytes, 8 * 1024);
  assert.equal(byBranch.get("hui/merged")?.removal, "queued");
  assert.equal(byBranch.get("hui/merged")?.remainingBytes, undefined);
  assert.equal(byBranch.get("hui/dirty")?.removal, undefined);
  assert.equal(during.pending, true);
  assert.equal(calls.some((args) => args.includes(f.managed("open")) && args.includes("status")), false);
  release();
  await removal;
  const after = await service.inventory([]);
  assert.equal(after.worktrees.some((row) => row.removal), false);
  assert.equal(after.worktrees.some((row) => row.branch === "hui/open"), false);
});

test("acknowledging unread changes covers dirty but unrelated risks do not", () => {
  assert.equal(riskAcknowledged("dirty", ["unknown"]), true);
  assert.equal(riskAcknowledged("dirty", ["external"]), false);
});
