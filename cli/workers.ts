/**
 * `hui workers`: the Settings → Workers list, add, edit and remove, through the
 * running gateway's `/__hui/workers` routes, so connections and their state
 * stay with the gateway that owns them.
 */
import type { WorkerInput, WorkerView } from "../server/worker/workers.ts";

export type WorkerFlags = { name?: string; command?: string; "extra-path"?: string[] };

/** Calls one workers route of the gateway at `base`; a refused request throws its error. */
async function request<T>(base: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(new URL(`/__hui/workers${path}`, base), {
    method, headers: { "x-hui": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000), redirect: "error",
  });
  const text = await response.text();
  let reply: T & { error?: string };
  // A few gateway refusals (a disallowed Host, a stopping gateway) are plain text.
  try { reply = JSON.parse(text) as T & { error?: string }; } catch { throw new Error(text.trim() || `HUI returned HTTP ${response.status}.`); }
  if (!response.ok) throw new Error(reply.error ?? `HUI returned HTTP ${response.status}.`);
  return reply;
}

const list = async (base: string) => (await request<{ workers: WorkerView[] }>(base, "")).workers;

/** The worker a name or id names; a name two workers share must be given as an id. */
async function find(base: string, target: string): Promise<WorkerView> {
  const workers = await list(base);
  const byId = workers.find((worker) => worker.id === target);
  if (byId) return byId;
  const named = workers.filter((worker) => worker.name === target);
  if (named.length === 1) return named[0]!;
  throw new Error(named.length ? `${named.length} workers are named ${target}. Use an id: hui workers list --json.` : `No worker named ${target}. See hui workers list.`);
}

export async function workersCommand(base: string, action: string, target: string | undefined, flags: WorkerFlags): Promise<unknown> {
  if (action === "list") return list(base);
  if (action === "add") {
    const input: WorkerInput = { name: flags.name ?? "", command: flags.command ?? "", extraPaths: flags["extra-path"] ?? [] };
    const { worker } = await request<{ worker: WorkerView }>(base, "", "POST", input);
    // As Settings does: a new worker connects at once, in the background.
    await request(base, `/${worker.id}/connect`, "POST");
    return { ...worker, state: "connecting" };
  }
  const worker = await find(base, target!);
  if (action === "edit") {
    // The gateway keeps every field left out; a new command applies on the next connect.
    const input: Partial<WorkerInput> = { name: flags.name, command: flags.command, extraPaths: flags["extra-path"] };
    return (await request<{ worker: WorkerView }>(base, `/${worker.id}`, "PATCH", input)).worker;
  }
  await request(base, `/${worker.id}`, "DELETE");
  return { removed: worker.name, id: worker.id };
}

/** One line per worker, for people; --json prints the views. */
export function formatWorkers(workers: readonly WorkerView[]): string {
  if (!workers.length) return "No workers. Add one with hui workers add --name <name> --command \"ssh <host>\".";
  return workers.map((worker) => `${worker.name}  ${worker.state}${worker.error ? ` (${worker.error})` : ""}  ${worker.command}  ${worker.id}`).join("\n");
}
