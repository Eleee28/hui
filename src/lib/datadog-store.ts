/** Browser half of the Datadog integration: a card's sign-in, which waits on pup's sign-in through src/api/datadog.ts,
 * and chat previews, one request per message for its (at most three) links, remembered per URL for the page so
 * re-renders do not refetch. A finished sign-in or an org change drops what the page remembers and tells every card
 * on it to load again. */
import { MAX_DATADOG_EMBEDS } from "./markdown/datadog-links.ts";
import type { DatadogConnection, DatadogOrg, DatadogPreviewResult } from "../api/schema/datadog.ts";
import type { DatadogRef } from "./markdown/datadog-links.ts";
import { fetchDatadogPreviews, loadDatadogConnection, startDatadogLogin } from "../api/datadog.ts";

/** Fired on `window` after a Datadog sign-in succeeds or the org list changes; cards listen and load again. */
export const DATADOG_CHANGED = "hui-datadog-changed";
const POLL_MS = 1_500;
/** A card stops waiting after this long even if the gateway never answers again (it gives up after 6 minutes). */
const SIGN_IN_WAIT_MS = 7 * 60_000;
const FAILURE_RETRY_MS = 30_000;
const SUCCESS_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 60;

const sameOrg = (a: DatadogOrg, b: DatadogOrg) => a.name === b.name && a.site === b.site;

/** After a sign-in succeeds or an org is added or removed: the page forgets its previews (the gateway already
 * has) and every card loads again. */
export function notifyDatadogChanged(): void {
  cache.clear();
  settled.clear();
  window.dispatchEvent(new Event(DATADOG_CHANGED));
}

/** Signs in to one org from a card: starts pup's sign-in, or waits on the one already running for that org, and
 * resolves once that org is connected; rejects with why not. Another org's sign-in, or a cancel, is not a success. */
export async function signInToDatadog(org: DatadogOrg, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<void> {
  let connection: DatadogConnection;
  try {
    connection = await startDatadogLogin(org);
  } catch (error) {
    connection = await loadDatadogConnection();
    if (connection.login.phase !== "pending" || !sameOrg(connection.login.org, org)) throw error;
  }
  const deadline = Date.now() + SIGN_IN_WAIT_MS;
  while (connection.login.phase === "pending" && sameOrg(connection.login.org, org) && Date.now() < deadline) {
    await wait(POLL_MS);
    // A dropped poll keeps waiting: the sign-in goes on in the gateway.
    connection = await loadDatadogConnection().catch(() => connection);
  }
  const login = connection.login;
  if (login.phase === "failed" && sameOrg(login.org, org)) throw new Error(login.message);
  if (connection.orgs.find((entry) => sameOrg(entry, org))?.status !== "connected") throw new Error("The sign-in did not finish.");
  notifyDatadogChanged();
}

type Entry = { at: number; result: Promise<DatadogPreviewResult> };
const cache = new Map<string, Entry>();
/** The latest answer per URL, kept past its TTL: a card shown again draws at once and refreshes in place. */
const settled = new Map<string, DatadogPreviewResult>();

export function settledDatadogPreview(ref: DatadogRef): DatadogPreviewResult | undefined {
  return settled.get(ref.url);
}

function fresh(entry: Entry | undefined, now: number): entry is Entry {
  return Boolean(entry) && now - entry!.at < SUCCESS_TTL_MS;
}

/** Previews in the order of `refs`. Never rejects: a failed request becomes `unavailable`. */
export function loadDatadogPreviews(refs: readonly DatadogRef[], now = Date.now(), fetcher = fetchDatadogPreviews): Promise<DatadogPreviewResult[]> {
  const wanted = refs.slice(0, MAX_DATADOG_EMBEDS);
  const entries = new Map<string, Entry>();
  for (const ref of wanted) {
    const entry = cache.get(ref.url);
    if (fresh(entry, now)) entries.set(ref.url, entry);
  }
  const missing = wanted.filter((ref) => !entries.has(ref.url));
  if (missing.length) {
    // ponytail: clear-all eviction like the Markdown cache, before this message's entries go in; images make
    // entries large, so the cap stays small.
    if (cache.size + missing.length > CACHE_LIMIT) cache.clear();
    const batch = fetcher(missing)
      .catch((): DatadogPreviewResult[] => missing.map((ref) => ({ url: ref.url, error: "unavailable" })));
    for (const [index, ref] of missing.entries()) {
      const entry: Entry = { at: now, result: batch.then((results) => results[index] ?? { url: ref.url, error: "unavailable" }) };
      cache.set(ref.url, entry);
      entries.set(ref.url, entry);
      void entry.result.then((result) => { if (cache.get(ref.url) === entry) settled.set(ref.url, result); });
      // Failures age out sooner so a later render retries once the cause is fixed.
      void entry.result.then((result) => { if (result.error && cache.get(ref.url) === entry) entry.at = now - SUCCESS_TTL_MS + FAILURE_RETRY_MS; });
    }
  }
  return Promise.all(wanted.map((ref) => entries.get(ref.url)!.result));
}

/** Test helper. */
export function clearDatadogPreviewCache(): void {
  cache.clear();
  settled.clear();
}
