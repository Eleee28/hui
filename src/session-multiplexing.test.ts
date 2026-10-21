import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

test("pane views are keyed independently of session and retain hidden session views", () => {
  const view = readFileSync(new URL("./components/session-multiplexer.ts", import.meta.url), "utf8");
  assert.ok(view.includes('repeat(stablePanes, (pane) => pane.id'));
  assert.match(view, /const stablePanes = \[\.\.\.panes\]\.sort/);
  assert.doesNotMatch(view, /repeat\(column\.panes/);
  assert.ok(view.includes('repeat(slots.get(pane.id)'));
  assert.ok(view.includes('?inert=${!visible || !current}'));
  assert.ok(view.includes('@pointerdown=${() => this.onFocusPane(pane.id)}'));
  assert.ok(view.includes('@focusin=${() => this.onFocusPane(pane.id)}'));
});

test("duplicate-session controls use pane-scoped ids", () => {
  const home = readFileSync(new URL("./views/home.ts", import.meta.url), "utf8");
  assert.ok(home.includes('props.controlScope ? `${props.controlScope}-`'));
  assert.ok(home.includes('renderActionTooltip(rewindTooltipId,'));
  assert.ok(home.includes('id=${id} role="tooltip"'));
});

test("the narrow panel selector uses the shared HUI picker instead of a native select", () => {
  const selector = readFileSync(new URL("./views/panel-selector.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles/terminal.css", import.meta.url), "utf8");
  assert.match(selector, /renderPicker\(\{/);
  assert.match(selector, /label: "Active panel"/);
  assert.doesNotMatch(selector, /<select/);
  assert.doesNotMatch(css, /\.hui-panel-selector select/);
});
