/**
 * Self-update for an installed gateway: a release check cached once per gateway and shared by every tab, and
 * starting an update, which hands off to a detached update worker once no session holds blocking work. The
 * development server has no installation and reports updates as unavailable.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { packageVersion, type Installation } from "../cli/installation.ts";
import { checkRelease } from "../cli/releases.ts";
import { LOG_FILE } from "../cli/state.ts";
import { readUpdateJob } from "../cli/update-job.ts";
import { liveSessions } from "./sessions/live-sessions.ts";
import { UPDATE_CHECK_INTERVAL_MS, type UpdateCheck, type UpdateSnapshot } from "../cli/releases.ts";

export class UpdateConflict extends Error {}

export function createUpdates(installation?: Installation, dependencies: {
  checkRelease?: typeof checkRelease; now?: () => number;
} = {}) {
  const resolveRelease = dependencies.checkRelease ?? checkRelease;
  const now = dependencies.now ?? Date.now;
  let check: UpdateCheck | null = null;
  let checkedAt = -Infinity;
  let checking: Promise<UpdateCheck> | undefined;
  let starting = false;
  const status = async (): Promise<UpdateSnapshot> => ({
    currentVersion: installation ? await packageVersion(installation.packageRoot) : null,
    check, job: installation ? await readUpdateJob(installation.installationRoot) : null,
  });
  return {
    status,
    async check(background = false): Promise<UpdateSnapshot> {
      // One cache per gateway, including unavailable results, across all tabs.
      // Explicit checks bypass freshness but still share any in-flight lookup.
      if (background) {
        const snapshot = await status();
        if (starting || snapshot.job?.status === "running" || check && now() - checkedAt < UPDATE_CHECK_INTERVAL_MS) return snapshot;
      }
      if (!installation) {
        check = { currentVersion: null, latest: null, status: "unavailable", canInstall: false,
          message: "This is the development server. Update the source checkout through Git; installed HUI packages can update from GitHub Releases." };
      } else {
        checking ??= resolveRelease(installation).finally(() => { checking = undefined; });
        check = await checking;
      }
      checkedAt = now();
      return status();
    },
    async start(version: string): Promise<UpdateSnapshot> {
      if (starting) throw new UpdateConflict("Another update is starting. Wait for it to finish.");
      starting = true;
      try {
        if (!installation || !check?.canInstall || check.latest?.version !== version) throw new UpdateConflict("Check for an installable release before updating.");
        if ((await readUpdateJob(installation.installationRoot))?.status === "running") throw new UpdateConflict("An update is already running.");
        if (liveSessions.blockingWorkCount) throw new UpdateConflict("Finish active sessions before updating HUI.");
        const log = await open(LOG_FILE, "a", 0o600);
        const child = spawn(process.execPath, [join(installation.packageRoot, "build/cli/update-worker.js"), JSON.stringify(installation), randomUUID(), version], {
          cwd: installation.packageRoot, detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"],
        });
        await log.close();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error("The updater did not start. Check the gateway log.")); }, 10_000);
          const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
          child.once("error", () => done(new Error("Could not start the updater. Check the gateway log.")));
          child.once("exit", () => done(new Error("The updater exited before starting. Check the gateway log.")));
          child.once("message", (value: unknown) => {
            const message = value as { ready?: boolean; error?: string };
            done(message.ready ? undefined : new UpdateConflict(message.error ?? "Update could not start."));
          });
        });
        child.unref();
        return status();
      } finally { starting = false; }
    },
  };
}

export let updates = createUpdates();
export function configureUpdates(installation: Installation) { updates = createUpdates(installation); }
