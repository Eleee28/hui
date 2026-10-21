import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { checkNightly, checkRelease, downloadRelease, githubReadWith, githubToken, newerVersion, nightlyRelease, parseNightly, parseRelease, type GithubRead } from "./releases.ts";

const bytes = Buffer.from("synthetic archive");
const checksum = Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}  hui-0.2.0.tgz\n`);
const metadata = () => ({ tag_name: "v0.2.0", draft: false, prerelease: false,
  assets: [{ id: 1, name: "hui-0.2.0.tgz", size: bytes.length }, { id: 2, name: "hui-0.2.0.tgz.sha256", size: checksum.length }] });

test("only a stable tag with unique bounded archive/checksum asset IDs is installable", () => {
  assert.equal(parseRelease(metadata()).url, "https://github.com/DaniFdz/hui/releases/tag/v0.2.0");
  for (const invalid of [null, {}, { ...metadata(), tag_name: "v0.2.0-rc.1" }, { ...metadata(), draft: true },
    { ...metadata(), prerelease: true }, { ...metadata(), assets: [] }, { ...metadata(), assets: [...metadata().assets, metadata().assets[0]] },
    { ...metadata(), assets: [{ id: -1, name: "hui-0.2.0.tgz", size: bytes.length }, metadata().assets[1]] },
    { ...metadata(), assets: [{ id: 1, name: "hui-0.2.0.tgz", size: 101 * 1024 * 1024 }, metadata().assets[1]] }]) {
    assert.throws(() => parseRelease(invalid));
  }
});

const nightlyVersion = "0.2.1-nightly.20261004131149.gb0f30d5";
const nightly = () => ({ tag_name: "nightly", draft: false, prerelease: true, assets: [
  { id: 7, name: `hui-${nightlyVersion}.tgz`, size: bytes.length }, { id: 8, name: `hui-${nightlyVersion}.tgz.sha256`, size: checksum.length }] });

test("the nightly prerelease names its version through its single nightly archive", () => {
  const release = parseNightly(nightly());
  assert.equal(release.version, nightlyVersion);
  assert.equal(release.tag, "nightly");
  assert.equal(release.url, "https://github.com/DaniFdz/hui/releases/tag/nightly");
  assert.deepEqual([release.archive.id, release.checksum.id], [7, 8]);
  const archive = (name: string) => ({ id: 9, name, size: bytes.length });
  for (const invalid of [null, metadata(), { ...nightly(), prerelease: false }, { ...nightly(), draft: true }, { ...nightly(), tag_name: "v0.2.1" },
    { ...nightly(), assets: [nightly().assets[0]] },
    { ...nightly(), assets: [...nightly().assets, archive("hui-0.2.1-nightly.20261005000000.gabcdef0.tgz")] },
    { ...nightly(), assets: [archive("hui-0.2.1.tgz"), { id: 10, name: "hui-0.2.1.tgz.sha256", size: checksum.length }] },
    { ...nightly(), assets: [archive("hui-0.2.1-nightly.2026.gb0f30d5.tgz"), { id: 10, name: "hui-0.2.1-nightly.2026.gb0f30d5.tgz.sha256", size: checksum.length }] }]) {
    assert.throws(() => parseNightly(invalid));
  }
});

test("nightly resolution reads the rolling tag and reports a missing nightly as unpublished", async (t) => {
  const requested: string[] = [];
  const release = await nightlyRelease(async (path) => { requested.push(path); return Buffer.from(JSON.stringify(nightly())); });
  assert.equal(release.version, nightlyVersion);
  assert.deepEqual(requested, ["repos/DaniFdz/hui/releases/tags/nightly"]);
  await assert.rejects(nightlyRelease(async () => { throw new Error("No stable HUI release is published yet."); }), /No HUI nightly is published/u);

  const root = await mkdtemp(join(tmpdir(), "hui-nightly-check-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules/hui");
  const install = async (version: string) => {
    for (const [file, value] of Object.entries({ "package.json": JSON.stringify({ name: "hui", version }), "build/release.json": JSON.stringify({ format: 1, version }),
      "dist/index.html": "", "build/cli/main.js": "", "build/cli/gateway-run.js": "", "build/server/runtimes/pi-sdk-worker.js": "" })) {
      const path = join(installed, file);
      await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, value);
    }
  };
  const read: GithubRead = async () => Buffer.from(JSON.stringify(nightly()));
  const installation = { installationRoot: installed, packageRoot: installed };
  // Any different build is offered, even a stable one newer than the nightly.
  await install("0.3.0");
  assert.deepEqual([(await checkNightly(installation, read)).status, (await checkNightly(installation, read)).canInstall], ["available", true]);
  await install(nightlyVersion);
  const current = await checkNightly(installation, read);
  assert.equal(current.status, "current"); assert.equal(current.canInstall, false);
  // On a nightly, the stable channel waits for a stable release past it.
  assert.equal((await checkRelease(installation, async () => Buffer.from(JSON.stringify(metadata())))).status, "current");
  const missing = await checkNightly(installation, async () => { throw new Error("No stable HUI release is published yet."); });
  assert.equal(missing.status, "unpublished"); assert.equal(missing.canInstall, false);
});

test("version ordering is numeric and never downgrades a newer installation", () => {
  assert(newerVersion("0.10.0", "0.9.0"));
  assert(newerVersion("1.0.0", "1.0.0-rc.1"));
  assert(!newerVersion("0.9.0", "0.10.0"));
  assert(!newerVersion("1.0.0", "1.0.0"));
});

test("public release reads need no gh login and enforce response bounds", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const read = (response: Response) => githubReadWith(async (input, init) => {
    calls.push({ url: String(input), init });
    return response;
  }, "repos/DaniFdz/hui/releases/latest", 32);
  assert.deepEqual(await read(new Response("release")), Buffer.from("release"));
  assert.equal(calls[0]?.url, "https://api.github.com/repos/DaniFdz/hui/releases/latest");
  assert.equal(new Headers(calls[0]?.init?.headers).get("user-agent"), "HUI updater");
  await assert.rejects(read(new Response("missing", { status: 404 })), /No stable HUI release is published/u);
  await assert.rejects(read(new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } })), /anonymous API rate limit.*GITHUB_TOKEN.*gh auth login/u);
  await assert.rejects(read(new Response("limited", { status: 403 })), /anonymous API rate limit/u);
  await assert.rejects(read(new Response("limited", { status: 429 })), /anonymous API rate limit/u);
  await assert.rejects(read(new Response("x".repeat(33))), /allowed size/u);
  assert(calls.every(({ init }) => !new Headers(init?.headers).has("authorization")));
});

test("a token authenticates API reads but never follows a download redirect off api.github.com", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const read = (responses: Response[], binary = false) => githubReadWith(async (input, init) => {
    calls.push({ url: String(input), init });
    return responses.shift()!;
  }, "repos/DaniFdz/hui/releases/assets/1", 32, binary, "secret-token");
  assert.deepEqual(await read([new Response("release")]), Buffer.from("release"));
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer secret-token");
  assert.equal(calls[0]?.init?.redirect, "manual");

  calls.length = 0;
  const storage = "https://release-assets.githubusercontent.com/archive?sig=1";
  assert.deepEqual(await read([new Response(null, { status: 302, headers: { location: storage } }), new Response("archive")], true), Buffer.from("archive"));
  assert.deepEqual(calls.map(({ url }) => url), ["https://api.github.com/repos/DaniFdz/hui/releases/assets/1", storage]);
  assert.equal(new Headers(calls[1]?.init?.headers).get("authorization"), null);
  assert.equal(new Headers(calls[1]?.init?.headers).get("accept"), "application/octet-stream");
  await assert.rejects(read([new Response(null, { status: 302, headers: { location: "http://example.test/archive" } })], true), /HTTP 302/u);
  await assert.rejects(read([new Response(null, { status: 302 })], true), /HTTP 302/u);

  // An authenticated 403 is a token problem unless GitHub says the quota is spent.
  await assert.rejects(read([new Response("forbidden", { status: 403 })]), /failed with HTTP 403/u);
  await assert.rejects(read([new Response("limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } })]), /rate limit for your GitHub account/u);
});

test("the release token comes from GITHUB_TOKEN, GH_TOKEN, then the gh login, else stays anonymous", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hui-release-token-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const gh = join(root, "gh");
  await writeFile(gh, "#!/bin/sh\n[ \"$*\" = 'auth token --hostname github.com' ] && [ \"$GH_PROMPT_DISABLED\" = 1 ] && echo ' gh-token ' && exit 0\nexit 1\n");
  await chmod(gh, 0o755);
  const failing = join(root, "gh-signed-out");
  await writeFile(failing, "#!/bin/sh\necho 'not logged in' >&2\nexit 4\n");
  await chmod(failing, 0o755);
  assert.equal(await githubToken({ GITHUB_TOKEN: " env-token ", GH_TOKEN: "other" }, gh), "env-token");
  assert.equal(await githubToken({ GITHUB_TOKEN: " ", GH_TOKEN: "gh-env-token" }, gh), "gh-env-token");
  assert.equal(await githubToken({}, gh), "gh-token");
  assert.equal(await githubToken({}, failing), "");
  assert.equal(await githubToken({}, join(root, "missing-gh")), "");
});

test("download verifies asset identity, exact length and digest before writing an archive", async () => {
  const requested: string[] = [];
  const read: GithubRead = async (path) => { requested.push(path); return path.endsWith("/2") ? checksum : bytes; };
  const download = await downloadRelease(parseRelease(metadata()), read);
  try { assert.deepEqual(await readFile(download.path), bytes); }
  finally { await download.dispose(); }
  assert.deepEqual(requested, ["repos/DaniFdz/hui/releases/assets/2", "repos/DaniFdz/hui/releases/assets/1"]);
  await assert.rejects(downloadRelease(parseRelease(metadata()), async (path) => path.endsWith("/2") ? checksum : Buffer.from("corrupted archive")), /SHA-256 or size/u);
  await assert.rejects(downloadRelease(parseRelease(metadata()), async () => Buffer.from(checksum.toString().replace("hui-0.2.0.tgz", "hui-0.3.0.tgz"))), /checksum file/u);
});

test("checks distinguish availability, unpublished releases and source-managed installations without writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hui-release-check-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const installed = join(root, "node_modules/hui");
  for (const [file, value] of Object.entries({ "package.json": JSON.stringify({ name: "hui", version: "0.1.0" }), "build/release.json": JSON.stringify({ format: 1, version: "0.1.0" }),
    "dist/index.html": "", "build/cli/main.js": "", "build/cli/gateway-run.js": "", "build/server/runtimes/pi-sdk-worker.js": "" })) {
    const path = join(installed, file);
    await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, value);
  }
  const read: GithubRead = async () => Buffer.from(JSON.stringify(metadata()));
  const result = await checkRelease({ installationRoot: installed, packageRoot: installed }, read);
  assert.equal(result.status, "available"); assert.equal(result.canInstall, true);
  const source = await checkRelease({ installationRoot: root, packageRoot: installed }, read);
  assert.equal(source.canInstall, false); assert.match(source.message, /source checkout/u);
  const unpublished = await checkRelease({ installationRoot: installed, packageRoot: installed }, async () => { throw new Error("No stable HUI release is published yet."); });
  assert.equal(unpublished.status, "unpublished"); assert.equal(unpublished.canInstall, false);
});
