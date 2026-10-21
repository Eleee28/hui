/**
 * The terminal key bar shown on narrow and touch screens: Esc, Tab, a Ctrl latch and the arrows, keys a soft
 * keyboard lacks. One Ctrl tap applies Control to the next key only; a second tap within 400 ms locks it on until
 * tapped again. The terminal pane sends named keys through Gespenst (so cursor keys follow the application's mode)
 * and applies the latch to the next typed character. Also decides which clipboard shortcuts the browser handles.
 * Ported from AgentsInTheCloud (MIT) packages/observable-terminal/src/client/key-bar.ts and src/server/key-bar.ts.
 */

export type TerminalBarKey = { code: "Escape" | "Tab" | "Control" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"; label: string; name: string };

export const TERMINAL_BAR_KEYS: readonly TerminalBarKey[] = [
  { code: "Escape", label: "Esc", name: "Escape" },
  { code: "Tab", label: "Tab", name: "Tab" },
  { code: "Control", label: "Ctrl", name: "Control for next keystroke" },
  { code: "ArrowUp", label: "↑", name: "Up arrow" },
  { code: "ArrowDown", label: "↓", name: "Down arrow" },
  { code: "ArrowLeft", label: "←", name: "Left arrow" },
  { code: "ArrowRight", label: "→", name: "Right arrow" },
];

/** What Control turns typed text into: C0 control bytes for letters and @[\\]^_, DEL for ?, NUL for space. */
export function controlModifiedText(data: string): string {
  // Cursor keys can arrive in normal or application-cursor mode.
  if (/^\x1b(?:\[|O)[ABCD]$/.test(data)) return `\x1b[1;5${data.at(-1)}`;
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (data === "?") return "\x7f";
  if (data === " ") return "\x00";
  return data;
}

/** A second Ctrl tap within this window locks Ctrl on. */
export const CONTROL_DOUBLE_TAP_MS = 400;

export type ControlState = "off" | "next" | "locked";

export class ControlLatch {
  declare state: ControlState;
  declare private tappedAt: number;
  constructor() { this.state = "off"; this.tappedAt = Number.NEGATIVE_INFINITY; }

  /** The Ctrl key was tapped at `now` (ms). */
  tap(now: number): void {
    const doubleTap = now - this.tappedAt <= CONTROL_DOUBLE_TAP_MS;
    this.tappedAt = now;
    if (this.state === "off") this.state = "next";
    else if (this.state === "next" && doubleTap) this.state = "locked";
    else this.state = "off";
  }

  /** Whether Control applies to the key being sent; a one-shot latch turns off. */
  consume(): boolean {
    if (this.state === "off") return false;
    if (this.state === "next") this.state = "off";
    return true;
  }

  reset(): void { this.state = "off"; }

  get label(): string { return this.state === "locked" ? "Control, locked on" : "Control for next keystroke"; }
}

/** What a clipboard shortcut in the terminal should do; Gespenst would otherwise send Ctrl+V as input and copy only
 * through the async Clipboard API, which plain-HTTP LAN origins lack. */
export type ClipboardKey = "copy" | "copy-now" | "paste";
export type ClipboardKeyEvent = { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/**
 * `copy`: let the browser fire its copy event (⌘C), which the pane fills with the terminal selection. `copy-now`:
 * copy at once and keep the browser default (Ctrl+Shift+C opens DevTools in Chromium). `paste`: let the browser
 * paste (⌘V, Ctrl+Shift+V, and Ctrl+V off Apple platforms, where Ctrl+V stays a terminal key). Ctrl+C is always the
 * terminal's interrupt.
 */
export function clipboardKey(event: ClipboardKeyEvent, apple: boolean): ClipboardKey | undefined {
  if (event.altKey || (event.code !== "KeyC" && event.code !== "KeyV")) return undefined;
  const copy = event.code === "KeyC";
  if (event.metaKey && !event.ctrlKey) return apple ? (copy ? "copy" : "paste") : undefined;
  if (!event.ctrlKey || event.metaKey) return undefined;
  if (event.shiftKey) return copy ? "copy-now" : "paste";
  return !copy && !apple ? "paste" : undefined;
}
