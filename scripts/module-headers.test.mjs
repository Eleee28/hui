/**
 * Keeps the code map honest: every source module opens with a header comment saying what it owns, and every
 * directory holding source modules is named in docs/map.md by its full path. Whether a header is still true is a
 * review matter; this only catches a missing one.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["bin", "cli", "desktop", "scripts", "server", "src"];
/** A hash-pinned port of OpenClaw source (see its README): edited only by re-porting, never by hand. */
const PINNED = "src/components/openclaw/";
const SOURCE = /\.(?:ts|mjs|cjs|js)$/u;
const SKIPPED = /\.(?:test|d)\.(?:ts|mjs|cjs|js)$/u;

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...await sources(path));
    } else if (SOURCE.test(entry.name) && !SKIPPED.test(entry.name) && !path.startsWith(PINNED)) found.push(path);
  }
  return found;
}

const files = (await Promise.all(ROOTS.map(sources))).flat().sort();

test("every source module starts with a header comment", async () => {
  const missing = [];
  for (const file of files) {
    const lines = (await readFile(join(root, file), "utf8")).split("\n").filter((line) => line.trim() !== "");
    const first = lines[0]?.startsWith("#!") ? lines[1] : lines[0];
    if (!first?.startsWith("/*") && !first?.startsWith("//")) missing.push(file);
  }
  assert.deepEqual(missing, [], "add a header comment saying what the module owns (see docs/map.md)");
});

test("docs/map.md names every directory that holds source modules", async () => {
  const map = await readFile(join(root, "docs/map.md"), "utf8");
  const directories = [...new Set(files.map((file) => posix.dirname(file)))];
  const unnamed = directories.filter((directory) => !map.includes(`${directory}/`));
  assert.deepEqual(unnamed, [], "add the directory to docs/map.md");
});
