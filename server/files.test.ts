import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { fileExtension, MAX_RESOLVE_PATHS, contentEtag, decodeText, FilesError, FilesRoot, normalizeFilesPath, parseIfMatch, searchRank, validEntryName } from "./files.ts";

test("file extensions and resolve limits match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./files.fixture.json", import.meta.url), "utf8"));
  assert.equal(MAX_RESOLVE_PATHS, fixture.maxResolvePaths);
  for (const item of fixture.paths) assert.equal(fileExtension(item.input), item.extension);
});

const base = await realpath(await mkdtemp(join(tmpdir(), "hui-files-")));
afterAll(() => rm(base, { recursive: true, force: true }));
let counter = 0;

/** A fresh working directory beside a sibling "outside" folder the view must never reach. */
async function fixture() {
  const dir = join(base, `case-${++counter}`);
  const root = join(dir, "work");
  const outside = join(dir, "outside");
  await mkdir(join(root, "src", "lib"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "README.md"), "# Hello\n");
  await writeFile(join(root, "src", "main.ts"), "export const answer = 42;\r\n");
  await writeFile(join(root, "src", "lib", "util.ts"), "export {};\n");
  await writeFile(join(outside, "secret.txt"), "do not read");
  return { root, outside, files: await FilesRoot.open(root) };
}

async function refused(promise: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert(error instanceof FilesError, String(error));
    assert.equal(error.status, status, error.message);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("relative paths are normalized and escapes refused before touching the disk", () => {
  assert.equal(normalizeFilesPath(""), "");
  assert.equal(normalizeFilesPath("./src//lib/"), "src/lib");
  assert.throws(() => normalizeFilesPath("../outside"), /leaves the working directory/u);
  assert.throws(() => normalizeFilesPath("src/../../outside"), /leaves the working directory/u);
  assert.throws(() => normalizeFilesPath("/etc/passwd"), /relative/u);
  assert.throws(() => normalizeFilesPath("a\0b"), /NUL/u);
  assert.throws(() => validEntryName("a/b"), /without slashes/u);
  assert.throws(() => validEntryName(".."), /without slashes/u);
  assert.equal(validEntryName("notes.md"), "notes.md");
  assert.equal(parseIfMatch('W/"abc"'), "abc");
  assert.equal(parseIfMatch(' "abc" '), "abc");
  assert.equal(parseIfMatch(undefined), undefined);
});

test("search ranks names that start with the query first and requires every word", () => {
  assert.equal(searchRank("src/main.ts", "zzz"), undefined);
  assert.equal(searchRank("src/main.ts", "src missing"), undefined);
  const start = searchRank("src/main.ts", "main")!;
  const inside = searchRank("src/domain.ts", "main")!;
  const folder = searchRank("main/index.ts", "main")!;
  assert(start < inside && inside < folder, `${start} ${inside} ${folder}`);
});

test("text decoding refuses NUL bytes and invalid UTF-8 but keeps a BOM", () => {
  assert.equal(decodeText(Buffer.from([0x61, 0x00])), undefined);
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0xfd])), undefined);
  assert.equal(decodeText(Buffer.from("\ufeffhola", "utf8")), "\ufeffhola");
});

test("a listing puts folders first and stays inside the root", async () => {
  const { files, root, outside } = await fixture();
  await symlink(outside, join(root, "escape"));
  await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
  await symlink(join(root, "src"), join(root, "src-link"));
  await symlink(join(root, "missing"), join(root, "dangling"));
  const listing = await files.list("");
  assert.equal(listing.path, "");
  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.kind, entry.symlink ?? false]), [
    ["src", "directory", false],
    ["src-link", "directory", true],
    ["dangling", "symlink", false],
    ["escape", "symlink", false],
    ["README.md", "file", false],
    ["secret-link.txt", "symlink", false],
  ]);
  assert.deepEqual((await files.list("src")).entries.map((entry) => entry.path), ["src/lib", "src/main.ts"]);
  await refused(files.list("escape"), 403, "outside");
  await refused(files.list("../outside"), 403, "outside");
  await refused(files.list("README.md"), 422);
  await refused(files.list("nope"), 404);
});

