import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { DATADOG_APP_HOSTS, datadogRefsInText, MAX_DATADOG_EMBEDS, normalizeDatadogSite, parseDatadogUrl, pupSite } from "./datadog-links.ts";

const SHARE = "https://app.datadoghq.com/s/yB5yjZ/dgj-s33-htg";
const WIDGET = "https://app.datadoghq.com/dashboard/ict-mcm-a8d/home-server?from_ts=1792170000000&live=true&tile_focus=7104162830770254&to_ts=1792173600000";

test("parses share links and dashboard links, and nothing else", () => {
  assert.deepEqual(parseDatadogUrl(SHARE), { kind: "share", url: SHARE, host: "app.datadoghq.com" });
  assert.deepEqual(parseDatadogUrl(WIDGET), {
    kind: "dashboard", url: WIDGET, host: "app.datadoghq.com", dashboardId: "ict-mcm-a8d", widgetId: "7104162830770254",
  });
  assert.equal(parseDatadogUrl("https://dd.datad0g.com/dashboard/abc-123-xyz?fullscreen_widget=42")?.kind, "dashboard");
  assert.equal((parseDatadogUrl("https://dd.datad0g.com/dashboard/abc-123-xyz?fullscreen_widget=42") as { widgetId?: string }).widgetId, "42");
  assert.equal((parseDatadogUrl("https://us3.datadoghq.com/dashboard/abc-123-xyz") as { widgetId?: string }).widgetId, undefined);
  // Ids past Number.MAX_SAFE_INTEGER lose precision in pup's parsed JSON: such a link is a plain dashboard link.
  for (const id of ["9007199254740993", "12345678901234567"]) {
    assert.equal((parseDatadogUrl(`https://app.datadoghq.com/dashboard/abc-123-xyz?tile_focus=${id}`) as { widgetId?: string }).widgetId, undefined, id);
  }
  assert.equal((parseDatadogUrl("https://app.datadoghq.com/dashboard/abc-123-xyz?tile_focus=9007199254740991") as { widgetId?: string }).widgetId, "9007199254740991");
  for (const raw of [
    "http://app.datadoghq.com/s/yB5yjZ/dgj-s33-htg", "https://app.datadoghq.com:8443/s/a/b", "https://u:p@app.datadoghq.com/s/a/b",
    "https://app.datadoghq.com/s/a", "https://app.datadoghq.com/s/a/b/c", "https://app.datadoghq.com/monitors/123",
    "https://app.datadoghq.com/dashboard/lists", "https://app.datadoghq.com/logs?query=x", "https://evil-datadoghq.com/s/a/b",
    "https://app.datadoghq.com.evil.test/s/a/b", "https://docs.example.com/s/a/b", "not a url",
  ]) assert.equal(parseDatadogUrl(raw), undefined, raw);
});

test("finds links in reading order, keeps query brackets, skips code, deduplicates and caps at three", () => {
  const brackets = "https://app.datadoghq.com/dashboard/abc-123-xyz/x?tpl_var_env[0]=prod&tpl_var_dc%5B0%5D=us1&tile_focus=9";
  const text = [
    "Lag spike: " + SHARE + ".",
    "`https://app.datadoghq.com/s/code/inline-span`",
    "```",
    "https://app.datadoghq.com/s/code/fenced",
    "```",
    `See [the widget](${brackets}) and (${SHARE}), then ${WIDGET}`,
    "Fourth: https://dd.datad0g.com/s/four/four",
  ].join("\n");
  assert.deepEqual(datadogRefsInText(text).map((ref) => ref.url), [SHARE, brackets, WIDGET]);
  assert.deepEqual(datadogRefsInText(text, 10).map((ref) => ref.url).at(-1), "https://dd.datad0g.com/s/four/four");
  assert.deepEqual(datadogRefsInText(`[${SHARE}](${SHARE})`).map((ref) => ref.url), [SHARE]);
  assert.deepEqual(datadogRefsInText("**https://app.datadoghq.com/s/yB5yjZ/dgj-s33-htg**").map((ref) => ref.url), [SHARE]);
  assert.deepEqual(datadogRefsInText("No links, just datadoghq.com."), []);
});

test("normalizes the site typed for an org and maps it to pup's site", () => {
  assert.equal(normalizeDatadogSite(""), "app.datadoghq.com");
  assert.equal(normalizeDatadogSite(" APP.datadoghq.com "), "app.datadoghq.com");
  assert.equal(normalizeDatadogSite("datadoghq.eu"), "app.datadoghq.eu");
  assert.equal(normalizeDatadogSite("https://dd.datad0g.com/dashboard/abc-123-xyz"), "dd.datad0g.com");
  assert.equal(normalizeDatadogSite("us3.datadoghq.com"), "us3.datadoghq.com");
  for (const raw of ["example.com", "http://app.datadoghq.com", "app.datadoghq.com:443x", "https://app.datadoghq.com:8443", 7]) {
    assert.equal(normalizeDatadogSite(raw), undefined, String(raw));
  }
  assert.equal(pupSite("app.datadoghq.com"), "datadoghq.com");
  assert.equal(pupSite("app.datad0g.com"), "datad0g.com");
  assert.equal(pupSite("dd.datad0g.com"), "dd.datad0g.com");
  assert.equal(pupSite("us5.datadoghq.com"), "us5.datadoghq.com");
});

test("Datadog link parsing and site normalization match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./datadog-links.fixture.json", import.meta.url), "utf8"));
  assert.equal(MAX_DATADOG_EMBEDS, fixture.maxEmbeds);
  assert.deepEqual(DATADOG_APP_HOSTS, fixture.appHosts);
  for (const item of fixture.urls) assert.deepEqual(parseDatadogUrl(item.input) ?? null, item.expected, item.input);
  for (const item of fixture.sites) assert.equal(normalizeDatadogSite(item.input) ?? null, item.expected, String(item.input));
  assert.equal(normalizeDatadogSite(undefined), "app.datadoghq.com");
  for (const item of fixture.pupSites) assert.equal(pupSite(item.input), item.expected, item.input);
});
