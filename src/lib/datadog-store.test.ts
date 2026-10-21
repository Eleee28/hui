import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { parseDatadogUrl } from "./markdown/datadog-links.ts";
import type { DatadogConnection, DatadogPreviewResult } from "../api/schema/datadog.ts";
import type { DatadogRef } from "./markdown/datadog-links.ts";
import { clearDatadogPreviewCache, DATADOG_CHANGED, loadDatadogPreviews, settledDatadogPreview, signInToDatadog } from "./datadog-store.ts";

const ref = (url: string) => parseDatadogUrl(url)!;
const PROD = { name: "prod", site: "app.datadoghq.com" };

test("batches one request per message, reuses results and retries failures after a sign-in", async () => {
  clearDatadogPreviewCache();
  const requests: string[][] = [];
  let error: DatadogPreviewResult["error"] = "signed_out";
  const fetcher = async (batch: readonly DatadogRef[]): Promise<DatadogPreviewResult[]> => {
    requests.push(batch.map((item) => item.url));
    return batch.map(({ url: item }): DatadogPreviewResult => error ? { url: item, error, signIn: PROD } : { url: item, preview: { kind: "share", url: item, title: "t" } });
  };
  const refs = ["a", "b", "c", "d"].map((id) => ref(`https://app.datadoghq.com/s/org/${id}`));
  assert.equal((await loadDatadogPreviews(refs, 0, fetcher)).length, 3, "at most three cards");
  assert.equal(requests.length, 1);
  await loadDatadogPreviews(refs, 1_000, fetcher);
  assert.equal(requests.length, 1, "fresh results are not refetched");
  assert.equal(settledDatadogPreview(refs[0]!)?.error, "signed_out", "a card shown again draws its last answer at once");

  // A sign-in elsewhere on the page drops remembered failures and tells cards to load again.
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  const reloaded = new Promise((resolve) => page.addEventListener(DATADOG_CHANGED, resolve, { once: true }));
  const connection = (login: DatadogConnection["login"]): DatadogConnection => ({ cli: { installed: true, version: "1" }, orgs: [{ ...PROD, status: "connected" }], pupOrgs: [], login });
  const answers = [connection({ phase: "pending", org: PROD, expiresAt: 1 }), connection({ phase: "pending", org: PROD, expiresAt: 1 }), connection({ phase: "idle" })];
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return Response.json(answers.shift());
  });
  await signInToDatadog(PROD, async () => {});
  assert.deepEqual(calls, ["POST /__hui/datadog/login", "GET /__hui/datadog", "GET /__hui/datadog"]);
  await reloaded;
  assert.equal(settledDatadogPreview(refs[0]!), undefined, "a change forgets what the page remembered");
  error = undefined;
  assert.equal((await loadDatadogPreviews(refs, 2_000, fetcher))[0]?.preview?.title, "t");
  assert.equal(requests.length, 2);
});

test("a sign-in counts only when its own org ends up connected", async () => {
  const view = (login: DatadogConnection["login"], status: "connected" | "signed_out" = "signed_out"): DatadogConnection => ({ cli: { installed: true, version: "1" }, orgs: [{ ...PROD, status }], pupOrgs: [], login });
  vi.stubGlobal("fetch", async () => Response.json(view({ phase: "failed", org: PROD, message: "Error: OAuth error: access_denied" })));
  await assert.rejects(signInToDatadog(PROD, async () => {}), /access_denied/u);

  // Cancelled from Settings: the gateway goes back to idle, but the org is still signed out.
  const cancelled = [view({ phase: "pending", org: PROD, expiresAt: 1 }), view({ phase: "idle" })];
  vi.stubGlobal("fetch", async () => Response.json(cancelled.shift()));
  await assert.rejects(signInToDatadog(PROD, async () => {}), /did not finish/u);

  // Already signing in to this org elsewhere (409): the card waits on that sign-in, through a dropped poll.
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  const answers: (() => Response)[] = [
    () => Response.json({ error: "Another Datadog sign-in is in progress." }, { status: 409 }),
    () => Response.json(view({ phase: "pending", org: PROD, expiresAt: 1 })),
    () => { throw new TypeError("network down"); },
    () => Response.json(view({ phase: "idle" }, "connected")),
  ];
  vi.stubGlobal("fetch", async () => answers.shift()!());
  const reloaded = new Promise((resolve) => page.addEventListener(DATADOG_CHANGED, resolve, { once: true }));
  await signInToDatadog(PROD, async () => {});
  assert.equal(answers.length, 0);
  await reloaded;
});

test("a failed request becomes unavailable, and a full page cache keeps the links being loaded", async () => {
  clearDatadogPreviewCache();
  const results = await loadDatadogPreviews([ref("https://app.datadoghq.com/s/a/b")], 0, async () => { throw new Error("offline"); });
  assert.deepEqual(results, [{ url: "https://app.datadoghq.com/s/a/b", error: "unavailable" }]);

  clearDatadogPreviewCache();
  const titled = async (batch: readonly DatadogRef[]): Promise<DatadogPreviewResult[]> =>
    batch.map(({ url: item }): DatadogPreviewResult => ({ url: item, preview: { kind: "share", url: item, title: item.slice(-1) } }));
  for (let index = 0; index < 59; index += 1) await loadDatadogPreviews([ref(`https://app.datadoghq.com/s/fill/x${index}`)], 0, titled);
  const message = await loadDatadogPreviews(["a", "b", "c"].map((id) => ref(`https://app.datadoghq.com/s/new/${id}`)), 0, titled);
  assert.deepEqual(message.map((result) => result.preview?.title), ["a", "b", "c"]);
});
