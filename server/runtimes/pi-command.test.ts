import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piCommand } from "./pi-command.ts";
import { PI_SDK_VERSION } from "./pi-backend.ts";

// The PI CLI this starts reads and locks PI's settings: never the operator's own.
const root = await mkdtemp(join(tmpdir(), "hui-pi-command-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
afterAll(() => rm(root, { recursive: true, force: true }));

test("PI CLI uses the packaged version without relying on PATH, with an explicit rollback override", async () => {
  const cli = piCommand(["--version"], "");
  assert.equal(cli.command, process.execPath);
  assert.equal((await promisify(execFile)(cli.command, cli.args)).stdout.trim(), PI_SDK_VERSION);
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.equal(manifest.dependencies["@earendil-works/pi-coding-agent"], PI_SDK_VERSION, "the reported SDK version must be the pinned one");
  assert.deepEqual(piCommand(["--version"], "/explicit/pi"), { command: "/explicit/pi", args: ["--version"] });
});
