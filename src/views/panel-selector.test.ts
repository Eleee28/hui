import assert from "node:assert/strict";
import { test } from "vitest";
import { html } from "lit";
import { panelSelectorOptions } from "./panel-selector.ts";

const icon = html`<svg width="16" height="16"></svg>`;
const strip = (options: ReturnType<typeof panelSelectorOptions>) => options.map(({ value, label, description, disabled }) => ({ value, label, description, ...(disabled ? { disabled } : {}) }));

test("narrow screens list the chat panes, the open Work views and the launchers, each with its own prefix", () => {
  const options = panelSelectorOptions({
    panes: [{ id: "p1", sessionId: "a" }, { id: "p2", sessionId: "b" }],
    sessionTitle: (id) => ({ a: "Alpha" } as Record<string, string>)[id],
    workViews: [{ key: "terminal:t1", title: "Terminal 1", icon }, { key: "browser", title: "Browser", icon }],
    launchers: [{ kind: "terminal", label: "New terminal", icon }, { kind: "browser", label: "Browser", icon, unavailable: "The managed browser is off." }],
  });
  assert.deepEqual(strip(options), [
    { value: "pane:p1", label: "1 · Chat", description: "Alpha" },
    { value: "pane:p2", label: "2 · Chat", description: "Session" },
    { value: "work:terminal:t1", label: "Terminal 1", description: "Work" },
    { value: "work:browser", label: "Browser", description: "Work" },
    { value: "launch:terminal", label: "New terminal", description: "Open" },
    { value: "launch:browser", label: "Browser", description: "The managed browser is off.", disabled: true },
  ]);
});

test("a single chat with nothing open still reaches the empty Work destination", () => {
  const options = panelSelectorOptions({
    panes: [{ id: "p1", sessionId: "a" }],
    sessionTitle: () => "Alpha",
    workViews: [],
    launchers: [],
  });
  assert.deepEqual(strip(options), [
    { value: "pane:p1", label: "Chat", description: "Alpha" },
    { value: "work:", label: "Work", description: "Nothing open" },
  ]);
});
