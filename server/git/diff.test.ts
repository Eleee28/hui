import assert from "node:assert/strict";
import { DIFF_COMPARISONS, isDiffComparison } from "./diff.ts";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import {
  diffChanges,
  diffFile,
  diffInfo,
  DiffError,
  headerPaths,
  MAX_FILE_PATCH_LINES,
  mergeChanges,
  offeredBranches,
  parseRawNumstat,
  pickDefaultBranch,
  pickParentBranch,
  resolveBranchName,
  splitPatch,
  unquoteGitPath,
} from "./diff.ts";

/* ── fixture repositories ── */

let scratch = "";
const isolated = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...isolated }, encoding: "utf8" });
}
let repositories = 0;
async function repository(name: string): Promise<string> {
  const root = join(scratch, `${name}-${++repositories}`);
  execFileSync("mkdir", ["-p", root]);
  git(root, "init", "-q", "-b", "main");
  return root;
}
async function commitFile(root: string, path: string, content: string, message: string) {
  await writeFile(join(root, path), content);
  git(root, "add", "--", path);
  git(root, "commit", "-q", "-m", message);
}
async function objectCount(root: string): Promise<number> {
  let count = 0;
  for (const folder of await readdir(join(root, ".git", "objects"))) {
    if (folder.length !== 2) continue;
    count += (await readdir(join(root, ".git", "objects", folder))).length;
  }
  return count;
}

/** main → feature-a → feature-b, with uncommitted edits on feature-b: a new, a deleted and a renamed file. */
async function stack(): Promise<string> {
  const root = await repository("stack");
  await commitFile(root, "README.md", "# Fixture\n", "init");
  await commitFile(root, "gone.txt", "to be deleted\n", "add gone");
  await commitFile(root, "move-me.txt", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n", "add move-me");
  git(root, "checkout", "-q", "-b", "feature-a");
  await commitFile(root, "a.txt", "feature a\n", "feature a");
  git(root, "checkout", "-q", "-b", "feature-b");
  await commitFile(root, "b.txt", "feature b\n", "feature b 1");
  await commitFile(root, "b.txt", "feature b\nsecond\n", "feature b 2");
  git(root, "checkout", "-q", "main");
  await commitFile(root, "main-later.txt", "landed later on main\n", "later on main");
  git(root, "checkout", "-q", "feature-b");
  await writeFile(join(root, "new file.txt"), "brand new\n");
  await unlink(join(root, "gone.txt"));
  await rename(join(root, "move-me.txt"), join(root, "moved.txt"));
  await writeFile(join(root, "README.md"), "# Fixture\n\nEdited.\n");
  return root;
}

beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), "hui-git-diff-")); });
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

/* ── parsing ── */

test("Git's quoted paths are unquoted, octal escapes as UTF-8 bytes", () => {
  assert.equal(unquoteGitPath("plain.txt"), "plain.txt");
  assert.equal(unquoteGitPath('"tab\\there.txt"'), "tab\there.txt");
  assert.equal(unquoteGitPath('"quote\\"d.txt"'), 'quote"d.txt');
  assert.equal(unquoteGitPath('"caf\\303\\251.txt"'), "café.txt");
});

test("the diff --git line yields both paths when they can be told apart", () => {
  assert.deepEqual(headerPaths("diff --git a/src/a b.txt b/src/a b.txt"), { oldPath: "src/a b.txt", path: "src/a b.txt" });
  assert.deepEqual(headerPaths('diff --git "a/x\\ty" "b/x\\ty"'), { oldPath: "x\ty", path: "x\ty" });
  assert.equal(headerPaths("diff --git a/one b/two three"), undefined);
});

test("raw and numstat records pair up, renames carry both paths and binary files no counts", () => {
  const output = [
    ":100644 100644 aaa bbb M", "keep.txt",
    ":100644 100644 ccc ddd R087", "old name.txt", "new name.txt",
    ":000000 100644 000 eee A", "image.png",
    ":100644 000000 fff 000 D", "gone.txt",
    "1\t2\tkeep.txt",
    "3\t0\t", "old name.txt", "new name.txt",
    "-\t-\timage.png",
    "0\t4\tgone.txt",
    "",
  ].join("\0");
  assert.deepEqual(parseRawNumstat(output), [
    { path: "keep.txt", status: "M", oldMode: "100644", newMode: "100644", additions: 1, deletions: 2, binary: false },
    { path: "new name.txt", oldPath: "old name.txt", status: "R", similarity: 87, oldMode: "100644", newMode: "100644", additions: 3, deletions: 0, binary: false },
    { path: "image.png", status: "A", newMode: "100644", additions: 0, deletions: 0, binary: true },
    { path: "gone.txt", status: "D", oldMode: "100644", additions: 0, deletions: 4, binary: false },
  ]);
});

