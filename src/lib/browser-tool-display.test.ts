import assert from "node:assert/strict";
import { test } from "vitest";
import { browserToolSummary } from "./browser-tool-display.ts";

test("browser tool rows summarize the action without page content", () => {
  assert.equal(browserToolSummary({ action: "open", url: "https://example.com/docs/intro?x=1" }), "open example.com/docs/intro");
  assert.equal(browserToolSummary({ action: "navigate", url: "http://127.0.0.1:5173/" }), "navigate 127.0.0.1:5173");
  assert.equal(browserToolSummary({ action: "open", url: "file:///tmp/report.html" }), "open file:///tmp/report.html");
  assert.equal(browserToolSummary({ action: "act", kind: "click", ref: "e4" }), "act click e4");
  assert.equal(browserToolSummary({ action: "act", kind: "press", key: "Enter" }), "act press Enter");
  assert.equal(browserToolSummary({ action: "act", kind: "wait", text: "Saved" }), "act wait Saved");
  assert.equal(browserToolSummary({ action: "close", tabId: "t2" }), "close t2");
  assert.equal(browserToolSummary({ action: "resize", width: 390, height: 844 }), "resize 390×844");
  assert.equal(browserToolSummary({ action: "snapshot" }), "snapshot");
  assert.equal(browserToolSummary({ action: "open", url: `https://example.com/${"a".repeat(200)}` }).length, 85);
  assert.equal(browserToolSummary(undefined), "");
  assert.equal(browserToolSummary({ url: "https://example.com" }), "");
});
