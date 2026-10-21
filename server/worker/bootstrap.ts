/**
 * Getting a remote ready through nothing but its connect command. Every step
 * runs `<command> sh -s` with a POSIX script on stdin, which works the same for
 * `ssh host`, `docker exec -i box` or `kubectl exec -i pod --`: no quoting
 * survives two shells, nothing is assumed about the remote login shell, and no
 * secret ever travels in argv.
 */
import { spawn } from "node:child_process";
import { releaseBundle, type WorkerRelease } from "./release.ts";
import { shellQuote } from "./workers.ts";

export type ConnectCommand = readonly string[];

export class BootstrapError extends Error {
  override name = "BootstrapError";
  readonly output: string;
  constructor(message: string, output = "") {
    super(message);
    this.output = output;
  }
}

const PRELUDE = `D="\${XDG_DATA_HOME:-$HOME/.local/share}/hui-worker"
hui_node() {
  for n in "$D/node/bin/node" "$(command -v node 2>/dev/null)" "$HOME/.local/bin/node" /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node $(ls -d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node 2>/dev/null | sort -r); do
    if [ -n "$n" ] && [ -x "$n" ] && [ -x "$(dirname "$n")/npm" ] && "$n" -e 'process.exit(parseInt(process.versions.node)>=24?0:1)' >/dev/null 2>&1; then
      echo "$n"; return 0
    fi
  done
  return 1
}
`;

export function probeScript(release: WorkerRelease): string {
  return `${PRELUDE}
N="$(hui_node || true)"
echo "HUI_NODE=$N"
echo "HUI_OS=$(uname -s) $(uname -m)"
if [ -f "$D/releases/${release.id}/.ready" ]; then echo "HUI_RELEASE=ready"; else echo "HUI_RELEASE=missing"; fi
echo "HUI_DIR=$D"
`;
}

/** Installs the gateway's own Node version into the HUI data directory. */
export function nodeInstallScript(version: string): string {
  return `set -e
${PRELUDE}
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "HUI_ERROR=Unsupported operating system $(uname -s)"; exit 1 ;; esac
# nodejs.org builds need glibc; Alpine and other musl systems bring their own.
if [ "$os" = linux ] && { ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; }; then
  echo "HUI_ERROR=This remote uses musl (Alpine Linux), where HUI cannot install Node.js. Install Node.js 24 or newer and npm there (for example apk add nodejs npm) and connect again"; exit 1
fi
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "HUI_ERROR=Unsupported CPU $(uname -m)"; exit 1 ;; esac
url="https://nodejs.org/dist/${version}/node-${version}-$os-$arch.tar.gz"
mkdir -p "$D"
tmp="$D/.node.$$"
rm -rf "$tmp"; mkdir -p "$tmp"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$tmp/node.tgz"
elif command -v wget >/dev/null 2>&1; then wget -q "$url" -O "$tmp/node.tgz"
else echo "HUI_ERROR=Install Node.js 24 or newer, or curl or wget so HUI can install it"; exit 1; fi
tar -xzf "$tmp/node.tgz" -C "$tmp" --strip-components=1
rm -f "$tmp/node.tgz"
rm -rf "$D/node"; mv "$tmp" "$D/node"
echo "HUI_NODE=$D/node/bin/node"
`;
}

const UNPACK = `const fs=require("fs"),path=require("path"),zlib=require("zlib");const root=path.resolve(process.argv[1]);for(const f of JSON.parse(zlib.gunzipSync(Buffer.from(fs.readFileSync(0,"utf8"),"base64")))){const p=path.resolve(root,f.path);if(!p.startsWith(root+path.sep))throw new Error("bad path");fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,Buffer.from(f.data,"base64"),{mode:f.mode});}`;

/** Unpacks the release and installs its npm dependencies, atomically. */
export function releaseInstallScript(release: WorkerRelease, node: string): string {
  const bundle = releaseBundle(release).replace(/.{1,76}/gu, "$&\n");
  return `set -e
${PRELUDE}
N=${shellQuote(node)}
R="$D/releases/${release.id}"
if [ -f "$R/.ready" ]; then echo "HUI_RELEASE=ready"; exit 0; fi
T="$D/releases/.${release.id}.$$"
rm -rf "$T"; mkdir -p "$T"
cat > "$T/.bundle" <<'__HUI_BUNDLE__'
${bundle}__HUI_BUNDLE__
"$N" -e ${shellQuote(UNPACK)} "$T" < "$T/.bundle"
rm -f "$T/.bundle"
cd "$T"
PATH="$(dirname "$N"):$PATH" "$(dirname "$N")/npm" install --omit=dev --no-audit --no-fund --loglevel=error >&2
touch .ready
cd "$D"
if [ -f "$R/.ready" ]; then rm -rf "$T"; else rm -rf "$R"; mv "$T" "$R"; fi
# Keep the three newest releases and the one the running host was started from.
cur="$(cat "$D/state/release" 2>/dev/null || true)"
ls -1dt "$D"/releases/*/ 2>/dev/null | tail -n +4 | while read -r old; do [ "$old" = "$D/releases/$cur/" ] || rm -rf "$old"; done
echo "HUI_RELEASE=ready"
`;
}

/** `exec` hands the rest of stdin to the bridge; the gateway sends nothing
 * until the bridge prints its ready line, so `sh` cannot read ahead into it. */
export function connectScript(release: WorkerRelease, node: string): string {
  return `${PRELUDE}exec ${shellQuote(node)} "$D/releases/${release.id}/${release.entry}" connect\n`;
}

export function markers(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^HUI_([A-Z]+)=(.*)$/u.exec(line.trim());
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

/** Runs one script to completion through the connect command. */
export function runScript(command: ConnectCommand, script: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!command.length) { reject(new BootstrapError("The worker has no connect command.")); return; }
    const child = spawn(command[0]!, [...command.slice(1), "sh", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new BootstrapError("The remote did not answer in time.", stderr)); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
    child.on("error", (error) => { clearTimeout(timer); reject(new BootstrapError(`Could not run ${command[0]}: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const error = markers(stdout)["ERROR"];
      if (error) reject(new BootstrapError(error, stderr));
      else if (code !== 0) reject(new BootstrapError(`${command[0]} exited with code ${code}.`, stderr));
      else resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(script);
  });
}