test("reads refuse traversal and symlinks that leave the root", async () => {
  const { files, root, outside } = await fixture();
  await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
  await symlink(outside, join(root, "escape"));
  await refused(files.read("../outside/secret.txt"), 403, "outside");
  await refused(files.read("src/../../outside/secret.txt"), 403, "outside");
  await refused(files.read("secret-link.txt"), 403, "outside");
  await refused(files.read("escape/secret.txt"), 403, "outside");
  await refused(files.raw("escape/secret.txt"), 403, "outside");
  await refused(files.read("/etc/hostname"), 400);
  await refused(files.read("src"), 422);
});

test("reads tell text, images, PDFs, binary and oversized files apart", async () => {
  const { files, root } = await fixture();
  const text = await files.read("src/main.ts");
  assert.equal(text.kind, "text");
  assert.equal(text.content, "export const answer = 42;\r\n");
  assert.equal(text.etag, contentEtag(Buffer.from(text.content!)));
  assert.equal(text.writable, true);
  await writeFile(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const image = await files.read("logo.png");
  assert.equal(image.kind, "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.content, undefined);
  assert.equal((await files.raw("logo.png")).data.length, 7);
  await writeFile(join(root, "doc.pdf"), "%PDF-1.4");
  assert.equal((await files.read("doc.pdf")).kind, "pdf");
  await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2, 3]));
  const binary = await files.read("blob.bin");
  assert.equal(binary.kind, "binary");
  assert.equal(binary.content, undefined);
  assert.equal(binary.size, 4);
  await writeFile(join(root, "big.log"), Buffer.alloc(2_000_001, 0x61));
  assert.equal((await files.read("big.log")).kind, "too-large");
  await writeFile(join(root, "icon.svg"), "<svg/>");
  assert.equal((await files.read("icon.svg")).kind, "text");
});

test("a save needs the version it edited and answers a conflict with the current file", async () => {
  const { files, root } = await fixture();
  const read = await files.read("src/main.ts");
  await refused(files.write("src/main.ts", "x", undefined), 428);
  const saved = await files.write("src/main.ts", "export const answer = 43;\r\n", read.etag);
  assert.equal(await readFile(join(root, "src", "main.ts"), "utf8"), "export const answer = 43;\r\n");
  assert.notEqual(saved.etag, read.etag);
  // The agent edits the file behind the view's back.
  await writeFile(join(root, "src", "main.ts"), "agent wrote this\n");
  await assert.rejects(files.write("src/main.ts", "mine", saved.etag), (error: unknown) => {
    assert(error instanceof FilesError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "conflict");
    assert.equal(error.current?.content, "agent wrote this\n");
    return true;
  });
  assert.equal(await readFile(join(root, "src", "main.ts"), "utf8"), "agent wrote this\n");
  // Overwriting names the version the operator saw in the conflict.
  const current = await files.read("src/main.ts");
  await files.write("src/main.ts", "mine", current.etag);
  assert.equal(await readFile(join(root, "src", "main.ts"), "utf8"), "mine");
  // No temporary file is left behind.
  assert.deepEqual((await readdir(join(root, "src"))).sort(), ["lib", "main.ts"]);
});

test("a save keeps the file's mode, follows an inside symlink and refuses writes outside", async () => {
  const { files, root, outside } = await fixture();
  const script = join(root, "run.sh");
  await writeFile(script, "echo hi\n");
  await chmod(script, 0o755);
  await files.write("run.sh", "echo bye\n", (await files.read("run.sh")).etag);
  assert.equal((await stat(script)).mode & 0o777, 0o755);
  await symlink(join(root, "README.md"), join(root, "readme-link.md"));
  await files.write("readme-link.md", "# Linked\n", (await files.read("readme-link.md")).etag);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "# Linked\n");
  await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));
  await refused(files.write("secret-link.txt", "pwned", "x"), 403, "outside");
  await refused(files.write("../outside/secret.txt", "pwned", "x"), 403, "outside");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "do not read");
  await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2]));
  await refused(files.write("blob.bin", "text", (await files.read("blob.bin")).etag), 415);
});

