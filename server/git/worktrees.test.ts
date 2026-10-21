import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  checkoutSessionRef,
  createSessionWorktree,
  inspectGitCheckout,
  isMergedCleanupCandidate,
  parseGitWorktreeProgress,
  runGit,
  worktreeSlug,
} from "./worktrees.ts";
import type { WorktreeRow } from "../api/worktrees.ts";

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "hui-worktree-test-"));
  assert.equal((await runGit(root, ["init", "-b", "main"])).code, 0);
  assert.equal((await runGit(root, ["config", "user.email", "hui@example.invalid"])).code, 0);
  assert.equal((await runGit(root, ["config", "user.name", "HUI tests"])).code, 0);
  await mkdir(join(root, "packages", "app"), { recursive: true });
  await writeFile(join(root, "README.md"), "test\n", "utf8");
  await writeFile(join(root, "packages", "app", "index.ts"), "export {};\n", "utf8");
  assert.equal((await runGit(root, ["add", "."])).code, 0);
  assert.equal((await runGit(root, ["commit", "-m", "initial"])).code, 0);
  return root;
}

test("worktree slugs are readable, bounded Git name components", () => {
  assert.equal(worktreeSlug(" Fix the command palette! "), "fix-the-command-palette");
  assert.equal(worktreeSlug("áéí — π"), "aei");
  assert.equal(worktreeSlug("---"), "session");
});

test("inspects the current checkout and offers bounded branch suggestions", async () => {
  const repo = await repository();
  assert.equal((await runGit(repo, ["branch", "topic"])).code, 0);
  const checkout = await inspectGitCheckout(repo);
  assert.equal(checkout.available, true);
  assert.equal(checkout.headBranch, "main");
  assert.equal(checkout.defaultBranch, "main");
  assert.deepEqual(checkout.branches.slice(0, 2), ["main", "topic"]);
});

test("default base follows origin HEAD instead of the checked-out branch", async () => {
  const repo = await repository();
  for (const args of [
    ["branch", "release"],
    ["update-ref", "refs/remotes/origin/release", "HEAD"],
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release"],
    ["checkout", "-b", "topic"],
  ]) assert.equal((await runGit(repo, args)).code, 0);
  const checkout = await inspectGitCheckout(repo);
  assert.equal(checkout.headBranch, "topic");
  assert.equal(checkout.defaultBranch, "release");
  assert.equal(checkout.branches[0], "release");
  assert.equal((await runGit(repo, ["branch", "-D", "release"])).code, 0);
  assert.equal((await inspectGitCheckout(repo)).defaultBranch, "origin/release");
  assert.equal((await runGit(repo, ["checkout", "--detach"])).code, 0);
  assert.equal((await inspectGitCheckout(repo)).defaultBranch, "origin/release");
});

test("ref enumeration failure retains a remote-qualified default", async () => {
  const repo = await repository();
  assert.equal((await runGit(repo, ["update-ref", "refs/remotes/origin/release", "HEAD"])).code, 0);
  assert.equal((await runGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release"])).code, 0);
  const checkout = await inspectGitCheckout(repo, (cwd, args) => args[0] === "for-each-ref"
    ? Promise.resolve({ code: 1, stdout: "", stderr: "unavailable" }) : runGit(cwd, args));
  assert.equal(checkout.defaultBranch, "origin/release");
  assert.equal(checkout.branchesUnavailable, true);
  assert.deepEqual(checkout.branches, []);
});

test("without origin HEAD the base prefers local main, then master, then current HEAD", async () => {
  const repo = await repository();
  assert.equal((await runGit(repo, ["checkout", "-b", "topic"])).code, 0);
  assert.equal((await inspectGitCheckout(repo)).defaultBranch, "main");
  assert.equal((await runGit(repo, ["branch", "-m", "main", "master"])).code, 0);
  assert.equal((await inspectGitCheckout(repo)).defaultBranch, "master");
  assert.equal((await runGit(repo, ["branch", "-D", "master"])).code, 0);
  assert.equal((await inspectGitCheckout(repo)).defaultBranch, "topic");
  assert.equal((await runGit(repo, ["checkout", "--detach"])).code, 0);
  assert.equal((await inspectGitCheckout(repo)).defaultBranch, "HEAD");
});

test("reports a non-repository without inventing checkout data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hui-checkout-test-"));
  assert.deepEqual(await inspectGitCheckout(directory), {
    available: false,
    headBranch: "",
    defaultBranch: "",
    branches: [],
  });
});

test("parses Git checkout and filter progress without inventing an overall percentage", () => {
  assert.deepEqual(parseGitWorktreeProgress("Preparing worktree\rUpdating files:  72% (1800/2500)"), {
    phase: "checkout",
    percent: 72,
    completed: 1800,
    total: 2500,
  });
  assert.deepEqual(parseGitWorktreeProgress("\rFiltering content:  14% (7/50)"), {
    phase: "filtering",
    percent: 14,
    completed: 7,
    total: 50,
  });
  assert.equal(parseGitWorktreeProgress("Preparing worktree (new branch 'feature/task')"), undefined);
});

