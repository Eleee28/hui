/**
 * Starting and stopping the gateway's backend: startup recovery (Durable sessions, interrupted runs, watchers,
 * subagents, triggers), the Durable store-failure hook, and the ordered shutdown that releases the store.
 */
import { workers } from "./workers.ts";
import { readHuiSettings } from "./hui-settings.ts";
import { liveSessions } from "./sessions/live-sessions.ts";
import { mirrorDiagnosticLogs, recordDiagnosticEvent } from "./observability.ts";
import { durableHost } from "./runtimes/durable-host.ts";
import { stopAgentToolBridge } from "./agent-tools/bridge.ts";
import { terminals } from "./terminals/terminals.ts";
import { ensureConfigDir } from "./themes.ts";
import { readRegistry, type SessionRecord } from "./sessions/sessions.ts";
import {
  automation,
  botRegistry,
  bots,
  datadogOrgs,
  githubCli,
  macPower,
  managedBrowser,
  questionnaires,
  secretFiles,
  secretRequests,
  subagents,
  triggers,
  vscode,
  watchers,
} from "./services.ts";

durableHost().storeFailed = async () => reattachAfterStoreFailure(await readRegistry());

function initializeSubagents(): void {
  void subagents.initialize().catch((error: unknown) => {
    recordDiagnosticEvent({
      area: "session",
      level: "error",
      action: "subagent_recovery_failed",
      summary: error instanceof Error ? error.message : "Could not recover subagent state.",
    });
  });
}

/** A corrupt watcher registry must not stop the gateway, and a watcher whose
 * conversation no longer exists is stopped and forgotten once. */
function initializeWatchers(): void {
  void watchers
    .initialize()
    .then(async () => watchers.prune(new Set((await readRegistry()).map((record) => record.id))))
    .catch((error: unknown) => {
      recordDiagnosticEvent({
        area: "session",
        level: "error",
        action: "watcher_recovery_failed",
        summary: error instanceof Error ? error.message : "Could not recover watchers.",
      });
    });
}

export async function startBackend(): Promise<void> {
  // Warnings, errors and lifecycle events also go to stderr: the managed
  // gateway appends it to gateway.log and a development server prints it.
  mirrorDiagnosticLogs((line) => process.stderr.write(line));
  await ensureConfigDir();
  void macPower?.start((await readHuiSettings()).power.keepAwake);
  await automation.start();
  // Session views name bots' chats from this list; a broken bots.json is reported by the bot routes.
  await botRegistry.list().catch(() => undefined);
  // Bots from before SOUL.md: their instructions become SOUL.md once (bots.json keeps them until then).
  void bots.migrate().then((moved) => {
    if (moved.souls || moved.cleared) {
      recordDiagnosticEvent({
        area: "session", level: "info", action: "bots_souls_migrated",
        summary: `${moved.souls} bot${moved.souls === 1 ? "" : "s"} got their instructions as SOUL.md; ${moved.cleared} conversation${moved.cleared === 1 ? "" : "s"} no longer carry instructions`,
      });
    }
  }, (error: unknown) => recordDiagnosticEvent({
    area: "session", level: "warning", action: "bots_souls_migration_failed",
    summary: "Bots' instructions could not become SOUL.md; HUI tries again at its next start",
    detail: error instanceof Error ? error.message : String(error),
  }));
  // The roster's copy of each bot's tool and skill lists follows its chat's document, which may have moved without it.
  void bots.reconcileAccess().then((repaired) => {
    if (repaired) {
      recordDiagnosticEvent({
        area: "session", level: "info", action: "bots_access_reconciled",
        summary: `${repaired} bot${repaired === 1 ? "'s" : "s'"} tool and skill lists were copied again from their chats`,
      });
    }
  }, (error: unknown) => recordDiagnosticEvent({
    area: "session", level: "warning", action: "bots_access_reconcile_failed",
    summary: "Bots' tool and skill lists could not be checked against their chats; HUI tries again at its next start",
    detail: error instanceof Error ? error.message : String(error),
  }));
  initializeWatchers();
  initializeSubagents();
  // Triggers: what waited for a cooldown across the restart goes out once its cooldown ends.
  void triggers.start().catch((error: unknown) => recordDiagnosticEvent({
    area: "session", level: "warning", action: "triggers_start_failed", summary: "Bots' triggers did not start",
    detail: error instanceof Error ? error.message : String(error),
  }));
  void secretFiles.sweep();
  await workers.list().catch(() => undefined);
  // Opening the Durable store resumes its interrupted runs, including those of
  // sessions no browser has reopened yet, once those sessions have loaded their
  // PI extensions again. Another gateway owning it is reported.
  durableHost().beforeResume = async (conversations) => reopenDurableSessions(conversations, await readRegistry());
  void durableHost().open().catch((error: unknown) => recordDiagnosticEvent({
    area: "runtime", level: "warning", action: "durable_open_failed",
    summary: "The Durable session store did not open",
    detail: error instanceof Error ? error.message : String(error),
  }));
  recoverInterruptedSessions(await readRegistry());
  // Auto-star the HUI repo when GitHub is connected.
  void githubCli.starHuiRepo().catch(() => {}); // best-effort, non-blocking
}

