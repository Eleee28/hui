import assert from "node:assert/strict";
import { test } from "vitest";

import type { DatadogOrg } from "../api/datadog.ts";
import { PupError } from "./datadog.ts";
import {
  DatadogPreviews,
  findWidget,
  imageType,
  openGraph,
  previewTtlMs,
  substituteTemplateVariables,
  templateVariables,
  timeRange,
  type PreviewFetch,
  type PreviewOrgs,
} from "./datadog-previews.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake image")]);
const PNG_DATA = `data:image/png;base64,${PNG.toString("base64")}`;
const SHARE = "https://app.datadoghq.com/s/yB5yjZ/dgj-s33-htg";
const SHARE_PAGE = `<html><head><title>x | Datadog</title>
<meta property="og:type" content="website" />
<meta content="[streaming-topicstats] Lag &amp; &quot;time&quot;" property="og:title" />
<meta property="og:image" content="https://p.datadoghq.com/s/image/yB5yjZ/dgj-s33-htg.png" />
<meta property="og:description" content="None" /></head></html>`;
const PROD: DatadogOrg = { name: "prod", site: "app.datadoghq.com" };
const STAGING: DatadogOrg = { name: "staging", site: "app.datadoghq.com" };
const WIDGET_URL = "https://app.datadoghq.com/dashboard/abc-123-xyz/lag?from_ts=1792170000000&to_ts=1792173600000&live=true&tile_focus=42&tpl_var_env[0]=prod&tpl_var_env[1]=staging";
const DASHBOARD = {
  title: "Streaming lag",
  description: "Kafka consumer lag per topic.",
  template_variables: [{ name: "env", prefix: "env", defaults: ["*"] }, { name: "environment", prefix: "environment", default: "eu1" }],
  widgets: [
    { id: 1, definition: { type: "note", content: "hello" } },
    { id: 2, definition: { type: "group", widgets: [{ id: 42, definition: { type: "timeseries", title: "Lag for $env", requests: [{ queries: [{ query: "max:kafka.lag{$env,$environment,service:x}" }] }] } }] } },
  ],
};

type Route = Response | (() => Response | Promise<Response>);
function fakeFetch(routes: Record<string, Route | Route[]>) {
  const seen: string[] = [];
  const fetch: PreviewFetch = async (url) => {
    seen.push(url);
    const route = routes[url];
    const next = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
    if (!next) return new Response("missing", { status: 404 });
    return typeof next === "function" ? next() : next.clone();
  };
  return { fetch, seen };
}

function fakeOrgs(configured: DatadogOrg[], handler: (args: readonly string[], org: DatadogOrg) => unknown) {
  const calls: string[] = [];
  const signedOut: string[] = [];
  const state = { refreshWorks: true, refreshed: 0 };
  const orgs: PreviewOrgs = {
    orgsFor: async (host) => configured.filter((org) => org.site === host),
    run: async (args, org) => {
      calls.push(`${org?.name}: ${args.slice(0, 2).join(" ")}`);
      return handler(args, org!);
    },
    refresh: async () => { state.refreshed += 1; return state.refreshWorks; },
    signedOut: (org, value) => { if (value) signedOut.push(org.name); },
  };
  return { orgs, calls, signedOut, state };
}

const instant = { sleep: async () => {} };

