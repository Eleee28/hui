/** Receipt for a browser-started update. Operational only, not session or PI state: the detached worker writes it and
 * it survives the gateway replacement, so the reconnecting browser can distinguish failure from success. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { updateDirectory } from "./installation.ts";
import { processAlive } from "./state.ts";
import type { UpdateJob } from "./releases.ts";

export const updateJobFile = (installationRoot: string) => join(updateDirectory(installationRoot), "job.json");

export async function readUpdateJob(installationRoot: string): Promise<UpdateJob | null> {
  let job: UpdateJob;
  try { job = JSON.parse(await readFile(updateJobFile(installationRoot), "utf8")) as UpdateJob; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!job || typeof job.id !== "string" || !Number.isSafeInteger(job.pid) || job.pid <= 0
    || !["running", "succeeded", "failed"].includes(job.status) || typeof job.version !== "string" || typeof job.message !== "string") {
    throw new Error("Invalid update receipt. Inspect the gateway log before retrying.");
  }
  if (job.status === "running" && !processAlive(job.pid)) return { ...job, status: "failed", message: "The updater exited before reporting completion. Check hui gateway status and logs before retrying." };
  return job;
}