test("creates a prefixed worktree for the selected repository subdirectory", async () => {
  const repo = await repository();
  const managedRoot = join(repo, "..", "managed-worktrees");
  const phases: string[] = [];
  const created = await createSessionWorktree({
    sourceDirectory: join(repo, "packages", "app"),
    title: "Fix command palette",
    branchPrefix: "developer/",
    root: managedRoot,
    onProgress: (progress) => { phases.push(progress.phase); },
  });

  assert.equal(created.branch, "developer/fix-command-palette");
  assert.equal((await runGit(created.cwd, ["branch", "--show-current"])).stdout.trim(), created.branch);
  assert.equal(await stat(created.cwd).then((entry) => entry.isDirectory()), true);
  assert.equal(phases[0], "preparing");
  assert.equal(phases.at(-1), "finalizing");

  await created.rollback();
  assert.equal(await stat(created.path).then(() => true).catch(() => false), false);
  assert.notEqual((await runGit(repo, ["show-ref", "--verify", `refs/heads/${created.branch}`])).code, 0);
});

test("an explicit workspace name replaces the prompt-derived branch slug", async () => {
  const repo = await repository();
  const root = join(repo, "..", "managed-worktrees-named");
  const created = await createSessionWorktree({
    sourceDirectory: repo,
    title: "A completely different prompt",
    branchName: "My chosen branch",
    branchPrefix: "feature/",
    root,
  });
  assert.equal(created.branch, "feature/my-chosen-branch");
  await created.rollback();
});

test("creates the worktree from an explicitly selected base ref", async () => {
  const repo = await repository();
  assert.equal((await runGit(repo, ["checkout", "-b", "topic"])).code, 0);
  await writeFile(join(repo, "topic.txt"), "topic\n", "utf8");
  assert.equal((await runGit(repo, ["add", "topic.txt"])).code, 0);
  assert.equal((await runGit(repo, ["commit", "-m", "topic"])).code, 0);
  assert.equal((await runGit(repo, ["checkout", "main"])).code, 0);
  const created = await createSessionWorktree({
    sourceDirectory: repo,
    title: "From topic",
    baseRef: "topic",
    branchPrefix: "feature/",
    root: join(repo, "..", "managed-worktrees-base"),
  });
  assert.equal(await stat(join(created.path, "topic.txt")).then((entry) => entry.isFile()), true);
  await created.rollback();
});

test("switches the current checkout to a selected ref without creating a worktree", async () => {
  const repo = await repository();
  assert.equal((await runGit(repo, ["checkout", "-b", "topic"])).code, 0);
  await writeFile(join(repo, "topic.txt"), "topic\n", "utf8");
  assert.equal((await runGit(repo, ["add", "topic.txt"])).code, 0);
  assert.equal((await runGit(repo, ["commit", "-m", "topic"])).code, 0);
  assert.equal((await runGit(repo, ["checkout", "main"])).code, 0);

  await checkoutSessionRef(join(repo, "packages", "app"), "topic");

  assert.equal((await runGit(repo, ["branch", "--show-current"])).stdout.trim(), "topic");
  assert.equal(await stat(join(repo, "topic.txt")).then((entry) => entry.isFile()), true);
});

test("uses the next readable suffix when the generated branch already exists", async () => {
  const repo = await repository();
  const root = join(repo, "..", "managed-worktrees-collision");
  const first = await createSessionWorktree({ sourceDirectory: repo, title: "Task", branchPrefix: "feature/", root });
  const second = await createSessionWorktree({ sourceDirectory: repo, title: "Task", branchPrefix: "feature/", root });
  assert.equal(first.branch, "feature/task");
  assert.equal(second.branch, "feature/task-2");
  await second.rollback();
  await first.rollback();
});

test("parallel creations with one name take separate suffixes", async () => {
  const repo = await repository();
  const root = join(repo, "..", "managed-worktrees-parallel");
  const created = await Promise.all([1, 2, 3].map(() =>
    createSessionWorktree({ sourceDirectory: repo, title: "Task", branchPrefix: "feature/", root })));
  assert.deepEqual(created.map(({ branch }) => branch).sort(), ["feature/task", "feature/task-2", "feature/task-3"]);
  for (const worktree of created) await worktree.rollback();
});

test("refuses workspace creation outside a Git repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hui-not-a-repo-"));
  await assert.rejects(
    () => createSessionWorktree({ sourceDirectory: directory, title: "Task", branchPrefix: "feature/", root: join(directory, "worktrees") }),
    /requires a Git repository/,
  );
});

const fixture: { input: WorktreeRow; expected: boolean }[] = JSON.parse(readFileSync(new URL("./worktrees.fixture.json", import.meta.url), "utf8"));

test("worktrees preserves the shared runtime fixtures", () => {
  for (const { input, expected } of fixture) assert.equal(isMergedCleanupCandidate(input), expected);
});