test("a patch splits per file: renames, binary, no newline at EOF and CRLF lines intact", () => {
  const patch = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 90%",
    "rename from old.txt",
    "rename to new.txt",
    "index 1..2 100644",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1,2 +1,2 @@",
    " same",
    "-before",
    "\\ No newline at end of file",
    "+after\r",
    "diff --git a/logo.png b/logo.png",
    "index 3..4 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");
  const chunks = splitPatch(patch);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], { path: "new.txt", oldPath: "old.txt", binary: false, truncated: false, body: "@@ -1,2 +1,2 @@\n same\n-before\n\\ No newline at end of file\n+after\r" });
  assert.deepEqual(chunks[1], { path: "logo.png", binary: true, truncated: false, body: "" });
  assert.deepEqual(chunks[2], { path: "gone.txt", binary: false, truncated: false, body: "@@ -1 +0,0 @@\n-bye" });
});

test("a huge file's patch stops at the per-file limit; a chunk the total cap cut is left to load alone", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `+line ${i}`);
  const patch = ["diff --git a/big.txt b/big.txt", "--- a/big.txt", "+++ b/big.txt", "@@ -0,0 +1,50 @@", ...lines, "diff --git a/cut.txt b/cut.txt", "--- a/cut.txt", "+++ b/cut.txt", "@@ -1 +1 @@", "-x"].join("\n");
  const chunks = splitPatch(patch, { maxLines: 11, complete: false });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.truncated, true);
  assert.equal(chunks[0]!.body.split("\n").length, 11);
  const files = mergeChanges([
    { path: "big.txt", status: "M", additions: 50, deletions: 0, binary: false },
    { path: "cut.txt", status: "M", additions: 0, deletions: 1, binary: false },
  ], chunks, true);
  assert.equal(files[0]!.truncated, "file");
  assert.equal(files[1]!.truncated, "total");
  assert.equal(files[1]!.patch, undefined);
  assert.ok(MAX_FILE_PATCH_LINES > 1000);
});

test("a listed file without a patch changed only its name or mode when nothing was cut", () => {
  const [file] = mergeChanges([{ path: "run.sh", status: "M", oldMode: "100644", newMode: "100755", additions: 0, deletions: 0, binary: false }], [], false);
  assert.equal(file!.patch, "");
  assert.equal(file!.truncated, undefined);
});

/* ── branch rules ── */

const refs = ["refs/heads/main", "refs/heads/feature-a", "refs/heads/feature-b", "refs/remotes/origin/main", "refs/remotes/origin/feature-b", "refs/remotes/origin/feature-a"];

test("the previous branch is the nearest ancestor, never the branch itself or its remote copy", () => {
  const ancestors = new Map([["refs/heads/main", 5], ["refs/remotes/origin/main", 5], ["refs/heads/feature-a", 2], ["refs/remotes/origin/feature-a", 2], ["refs/remotes/origin/feature-b", 1]]);
  assert.deepEqual(pickParentBranch({ branch: "feature-b", refs, remotes: ["origin"], ancestors, config: {}, defaultRef: "refs/remotes/origin/main" }), { ref: "refs/heads/feature-a", source: "nearest" });
  // A tie between a branch and the default branch at the same commit goes to the branch.
  const tie = new Map([["refs/heads/main", 3], ["refs/heads/feature-a", 3]]);
  assert.deepEqual(pickParentBranch({ branch: "feature-b", refs, remotes: ["origin"], ancestors: tie, config: {}, defaultRef: "refs/heads/main" }), { ref: "refs/heads/feature-a", source: "nearest" });
  assert.equal(pickParentBranch({ branch: "feature-b", refs, remotes: ["origin"], ancestors: new Map([["refs/remotes/origin/feature-b", 0]]), config: {} }), undefined);
});

