/**
 * The worker release a gateway installs on a remote: the same HUI code this
 * gateway runs (source in a checkout, compiled output in a package), plus a
 * package.json limited to the packages the host and its runtimes import (PI's
 * SDK, Pi Durable and their peers) so the remote installs only those, at the
 * versions pinned by HUI's own lockfile. Its id changes with any file.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Everything the host, Pi Durable and the PI SDK worker import from npm
 * (release.test.ts traces the imports). */
const WORKER_DEPENDENCIES = ["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-codemode", "@earendil-works/pi-coding-agent", "@earendil-works/pi-durable", "typebox"];

export type WorkerRelease = {
  id: string;
  /** Release-relative path of the remote entry point. */
  entry: string;
  /** Local package root, which maps onto the remote release directory. */
  root: string;
  files: { path: string; mode: number; data: Buffer }[];
};

const SOURCE = import.meta.url.endsWith(".ts");
export const PACKAGE_ROOT = fileURLToPath(new URL(SOURCE ? "../../" : "../../../", import.meta.url));

async function collect(root: string, dir: string, out: WorkerRelease["files"]): Promise<void> {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") await collect(root, path, out);
    } else if (entry.isFile() && !/\.test\.[cm]?[jt]s$/u.test(entry.name)) {
      const absolute = join(root, path);
      out.push({ path, mode: (await stat(absolute)).mode & 0o777, data: await readFile(absolute) });
    }
  }
}

let cached: Promise<WorkerRelease> | undefined;

export function workerRelease(): Promise<WorkerRelease> {
  cached ??= (async () => {
    const root = PACKAGE_ROOT;
    const dirs = SOURCE ? ["server", "skills"] : ["build/server", "build/skills"];
    const files: WorkerRelease["files"] = [];
    for (const dir of dirs) if (existsSync(join(root, dir))) await collect(root, dir, files);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string; dependencies?: Record<string, string> };
    const dependencies = Object.fromEntries(WORKER_DEPENDENCIES.map((name) => [name, pkg.dependencies?.[name] ?? "*"]));
    files.push({ path: "package.json", mode: 0o644, data: Buffer.from(`${JSON.stringify({ name: "hui-worker", version: pkg.version ?? "0.0.0", private: true, type: "module", dependencies }, null, 2)}\n`) });
    // A package carries the lockfile it was built with in build/ (scripts/build.mjs).
    files.push({ path: "package-lock.json", mode: 0o644, data: await readFile(join(root, SOURCE ? "package-lock.json" : "build/package-lock.json")) });
    files.sort((a, b) => a.path.localeCompare(b.path));
    const hash = createHash("sha256");
    for (const file of files) hash.update(file.path).update("\0").update(file.data).update("\0");
    return { id: `${pkg.version ?? "0.0.0"}-${hash.digest("hex").slice(0, 12)}`, entry: SOURCE ? "server/worker/main.ts" : "build/server/worker/main.js", root, files };
  })();
  return cached;
}

/** gzip(JSON) as base64, unpacked on the remote by a Node one-liner. */
export function releaseBundle(release: WorkerRelease): string {
  return gzipSync(Buffer.from(JSON.stringify(release.files.map((file) => ({ path: file.path, mode: file.mode, data: file.data.toString("base64") }))))).toString("base64");
}

/** Maps a path inside this package onto the same path in a remote release. */
export function remoteReleasePath(release: WorkerRelease, releaseDir: string, local: string): string | undefined {
  const rel = relative(release.root, local);
  return rel.startsWith("..") ? undefined : `${releaseDir}/${rel.split("\\").join("/")}`;
}
