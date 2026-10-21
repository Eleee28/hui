import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { workerRelease } from "./release.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\.meta\.resolve\(\s*|^import\s+)["']([^"']+)["']/gmu;

/** npm packages reachable from `roots` through static and literal dynamic imports. */
async function packagesImportedFrom(roots: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [...roots];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = (await readFile(file, "utf8")).replace(/^\s*(?:\/\/|\*).*$/gmu, "");
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (specifier!.startsWith(".")) queue.push(resolve(dirname(file), specifier!));
      else if (!specifier!.startsWith("node:")) packages.add(specifier!.split("/").slice(0, specifier!.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return packages;
}

test("the worker release installs every package the host and its runtimes import", async () => {
  const runtimes = join(repo, "server", "runtimes");
  // Child processes and PI extensions the host starts live beside the adapters.
  const children = (await readdir(runtimes)).filter((name) => /\.m?[jt]s$/u.test(name) && !name.includes(".test.")).map((name) => join(runtimes, name));
  const imported = await packagesImportedFrom([join(repo, "server", "worker", "main.ts"), join(repo, "server", "worker", "host.ts"), ...children]);
  const release = await workerRelease();
  const pkg = JSON.parse(release.files.find((file) => file.path === "package.json")!.data.toString("utf8")) as { dependencies: Record<string, string> };
  const own = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [...imported].sort());
  // Pinned to HUI's own versions, which the shipped lockfile resolves.
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.equal(version, own.dependencies[name], name);
});
