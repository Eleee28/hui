/** Browser client for the provider settings: the providers snapshot, one connection's usage quota, and the
 * sign-in, selection and removal requests. The gateway owns the credentials. */
import type { ProviderQuota, ProviderSnapshot } from "./schema/providers.ts";
import { fetchJson } from "./request.ts";

const API = "/__hui/providers";

export function loadProviders(): Promise<ProviderSnapshot> {
  return fetchJson<ProviderSnapshot>(API, { signal: AbortSignal.timeout(20_000) });
}

export function providerRequest(path: string, method: string, body?: unknown) {
  return fetchJson(`${API}/${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(25_000) });
}

export function loadProviderQuota(id: string): Promise<ProviderQuota> {
  return fetchJson<ProviderQuota>(`${API}/${id}/quota`, { signal: AbortSignal.timeout(20_000) });
}
