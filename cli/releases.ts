/** Published HUI releases on GitHub: the latest stable release and the rolling nightly, update checks against the
 * running build, and downloads verified by size and checksum. It reads the public API through paths built here,
 * authenticated with the operator's GitHub token when one is available, and never installs anything; staging and
 * activation belong to update.ts. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertUpdatable, packageVersion, type Installation } from "./installation.ts";
import type { ReleaseInfo, UpdateCheck } from "../src/lib/update-types.ts";

export const RELEASE_REPOSITORY = "DaniFdz/hui";
/** Rolling prerelease the Nightly workflow replaces with each validated main commit. */
export const NIGHTLY_TAG = "nightly";
const NIGHTLY_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.[1-9]\d{13}\.g[0-9a-f]{7,40}$/u;
const repositoryPath = `repos/${RELEASE_REPOSITORY}`;
const MAX_ARCHIVE = 100 * 1024 * 1024;
type Asset = { id: number; name: string; size: number };
export type Release = ReleaseInfo & { archive: Asset; checksum: Asset };
export type GithubRead = (path: string, maxBytes: number, binary?: boolean) => Promise<Buffer>;

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("GitHub release response exceeded the allowed size.");
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("GitHub release response exceeded the allowed size.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** The operator's GitHub token, first non-empty of GITHUB_TOKEN, GH_TOKEN and
 * `gh auth token`; "" when none is available, so reads stay anonymous. The
 * releases are public: a token only lifts the anonymous 60-an-hour limit,
 * which a shared or VPN network exhausts easily. */
export function githubToken(env: NodeJS.ProcessEnv = process.env, command = "gh"): Promise<string> {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const token = env[name]?.trim();
    if (token) return Promise.resolve(token);
  }
  return new Promise((resolve) => {
    execFile(command, ["auth", "token", "--hostname", "github.com"], {
      env: { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" }, timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8",
    }, (error, stdout) => resolve(error ? "" : stdout.trim()));
  });
}

/** Paths and asset IDs are generated here, never followed from release-provided
 * URLs. A token goes to api.github.com only: an authenticated asset download's
 * redirect to GitHub's storage host is followed by hand, without it. */
export async function githubReadWith(fetchImpl: typeof fetch, path: string, maxBytes: number, binary = false, token = ""): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), binary ? 120_000 : 20_000);
  try {
    const headers: Record<string, string> = {
      Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
      "User-Agent": "HUI updater",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const url = `https://api.github.com/${path}`;
    let response = await fetchImpl(url, {
      headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
      redirect: token ? "manual" : "follow",
      signal: controller.signal,
    });
    if (token && response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const next = location ? new URL(location, url) : undefined;
      if (next?.protocol !== "https:") throw new Error(`GitHub release access failed with HTTP ${response.status}.`);
      response = await fetchImpl(next, { headers, redirect: "follow", signal: controller.signal });
    }
    if (response.status === 404) throw new Error("No stable HUI release is published yet.");
    // Anonymous reads of a public repository are only refused for the rate limit.
    if (response.status === 429 || response.status === 403 && (!token || response.headers.get("x-ratelimit-remaining") === "0")) {
      throw new Error(token
        ? "GitHub's API rate limit for your GitHub account is exhausted. Retry after the rate-limit reset."
        : "GitHub's anonymous API rate limit (60 requests an hour per network) is exhausted. Set GITHUB_TOKEN or sign in with the GitHub CLI (gh auth login) to authenticate, or retry after the rate-limit reset.");
    }
    if (!response.ok) throw new Error(`GitHub release access failed with HTTP ${response.status}.`);
    return await boundedBody(response, maxBytes);
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("No stable HUI release")
      || error.message.startsWith("GitHub release") || error.message.startsWith("GitHub's "))) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("GitHub release access timed out.");
    throw new Error("GitHub release access failed. Check the gateway host's internet connection and retry.");
  } finally {
    clearTimeout(timeout);
  }
}

export const githubRead: GithubRead = async (path, maxBytes, binary = false) => githubReadWith(fetch, path, maxBytes, binary, await githubToken());

type RawRelease = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;

export function parseRelease(value: unknown): Release {
  const raw = value as RawRelease;
  const version = typeof raw?.tag_name === "string" ? /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u.exec(raw.tag_name)?.[1] : undefined;
  if (!version || raw?.draft !== false || raw.prerelease !== false || !Array.isArray(raw.assets)) throw new Error("GitHub did not return a stable HUI release.");
  const tag = `v${version}`;
  return releaseAssets(raw.assets as Array<Asset | null>, version, tag);
}

/** The `nightly` prerelease holds exactly one archive, named after the nightly
 * version it was stamped with, and its checksum. */
export function parseNightly(value: unknown): Release {
  const raw = value as RawRelease;
  if (raw?.tag_name !== NIGHTLY_TAG || raw.draft !== false || raw.prerelease !== true || !Array.isArray(raw.assets)) {
    throw new Error("GitHub did not return the HUI nightly prerelease.");
  }
  const assets = raw.assets as Array<Asset | null>;
  const archives = assets.flatMap((entry) => {
    const version = typeof entry?.name === "string" ? /^hui-(.+)\.tgz$/u.exec(entry.name)?.[1] : undefined;
    return version && NIGHTLY_VERSION.test(version) ? [version] : [];
  });
  if (archives.length !== 1) throw new Error("The nightly prerelease does not hold exactly one nightly archive.");
  return releaseAssets(assets, archives[0]!, NIGHTLY_TAG);
}

