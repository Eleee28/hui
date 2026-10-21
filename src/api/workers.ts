/**
 * Browser client for remote workers: listing, adding, editing and removing them and requesting connect, sync or
 * disconnect. Those operations run in the gateway; the UI polls the list for progress.
 */
import { fetchJson } from "./request.ts";
import type { WorkerInput, WorkerView, WorkersResponse, WorkerResponse } from "./schema/workers.ts";

export type { WorkerInput, WorkerView };

const WORKERS_URL = "/__hui/workers";
const JSON_HEADERS = { "content-type": "application/json" } as const;
const workerUrl = (id: string, suffix = "") => `${WORKERS_URL}/${encodeURIComponent(id)}${suffix}`;

export async function loadWorkers(): Promise<WorkerView[]> {
  return (await fetchJson<WorkersResponse>(WORKERS_URL)).workers ?? [];
}

export async function createWorker(input: WorkerInput): Promise<WorkerView> {
  return (await fetchJson<WorkerResponse>(WORKERS_URL, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(input) })).worker;
}

export async function updateWorker(id: string, input: Partial<WorkerInput>): Promise<WorkerView> {
  return (await fetchJson<WorkerResponse>(workerUrl(id), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(input) })).worker;
}

export async function removeWorker(id: string): Promise<void> {
  await fetchJson(workerUrl(id), { method: "DELETE" });
}

/** Connect, sync and disconnect run in the gateway; poll the list for progress. */
export async function workerAction(id: string, action: "connect" | "sync" | "disconnect"): Promise<void> {
  await fetchJson(workerUrl(id, `/${action}`), { method: "POST" });
}
