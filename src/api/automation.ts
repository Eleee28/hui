/**
 * Browser client for the gateway's automation scheduler. Tasks, schedules and runs live on the server; this
 * module only crosses `/__hui/automation` and hands back the scheduler snapshot that follows each change.
 */
import type {
  AutomationRun,
  AutomationSnapshot,
  AutomationCreateResponse,
  AutomationMutationResponse,
  AutomationRunResponse,
  AutomationTaskInput,
} from "./schema/automation.ts";
import { trackedFetch } from "./request.ts";

const AUTOMATION_URL = "/__hui/automation";
const HEADERS = { "x-hui": "1" } as const;

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Automation request failed (${response.status}).`);
  return body;
}

export async function loadAutomation(): Promise<AutomationSnapshot> {
  return responseJson(await trackedFetch(AUTOMATION_URL, { headers: HEADERS }));
}

export async function createAutomationTask(input: AutomationTaskInput): Promise<AutomationSnapshot> {
  const body = await responseJson<AutomationCreateResponse>(
    await trackedFetch(`${AUTOMATION_URL}/tasks`, {
      method: "POST",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.snapshot;
}

export async function updateAutomationTask(
  id: string,
  input: AutomationTaskInput,
): Promise<AutomationSnapshot> {
  const body = await responseJson<AutomationMutationResponse>(
    await trackedFetch(`${AUTOMATION_URL}/tasks/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.snapshot;
}

export async function deleteAutomationTask(id: string): Promise<AutomationSnapshot> {
  const body = await responseJson<AutomationMutationResponse>(
    await trackedFetch(`${AUTOMATION_URL}/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: HEADERS,
    }),
  );
  return body.snapshot;
}

export async function runAutomationTask(id: string): Promise<AutomationRun> {
  const body = await responseJson<AutomationRunResponse>(
    await trackedFetch(`${AUTOMATION_URL}/tasks/${encodeURIComponent(id)}/run`, {
      method: "POST",
      headers: HEADERS,
    }),
  );
  return body.run;
}

export async function cancelAutomationRun(id: string): Promise<void> {
  await responseJson(
    await trackedFetch(`${AUTOMATION_URL}/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: HEADERS,
    }),
  );
}

export type { AutomationRun, AutomationSchedule, AutomationSnapshot, AutomationTask, AutomationTaskInput } from "./schema/automation.ts";
