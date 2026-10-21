/**
 * The openvscode-server HUI installs on Linux when the machine has no VS Code: Gitpod's MIT release, pinned to one
 * version and to the SHA-256 of each architecture's asset, downloaded through the gateway's outbound path (the
 * process's HTTP(S)_PROXY and NO_PROXY), verified, unpacked with the system `tar` into a staging directory, checked to
 * run, and only then renamed into place, so an install is either complete or absent. One install runs at a time,
 * with progress and cancel; removing deletes only what HUI installed. Detection and running are
 * vscode-providers.ts's and vscode.ts's job.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { Agent as HttpAgent, get as httpGet, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, get as httpsGet } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VscodeInstallPhase, VscodeInstallStatus } from "../api/vscode.ts";

export type OpenvscodeArch = "x64" | "arm64" | "armhf";
export type OpenvscodeRelease = { version: string; assets: Record<OpenvscodeArch, { size: number; sha256: string }> };

/**
 * The release HUI installs. Each SHA-256 was computed on 2026-10-09 by downloading the three linux assets of
 * github.com/gitpod-io/openvscode-server/releases/tag/openvscode-server-v1.109.5 and running `sha256sum` on them;
 * they equal the digests GitHub lists for the same assets. Bumping the version means repeating that for every asset.
 */
export const OPENVSCODE_SERVER_RELEASE: OpenvscodeRelease = {
  version: "1.109.5",
  assets: {
    x64: { size: 76_686_959, sha256: "b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363" },
    arm64: { size: 74_488_835, sha256: "36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc" },
    armhf: { size: 68_994_573, sha256: "f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb" },
  },
};

export const OPENVSCODE_SERVER_DOWNLOADS = "https://github.com/gitpod-io/openvscode-server/releases/download";

/** Node's `process.arch` as the release names it; undefined where Gitpod publishes no Linux build. */
export function openvscodeArch(platform: NodeJS.Platform, arch: string): OpenvscodeArch | undefined {
  if (platform !== "linux") return undefined;
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  if (arch === "arm") return "armhf";
  return undefined;
}

export function openvscodeDirectoryName(version: string, arch: OpenvscodeArch): string {
  return `openvscode-server-v${version}-linux-${arch}`;
}

/** `<base>/openvscode-server-v1.109.5/openvscode-server-v1.109.5-linux-x64.tar.gz`. */
export function openvscodeAssetUrl(base: string, version: string, arch: OpenvscodeArch): string {
  return `${base.replace(/\/+$/u, "")}/openvscode-server-v${version}/${openvscodeDirectoryName(version, arch)}.tar.gz`;
}

export class VscodeInstallError extends Error {}

export type VscodeInstallerOptions = {
  /** Where installs live; one directory per version and architecture below it. */
  dir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  release?: OpenvscodeRelease;
  /** Release download base; a mirror must serve the same files, since the checksums stay pinned. */
  downloads?: string;
  /** The environment whose proxy variables the download follows. */
  env?: NodeJS.ProcessEnv;
  /** Throws, with the reason, when the unpacked server cannot run on this machine. */
  verify: (executable: string) => Promise<void>;
  /** NixOS cannot run the generic Linux build without nix-ld. */
  nixos?: boolean;
  /** Called on every progress step, so a status poll is not the only way to learn of it. */
  onChange?: () => void;
};

const MAX_REDIRECTS = 5;

function readable(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}

export class VscodeInstaller {
  readonly dir: string;
  readonly platform: NodeJS.Platform;
  readonly release: OpenvscodeRelease;
  readonly arch: OpenvscodeArch | undefined;
  readonly #options: VscodeInstallerOptions;
  #task: { phase: VscodeInstallPhase; received: number; total: number; abort: AbortController; done: Promise<void> } | undefined;
  #error = "";

  constructor(options: VscodeInstallerOptions) {
    this.#options = options;
    this.dir = options.dir;
    this.platform = options.platform ?? process.platform;
    this.release = options.release ?? OPENVSCODE_SERVER_RELEASE;
    this.arch = openvscodeArch(this.platform, options.arch ?? process.arch);
  }

