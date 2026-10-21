import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { completeLocalPaths, completeWorkingDirectories, displayPath, resolveWorkingDirectory } from "./working-directories.ts";

test("working directories accept home, relative and absolute paths", () => {
  assert.equal(resolveWorkingDirectory("~", "/home/test"), "/home/test");
  assert.equal(resolveWorkingDirectory("~/repo", "/home/test"), "/home/test/repo");
  assert.equal(resolveWorkingDirectory("repo", "/home/test"), "/home/test/repo");
  assert.equal(resolveWorkingDirectory("/srv/repo", "/home/test"), "/srv/repo");
  assert.equal(resolveWorkingDirectory("", "/home/test"), "/home/test");
});

test("completion hides dot directories until the fragment starts with a dot", async () => {
  const home = await mkdtemp(join(tmpdir(), "hui-cwd-"));
  await Promise.all([
    mkdir(join(home, "Projects")),
    mkdir(join(home, "Pictures")),
    mkdir(join(home, ".private")),
  ]);
  await symlink(join(home, "Projects"), join(home, "Project-link"));

  assert.deepEqual(await completeWorkingDirectories("~/P", home), [
    "~/Pictures/",
    "~/Project-link/",
    "~/Projects/",
  ]);
  assert.deepEqual(await completeWorkingDirectories("~/.", home), ["~/.private/"]);
  assert.deepEqual(await completeWorkingDirectories("~/", home), [
    "~/Pictures/",
    "~/Project-link/",
    "~/Projects/",
  ]);
});

test("local path completion includes files and directories relative to the workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "hui-path-home-"));
  const cwd = join(home, "project");
  await mkdir(join(cwd, "src"), { recursive: true });
  await Promise.all([
    writeFile(join(cwd, "spec.md"), "spec"),
    writeFile(join(cwd, "src", "server.ts"), "server"),
    writeFile(join(cwd, ".env"), "hidden"),
  ]);

  assert.deepEqual(await completeLocalPaths("s", cwd, home), [
    { path: "src/", kind: "directory" },
    { path: "spec.md", kind: "file" },
  ]);
  assert.deepEqual(await completeLocalPaths("src/se", cwd, home), [
    { path: "src/server.ts", kind: "file" },
  ]);
  assert.deepEqual(await completeLocalPaths(".", cwd, home), [
    { path: ".env", kind: "file" },
  ]);
  assert.deepEqual(await completeLocalPaths("~/project/src/", cwd, home), [
    { path: "~/project/src/server.ts", kind: "file" },
  ]);
});

test("display paths shorten only the home directory itself and paths inside it", () => {
  assert.equal(displayPath("/home/me", "/home/me"), "~/");
  assert.equal(displayPath("/home/me/Projects/HUI", "/home/me"), "~/Projects/HUI");
  assert.equal(displayPath("/home/mentor/x", "/home/me"), "/home/mentor/x");
  assert.equal(displayPath("/srv/app", "/home/me"), "/srv/app");
});
