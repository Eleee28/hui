import assert from "node:assert/strict";
import { test } from "vitest";
import { clipboardKey, ControlLatch, controlModifiedText, TERMINAL_BAR_KEYS } from "./keys.ts";

test("the key bar offers Esc, Tab, Ctrl and the arrows", () => {
  assert.deepEqual(TERMINAL_BAR_KEYS.map(({ label }) => label), ["Esc", "Tab", "Ctrl", "↑", "↓", "←", "→"]);
});

test("Control maps typed characters onto terminal control input", () => {
  assert.equal(controlModifiedText("c"), "\x03");
  assert.equal(controlModifiedText("C"), "\x03");
  assert.equal(controlModifiedText("["), "\x1b");
  assert.equal(controlModifiedText("?"), "\x7f");
  assert.equal(controlModifiedText(" "), "\x00");
  assert.equal(controlModifiedText("\x1b[A"), "\x1b[1;5A");
  assert.equal(controlModifiedText("\x1bOD"), "\x1b[1;5D");
  for (const data of ["1", "ab", "\t", "\x1b", "\x1b[1;5A"]) assert.equal(controlModifiedText(data), data, "left alone, so a key sent with Control is not changed twice");
});

test("one Ctrl tap applies to the next key; a double tap locks it until tapped again", () => {
  const latch = new ControlLatch();
  assert.equal(latch.consume(), false);
  latch.tap(1000);
  assert.equal(latch.state, "next");
  assert.equal(latch.consume(), true);
  assert.equal(latch.consume(), false, "one-shot");

  latch.tap(2000);
  latch.tap(2300);
  assert.equal(latch.state, "locked");
  assert.equal(latch.label, "Control, locked on");
  assert.equal(latch.consume(), true);
  assert.equal(latch.consume(), true, "stays on");
  latch.tap(5000);
  assert.equal(latch.state, "off");

  latch.tap(6000);
  latch.tap(7000);
  assert.equal(latch.state, "off", "a slow second tap turns it off instead of locking");
  latch.tap(8000);
  latch.reset();
  assert.equal(latch.state, "off");
});

test("clipboard shortcuts copy and paste through the browser; Ctrl+C stays the interrupt", () => {
  const key = (code: string, modifiers: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
  assert.equal(clipboardKey(key("KeyC", { metaKey: true }), true), "copy");
  assert.equal(clipboardKey(key("KeyV", { metaKey: true }), true), "paste");
  assert.equal(clipboardKey(key("KeyC", { ctrlKey: true }), true), undefined);
  assert.equal(clipboardKey(key("KeyV", { ctrlKey: true }), true), undefined, "Ctrl+V is a terminal key on a Mac");
  assert.equal(clipboardKey(key("KeyC", { ctrlKey: true }), false), undefined);
  assert.equal(clipboardKey(key("KeyV", { ctrlKey: true }), false), "paste");
  assert.equal(clipboardKey(key("KeyC", { ctrlKey: true, shiftKey: true }), false), "copy-now");
  assert.equal(clipboardKey(key("KeyV", { ctrlKey: true, shiftKey: true }), false), "paste");
  assert.equal(clipboardKey(key("KeyV", { ctrlKey: true, altKey: true }), false), undefined);
  assert.equal(clipboardKey(key("KeyX", { ctrlKey: true }), false), undefined);
  assert.equal(clipboardKey(key("KeyC", { metaKey: true }), false), undefined, "the Windows key is not a copy modifier");
});
