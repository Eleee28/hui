import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, type TestContext } from "vitest";
import {
  OPENVSCODE_SERVER_RELEASE, openvscodeArch, openvscodeAssetUrl, VscodeInstaller, type OpenvscodeRelease,
} from "./install.ts";

test("Node's architecture maps onto the release's Linux assets, and nothing else is offered", () => {
  assert.equal(openvscodeArch("linux", "x64"), "x64");
  assert.equal(openvscodeArch("linux", "arm64"), "arm64");
  assert.equal(openvscodeArch("linux", "arm"), "armhf");
  assert.equal(openvscodeArch("linux", "ia32"), undefined);
  assert.equal(openvscodeArch("darwin", "arm64"), undefined, "Gitpod publishes no macOS build");
  assert.equal(openvscodeArch("win32", "x64"), undefined);
  assert.equal(
    openvscodeAssetUrl("https://github.com/gitpod-io/openvscode-server/releases/download/", "1.109.5", "armhf"),
    "https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.109.5/openvscode-server-v1.109.5-linux-armhf.tar.gz",
  );
  for (const arch of ["x64", "arm64", "armhf"] as const) {
    const asset = OPENVSCODE_SERVER_RELEASE.assets[arch];
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u, `${arch} is pinned`);
    assert.ok(asset.size > 50_000_000, `${arch} has its real size`);
  }
});

/** A release archive shaped like Gitpod's: one top directory with bin/openvscode-server. */
async function archive(dir: string, version: string, arch: string, script = "#!/bin/sh\necho 'OpenVSCode Server 9.9.9'\n"): Promise<Buffer> {
  const root = join(dir, "src");
  const name = `openvscode-server-v${version}-linux-${arch}`;
  await mkdir(join(root, name, "bin"), { recursive: true });
  await writeFile(join(root, name, "bin", "openvscode-server"), script);
  await chmod(join(root, name, "bin", "openvscode-server"), 0o755);
  await writeFile(join(root, name, "LICENSE.txt"), "MIT");
  const file = join(dir, "asset.tar.gz");
  await promisify(execFile)("tar", ["-czf", file, "-C", root, name]);
  return readFile(file);
}

function releaseOf(body: Buffer, version = "9.9.9"): OpenvscodeRelease {
  const pin = { size: body.length, sha256: createHash("sha256").update(body).digest("hex") };
  return { version, assets: { x64: pin, arm64: pin, armhf: pin } };
}

type Release = { origin: string; requests: string[]; server: Server };

/** A local release host: redirects the asset path to another path, like GitHub, then serves `serve`'s answer. */
async function releaseServer(t: TestContext, serve: (request: IncomingMessage, response: ServerResponse) => void): Promise<Release> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if ((request.url ?? "").includes("/openvscode-server-v")) {
      response.writeHead(302, { location: "/assets/blob" }).end();
      return;
    }
    serve(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { origin: `http://127.0.0.1:${address.port}`, requests, server };
}

async function leftovers(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter((name) => name.startsWith(".")); } catch { return []; }
}

const accept = async () => undefined;

test("an install downloads through a redirect, checks the pinned SHA-256, unpacks and lands atomically", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-install-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const body = await archive(dir, "9.9.9", "arm64");
  const release = await releaseServer(t, (_request, response) => { response.writeHead(200, { "content-length": body.length }).end(body); });
  const verified: string[] = [];
  const phases: string[] = [];
  const root = join(dir, "installs");
  const installer: VscodeInstaller = new VscodeInstaller({
    dir: root, platform: "linux", arch: "arm64", release: releaseOf(body), downloads: release.origin, env: {},
    verify: async (executable) => { verified.push(executable); assert.equal(existsSync(join(root, "openvscode-server-v9.9.9-linux-arm64")), false, "nothing is in place before it is checked"); },
    onChange: () => { const task = installer.progress; if (task) phases.push(task.phase); },
  });

  const before = await installer.status();
  assert.deepEqual([before.supported, before.arch, before.size, before.installed, before.task], [true, "arm64", body.length, null, null]);
  await installer.install();
  assert.deepEqual(release.requests, ["/openvscode-server-v9.9.9/openvscode-server-v9.9.9-linux-arm64.tar.gz", "/assets/blob"]);
  assert.equal(verified.length, 1);
  assert.match(verified[0] ?? "", /\/\.staging-[0-9a-f]+\/openvscode-server-v9\.9\.9-linux-arm64\/bin\/openvscode-server$/u, "it is checked in staging");
  const after = await installer.status();
  assert.deepEqual(after.installed, { version: "9.9.9", path: join(root, "openvscode-server-v9.9.9-linux-arm64", "bin", "openvscode-server") });
  assert.deepEqual([after.task, after.error], [null, ""]);
  assert.deepEqual(await leftovers(root), [], "the archive and the staging directory are gone");
  assert.ok(phases.includes("verifying") && phases.includes("extracting"));

  await installer.uninstall();
  assert.equal((await installer.status()).installed, null);
  assert.deepEqual(await readdir(root), []);
});

