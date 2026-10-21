/**
 * Single-key mnemonics for a session's dropdown menu (pin, rename, unread, archive, delete). They run the
 * matching item instead of Web Awesome's typeahead and stay out of text fields and submenus.
 */
import { closeDropdownOnEscape } from "../web-awesome.ts";

/** Menu mnemonics are actions, not Web Awesome typeahead navigation. */
const ACTIONS: Readonly<Record<string, string>> = { p: "pin", r: "rename", u: "unread", a: "archive", d: "delete" };

type ShortcutInput = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "repeat" | "isComposing">;

export function sessionMenuAction(event: ShortcutInput): string | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return undefined;
  return ACTIONS[event.key.toLowerCase()];
}

/** Capture runs before the dropdown's internal typeahead handler. */
export const sessionMenuShortcuts = {
  capture: true,
  handleEvent(event: KeyboardEvent): void {
    const dropdown = event.currentTarget as HTMLElement & { open: boolean };
    if (!dropdown.open) return;
    if (event.key === "Escape") { closeDropdownOnEscape(event); return; }
    const action = sessionMenuAction(event);
    if (!action) return;
    const path = event.composedPath();
    if (path.some((target) => {
      const element = target as Partial<HTMLElement>;
      return element.isContentEditable || ["input", "textarea", "select"].includes(element.localName ?? "")
        || element.getAttribute?.("slot") === "submenu";
    })) return;
    const item = dropdown.querySelector<HTMLElement & { disabled?: boolean }>(`:scope > wa-dropdown-item[value="${action}"]`);
    if (!item || item.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Use the existing selection path, including focus return and menu closing.
    item.click();
  },
};
