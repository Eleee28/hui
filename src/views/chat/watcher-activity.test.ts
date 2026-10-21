import assert from "node:assert/strict";
import { test } from "vitest";
import { renderWatcherActivity, watcherTargetLabel, type WatcherActivityProps } from "./watcher-activity.ts";
import type { Watcher } from "../../api/watchers.ts";

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "strings" in value && "values" in value) {
    const template = value as { strings: readonly string[]; values: unknown[] };
    return template.strings.map((part, i) => part + text(template.values[i])).join("");
  }
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

const running: Watcher = {
  id: "w1",
  purpose: "Wait for #21532 approval",
  target: "https://github.com/ddoghq/web-ui/pull/21532",
  outcome: "post /merge",
  command: "bash merge-21532.sh",
  logPath: "/Users/dani/.config/hui/watchers/w1.log",
  state: "running",
  pid: 4242,
  startedAt: "2026-10-02T10:00:00.000Z",
  lastLine: "2026-10-02 10:05:00 OPEN REVIEW_REQUIRED",
};

function render(watchers: Watcher[], overrides: Partial<WatcherActivityProps> = {}): string {
  const noop = () => {};
  return text(renderWatcherActivity({
    watchers, pendingId: "", log: null, expanded: new Set(),
    onGroupToggle: noop, onToggle: noop, onStop: noop, onRestart: noop, onDismiss: noop,
    ...overrides,
  }));
}

test("a closed watcher is one row: purpose, latest output and state, no controls", () => {
  const row = render([running]);
  assert.match(row, /Wait for #21532 approval/u);
  assert.match(row, /OPEN REVIEW_REQUIRED/u);
  assert.match(row, /Running · /u);
  assert.doesNotMatch(row, /chat-subagents--group/u);
  assert.doesNotMatch(row, />Stop</u);
  assert.doesNotMatch(row, /Then: post \/merge/u);
});

test("an opened running row shows its details, log tail and Stop", () => {
  const opened = render([running], {
    expanded: new Set(["watcher:w1"]),
    log: { id: "w1", lines: ["first", "second"], truncated: false, loading: false },
  });
  assert.match(opened, /github\.com\/ddoghq\/web-ui\/pull\/21532/u);
  assert.match(opened, /Then: post \/merge/u);
  assert.match(opened, /<pre>first\nsecond<\/pre>/u);
  assert.match(opened, /PID 4242 · \/Users\/dani\/\.config\/hui\/watchers\/w1\.log/u);
  assert.match(opened, />Stop</u);
  assert.doesNotMatch(opened, />Restart</u);
});

test("an opened dead row explains itself and offers Restart and Dismiss", () => {
  const dead = render([{ ...running, state: "dead", lastLine: "" }], { expanded: new Set(["watcher:w1"]) });
  assert.match(dead, /Dead/u);
  assert.match(dead, /recorded no exit status/u);
  assert.match(dead, /No output yet\./u);
  assert.match(dead, />Restart</u);
  assert.match(dead, />Dismiss</u);
  assert.doesNotMatch(dead, />Stop</u);
});

test("several watchers collapse into one summary line", () => {
  const group = render([running, { ...running, id: "w2", purpose: "Post /merge", state: "done" }]);
  assert.match(group, /chat-subagents--group/u);
  assert.match(group, /2 watchers/u);
  assert.match(group, /1 running · Wait for #21532 approval/u);
  assert.equal(render([]), "");
});

test("watcherTargetLabel strips the scheme and clamps long URLs", () => {
  assert.equal(watcherTargetLabel("https://www.github.com/o/r/pull/1"), "github.com/o/r/pull/1");
  assert.equal(watcherTargetLabel(`https://example.com/${"x".repeat(120)}`).length, 78);
});
