import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { DATADOG_APP_HOSTS, MAX_DATADOG_EMBEDS, normalizeDatadogSite, parseDatadogUrl, pupSite } from "./datadog-links.ts";

test("Datadog link parsing and site normalization match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./datadog-links.fixture.json", import.meta.url), "utf8"));
  assert.equal(MAX_DATADOG_EMBEDS, fixture.maxEmbeds);
  assert.deepEqual(DATADOG_APP_HOSTS, fixture.appHosts);
  for (const item of fixture.urls) assert.deepEqual(parseDatadogUrl(item.input) ?? null, item.expected, item.input);
  for (const item of fixture.sites) assert.equal(normalizeDatadogSite(item.input) ?? null, item.expected, String(item.input));
  assert.equal(normalizeDatadogSite(undefined), "app.datadoghq.com");
  for (const item of fixture.pupSites) assert.equal(pupSite(item.input), item.expected, item.input);
});