function releaseAssets(assets: Array<Asset | null>, version: string, tag: string): Release {
  const asset = (name: string, limit: number): Asset => {
    const matches = assets.filter((entry: Asset | null) => entry?.name === name);
    const entry = matches[0] as Asset | undefined;
    if (matches.length !== 1 || !entry || !Number.isSafeInteger(entry.id) || entry.id <= 0 || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > limit) {
      throw new Error(`Release is missing a valid ${name} asset.`);
    }
    return { id: entry.id, name, size: entry.size };
  };
  return { version, tag, url: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${tag}`,
    archive: asset(`hui-${version}.tgz`, MAX_ARCHIVE), checksum: asset(`hui-${version}.tgz.sha256`, 512) };
}

export function newerVersion(latest: string, current: string): boolean {
  const left = latest.split(".").map(BigInt);
  const right = current.split("-")[0]!.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return current.includes("-");
}

export async function latestRelease(read: GithubRead = githubRead): Promise<Release> {
  return parseRelease(JSON.parse((await read(`${repositoryPath}/releases/latest`, 1024 * 1024)).toString()));
}

export async function nightlyRelease(read: GithubRead = githubRead): Promise<Release> {
  let body: Buffer;
  try { body = await read(`${repositoryPath}/releases/tags/${NIGHTLY_TAG}`, 1024 * 1024); }
  catch (error) {
    // The reader's 404 wording is about stable releases.
    if ((error as Error).message.startsWith("No stable HUI release")) throw new Error("No HUI nightly is published right now. One is built for each main commit; retry shortly.");
    throw error;
  }
  return parseNightly(JSON.parse(body.toString()));
}

/** A nightly is offered whenever it differs from the running build: it is an
 * explicit opt-in to whatever `main` holds, not an ordered upgrade. */
export async function checkNightly(installation: Installation, read: GithubRead = githubRead): Promise<UpdateCheck> {
  const currentVersion = await packageVersion(installation.packageRoot);
  let restriction = "";
  try { await assertUpdatable(installation.installationRoot); }
  catch (error) { restriction = (error as Error).message; }
  try {
    const release = await nightlyRelease(read);
    const available = release.version !== currentVersion;
    return { currentVersion, latest: { version: release.version, tag: release.tag, url: release.url },
      status: available ? "available" : "current", canInstall: available && !restriction,
      message: restriction || (available ? "A HUI nightly built from main is ready to install." : "You are running the published HUI nightly.") };
  } catch (error) {
    const message = (error as Error).message;
    return { currentVersion, latest: null, status: message.startsWith("No HUI nightly is published") ? "unpublished" : "unavailable",
      canInstall: false, message: [restriction, message].filter(Boolean).join(" ") };
  }
}

export async function checkRelease(installation: Installation, read: GithubRead = githubRead): Promise<UpdateCheck> {
  const currentVersion = await packageVersion(installation.packageRoot);
  let restriction = "";
  try { await assertUpdatable(installation.installationRoot); }
  catch (error) { restriction = (error as Error).message; }
  try {
    const release = await latestRelease(read);
    const available = newerVersion(release.version, currentVersion);
    return { currentVersion, latest: { version: release.version, tag: release.tag, url: release.url },
      status: available ? "available" : "current", canInstall: available && !restriction,
      message: restriction || (available ? "A new HUI release is ready to install." : "You are running the latest stable HUI release or a newer version.") };
  } catch (error) {
    const message = (error as Error).message;
    return { currentVersion, latest: null, status: message.startsWith("No stable HUI release is published") ? "unpublished" : "unavailable",
      canInstall: false, message: [restriction, message].filter(Boolean).join(" ") };
  }
}

/** Download both pinned assets, verify exact lengths and digest before npm ever
 * sees the archive. The checksum detects corruption; it is not a signature. */
export async function downloadRelease(release: Release, read: GithubRead = githubRead): Promise<{ path: string; sha256: string; dispose(): Promise<void> }> {
  const checksum = await read(`${repositoryPath}/releases/assets/${release.checksum.id}`, 512, true);
  const match = /^([a-fA-F0-9]{64})[ \t]+\*?([^\s]+)\s*$/u.exec(checksum.toString());
  if (checksum.length !== release.checksum.size || !match || match[2] !== release.archive.name) throw new Error("Release checksum file is invalid.");
  const archive = await read(`${repositoryPath}/releases/assets/${release.archive.id}`, MAX_ARCHIVE, true);
  const sha256 = createHash("sha256").update(archive).digest("hex");
  if (archive.length !== release.archive.size || sha256 !== match[1]!.toLowerCase()) throw new Error("Release SHA-256 or size does not match. Nothing was installed.");
  const directory = await mkdtemp(join(tmpdir(), "hui-download-"));
  const path = join(directory, release.archive.name);
  try { await writeFile(path, archive, { mode: 0o600, flag: "wx" }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, sha256, dispose: () => rm(directory, { recursive: true, force: true }) };
}