/** The sessions of Durable conversations with unfinished work, whose runs
 * resume once they are open (the store, not HUI's run marker, knows them all). */
export async function reopenDurableSessions(
  conversations: readonly unknown[],
  records: readonly SessionRecord[],
  sessions: Pick<typeof liveSessions, "ensure" | "booted"> = liveSessions,
): Promise<void> {
  const references = new Set(conversations.map((id) => `durable:${String(id)}`));
  const owners = records.filter((record) => record.piSessionFile && references.has(record.piSessionFile));
  await Promise.all(owners.map((record) => sessions.ensure(record) ? sessions.booted(record.id) : undefined));
}

/** A failed Durable store is about to open again (`DurableHost.storeFailed`): the sessions on this machine it ended
 * reattach, once a boot underway settles (one that got the failed store ends then too). Their boots open the store;
 * the host opens it anyway, which resumes the runs of sessions nobody has open, as at startup. */
export async function reattachAfterStoreFailure(
  records: readonly SessionRecord[],
  sessions: Pick<typeof liveSessions, "ensure" | "booted" | "isLive"> = liveSessions,
): Promise<void> {
  await Promise.all(records.filter((record) => !record.worker && sessions.isLive(record.id)).map(async (record) => {
    await sessions.booted(record.id);
    sessions.ensure(record, true);
  }));
}

/** Startup recovery is eager: interrupted work resumes even when no browser
 * has reopened that conversation yet. */
export function recoverInterruptedSessions(
  records: readonly SessionRecord[],
  sessions: Pick<typeof liveSessions, "ensure"> = liveSessions,
): number {
  let started = 0;
  for (const record of records) {
    if (record.runStartedAt && sessions.ensure(record)) started += 1;
  }
  return started;
}

/** Settles once the Durable store is released, so a backend started next in
 * this process (a development server restart) can open it. */
export async function stopBackend(): Promise<void> {
  try {
    macPower?.dispose();
    managedBrowser.dispose();
    // Signals openvscode-server and returns: a gateway stop never waits for it.
    vscode.dispose();
    terminals.dispose();
    githubCli.dispose();
    datadogOrgs.dispose();
    // Before the sessions close: a delivery still going out reaches its bot, and every trigger write has settled.
    await triggers.stop();
    automation.dispose();
    subagents.dispose();
    watchers.dispose();
    secretRequests.dispose();
    questionnaires.dispose();
    secretFiles.dispose();
    stopAgentToolBridge();
    // Closed first: remote sessions then keep running on their hosts instead of
    // receiving a kill from the disposal below.
    workers.disconnectAll();
    liveSessions.disposeAll();
  } finally {
    // Closing records no outcome: running Durable work resumes on the next start.
    // A failed step above must not leave the store locked.
    await durableHost().close();
  }
}