  get busy(): boolean { return Boolean(this.#task); }

  /** The running install's phase and bytes, read synchronously. */
  get progress(): VscodeInstallStatus["task"] {
    const task = this.#task;
    return task ? { phase: task.phase, received: task.received, total: task.total } : null;
  }

  #reason(): string {
    if (this.platform !== "linux") return "HUI installs a VS Code server only on Linux: openvscode-server publishes no build for this system.";
    if (!this.arch) return `openvscode-server publishes no Linux build for this processor (${this.#options.arch ?? process.arch}).`;
    return "";
  }

  /** The newest complete install of this architecture: the pinned version first, then any other one left behind. */
  async installed(): Promise<{ version: string; path: string } | null> {
    if (!this.arch) return null;
    let names: string[];
    try { names = await readdir(this.dir); } catch { return null; }
    const suffix = `-linux-${this.arch}`;
    const versions = names
      .filter((name) => name.startsWith("openvscode-server-v") && name.endsWith(suffix))
      .map((name) => name.slice("openvscode-server-v".length, -suffix.length))
      .sort((a, b) => (a === this.release.version ? -1 : b === this.release.version ? 1 : b.localeCompare(a, "en", { numeric: true })));
    for (const version of versions) {
      const path = join(this.dir, openvscodeDirectoryName(version, this.arch), "bin", "openvscode-server");
      try { if ((await stat(path)).isFile()) return { version, path }; } catch { /* incomplete */ }
    }
    return null;
  }

  async status(): Promise<VscodeInstallStatus> {
    const reason = this.#reason();
    const asset = this.arch ? this.release.assets[this.arch] : undefined;
    const task = this.#task;
    return {
      supported: !reason,
      reason,
      version: this.release.version,
      arch: this.arch ?? "",
      size: asset?.size ?? 0,
      dir: this.dir,
      installed: await this.installed(),
      task: task ? { phase: task.phase, received: task.received, total: task.total } : null,
      error: this.#error,
      hint: this.#options.nixos
        ? "On NixOS the downloaded build runs only with nix-ld; nixpkgs' openvscode-server on PATH needs nothing else."
        : "",
    };
  }

  /** Starts the install, or joins the one running; resolves when it finished, rejects with why it did not. */
  install(): Promise<void> {
    if (this.#task) return this.#task.done;
    const reason = this.#reason();
    if (reason || !this.arch) return Promise.reject(new VscodeInstallError(reason));
    const arch = this.arch;
    const asset = this.release.assets[arch];
    const abort = new AbortController();
    this.#error = "";
    const task = { phase: "downloading" as VscodeInstallPhase, received: 0, total: asset.size, abort, done: Promise.resolve() };
    this.#task = task;
    task.done = this.#run(arch, task).then(
      () => { this.#task = undefined; this.#options.onChange?.(); },
      (error: unknown) => {
        this.#task = undefined;
        this.#error = abort.signal.aborted ? "" : readable(error);
        this.#options.onChange?.();
        throw abort.signal.aborted ? new VscodeInstallError("The install was cancelled.") : error;
      },
    );
    task.done.catch(() => undefined);
    this.#options.onChange?.();
    return task.done;
  }

  /** Stops a running install; what it wrote so far is removed. */
  async cancel(): Promise<void> {
    const task = this.#task;
    if (!task) return;
    task.abort.abort();
    await task.done.catch(() => undefined);
  }

  /** Deletes every server HUI installed (and anything an interrupted install left). The caller stops it first. */
  async uninstall(): Promise<void> {
    await this.cancel();
    this.#error = "";
    let names: string[];
    try { names = await readdir(this.dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith("openvscode-server-v") || name.startsWith(".staging-") || name.startsWith(".download-") || name.startsWith(".old-")) {
        await rm(join(this.dir, name), { recursive: true, force: true });
      }
    }
  }

  async #run(arch: OpenvscodeArch, task: { phase: VscodeInstallPhase; received: number; total: number; abort: AbortController }) {
    const { version } = this.release;
    const asset = this.release.assets[arch];
    const signal = task.abort.signal;
    const id = randomBytes(6).toString("hex");
    const archive = join(this.dir, `.download-${id}.tar.gz`);
    const staging = join(this.dir, `.staging-${id}`);
    const name = openvscodeDirectoryName(version, arch);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const url = openvscodeAssetUrl(this.#options.downloads ?? OPENVSCODE_SERVER_DOWNLOADS, version, arch);
      const digest = await download(url, archive, {
        signal, env: this.#options.env ?? process.env, maxBytes: asset.size,
        onProgress: (received) => { task.received = received; },
      });
      task.phase = "verifying";
      this.#options.onChange?.();
      if (task.received !== asset.size) {
        throw new VscodeInstallError(`The download ended after ${task.received} of ${asset.size} bytes; nothing was installed.`);
      }
      if (digest !== asset.sha256) {
        throw new VscodeInstallError(`The download did not match the pinned SHA-256 of openvscode-server ${version} (${arch}); nothing was installed.`);
      }
      task.phase = "extracting";
      this.#options.onChange?.();
      await mkdir(staging, { mode: 0o700 });
      try {
        await promisify(execFile)("tar", ["-xzf", archive, "-C", staging, "--no-same-owner"], { signal, timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new VscodeInstallError(`The archive could not be unpacked with tar: ${readable(error)}`);
      }
      const executable = join(staging, name, "bin", "openvscode-server");
      if (!existsSync(executable)) throw new VscodeInstallError(`The archive holds no ${name}/bin/openvscode-server; nothing was installed.`);
      try { await this.#options.verify(executable); } catch (error) {
        throw new VscodeInstallError(`The downloaded openvscode-server does not run on this machine: ${readable(error)}${this.#options.nixos ? " On NixOS, enable nix-ld or install nixpkgs' openvscode-server." : ""}`);
      }
      if (signal.aborted) throw new VscodeInstallError("The install was cancelled.");
      const target = join(this.dir, name);
      if (existsSync(target)) await rename(target, join(this.dir, `.old-${id}`));
      await rename(join(staging, name), target);
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await rm(join(this.dir, `.old-${id}`), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Streams `url` into `file` and returns its SHA-256. Follows up to five redirects (GitHub serves releases from another
 * host), through the proxy the environment names for each URL, and refuses a body larger than expected.
 */
export async function download(url: string, file: string, options: {
  signal: AbortSignal; env: NodeJS.ProcessEnv; maxBytes: number; onProgress: (received: number) => void;
}): Promise<string> {
  const httpAgent = new HttpAgent({ proxyEnv: options.env } as ConstructorParameters<typeof HttpAgent>[0]);
  const httpsAgent = new HttpsAgent({ proxyEnv: options.env } as ConstructorParameters<typeof HttpsAgent>[0]);
  try {
    let current = new URL(url);
    for (let redirects = 0; ; redirects++) {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        if (current.protocol !== "https:" && current.protocol !== "http:") { reject(new VscodeInstallError(`Refusing to download from ${current.protocol}.`)); return; }
        const get = current.protocol === "https:" ? httpsGet : httpGet;
        const request = get(current, { agent: current.protocol === "https:" ? httpsAgent : httpAgent, signal: options.signal, timeout: 30_000 }, resolve);
        request.once("timeout", () => request.destroy(new Error("the server stopped answering")));
        request.once("error", reject);
      }).catch((error: unknown) => {
        if (options.signal.aborted) throw error;
        throw new VscodeInstallError(`Could not download openvscode-server from ${current.host}: ${readable(error)}. Check the internet connection, or the gateway's HTTPS_PROXY.`);
      });
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) throw new VscodeInstallError("The download redirected too many times.");
        current = new URL(response.headers.location, current);
        continue;
      }
      if (status !== 200) {
        response.resume();
        throw new VscodeInstallError(`The download from ${current.host} answered HTTP ${status}.`);
      }
      const hash = createHash("sha256");
      const out = createWriteStream(file, { mode: 0o600 });
      let received = 0;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
          response.destroy();
          out.destroy();
        };
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > options.maxBytes) { fail(new VscodeInstallError("The download is larger than the pinned release; nothing was installed.")); return; }
          hash.update(chunk);
          options.onProgress(received);
          if (!out.write(chunk)) { response.pause(); out.once("drain", () => response.resume()); }
        });
        response.once("end", () => out.end(() => { if (!settled) { settled = true; resolve(); } }));
        response.once("error", (error) => fail(options.signal.aborted ? error : new VscodeInstallError(`The download was interrupted: ${readable(error)}`)));
        response.once("aborted", () => fail(new VscodeInstallError("The download was interrupted.")));
        out.once("error", fail);
      });
      return hash.digest("hex");
    }
  } finally {
    httpAgent.destroy();
    httpsAgent.destroy();
  }
}
