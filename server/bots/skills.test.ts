import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { localBotSkills } from "./skills.ts";

const BOT = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("a bot's own skills are written into its home, owner-only, and read back by name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-bot-skills-"));
  try {
    const files = localBotSkills(dir);
    assert.deepEqual(await files.read(BOT), [], "no folder, no skills");
    await files.write(BOT, [{ name: "weather", text: "---\nname: weather\ndescription: W\n---\nGo.\n" }, { name: "packing-list", text: "P" }]);
    const file = join(dir, BOT, "skills", "weather", "SKILL.md");
    assert.equal(await readFile(file, "utf8"), "---\nname: weather\ndescription: W\n---\nGo.\n");
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(dir, BOT, "skills"))).mode & 0o777, 0o700);
    assert.deepEqual((await files.read(BOT)).map((skill) => skill.name), ["packing-list", "weather"]);
    await files.write(BOT, [{ name: "weather", text: "replaced" }]);
    assert.equal(await readFile(file, "utf8"), "replaced", "written again, atomically");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("names that aren't skill names, ids that aren't a bot's and links in the way are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-bot-skills-"));
  try {
    const files = localBotSkills(dir);
    for (const name of ["../evil", "Weather", "a/b", "-x", ""]) await assert.rejects(files.write(BOT, [{ name, text: "x" }]), /Not a skill name/u, name);
    await assert.rejects(files.write("../other", [{ name: "x", text: "x" }]), /Not a bot id/u);
    const outside = join(dir, "outside");
    await mkdir(outside);
    await mkdir(join(dir, BOT), { recursive: true });
    await symlink(outside, join(dir, BOT, "skills"));
    await assert.rejects(files.write(BOT, [{ name: "x", text: "x" }]), /is not a folder/u);
    assert.deepEqual(await files.read(BOT), [], "a link is never read through either");
    await writeFile(join(outside, "keep"), "still here");
    assert.equal(await readFile(join(outside, "keep"), "utf8"), "still here");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the files beside a SKILL.md are written owner-only and read back as text; hidden files, caches, logs, links and binaries stay behind with the reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-bot-skills-"));
  try {
    const files = localBotSkills(dir);
    await files.write(BOT, [{ name: "review", text: "R", files: [{ path: "scripts/approve.sh", text: "#!/bin/sh\necho ok\n" }, { path: "notes.md", text: "N" }] }]);
    const script = join(dir, BOT, "skills", "review", "scripts", "approve.sh");
    assert.equal(await readFile(script, "utf8"), "#!/bin/sh\necho ok\n");
    assert.equal((await lstat(script)).mode & 0o777, 0o600, "a script arrives without permission to run");
    const folder = join(dir, BOT, "skills", "review");
    await writeFile(join(folder, ".env"), "TOKEN=x");
    await mkdir(join(folder, "node_modules"));
    await writeFile(join(folder, "run.log"), "log");
    await writeFile(join(folder, "logo.png"), Buffer.from([0x89, 0x50, 0, 1]));
    await symlink(join(folder, "notes.md"), join(folder, "linked.md"));
    const [skill] = await files.read(BOT);
    assert.deepEqual(skill!.files, [{ path: "notes.md", text: "N" }, { path: "scripts/approve.sh", text: "#!/bin/sh\necho ok\n" }]);
    assert.deepEqual(skill!.skipped, [
      { path: ".env", reason: "a hidden file or folder" }, { path: "linked.md", reason: "a link" }, { path: "logo.png", reason: "not text" },
      { path: "node_modules", reason: "installed packages or a cache" }, { path: "run.log", reason: "a log" },
    ]);
    for (const path of ["../x", ".hidden/x", "SKILL.md", "/abs"]) await assert.rejects(files.write(BOT, [{ name: "review", text: "R", files: [{ path, text: "x" }] }]), /Not a file of a skill's folder/u, path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
