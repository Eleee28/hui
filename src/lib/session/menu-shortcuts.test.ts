import assert from "node:assert/strict";
import { test } from "vitest";
import { sessionMenuAction, sessionMenuShortcuts } from "./menu-shortcuts.ts";

const key = (value: string) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false });

test("displayed session menu mnemonics map to actions, in either case", () => {
  for (const [letter, action] of [["p", "pin"], ["r", "rename"], ["u", "unread"], ["a", "archive"], ["d", "delete"]]) {
    assert.equal(sessionMenuAction(key(letter!)), action);
    assert.equal(sessionMenuAction(key(letter!.toUpperCase())), action);
  }
  for (const value of ["ArrowDown", "Enter", "Tab", "Escape", "x"]) assert.equal(sessionMenuAction(key(value)), undefined);
});

test("modified, composing and repeated keys do not activate menu actions", () => {
  for (const flag of ["ctrlKey", "metaKey", "altKey", "repeat", "isComposing"]) {
    assert.equal(sessionMenuAction({ ...key("a"), [flag]: true }), undefined);
  }
});

function menuEvent(options: { open?: boolean; disabled?: boolean; path?: unknown[] } = {}) {
  let clicks = 0;
  let prevented = 0;
  let stopped = 0;
  const event = {
    ...key("a"),
    currentTarget: { open: options.open ?? true, querySelector: (selector: string) => {
      assert.equal(selector, ':scope > wa-dropdown-item[value="archive"]');
      return { disabled: options.disabled, click: () => clicks++ };
    } },
    composedPath: () => options.path ?? [],
    preventDefault: () => prevented++,
    stopImmediatePropagation: () => stopped++,
  } as unknown as KeyboardEvent;
  return { event, result: () => ({ clicks, prevented, stopped }) };
}

test("the capture handler activates the item once and prevents typeahead", () => {
  const fixture = menuEvent();
  assert.equal(sessionMenuShortcuts.capture, true);
  sessionMenuShortcuts.handleEvent(fixture.event);
  assert.deepEqual(fixture.result(), { clicks: 1, prevented: 1, stopped: 1 });
});

test("closed menus, disabled actions, text entry and submenus keep their native keys", () => {
  for (const options of [
    { open: false }, { disabled: true }, { path: [{ localName: "input" }] },
    { path: [{ isContentEditable: true }] },
    { path: [{ getAttribute: (name: string) => name === "slot" ? "submenu" : null }] },
  ]) {
    const fixture = menuEvent(options);
    sessionMenuShortcuts.handleEvent(fixture.event);
    assert.deepEqual(fixture.result(), { clicks: 0, prevented: 0, stopped: 0 });
  }
});