test("configuration names the previous branch before the nearest ancestor", () => {
  const ancestors = new Map([["refs/heads/feature-a", 1]]);
  const base = { branch: "feature-b", refs, remotes: ["origin"], ancestors };
  assert.deepEqual(pickParentBranch({ ...base, config: { ghMergeBase: "main" } }), { ref: "refs/heads/main", source: "gh-merge-base" });
  assert.deepEqual(pickParentBranch({ ...base, config: { gitTownParent: "origin/main" } }), { ref: "refs/remotes/origin/main", source: "git-town" });
  assert.deepEqual(pickParentBranch({ ...base, config: { upstream: "refs/remotes/origin/main" } }), { ref: "refs/remotes/origin/main", source: "upstream" });
  // Tracking its own remote copy says nothing about the stack.
  assert.deepEqual(pickParentBranch({ ...base, config: { upstream: "refs/remotes/origin/feature-b" } }), { ref: "refs/heads/feature-a", source: "nearest" });
  assert.deepEqual(pickParentBranch({ ...base, config: { ghMergeBase: "no-such-branch" } }), { ref: "refs/heads/feature-a", source: "nearest" });
});

test("branch names resolve to the local branch first, then the preferred remote", () => {
  assert.equal(resolveBranchName("feature-a", refs, ["origin"]), "refs/heads/feature-a");
  assert.equal(resolveBranchName("origin/main", refs, ["origin"]), "refs/remotes/origin/main");
  assert.equal(resolveBranchName("refs/heads/main", refs, ["origin"]), "refs/heads/main");
  assert.equal(resolveBranchName("only-remote", [...refs, "refs/remotes/fork/only-remote"], ["origin", "fork"]), "refs/remotes/fork/only-remote");
  assert.equal(resolveBranchName("", refs, ["origin"]), undefined);
});

test("the default branch follows origin/HEAD, then origin/main, origin/master, main, master", () => {
  assert.equal(pickDefaultBranch("refs/remotes/origin/trunk", [...refs, "refs/remotes/origin/trunk"]), "refs/remotes/origin/trunk");
  assert.equal(pickDefaultBranch(undefined, refs), "refs/remotes/origin/main");
  assert.equal(pickDefaultBranch(undefined, ["refs/heads/master", "refs/heads/x"]), "refs/heads/master");
  assert.equal(pickDefaultBranch(undefined, ["refs/heads/x"]), undefined);
});

test("offered branches list ancestors nearest first and leave out the branch itself", () => {
  const offered = offeredBranches({
    refs: refs.map((ref, index) => ({ ref, sha: String(index), date: 100 - index })),
    remotes: ["origin"],
    ancestors: new Map([["refs/heads/main", 4], ["refs/heads/feature-a", 1]]),
  }, "feature-b");
  assert.deepEqual(offered.map((branch) => branch.name), ["feature-a", "main", "origin/main", "origin/feature-a"]);
  assert.equal(offered[0]!.distance, 1);
});

/* ── against real repositories ── */

test("a stacked branch finds its parent and offers every comparison", async () => {
  const root = await stack();
  const info = await diffInfo(root, "~/stack");
  assert.equal(info.available, true);
  if (!info.available) return;
  assert.equal(info.branch, "feature-b");
  assert.equal(info.detached, false);
  assert.deepEqual(info.comparisons, ["uncommitted", "last-commit", "parent", "default"]);
  // Without a remote, the local main is the default branch.
  assert.equal(info.defaultBranch?.ref, "refs/heads/main");
  assert.equal(info.parent?.ref, "refs/heads/feature-a");
  assert.equal(info.parent?.source, "nearest");
  assert.equal(info.parent?.distance, 2);
  assert.equal(info.lastCommit?.subject, "feature b 2");
  assert.equal(info.uncommitted, 5);
  assert.ok(info.branches.some((branch) => branch.ref === "refs/heads/main"));
  assert.ok(!info.branches.some((branch) => branch.ref === "refs/heads/feature-b"));
  // origin/main takes over once it exists.
  git(root, "remote", "add", "origin", "https://example.invalid/fixture.git");
  git(root, "update-ref", "refs/remotes/origin/main", "main");
  const withOrigin = await diffInfo(root, "~/stack");
  assert.ok(withOrigin.available && withOrigin.comparisons.includes("default"));
  assert.equal(withOrigin.available && withOrigin.defaultBranch?.name, "origin/main");
});

