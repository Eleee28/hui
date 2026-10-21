import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { updateDirectory } from "./installation.ts";
import { atomicJson } from "./state.ts";
import { readUpdateJob, updateJobFile } from "./update-job.ts";

test("restart receipts distinguish completed updates from dead workers and invalid state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hui-update-receipt-"));
  const previous = process.env["XDG_DATA_HOME"];
  process.env["XDG_DATA_HOME"] = directory;
  t.onTestFinished(async () => {
    if (previous === undefined) delete process.env["XDG_DATA_HOME"]; else process.env["XDG_DATA_HOME"] = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const root = join(directory, "node_modules/hui");
  assert.equal(await readUpdateJob(root), null);
  await mkdir(updateDirectory(root), { recursive: true });
  const worker = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(worker, "exit");
  const receipt = { id: "fixture", pid: worker.pid, version: "0.2.0", status: "running", message: "Installing" };
  await atomicJson(updateJobFile(root), receipt);
  assert.equal((await readUpdateJob(root))?.status, "failed");
  await atomicJson(updateJobFile(root), { ...receipt, status: "succeeded" });
  assert.equal((await readUpdateJob(root))?.status, "succeeded");
  await atomicJson(updateJobFile(root), { ...receipt, pid: -1 });
  await assert.rejects(readUpdateJob(root), /Invalid update receipt/u);
});
