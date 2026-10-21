import assert from "node:assert/strict";
import { test } from "vitest";
import { commandToolPresentation } from "./command-tool-card.ts";
import { renderHighlightedCommand } from "./command-highlight.ts";

test("command rows use the original compact preamble while preserving full input", () => {
  const command = "cd '/tmp/fixture path' && printf '%s\\n' 'quoted ; && |' 42 | head -n 2";
  const view = commandToolPresentation({ kind: "tool", id: "c1", name: "bash", args: { command, timeout: 30 } });
  assert.deepEqual(view, { command, preview: "printf '%s\\n' 'quoted ; && |' 42 | head -n 2", extras: [["timeout", 30]] });
});

test("command previews unwrap shell wrappers, bound text and retain invalid inputs elsewhere", () => {
  assert.equal(commandToolPresentation({ kind: "tool", id: "c1", name: "bash", args: { command: "bash -lc 'printf 1'" } })?.command, "printf 1");
  assert.equal(commandToolPresentation({ kind: "tool", id: "c1", name: "bash", args: { command: "  printf 1\n" } })?.command, "  printf 1\n");
  assert.equal(commandToolPresentation({ kind: "tool", id: "c1", name: "bash", args: { command: "a".repeat(199) + "🦀x" } })?.preview, "a".repeat(199));
  assert.equal(commandToolPresentation({ kind: "tool", id: "c1", name: "bash", args: { command: "  " } }), null);
});

test("every transcript re-render reuses a command row's parsed preview", () => {
  // Keystrokes, streamed tokens and the 3s poll re-render the whole transcript;
  // re-parsing every command made typing lag on long sessions.
  const item = { kind: "tool" as const, id: "c1", name: "bash", args: { command: "cd /tmp && ls" } };
  const view = commandToolPresentation(item);
  assert.equal(commandToolPresentation(item), view);
  // A changed row is a new item, so it never shows the old command.
  assert.equal(commandToolPresentation({ ...item, args: { command: "pwd" } })?.preview, "pwd");
});

test("the original display highlighter bounds work and does not interpret shell input", () => {
  const source = "x".repeat(2001);
  assert.deepEqual(renderHighlightedCommand(source).values, [source]);
  const result = renderHighlightedCommand("printf --help 'quoted' 42 | head");
  const tokens = result.values[0] as Array<{ values: unknown[] }>;
  assert.deepEqual(tokens.filter((part) => part.values.length === 2).map((part) => part.values), [
    ["name", "printf"], ["flag", "--help"], ["str", "'quoted'"], ["num", "42"], ["op", "|"], ["name", "head"],
  ]);
});