test("without %(ahead-behind) (Git before 2.41) the distances are counted one by one", async () => {
  const root = await stack();
  const { runGit } = await import("./diff.ts");
  const oldGit: Parameters<typeof diffInfo>[2] = async (cwd, args, options) => args.some((arg) => arg.includes("ahead-behind"))
    ? { code: 128, stdout: "", stderr: "fatal: unknown field name: ahead-behind:HEAD", truncated: false }
    : runGit(cwd, args, options);
  const info = await diffInfo(root, "~/stack", oldGit);
  assert.ok(info.available);
  assert.equal(info.available && info.parent?.ref, "refs/heads/feature-a");
  assert.equal(info.available && info.parent?.distance, 2);
});

test("uncommitted changes include untracked files and renames without writing to the repository", async () => {
  const root = await stack();
  const index = await readFile(join(root, ".git", "index"));
  const objects = await objectCount(root);
  const changes = await diffChanges(root, { comparison: "uncommitted", uncommitted: true });
  const byPath = new Map(changes.files.map((file) => [file.path, file]));
  assert.equal(byPath.get("new file.txt")?.status, "A");
  assert.match(byPath.get("new file.txt")?.patch ?? "", /^\+brand new$/mu);
  assert.equal(byPath.get("gone.txt")?.status, "D");
  assert.equal(byPath.get("moved.txt")?.status, "R");
  assert.equal(byPath.get("moved.txt")?.oldPath, "move-me.txt");
  assert.equal(byPath.get("README.md")?.status, "M");
  assert.equal(changes.includesUncommitted, true);
  assert.ok(changes.additions >= 3);
  assert.deepEqual(await readFile(join(root, ".git", "index")), index, "the index is untouched");
  assert.equal(await objectCount(root), objects, "no object was written");
  assert.match(git(root, "status", "--porcelain"), /\?\? "new file.txt"|\?\? new file.txt/u, "the new file is still untracked");
});

test("the last commit, the previous branch and the default branch compare the right commits", async () => {
  const root = await stack();
  const last = await diffChanges(root, { comparison: "last-commit", uncommitted: true });
  assert.deepEqual(last.files.map((file) => file.path), ["b.txt"]);
  assert.equal(last.includesUncommitted, false);
  const parent = await diffChanges(root, { comparison: "parent", uncommitted: false });
  assert.deepEqual(parent.files.map((file) => file.path), ["b.txt"]);
  assert.equal(parent.base.label, "feature-a");
  const parentAndWorktree = await diffChanges(root, { comparison: "parent", uncommitted: true });
  assert.deepEqual(parentAndWorktree.files.map((file) => file.path).sort(), ["README.md", "b.txt", "gone.txt", "moved.txt", "new file.txt"]);
  git(root, "remote", "add", "origin", "https://example.invalid/fixture.git");
  git(root, "update-ref", "refs/remotes/origin/main", "main");
  // Three dots: a file that landed on main later is not shown as removed.
  const fromDefault = await diffChanges(root, { comparison: "default", uncommitted: false });
  assert.deepEqual(fromDefault.files.map((file) => file.path).sort(), ["a.txt", "b.txt"]);
  const picked = await diffChanges(root, { comparison: "parent", parent: "refs/heads/main", uncommitted: false });
  assert.deepEqual(picked.files.map((file) => file.path).sort(), ["a.txt", "b.txt"]);
});

test("a branch the gateway did not offer is refused", async () => {
  const root = await stack();
  await assert.rejects(diffChanges(root, { comparison: "parent", parent: "refs/heads/feature-b", uncommitted: false }), (error: unknown) => error instanceof DiffError && error.status === 400);
  await assert.rejects(diffChanges(root, { comparison: "parent", parent: "refs/heads/nope", uncommitted: false }), (error: unknown) => error instanceof DiffError && error.code === "unknown-ref");
});