test("create refuses existing names and paths outside the root", async () => {
  const { files, root, outside } = await fixture();
  assert.deepEqual(await files.create("src/new.ts", "file"), { name: "new.ts", path: "src/new.ts", kind: "file", size: 0 });
  assert.equal(await readFile(join(root, "src", "new.ts"), "utf8"), "");
  await files.create("docs", "directory");
  assert((await stat(join(root, "docs"))).isDirectory());
  await refused(files.create("src/new.ts", "file"), 409, "exists");
  await refused(files.create("missing/new.ts", "file"), 404);
  await refused(files.create("../outside/new.ts", "file"), 403, "outside");
  await symlink(outside, join(root, "escape"));
  await refused(files.create("escape/new.ts", "file"), 403, "outside");
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
});

test("uploads land in a folder, never replace without overwrite and never write through a link", async () => {
  const { files, root, outside } = await fixture();
  const entry = await files.upload("src", "data.bin", Buffer.from([1, 2, 3]), false);
  assert.equal(entry.path, "src/data.bin");
  assert.deepEqual([...await readFile(join(root, "src", "data.bin"))], [1, 2, 3]);
  await refused(files.upload("src", "data.bin", Buffer.from([4]), false), 409, "exists");
  await files.upload("src", "data.bin", Buffer.from([4]), true);
  assert.deepEqual([...await readFile(join(root, "src", "data.bin"))], [4]);
  await refused(files.upload("", "src", Buffer.from([1]), true), 422);
  await refused(files.upload("src", "../x", Buffer.from([1]), false), 422);
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  await refused(files.upload("", "link.txt", Buffer.from("pwned"), true), 422);
  await symlink(outside, join(root, "escape"));
  await refused(files.upload("escape", "x.txt", Buffer.from("pwned"), true), 403, "outside");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "do not read");
});

test("delete removes a link rather than its target, needs consent for a full folder and never the root", async () => {
  const { files, root, outside } = await fixture();
  await refused(files.remove("", true), 422);
  await refused(files.remove(".", true), 422);
  await refused(files.remove("../outside", true), 403, "outside");
  await symlink(outside, join(root, "escape"));
  assert.deepEqual(await files.remove("escape", false), { path: "escape", kind: "symlink" });
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
  await refused(files.remove("src", false), 409, "not_empty");
  assert.deepEqual(await files.remove("src/lib/util.ts", false), { path: "src/lib/util.ts", kind: "file" });
  assert.deepEqual(await files.remove("src/lib", false), { path: "src/lib", kind: "directory" });
  assert.deepEqual(await files.remove("src", true), { path: "src", kind: "directory" });
  assert.deepEqual(await readdir(root), ["README.md"]);
  await refused(files.remove("src", true), 404);
});

test("search uses Git's file list inside a repository and a bounded walk elsewhere", async () => {
  const { files, root } = await fixture();
  const walked = await files.search("util");
  assert.equal(walked.source, "walk");
  assert.deepEqual(walked.entries.map((entry) => entry.path), ["src/lib/util.ts"]);
  assert.deepEqual((await files.search("   ")).entries, []);
  const repo = join(base, `repo-${++counter}`);
  await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
  await writeFile(join(repo, ".gitignore"), "node_modules/\nbuild.log\n");
  await writeFile(join(repo, "build.log"), "ignored");
  await writeFile(join(repo, "tracked.ts"), "1");
  await writeFile(join(repo, "untracked.ts"), "2");
  await writeFile(join(repo, "node_modules", "dep", "index.ts"), "3");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", "tracked.ts", ".gitignore");
  git("commit", "-qm", "init");
  const repoFiles = await FilesRoot.open(repo);
  const found = await repoFiles.search(".ts");
  assert.equal(found.source, "git");
  assert.deepEqual(found.entries.map((entry) => entry.path).sort(), ["tracked.ts", "untracked.ts"]);
  assert.deepEqual((await repoFiles.search("build")).entries, []);
  assert(root);
});

test("opening a missing working directory says so", async () => {
  await refused(FilesRoot.open(join(base, "does-not-exist")), 404, "not_found");
});
