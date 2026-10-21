import assert from "node:assert/strict";
import { test } from "vitest";

import { parseDatadogUrl } from "./markdown/datadog-links.ts";
import { datadogPreviewMessage, formatDatadogRange } from "./datadog.ts";

const ref = (url: string) => parseDatadogUrl(url)!;

test("says why a card has no graph and when its graph is from", () => {
  const share = ref("https://app.datadoghq.com/s/a/b");
  const widget = ref("https://acme.datadoghq.com/dashboard/abc-123-xyz?tile_focus=1");
  assert.equal(datadogPreviewMessage(share, { url: share.url, error: "not_found" }), "This share link is not available.");
  assert.equal(datadogPreviewMessage(widget, { url: widget.url, error: "not_found" }), "Not found in your Datadog orgs for acme.datadoghq.com.");
  assert.equal(datadogPreviewMessage(widget, { url: widget.url, error: "no_org" }), "Add a Datadog org for acme.datadoghq.com in Settings → Integrations to preview it.");
  assert.equal(datadogPreviewMessage(widget, { url: widget.url, error: "signed_out", signIn: { name: "", site: "dd.datad0g.com" } }), "Sign in to pup's default session for dd.datad0g.com to preview it.");
  assert.equal(datadogPreviewMessage(widget, { url: widget.url, preview: { kind: "widget", url: widget.url, title: "t" } }), "Datadog could not draw this widget.");
  assert.equal(datadogPreviewMessage(widget, { url: widget.url, preview: { kind: "widget", url: widget.url, title: "t", image: "data:image/png;base64,x" } }), "");
  assert.equal(formatDatadogRange(0, 1, true), "Past 1 hour");
  // Local time in the reader's own format; the date appears once for a range within one day.
  const from = new Date(2026, 9, 16, 10, 20).getTime();
  const day = (time: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(time);
  const sameDay = formatDatadogRange(from, from + 3_600_000);
  assert.equal(sameDay.split(day(from)).length - 1, 1, sameDay);
  assert.match(sameDay, /10:20.*–.*11:20/u);
  assert.match(formatDatadogRange(from, from + 86_400_000), new RegExp(`^${day(from)}, .+ – ${day(from + 86_400_000)}, `, "u"));
});