test("one file loads on its own, with its rename source", async () => {
  const root = await stack();
  const moved = await diffFile(root, { comparison: "uncommitted", uncommitted: true }, "moved.txt", "move-me.txt");
  assert.equal(moved?.status, "R");
  assert.equal(moved?.oldPath, "move-me.txt");
  const added = await diffFile(root, { comparison: "uncommitted", uncommitted: true }, "new file.txt", undefined);
  assert.equal(added?.status, "A");
  assert.equal(await diffFile(root, { comparison: "uncommitted", uncommitted: true }, "b.txt", undefined), null);
  await assert.rejects(diffFile(root, { comparison: "uncommitted", uncommitted: true }, "../outside.txt", undefined), /leaves the working directory/u);
});

test("a detached HEAD has no previous branch; an empty repository only uncommitted changes", async () => {
  const root = await stack();
  git(root, "checkout", "-q", "--detach", "HEAD~1");
  const info = await diffInfo(root, "~/stack");
  assert.ok(info.available);
  if (!info.available) return;
  assert.equal(info.detached, true);
  assert.equal(info.parent, undefined);
  assert.ok(!info.comparisons.includes("parent"));
  await assert.rejects(diffChanges(root, { comparison: "parent", uncommitted: true }), (error: unknown) => error instanceof DiffError && error.code === "detached");

  const empty = await repository("empty");
  await writeFile(join(empty, "first.txt"), "hello\n");
  const emptyInfo = await diffInfo(empty, "~/empty");
  assert.ok(emptyInfo.available && emptyInfo.unborn);
  assert.deepEqual(emptyInfo.available && emptyInfo.comparisons, ["uncommitted"]);
  const changes = await diffChanges(empty, { comparison: "uncommitted", uncommitted: true });
  assert.deepEqual(changes.files.map((file) => [file.path, file.status]), [["first.txt", "A"]]);
});

test("a folder outside any repository says so", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hui-not-a-repo-"));
  try {
    const info = await diffInfo(folder, "~/plain", (cwd, args, options) => import("./diff.ts").then(({ runGit }) => runGit(cwd, args, { ...options, env: { ...options?.env, GIT_CEILING_DIRECTORIES: tmpdir() } })));
    assert.deepEqual(info, { available: false, reason: "The conversation's working directory is not inside a Git repository.", code: "not-repo" });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a subdirectory's diff covers only it, with paths relative to it", async () => {
  const root = await repository("nested");
  execFileSync("mkdir", ["-p", join(root, "pkg")]);
  await commitFile(root, "top.txt", "top\n", "top");
  await commitFile(root, "pkg/inner.txt", "inner\n", "inner");
  await writeFile(join(root, "top.txt"), "top changed\n");
  await writeFile(join(root, "pkg", "inner.txt"), "inner changed\n");
  await writeFile(join(root, "pkg", "fresh.txt"), "fresh\n");
  const info = await diffInfo(join(root, "pkg"), "~/nested/pkg");
  assert.equal(info.available && info.subdirectory, "pkg");
  assert.equal(info.available && info.uncommitted, 2);
  const changes = await diffChanges(join(root, "pkg"), { comparison: "uncommitted", uncommitted: true });
  assert.deepEqual(changes.files.map((file) => file.path).sort(), ["fresh.txt", "inner.txt"]);
});

test("CRLF lines, a missing final newline and binary files come through", async () => {
  const root = await repository("shapes");
  await commitFile(root, "dos.txt", "one\r\ntwo\r\n", "dos");
  await commitFile(root, "eof.txt", "no newline", "eof");
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(root, "add", "blob.bin");
  git(root, "commit", "-q", "-m", "blob");
  await writeFile(join(root, "dos.txt"), "one\r\nTWO\r\n");
  await writeFile(join(root, "eof.txt"), "no newline, still");
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 9, 9, 9, 0, 255]));
  const changes = await diffChanges(root, { comparison: "uncommitted", uncommitted: true });
  const byPath = new Map(changes.files.map((file) => [file.path, file]));
  assert.match(byPath.get("dos.txt")!.patch!, /^\+TWO\r$/mu);
  assert.match(byPath.get("eof.txt")!.patch!, /^\\ No newline at end of file$/mu);
  assert.equal(byPath.get("blob.bin")!.binary, true);
  assert.equal(byPath.get("blob.bin")!.patch, undefined);
});

test("diff comparison guards match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./diff.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(DIFF_COMPARISONS, fixture.comparisons);
  for (const item of fixture.cases) assert.equal(isDiffComparison(item.input), item.expected);
});
