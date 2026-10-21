/**
 * Sessions still on PI's SDK worker. New sessions run on Pi Durable; `--fix` moves the older ones too
 * (`importPiSession`) and points their registry records at the new conversations. PI's transcripts are only read,
 * so they stay where they were, unchanged, and the registry is copied to `backups/` before its first change.
 */
import { readFile, stat } from "node:fs/promises";
import { backupRegistry, readRegistry, updateRegistry, type SessionRecord } from "../server/sessions/sessions.ts";
import type { DoctorCheck, DoctorItem, DoctorResult } from "./doctor-types.ts";

const ID = "pi-sessions";
const TITLE = "PI sessions";

type Candidate = { record: SessionRecord; blocked?: string };

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function label(record: SessionRecord): string {
  const title = record.title.length > 60 ? `${record.title.slice(0, 59)}…` : record.title;
  return `"${title}" (${record.id.slice(0, 8)})`;
}

async function candidates(): Promise<Candidate[]> {
  // A worker's sessions run there, beside their transcripts.
  const records = (await readRegistry()).filter((record) => record.tool === "pi" && !record.worker);
  return Promise.all(records.map(async (record): Promise<Candidate> => {
    // A gateway sends an interrupted PI run a recovery prompt at its next start; moving it now would drop that.
    if (record.runStartedAt) {
      return { record, blocked: "it has an interrupted run. Start the gateway and let the run finish or stop it, then run hui doctor --fix again" };
    }
    const file = record.piSessionFile;
    if (file?.startsWith("durable:")) return { record, blocked: `it names a Durable conversation (${file}) but runs on PI` };
    if (file && !await stat(file).then((info) => info.isFile(), () => false)) {
      return { record, blocked: `its PI transcript is missing: ${file}` };
    }
    return { record };
  }));
}

function result(found: readonly Candidate[], items: DoctorItem[], notes: string[]): DoctorResult {
  const remaining = items.filter((item) => item.status !== "fixed").length;
  const moved = items.length - remaining;
  if (!items.length) return { id: ID, title: TITLE, status: "ok", summary: "every session runs on Pi Durable", items, notes };
  const summary = moved
    ? `moved ${plural(moved, "session")} to Pi Durable${remaining ? `; ${plural(remaining, "session")} still ${remaining === 1 ? "runs" : "run"} on PI` : ""}`
    : `${plural(found.length, "session")} still ${found.length === 1 ? "runs" : "run"} on PI's worker`;
  return { id: ID, title: TITLE, status: remaining ? "issue" : "fixed", summary, items, notes };
}

function describe(result: { messages: number; summaries: number; abandoned: number; reused: boolean; model?: string }): string {
  return [
    plural(result.messages, "message"),
    ...(result.summaries ? [plural(result.summaries, "summary", "summaries")] : []),
    ...(result.abandoned ? [`${plural(result.abandoned, "entry", "entries")} on abandoned branches left in the PI file`] : []),
    ...(result.model ? [`continues on ${result.model}`] : []),
    ...(result.reused ? ["copied by an earlier run"] : []),
  ].join(", ");
}

async function move(host: import("../server/runtimes/durable-host.ts").DurableHost, record: SessionRecord): Promise<DoctorItem> {
  const item = { id: record.id, label: label(record) };
  try {
    const { durableReference } = await import("../server/runtimes/durable.ts");
    const { importPiSession } = await import("../server/runtimes/pi-import.ts");
    let reference: string | undefined;
    let detail = "never started; it starts on Pi Durable";
    if (record.piSessionFile) {
      const content = await readFile(record.piSessionFile, "utf8");
      const imported = await importPiSession(host, {
        id: record.id, cwd: record.cwd, source: record.piSessionFile,
        ...(record.model ? { model: record.model } : {}), ...(record.thinking ? { thinking: record.thinking } : {}),
      }, content);
      reference = durableReference(imported.conversationId);
      detail = describe(imported);
    }
    const sessions = await updateRegistry((current) => current.map((session) =>
      session.id === record.id && session.tool === "pi" && session.piSessionFile === record.piSessionFile
        ? { ...session, tool: "durable", ...(reference ? { piSessionFile: reference } : {}) }
        : session));
    if (sessions.find((session) => session.id === record.id)?.tool !== "durable") {
      return { ...item, status: "failed", detail: "the session changed while it was being moved; run hui doctor again" };
    }
    return { ...item, status: "fixed", detail };
  } catch (error) {
    return { ...item, status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

export const piSessionsCheck: DoctorCheck = {
  id: ID,
  title: TITLE,
  async inspect() {
    const found = await candidates();
    const items = found.map(({ record, blocked }): DoctorItem => ({
      id: record.id, label: label(record), status: blocked ? "blocked" : "issue", ...(blocked ? { detail: blocked } : {}),
    }));
    const movable = found.filter((candidate) => !candidate.blocked).length;
    const which = movable === found.length ? (movable === 1 ? "it" : "them") : `the ${plural(movable, "session")} marked •`;
    return result(found, items, movable
      ? [`hui doctor --fix moves ${which} to Pi Durable while the gateway is stopped. PI's transcripts are kept unchanged.`]
      : []);
  },
  async fix() {
    const found = await candidates();
    const movable = found.filter((candidate) => !candidate.blocked);
    const blocked = found.filter((candidate) => candidate.blocked)
      .map(({ record, blocked: detail }): DoctorItem => ({ id: record.id, label: label(record), status: "blocked", detail: detail! }));
    if (!movable.length) return result(found, blocked, []);
    const { DurableHost, DURABLE_DIR } = await import("../server/runtimes/durable-host.ts");
    const { resolvePiAgentDir } = await import("../server/pi/paths.ts");
    // Never resumes a run: the store is only written in commits. Opening fails while a gateway owns it.
    const host = new DurableHost({ dir: DURABLE_DIR, agentDir: resolvePiAgentDir(), resume: false });
    host.configureDurableBots(null);
    const items: DoctorItem[] = [];
    let backup: string;
    try {
      await host.open();
      backup = await backupRegistry();
      for (const { record } of movable) items.push(await move(host, record));
    } finally {
      await host.close();
    }
    return result(found, [...items, ...blocked], [
      `Registry backup: ${backup}`,
      "PI's transcripts were not changed; entries on abandoned branches remain only there.",
    ]);
  },
};
