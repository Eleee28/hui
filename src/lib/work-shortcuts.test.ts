import assert from "node:assert/strict";
import { test } from "vitest";
import { ariaShortcut, formatShortcut, shortcutChord } from "./shortcut-binding.ts";
import { AVOIDED_SHORTCUTS, avoidedShortcut, WORK_SHORTCUTS } from "./work-shortcuts.ts";

const bindings = Object.entries(WORK_SHORTCUTS);

test("every Work pane shortcut is Mod+Alt+Shift plus a letter, and no two share one", () => {
  for (const [action, binding] of bindings) assert.match(binding, /^Mod\+Alt\+Shift\+Key[A-Z]$/u, action);
  assert.equal(new Set(bindings.map(([, binding]) => binding)).size, bindings.length);
});

test("no Work pane shortcut uses a chord a browser, desktop, editor or HUI already takes", () => {
  for (const [action, binding] of bindings) {
    for (const apple of [true, false]) {
      const taken = avoidedShortcut(binding, apple);
      assert.equal(taken, undefined, `${action} (${formatShortcut(binding, apple)}) is taken: ${taken?.taken}`);
    }
  }
});

test("the avoided table catches the chords that broke the old Mod+Alt scheme", () => {
  assert.match(avoidedShortcut("Mod+Alt+KeyW", true)?.taken ?? "", /Safari/u);
  assert.match(avoidedShortcut("Mod+Alt+KeyB", true)?.taken ?? "", /Chrome/u);
  assert.match(avoidedShortcut("Mod+Alt+KeyT", false)?.taken ?? "", /GNOME/u);
  assert.match(avoidedShortcut("Mod+Alt+KeyF", true)?.taken ?? "", /search/u);
  assert.match(avoidedShortcut("Mod+Alt+Shift+KeyV", true)?.taken ?? "", /Paste and Match Style/u);
  assert.equal(avoidedShortcut("Mod+Alt+KeyT", true)?.platform, "apple", "each platform is checked against its own chords");
  assert.equal(avoidedShortcut("Mod+Alt+KeyB", false), undefined);
  for (const entry of AVOIDED_SHORTCUTS) assert.match(entry.chord, /^(Meta|Control)(\+Alt)?(\+Shift)?\+[A-Z]\w+$/u, entry.chord);
});

test("the scheme reads as each platform writes it", () => {
  assert.equal(formatShortcut(WORK_SHORTCUTS.terminal, true), "⌥⇧⌘T");
  assert.equal(formatShortcut(WORK_SHORTCUTS.terminal, false), "Ctrl+Alt+Shift+T");
  assert.equal(formatShortcut(WORK_SHORTCUTS.togglePane, true), "⌥⇧⌘P");
  assert.equal(formatShortcut(WORK_SHORTCUTS.maximizePane, true), "⌥⇧⌘M");
  assert.equal(formatShortcut(WORK_SHORTCUTS.maximizePane, false), "Ctrl+Alt+Shift+M");
  assert.equal(formatShortcut(WORK_SHORTCUTS.files, false), "Ctrl+Alt+Shift+F");
  assert.equal(formatShortcut(WORK_SHORTCUTS.vscode, true), "⌥⇧⌘C");
  assert.equal(formatShortcut(WORK_SHORTCUTS.diff, true), "⌥⇧⌘D");
  assert.equal(formatShortcut(WORK_SHORTCUTS.diff, false), "Ctrl+Alt+Shift+D");
  assert.equal(ariaShortcut(WORK_SHORTCUTS.browser, true), "Meta+Alt+Shift+B");
  assert.equal(ariaShortcut(WORK_SHORTCUTS.browser, false), "Control+Alt+Shift+B");
  assert.equal(shortcutChord(WORK_SHORTCUTS.browser, false), "Control+Alt+Shift+KeyB");
});