test("a download that does not match its pinned checksum or size installs nothing and leaves nothing", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-install-bad-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const body = await archive(dir, "9.9.9", "x64");
  const tampered = Buffer.from(body);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
  let answer: Buffer = tampered;
  const release = await releaseServer(t, (_request, response) => { response.writeHead(200).end(answer); });
  const root = join(dir, "installs");
  const installer = new VscodeInstaller({ dir: root, platform: "linux", arch: "x64", release: releaseOf(body), downloads: release.origin, env: {}, verify: accept });

  await assert.rejects(installer.install(), /did not match the pinned SHA-256 of openvscode-server 9\.9\.9 \(x64\); nothing was installed/u);
  let status = await installer.status();
  assert.deepEqual([status.installed, status.task], [null, null]);
  assert.match(status.error, /pinned SHA-256/u, "the failure stays visible");
  assert.deepEqual(await readdir(root), []);

  answer = Buffer.concat([body, Buffer.from("more")]);
  await assert.rejects(installer.install(), /larger than the pinned release/u);
  answer = body.subarray(0, 100);
  await assert.rejects(installer.install(), /ended after 100 of \d+ bytes/u);
  status = await installer.status();
  assert.equal(status.installed, null);
  assert.deepEqual(await readdir(root), []);
});

test("a download cut off midway is cleaned up", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-install-cut-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const body = await archive(dir, "9.9.9", "x64");
  const release = await releaseServer(t, (_request, response) => {
    response.writeHead(200, { "content-length": body.length });
    response.write(body.subarray(0, Math.floor(body.length / 2)), () => response.socket?.destroy());
  });
  const root = join(dir, "installs");
  const installer = new VscodeInstaller({ dir: root, platform: "linux", arch: "x64", release: releaseOf(body), downloads: release.origin, env: {}, verify: accept });
  await assert.rejects(installer.install(), /interrupted|ended after/u);
  assert.deepEqual(await readdir(root), [], "the partial archive is removed");
});

test("a server that does not run on this machine is not installed, and the reason names it", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-install-verify-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const body = await archive(dir, "9.9.9", "x64");
  const release = await releaseServer(t, (_request, response) => { response.writeHead(200).end(body); });
  const root = join(dir, "installs");
  const installer = new VscodeInstaller({
    dir: root, platform: "linux", arch: "x64", release: releaseOf(body), downloads: release.origin, env: {}, nixos: true,
    verify: async () => { throw new Error("Could not start dynamically linked executable"); },
  });
  assert.match((await installer.status()).hint, /nix-ld/u);
  await assert.rejects(installer.install(), /does not run on this machine: Could not start dynamically linked executable On NixOS, enable nix-ld/u);
  assert.equal((await installer.status()).installed, null);
  assert.deepEqual(await readdir(root), []);
});

test("cancel stops a running download and removes it; a second install joins the first", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-install-cancel-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const body = await archive(dir, "9.9.9", "x64");
  const release = await releaseServer(t, (_request, response) => {
    response.writeHead(200, { "content-length": body.length });
    response.write(body.subarray(0, 10)); // and then nothing: the download waits
  });
  const root = join(dir, "installs");
  const installer = new VscodeInstaller({ dir: root, platform: "linux", arch: "x64", release: releaseOf(body), downloads: release.origin, env: {}, verify: accept });
  const first = installer.install();
  assert.equal(installer.install(), first, "one install at a time");
  for (let i = 0; i < 200 && ((await installer.status()).task?.received ?? 0) < 10; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await installer.status()).task?.received, 10, "progress is reported");
  await installer.cancel();
  await assert.rejects(first, /cancelled/u);
  const status = await installer.status();
  assert.deepEqual([status.task, status.error, status.installed], [null, "", null], "a cancel is no error");
  assert.deepEqual(await readdir(root), []);
});

test("the download goes through the gateway's HTTP proxy", { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-vscode-install-proxy-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const body = await archive(dir, "9.9.9", "x64");
  // A proxy that answers for a host that does not exist: only a proxied request can reach it.
  const proxy = await releaseServer(t, (_request, response) => { response.writeHead(200).end(body); });
  const root = join(dir, "installs");
  const installer = new VscodeInstaller({
    dir: root, platform: "linux", arch: "x64", release: releaseOf(body), downloads: "http://releases.hui.invalid/download", verify: accept,
    env: { HTTP_PROXY: proxy.origin, NO_PROXY: "" },
  });
  await installer.install();
  assert.equal(proxy.requests[0], "http://releases.hui.invalid/download/openvscode-server-v9.9.9/openvscode-server-v9.9.9-linux-x64.tar.gz");
  assert.ok((await installer.status()).installed);
});

test("other systems are told why HUI installs nothing", async () => {
  const mac = new VscodeInstaller({ dir: "/nowhere", platform: "darwin", arch: "arm64", verify: accept });
  const status = await mac.status();
  assert.deepEqual([status.supported, status.arch, status.size, status.installed], [false, "", 0, null]);
  assert.match(status.reason, /only on Linux/u);
  await assert.rejects(mac.install(), /only on Linux/u);
  assert.match((await new VscodeInstaller({ dir: "/nowhere", platform: "linux", arch: "ppc64", verify: accept }).status()).reason, /no Linux build for this processor \(ppc64\)/u);
});