test("reads Open Graph tags, image magic bytes and widget links' ranges", () => {
  assert.deepEqual(openGraph(SHARE_PAGE), {
    "og:type": "website", "og:title": "[streaming-topicstats] Lag & \"time\"", "og:image": "https://p.datadoghq.com/s/image/yB5yjZ/dgj-s33-htg.png", "og:description": "None",
  });
  assert.equal(imageType(PNG), "image/png");
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(imageType(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
  assert.equal(imageType(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")), undefined);

  const now = 1_800_000_000_000;
  assert.deepEqual(timeRange(new URL(WIDGET_URL), now), { from: 1792170000000, to: 1792173600000, relative: false });
  assert.deepEqual(timeRange(new URL("https://app.datadoghq.com/dashboard/a-b-c?fullscreen_widget=1&fullscreen_start_ts=5&fullscreen_end_ts=9&from_ts=1&to_ts=2"), now), { from: 5, to: 9, relative: false });
  assert.deepEqual(timeRange(new URL("https://app.datadoghq.com/dashboard/a-b-c?from_ts=9&to_ts=5"), now), { from: now - 3_600_000, to: now, relative: true });
  assert.equal(findWidget(DASHBOARD.widgets, "42")?.["id"], 42);
  assert.equal(findWidget(DASHBOARD.widgets, "7"), undefined);
  assert.equal(previewTtlMs({ url: "u", error: "signed_out" }), 15_000);
  assert.equal(previewTtlMs({ url: "u", preview: { kind: "widget", url: "u", title: "t", relative: true, image: "data:" } }), 5 * 60_000);
  assert.equal(previewTtlMs({ url: "u", preview: { kind: "widget", url: "u", title: "t", from: 1, to: 2 } }), 5 * 60_000, "not drawn: ask again soon");
  assert.equal(previewTtlMs({ url: "u", preview: { kind: "widget", url: "u", title: "t", from: 1, to: 2, image: "data:" } }), 3_600_000);
});

test("substitutes template variables like Datadog, in strings only", () => {
  const params = new URLSearchParams("tpl_var_env%5B0%5D=prod&tpl_var_env[1]=staging&tpl_var_host=web-1&tpl_var_hostname=other");
  const variables = templateVariables([
    { name: "env", prefix: "env", defaults: ["dev"] },
    { name: "host", prefix: "" },
    { name: "hostname", prefix: "host" },
    { name: "dc", prefix: "datacenter", default: "us1" },
    { name: "all", prefix: "service", defaults: ["*"] },
    { name: "region", prefix: "region", defaults: [], default: "eu1" },
    { name: "bad name", prefix: "x" },
  ], params);
  assert.deepEqual(variables, [
    { name: "env", prefix: "env", values: ["prod", "staging"] },
    { name: "host", prefix: "", values: ["web-1"] },
    { name: "hostname", prefix: "host", values: ["other"] },
    { name: "dc", prefix: "datacenter", values: ["us1"] },
    { name: "all", prefix: "service", values: ["*"] },
    { name: "region", prefix: "region", values: ["eu1"] },
  ]);
  assert.deepEqual(substituteTemplateVariables({
    query: "avg:cpu{$env,$host,$hostname,$dc,$all} by {host}",
    title: "CPU in $dc.value for $env.value ($unknown, $environment)",
    nested: [{ q: "$dc" }, 42, true, null],
  }, variables), {
    query: "avg:cpu{(env:prod OR env:staging),web-1,host:other,datacenter:us1,*} by {host}",
    title: "CPU in us1 for prod ($unknown, $environment)",
    nested: [{ q: "datacenter:us1" }, 42, true, null],
  });
});

test("previews a share link from its public page, image included", async () => {
  const { fetch, seen } = fakeFetch({
    [SHARE]: new Response(SHARE_PAGE, { status: 200, headers: { "content-type": "text/html" } }),
    "https://p.datadoghq.com/s/image/yB5yjZ/dgj-s33-htg.png": new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }),
  });
  const { orgs, calls } = fakeOrgs([], () => { throw new Error("no pup for share links"); });
  const previews = new DatadogPreviews(orgs, { fetch });
  assert.deepEqual(await previews.lookup(`${SHARE}?ignored=1`), {
    url: `${SHARE}?ignored=1`,
    preview: { kind: "share", url: `${SHARE}?ignored=1`, title: "[streaming-topicstats] Lag & \"time\"", image: PNG_DATA },
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(seen, [SHARE, "https://p.datadoghq.com/s/image/yB5yjZ/dgj-s33-htg.png"]);

  const gone = fakeFetch({ "https://app.datadoghq.com/s/yB5yjZ/zzz-zzz-zzz": new Response("{}", { status: 404 }) });
  assert.equal((await new DatadogPreviews(orgs, { fetch: gone.fetch }).lookup("https://app.datadoghq.com/s/yB5yjZ/zzz-zzz-zzz")).error, "not_found");
  assert.equal((await previews.lookup("https://acme.datadoghq.com/s/a/b")).error, "no_org");
  assert.equal((await previews.lookup("https://app.datadoghq.com/monitors/1")).error, "not_found");
});

test("never follows a share page outside Datadog or trusts what is not an image", async () => {
  const { orgs } = fakeOrgs([], () => undefined);
  const page = (image: string) => new Response(SHARE_PAGE.replace("https://p.datadoghq.com/s/image/yB5yjZ/dgj-s33-htg.png", image), { status: 200 });
  const outside = fakeFetch({ [SHARE]: page("https://evil.example/graph.png") });
  assert.deepEqual((await new DatadogPreviews(orgs, { fetch: outside.fetch }).lookup(SHARE)).preview?.image, undefined);
  assert.deepEqual(outside.seen, [SHARE]);

  const svg = fakeFetch({ [SHARE]: page("https://p.datadoghq.com/x.svg"), "https://p.datadoghq.com/x.svg": new Response("<svg/>", { status: 200, headers: { "content-type": "image/png" } }) });
  const svgResult = await new DatadogPreviews(orgs, { fetch: svg.fetch }).lookup(SHARE);
  assert.equal(svgResult.preview?.title, "[streaming-topicstats] Lag & \"time\"");
  assert.equal(svgResult.preview?.image, undefined);

  const redirect = fakeFetch({ [SHARE]: new Response(null, { status: 302, headers: { location: "https://internal.example/admin" } }) });
  assert.equal((await new DatadogPreviews(orgs, { fetch: redirect.fetch }).lookup(SHARE)).error, "unavailable");
  assert.deepEqual(redirect.seen, [SHARE]);

  // A local fixture origin is fetched only when it is the configured test origin.
  const local = "http://127.0.0.1:9/demo/graph.png";
  const fixture = fakeFetch({ [SHARE]: page(local), [local]: new Response(PNG, { status: 200 }) });
  assert.equal((await new DatadogPreviews(orgs, { fetch: fixture.fetch }).lookup(SHARE)).preview?.image, undefined);
  assert.equal((await new DatadogPreviews(orgs, { fetch: fixture.fetch, testOrigin: "http://127.0.0.1:9" }).lookup(SHARE)).preview?.image, PNG_DATA);

  const loop = fakeFetch({ [SHARE]: new Response(null, { status: 302, headers: { location: SHARE } }) });
  assert.equal((await new DatadogPreviews(orgs, { fetch: loop.fetch }).lookup(SHARE)).error, "unavailable");
  assert.equal(loop.seen.length, 3);
});

test("finds the org that has the dashboard and draws the focused widget", async () => {
  const graphDefs: unknown[] = [];
  const { orgs, calls, signedOut } = fakeOrgs([PROD, STAGING, { name: "eu", site: "app.datadoghq.eu" }], (args, org) => {
    if (args[0] === "dashboards") {
      if (org.name === "prod") throw new PupError("not_found");
      return DASHBOARD;
    }
    // The definition goes as a raw string (-f); the range as typed numbers (-F), in seconds.
    assert.equal(args[2], "-f");
    graphDefs.push(JSON.parse(String(args[3]).slice("graph_def=".length)));
    assert.deepEqual(args.slice(4), ["-F", "start=1792170000", "-F", "end=1792173600"]);
    return { snapshot_url: "https://app.datadoghq.com/api/v2/snapshot/view/public/2y/org/1.png" };
  });
  const pending = new Response(JSON.stringify({ data: { attributes: { status: "pending" } } }), { status: 200, headers: { "content-type": "application/vnd.api+json" } });
  const { fetch } = fakeFetch({ "https://app.datadoghq.com/api/v2/snapshot/view/public/2y/org/1.png": [pending, pending, new Response(PNG, { status: 200 })] });
  const previews = new DatadogPreviews(orgs, { fetch, ...instant });
  assert.deepEqual(await previews.lookup(WIDGET_URL), {
    url: WIDGET_URL,
    preview: {
      kind: "widget", url: WIDGET_URL, title: "Lag for (env:prod OR env:staging)", detail: "Streaming lag", org: "staging",
      from: 1792170000000, to: 1792173600000, image: PNG_DATA,
    },
  });
  assert.deepEqual(calls, ["prod: dashboards get", "staging: dashboards get", "staging: api v1/graph/snapshot"]);
  assert.deepEqual(signedOut, []);
  assert.equal((graphDefs[0] as { requests: { queries: { query: string }[] }[] }).requests[0]?.queries[0]?.query, "max:kafka.lag{(env:prod OR env:staging),environment:eu1,service:x}");

  // Cached: the same link does not call pup again.
  await previews.lookup(WIDGET_URL);
  assert.equal(calls.length, 3);

  const dashboardOnly = "https://app.datadoghq.com/dashboard/abc-123-xyz/lag";
  assert.deepEqual((await previews.lookup(dashboardOnly)).preview, {
    kind: "dashboard", url: dashboardOnly, title: "Streaming lag", detail: "Kafka consumer lag per topic.", org: "staging",
  });
  const note = "https://app.datadoghq.com/dashboard/abc-123-xyz?tile_focus=1";
  const noteResult = await previews.lookup(note);
  assert.equal(noteResult.preview?.kind, "widget");
  assert.equal(noteResult.preview?.image, undefined);
  assert.equal(noteResult.preview?.relative, true);
  assert.ok(!calls.slice(3).some((call) => call.includes("snapshot")));
});

test("refreshes an expired session once, then asks to sign in", async () => {
  const expired = new Set(["prod"]);
  const { orgs, calls, signedOut, state } = fakeOrgs([PROD], (args) => {
    if (expired.has("prod")) throw new PupError("expired");
    if (args[0] === "dashboards") return DASHBOARD;
    throw new PupError("not_found");
  });
  const original = orgs.refresh;
  orgs.refresh = async (org) => { expired.delete("prod"); return original(org); };
  const previews = new DatadogPreviews(orgs, instant);
  const renewed = await previews.lookup(WIDGET_URL);
  assert.equal(renewed.preview?.org, "prod");
  assert.equal(renewed.preview?.image, undefined, "a snapshot the session may not take leaves the card without image");
  assert.equal(state.refreshed, 1);
  assert.deepEqual(calls, ["prod: dashboards get", "prod: dashboards get", "prod: api v1/graph/snapshot"]);

  const dead = fakeOrgs([PROD, STAGING], (_args, org) => { throw new PupError(org.name === "prod" ? "expired" : "not_found"); });
  dead.state.refreshWorks = false;
  assert.deepEqual(await new DatadogPreviews(dead.orgs, instant).lookup(WIDGET_URL), { url: WIDGET_URL, error: "signed_out", signIn: PROD });
  assert.deepEqual(dead.signedOut, ["prod"]);
  assert.deepEqual(dead.calls, ["prod: dashboards get", "staging: dashboards get"]);
  assert.deepEqual(signedOut, []);
});

test("reports why an app link has no preview", async () => {
  const lookup = (handler: () => unknown, configured = [PROD]) => new DatadogPreviews(fakeOrgs(configured, handler).orgs, instant).lookup(WIDGET_URL);
  assert.equal((await lookup(() => { throw new PupError("not_found"); })).error, "not_found");
  assert.equal((await lookup(() => { throw new PupError("unavailable"); })).error, "unavailable");
  assert.equal((await lookup(() => { throw new PupError("cli_missing"); })).error, "cli_missing");
  assert.equal((await lookup(() => DASHBOARD, [])).error, "no_org");

  // A snapshot that never finishes leaves the card without image; a hung lookup ends at the deadline.
  let clock = 0;
  const pending = () => new Response(JSON.stringify({ data: { attributes: { status: "pending" } } }), { status: 200 });
  const slow = fakeOrgs([PROD], (args) => args[0] === "dashboards" ? DASHBOARD : { snapshot_url: "https://app.datadoghq.com/api/v2/snapshot/view/public/x.png" });
  const never = new DatadogPreviews(slow.orgs, { fetch: fakeFetch({ "https://app.datadoghq.com/api/v2/snapshot/view/public/x.png": pending }).fetch, now: () => clock, sleep: async () => { clock += 1_000; } });
  const result = await never.lookup(WIDGET_URL);
  assert.equal(result.preview?.kind, "widget");
  assert.equal(result.preview?.image, undefined);

  const hung = new DatadogPreviews(fakeOrgs([PROD], () => new Promise(() => {})).orgs, { deadlineMs: 20 });
  assert.deepEqual(await hung.lookup(WIDGET_URL), { url: WIDGET_URL, error: "unavailable" });
});

test("shares concurrent lookups and looks again once cleared", async () => {
  let fail = true;
  const { orgs, calls } = fakeOrgs([PROD], () => {
    if (fail) throw new PupError("unavailable");
    return DASHBOARD;
  });
  const previews = new DatadogPreviews(orgs, instant);
  const link = "https://app.datadoghq.com/dashboard/abc-123-xyz";
  const [first, second] = await Promise.all([previews.lookup(link), previews.lookup(link)]);
  assert.equal(first.error, "unavailable");
  assert.equal(second, first);
  assert.equal(calls.length, 1);
  fail = false;
  assert.equal((await previews.lookup(link)).error, "unavailable", "failures stay cached until cleared");
  previews.clear();
  assert.equal((await previews.lookup(link)).preview?.title, "Streaming lag");
});
