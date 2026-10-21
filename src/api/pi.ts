/** Browser client for the `pi` configuration page: reading the snapshot and a resource, and installing or removing
 * packages and skills. The gateway reads and changes PI's files. */
import type { PiMutationResult, PiResourceDocument, PiSnapshot } from "./schema/pi.ts";
import { fetchJson } from "./request.ts";

const PI_URL = "/__hui/pi";

/** Transport failures are intentionally not collapsed into an empty snapshot:
 * the caller owns an explicit loading/error/retry state. */
export function loadPiConfig(): Promise<PiSnapshot> {
  return fetchJson<PiSnapshot>(PI_URL);
}

export function loadPiResource(kind: "skill" | "plugin", id: string): Promise<PiResourceDocument> {
  return fetchJson<PiResourceDocument>(`${PI_URL}/resources/${kind}/${id}`);
}

function mutatePi(path: string, body: Record<string, string>, timeoutMs: number): Promise<PiMutationResult> {
  return fetchJson<PiMutationResult>(`${PI_URL}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function installPiPackage(url: string): Promise<PiMutationResult> {
  return mutatePi("packages/install", { url }, 125_000);
}

export function removePiPackage(source: string): Promise<PiMutationResult> {
  return mutatePi("packages/remove", { source }, 125_000);
}

export function installPiSkill(url: string): Promise<PiMutationResult> {
  return mutatePi("skills/install", { url }, 305_000);
}
