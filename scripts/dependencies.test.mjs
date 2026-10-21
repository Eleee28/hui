/**
 * Keeps an installed archive on the PI release HUI was tested with. npm installs the archive (`npm install -g`,
 * `hui update`) from package.json's ranges alone and ignores the lockfile the build ships, and PI
 * publishes its packages in lockstep, where a minor release can drop an export the previous ones import.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const json = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));

test("package.json pins every PI package the lockfile installs, at its locked version", async () => {
  const { dependencies } = await json("package.json");
  const { packages } = await json("package-lock.json");
  const unpinned = Object.entries(packages)
    .map(([path, { version, dev }]) => ({ name: /node_modules\/(@earendil-works\/[^/]+)$/u.exec(path)?.[1], version, dev }))
    .filter(({ name, version, dev }) => name && !dev && dependencies[name] !== version)
    .map(({ name, version }) => `${name}@${version}`);
  assert.deepEqual(unpinned, [], "add these to package.json dependencies at exactly these versions");
});
