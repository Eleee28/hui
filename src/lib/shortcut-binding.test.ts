import assert from "node:assert/strict";
import { test } from "vitest";
import { ariaShortcut, formatShortcut, matchesShortcut, shortcutChord, type ShortcutEvent } from "./shortcut-binding.ts";

const press = (code: string, modifiers: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, repeat: false, ...modifiers,
});

test("Mod is Command on Apple platforms and Ctrl elsewhere; the key matches by position", () => {
  assert.equal(matchesShortcut(press("KeyT", { metaKey: true, altKey: true }), "Mod+Alt+KeyT", true), true);
  assert.equal(matchesShortcut(press("KeyT", { ctrlKey: true, altKey: true }), "Mod+Alt+KeyT", true), false);
  assert.equal(matchesShortcut(press("KeyT", { ctrlKey: true, altKey: true }), "Mod+Alt+KeyT", false), true);
  assert.equal(matchesShortcut(press("KeyT", { metaKey: true, altKey: true }), "Mod+Alt+KeyT", false), false);
  // Exact modifiers only: no extra Shift, no missing Alt, no both Ctrl and Command.
  assert.equal(matchesShortcut(press("KeyT", { metaKey: true, altKey: true, shiftKey: true }), "Mod+Alt+KeyT", true), false);
  assert.equal(matchesShortcut(press("KeyT", { metaKey: true }), "Mod+Alt+KeyT", true), false);
  assert.equal(matchesShortcut(press("KeyT", { metaKey: true, ctrlKey: true, altKey: true }), "Mod+Alt+KeyT", true), false);
  assert.equal(matchesShortcut(press("KeyB", { metaKey: true, altKey: true }), "Mod+Alt+KeyT", true), false);
});

test("AltGr presses that type, repeats, composition and handled presses never trigger a shortcut", () => {
  const altGraph = (key: string) => key === "AltGraph";
  const altGr = press("KeyT", { ctrlKey: true, altKey: true, getModifierState: altGraph });
  assert.equal(matchesShortcut(altGr, "Mod+Alt+KeyT", false), false, "without the typed key it counts as text");
  // Spanish layout on Windows: Ctrl+Alt is AltGr, so Ctrl+Alt+E types € and stays text …
  assert.equal(matchesShortcut(press("KeyE", { ctrlKey: true, altKey: true, key: "€", getModifierState: altGraph }), "Mod+Alt+KeyE", false), false);
  assert.equal(matchesShortcut(press("KeyE", { ctrlKey: true, altKey: true, key: "Dead", getModifierState: altGraph }), "Mod+Alt+KeyE", false), false);
  // … while a chord that types nothing on that layout is still the shortcut.
  assert.equal(matchesShortcut(press("KeyT", { ctrlKey: true, altKey: true, shiftKey: true, key: "T", getModifierState: altGraph }), "Mod+Alt+Shift+KeyT", false), true);
  assert.equal(matchesShortcut(press("KeyT", { ctrlKey: true, altKey: true, key: "t", getModifierState: altGraph }), "Mod+Alt+KeyT", false), true);
  assert.equal(matchesShortcut(press("KeyT", { metaKey: true, altKey: true, key: "†", getModifierState: altGraph }), "Mod+Alt+KeyT", true), true, "Apple platforms have no AltGr rule");
  assert.equal(matchesShortcut(press("KeyT", { ctrlKey: true, altKey: true, repeat: true }), "Mod+Alt+KeyT", false), false);
  assert.equal(matchesShortcut(press("KeyT", { ctrlKey: true, altKey: true, isComposing: true }), "Mod+Alt+KeyT", false), false);
  assert.equal(matchesShortcut(press("KeyT", { ctrlKey: true, altKey: true, defaultPrevented: true }), "Mod+Alt+KeyT", false), false);
  assert.equal(matchesShortcut(press("KeyT"), "Hyper+KeyT", false), false, "unknown modifiers never match");
});

test("bindings read as each platform writes them", () => {
  assert.equal(formatShortcut("Mod+Alt+KeyT", true), "⌥⌘T");
  assert.equal(formatShortcut("Mod+Alt+KeyT", false), "Ctrl+Alt+T");
  assert.equal(formatShortcut("Mod+Shift+Comma", true), "⇧⌘,");
  assert.equal(formatShortcut("Mod+Alt+Shift+KeyT", true), "⌥⇧⌘T", "Apple's ⌃⌥⇧⌘ order");
  assert.equal(formatShortcut("Mod+Alt+Shift+KeyT", false), "Ctrl+Alt+Shift+T");
  assert.equal(shortcutChord("Mod+Alt+Shift+KeyT", true), "Meta+Alt+Shift+KeyT");
  assert.equal(shortcutChord("Mod+Alt+KeyT", false), "Control+Alt+KeyT");
  assert.equal(shortcutChord("Hyper+KeyT", false), "");
  assert.equal(formatShortcut("Mod+Alt+Digit1", false), "Ctrl+Alt+1");
  assert.equal(ariaShortcut("Mod+Alt+KeyW", true), "Meta+Alt+W");
  assert.equal(ariaShortcut("Mod+Alt+KeyW", false), "Control+Alt+W");
});
