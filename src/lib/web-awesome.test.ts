import assert from "node:assert/strict";
import { test } from "vitest";
import { closeDropdownOnEscape, hasOpenWebAwesomePopup } from "./web-awesome.ts";

test("an open shadow popup owns dismissal before the enclosing view", () => {
  for (const localName of ["wa-select", "wa-dropdown"]) {
    const event = { composedPath: () => [{ localName: "input" }, { localName, open: true }, {}] } as unknown as Event;
    assert.equal(hasOpenWebAwesomePopup(event), true);
  }
});

test("closed controls and unrelated open elements do not claim Escape", () => {
  const event = { composedPath: () => [{ localName: "wa-select", open: false }, { localName: "details", open: true }, {}] } as unknown as Event;
  assert.equal(hasOpenWebAwesomePopup(event), false);
});

function escapeEvent(key: string, open: boolean) {
  const calls: string[] = [];
  const popup = {
    open,
    querySelector: () => ({ focus: () => calls.push("focus trigger") }),
  };
  const event = {
    key, currentTarget: popup,
    preventDefault: () => calls.push("prevent default"),
    stopPropagation: () => calls.push("stop propagation"),
  } as unknown as KeyboardEvent;
  return { event, popup, calls };
}

test("Escape closes only the inner popup and returns focus before an enclosing Settings/drawer handler", () => {
  const { event, popup, calls } = escapeEvent("Escape", true);
  closeDropdownOnEscape(event);
  assert.equal(popup.open, false);
  assert.deepEqual(calls, ["prevent default", "stop propagation", "focus trigger"]);
});

test("Escape from an already-closed popup can reach the enclosing surface", () => {
  const { event, popup, calls } = escapeEvent("Escape", false);
  closeDropdownOnEscape(event);
  assert.equal(popup.open, false);
  assert.deepEqual(calls, []);
});

test("Tab and arrow keys stay owned by Web Awesome", () => {
  for (const key of ["Tab", "ArrowUp", "ArrowDown", "Home", "End", "Enter"]) {
    const { event, popup, calls } = escapeEvent(key, true);
    closeDropdownOnEscape(event);
    assert.equal(popup.open, true);
    assert.deepEqual(calls, []);
  }
});
