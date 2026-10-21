/** Synthetic GitHub fetch responses loaded into fixture Node processes.
 * Production code has no test URL override; all gateway/update/install behavior
 * remains the real package. */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export async function releaseFixture(root) {
  const bin = join(root, "github-bin");
  const file = join(root, "release-fixture.json");
  await mkdir(bin);
  await writeFile(file, JSON.stringify({ mode: "unpublished" }));
  const preload = join(bin, "release-fetch.mjs");
  await writeFile(preload, `
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const prefix = "https://api.github.com/";
  if (!url.startsWith(prefix)) return realFetch(input, init);
  const fixture = JSON.parse(readFileSync(process.env.HUI_RELEASE_FIXTURE, "utf8"));
  if (fixture.mode === "unpublished") return new Response("missing", { status: 404 });
  if (fixture.mode === "denied") return new Response("fixture token must not be returned", { status: 401 });
  const archive = readFileSync(fixture.archive);
  const name = "hui-" + fixture.version + ".tgz";
  const checksum = (fixture.mode === "corrupt" ? "0".repeat(64) : createHash("sha256").update(archive).digest("hex")) + "  " + name + "\\n";
  const endpoint = url.slice(prefix.length);
  const assets = [{id:1,name,size:archive.length},{id:2,name:name+".sha256",size:Buffer.byteLength(checksum)}];
  // A nightly fixture publishes only the rolling prerelease, like a repository
  // whose stable releases are older than its nightly.
  const nightly = fixture.channel === "nightly";
  if (endpoint === "repos/DaniFdz/hui/releases/latest") return nightly ? new Response("missing", { status: 404 }) : Response.json({tag_name:"v" + fixture.version, draft:false, prerelease:false, assets});
  if (endpoint === "repos/DaniFdz/hui/releases/tags/nightly") return nightly ? Response.json({tag_name:"nightly", draft:false, prerelease:true, assets}) : new Response("missing", { status: 404 });
  if (endpoint === "repos/DaniFdz/hui/releases/assets/1") return new Response(archive);
  if (endpoint === "repos/DaniFdz/hui/releases/assets/2") return new Response(checksum);
  return new Response("unexpected fixture endpoint", { status: 500 });
};
`);
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" ");
  return { env: { HUI_RELEASE_FIXTURE: file, NODE_OPTIONS: nodeOptions }, file,
    set: (value) => writeFile(file, JSON.stringify(value)) };
}

export async function packCandidate(installed, root, version) {
  const directory = join(root, `remote-${version}`);
  await mkdir(directory);
  for (const file of ["bin", "build", "dist", "desktop"]) await cp(join(installed, file), join(directory, file), { recursive: true });
  const pkg = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ ...pkg, version }));
  await writeFile(join(directory, "build/release.json"), JSON.stringify({ format: 1, version }));
  const [packed] = JSON.parse((await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: directory })).stdout);
  return join(root, packed.filename);
}
