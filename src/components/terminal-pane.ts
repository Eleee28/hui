/**
 * One of a session's shared terminals, drawn by Gespenst (Ghostty's VT in WebAssembly) inside a Work pane tab.
 * Gespenst parses and paints in a dedicated worker (WebGL2, falling back to Canvas 2D). The PTY lives in the gateway:
 * this element replays its snapshot, writes the socket's binary output straight into Gespenst as bytes, sends input
 * over the terminal socket and reconnects with backoff. It never fits the grid while the Work pane hides it and
 * resizes the PTY only once a measurable size has settled. It also owns the terminal's HUI theme colors (recolored
 * live), its fonts in the worker, link clicks, clipboard shortcuts, touch scrolling, the narrow/touch key bar and the
 * jump-to-bottom affordance. Hiding the tab or the pane leaves the terminal running; only "End terminal" stops it.
 * Tabs, closing and launching belong to the Work pane (`components/work-pane.ts`, `views/work/terminal.ts`).
 */
import { html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GespenstTerminal, TerminalBufferRow } from "@gespenst/core";
import "@gespenst/core/style.css";
import ghosttyWasm from "@gespenst/core/ghostty-vt.wasm?url";
import callbacksWasm from "@gespenst/core/ghostty-callbacks.wasm?url";
import { DEFAULT_TERMINAL_FONT, loadTerminalFont, terminalFontFaces, terminalFontStack, type FontSheet } from "../lib/terminal/font.ts";
import { HuiElement } from "../lit/hui-element.ts";
import { icons } from "../lib/icons.ts";
import { connectTerminal, endTerminal } from "../api/terminals.ts";
import type { TerminalView } from "../api/schema/terminals.ts";
import type { TerminalInput } from "../api/terminals.ts";
import { createTerminalStreamReader } from "../api/terminals.ts";
import { prepareReflow, ptyResize, skipHiddenFits, wrappedRowsAbove } from "../lib/terminal/fit.ts";
import { parseRgb, terminalTheme, type Rgb } from "../lib/terminal/theme.ts";
import { terminalLinkAt } from "../lib/terminal/links.ts";
import { clipboardKey, ControlLatch, controlModifiedText, TERMINAL_BAR_KEYS, type ControlState, type TerminalBarKey } from "../lib/terminal/keys.ts";
import { TerminalTouchGesture } from "../lib/terminal/touch.ts";
import { writeClipboardText } from "../lib/clipboard.ts";
import { APPLE_PLATFORM } from "../lib/shortcut-binding.ts";

type GespenstModule = typeof import("@gespenst/core");
let initialize: Promise<GespenstModule> | undefined;
function loadTerminal() {
  initialize ??= import("@gespenst/core").catch((error: unknown) => { initialize = undefined; throw error; });
  return initialize;
}

/** A size change is sent to the PTY once it has held this long, so dragging the pane edge redraws the shell once. */
const RESIZE_SETTLE_MS = 150;
const SCROLLBACK_LINES = 10_000;
const FONT_WAIT_MS = 1500;

let colorProbe: CanvasRenderingContext2D | null | undefined;
/** Any CSS color (oklch, color-mix, …) as sRGB channels, by painting one pixel; transparent yields the fallback. */
function cssColor(value: string, fallback: Rgb): Rgb {
  const parsed = parseRgb(value);
  if (parsed && !/rgba\([^)]*,\s*0\s*\)/u.test(value)) return parsed;
  colorProbe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!colorProbe || !value.trim()) return fallback;
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = "#000";
  colorProbe.fillStyle = value;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = colorProbe.getImageData(0, 0, 1, 1).data;
  return a ? { r, g, b } : fallback;
}

const stopTouchPointer = (event: PointerEvent) => {
  // Gespenst would treat a touch drag as a mouse selection; touch is handled as scrolling and taps instead.
  if (event.pointerType === "touch") event.stopPropagation();
};

@customElement("hui-terminal-pane")
export class TerminalPane extends HuiElement {
  @property() fontFamily = DEFAULT_TERMINAL_FONT;
  @property() ownerSessionId = "";
  @property() terminalId = "";
  @property({ type: Boolean }) visible = true;
  /** Take keyboard focus when the terminal opens (the operator just launched it). */
  @property({ type: Boolean }) active = true;
  /** The terminal was ended from this view; its tab should close. */
  @property({ attribute: false }) onEnded: (() => void) | undefined;
  /** Reports the gateway's view of the terminal (name, cwd, status) whenever it arrives. */
  @property({ attribute: false }) onTerminalView: ((view: TerminalView) => void) | undefined;
  @state() private terminalView: TerminalView | undefined;
  @state() private status = "Connecting…";
  @state() private error = "";
  @state() private truncated = false;
  @state() private busy = false;
  /** The viewport shows the newest output; otherwise "Jump to bottom" is offered. */
  @state() private atBottom = true;
  @state() private control: ControlState = "off";
  private module: GespenstModule | undefined;
  private terminal: GespenstTerminal | undefined;
  private socket: WebSocket | undefined;
  private generation = 0;
  private replaying = false;
  private ready = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  /** The size the PTY was last given (by a snapshot, a state frame or this view). */
  private sentSize = { cols: 0, rows: 0 };
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private themeObserver: MutationObserver | undefined;
  private themeFrame = 0;
  private themeQueue: Promise<void> = Promise.resolve();
  private loadedFaces = new Set<string>();
  private fontEpoch = 0;
  private selection = "";
  private rows: readonly TerminalBufferRow[] = [];
  private rowsReading = false;
  private rowsDirty = false;
  private rowsStale = true;
  private linkPress: { id: number; x: number; y: number; url: string } | undefined;
  private latch = new ControlLatch();
  private touch = new TerminalTouchGesture({
    scroll: (deltaY, clientX, clientY) => this.terminal?.element.dispatchEvent(new WheelEvent("wheel", { deltaY, clientX, clientY, cancelable: true })),
    tap: (clientX, clientY) => this.tap(clientX, clientY),
  });

  override updated(changed: PropertyValues) {
    if (changed.has("terminalId") || changed.has("ownerSessionId")) void this.start();
    else if (changed.has("visible") && this.visible) {
      this.fitTerminal();
      // Repaints rows a refit or a font change cleared while the view was hidden.
      this.scheduleTheme();
    }
    if (changed.has("fontFamily") && !changed.has("terminalId")) void this.applyFont();
  }

  override disconnectedCallback() { this.cleanup(); super.disconnectedCallback(); }

  private get surface() { return this.querySelector<HTMLElement>(".hui-terminal-surface"); }

  private cleanup() {
    ++this.generation;
    clearTimeout(this.retry);
    clearTimeout(this.resizeTimer);
    cancelAnimationFrame(this.themeFrame);
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.touch.cancel();
    this.ready = false;
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = undefined; }
    this.terminal?.dispose();
    this.terminal = undefined;
    this.loadedFaces.clear();
    this.selection = "";
    this.rows = [];
  }

  private theme() {
    const style = getComputedStyle(this);
    const background = cssColor(style.backgroundColor, { r: 0, g: 0, b: 0 });
    const foreground = cssColor(style.color, { r: 255, g: 255, b: 255 });
    return terminalTheme({ background, foreground, accent: cssColor(style.getPropertyValue("--accent"), foreground) });
  }

  /** Recolors an open terminal after the theme, mode or accent changed; one update at a time, latest wins. */
  private scheduleTheme = () => {
    cancelAnimationFrame(this.themeFrame);
    this.themeFrame = requestAnimationFrame(() => {
      const terminal = this.terminal;
      if (!terminal) return;
      this.themeQueue = this.themeQueue.then(async () => {
        if (this.terminal === terminal) await terminal.setTheme(this.theme());
      }).catch(() => {});
    });
  };

  /** Loads the stack's bundled faces into Gespenst's worker, then applies the family and repaints. */
  private async applyFont() {
    const terminal = this.terminal;
    if (!terminal) return;
    const stack = terminalFontStack(this.fontFamily);
    await loadTerminalFont(this.fontFamily);
    const faces = terminalFontFaces(this.fontFamily, document.styleSheets as unknown as Iterable<FontSheet>, document.baseURI)
      .filter((face) => !this.loadedFaces.has(face.source));
    await Promise.all(faces.map(async (face) => {
      this.loadedFaces.add(face.source);
      await terminal.loadFont(face).catch(() => { this.loadedFaces.delete(face.source); });
    }));
    if (this.terminal !== terminal || stack !== terminalFontStack(this.fontFamily)) return;
    // The worker's canvas keeps the fallbacks it resolved for a font string, so faces added afterwards stay unused
    // under the same string. A new string (alternately repeating the final generic family) resolves them again.
    await terminal.setFont({ family: ++this.fontEpoch % 2 ? `${stack}, monospace` : stack });
    // A new family clears the canvas without repainting it; reapplying the theme repaints every row.
    if (this.terminal === terminal) this.scheduleTheme();
  }

  private fitTerminal = () => {
    if (this.visible && this.ready) this.terminal?.fit();
  };

  /** Sends the grid to the PTY once it has settled and only while the pane can be measured. */
  private scheduleResize = () => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => void this.resizePty(), RESIZE_SETTLE_MS);
  };

  private async resizePty() {
    const terminal = this.terminal;
    if (!terminal || this.replaying || !this.ready) return;
    const size = ptyResize(this.surface, terminal.geometry, this.sentSize);
    if (!size) return;
    const oldCols = this.sentSize.cols;
    this.sentSize = size;
    if (size.cols !== oldCols) {
      // The shell redraws its prompt for the new width from where it began in the old layout; the emulator has
      // already reflowed it, so erase that copy and put the cursor where the shell's redraw will expect it.
      try {
        const { state } = await terminal.readBuffer({ start: 0, end: 0 });
        if (state.screen === "normal") {
          const cursor = state.scrollbackRows + state.cursorY;
          const { rows } = await terminal.readBuffer({ start: Math.max(0, cursor - 64), end: cursor + 1 });
          const rowsAbove = wrappedRowsAbove(rows, cursor);
          const line = rows.filter((row) => row.index >= cursor - rowsAbove && row.index <= cursor);
          const text = line.map((row, index) => index < line.length - 1 ? row.text : row.text.trimEnd()).join("");
          if (this.terminal === terminal) terminal.write(prepareReflow({ rowsAbove, cursorColumn: state.cursorX, cols: terminal.geometry.cols, text }, oldCols));
        }
      } catch { /* Disposed while reading: nothing to prepare. */ }
    }
    if (this.terminal === terminal && this.sentSize === size) this.send({ action: "resize", ...size });
  }

  private send(input: TerminalInput) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN || this.terminalView?.status !== "running" || this.replaying) return;
    this.socket.send(JSON.stringify(input));
  }

  private sendText(data: string) {
    // Paste is chunked on Unicode boundaries; a large paste never exceeds
    // the server's per-message limit or splits a surrogate pair.
    let chunk = "";
    for (const character of data) {
      chunk += character;
      if (chunk.length >= 4000) { this.send({ action: "input", data: chunk }); chunk = ""; }
    }
    if (chunk) this.send({ action: "input", data: chunk });
  }

  private async start() {
    this.cleanup();
    const generation = this.generation;
    this.status = "Connecting…";
    this.error = "";
    this.terminalView = undefined;
    this.atBottom = true;
    try {
      const module = this.module = await loadTerminal();
      await loadTerminalFont(this.fontFamily);
      if (generation !== this.generation || !this.isConnected) return;
      const terminal = await module.createTerminal({
        container: this.surface!, worker: "dedicated", renderer: "webgl2", wasm: ghosttyWasm, callbacksWasm,
        fontSizePx: 13, lineHeight: 1.1, fontFamily: terminalFontStack(this.fontFamily), defaultCursorBlink: true,
        scrollbackLines: SCROLLBACK_LINES, ariaLabel: "Shared terminal input", theme: this.theme(),
      });
      if (generation !== this.generation || !this.isConnected) { terminal.dispose(); return; }
      this.terminal = terminal;
      // A collapsed Work pane measures 0×0: keep the grid (and so the PTY) as it was.
      skipHiddenFits(terminal, () => this.surface);
      this.bind(terminal);
      // Prefer drawing the replay with the worker's fonts in place, but never wait long for them.
      await Promise.race([this.applyFont(), new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]);
      if (generation !== this.generation) return;
      this.themeObserver = new MutationObserver(this.scheduleTheme);
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-theme-mode", "data-theme-family", "data-theme-palette"] });
      if (this.active) terminal.focus();
      await this.connect(generation);
    } catch (error) {
      if (generation === this.generation) { this.error = error instanceof Error ? error.message : "Terminal unavailable."; this.status = "Disconnected"; }
    }
  }

  private bind(terminal: GespenstTerminal) {
    const decoder = new TextDecoder();
    terminal.on("input", ({ data, source }) => {
      let text = decoder.decode(data, { stream: true });
      if ((source === "key" || source === "text") && this.control !== "off" && text.length === 1) {
        if (this.latch.consume()) text = controlModifiedText(text);
        this.control = this.latch.state;
      }
      // Typing returns a scrolled-back viewport to the prompt, as native terminals do.
      if ((source === "key" || source === "text" || source === "paste") && !this.atBottom) terminal.scrollToBottom();
      this.sendText(text);
    });
    terminal.on("resize", this.scheduleResize);
    terminal.on("viewportChange", ({ state }) => {
      this.atBottom = state.screen === "alternate" || state.viewportY + state.viewportLength >= state.totalRows;
      // Rows for link lookups are read lazily on the next pointer move, not on every frame of output or scrolling.
      this.rowsStale = true;
    });
    terminal.on("selectionChange", () => {
      void terminal.getSelection().then((text) => { if (this.terminal === terminal) this.selection = text; }).catch(() => {});
    });
    const element = terminal.element;
    element.addEventListener("keydown", this.keydown, { capture: true });
    // Links: Gespenst paints into canvases, so read its cells under the pointer.
    element.addEventListener("pointerenter", () => void this.readRows());
    element.addEventListener("pointerleave", () => { element.style.cursor = ""; this.linkPress = undefined; });
    element.addEventListener("pointermove", (event) => {
      if (this.rowsStale) void this.readRows();
      element.style.cursor = this.linkAt(event.clientX, event.clientY) ? "pointer" : "";
    });
    element.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      const url = this.linkAt(event.clientX, event.clientY);
      if (url) {
        // A link press is neither mouse input for a full-screen program nor the start of a selection.
        this.linkPress = { id: event.pointerId, x: event.clientX, y: event.clientY, url };
        event.preventDefault();
        event.stopImmediatePropagation();
        terminal.focus();
      } else if (!event.shiftKey) terminal.clearSelection();
    }, { capture: true });
    element.addEventListener("pointerup", (event) => {
      const press = this.linkPress;
      this.linkPress = undefined;
      if (!press || press.id !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (Math.hypot(press.x - event.clientX, press.y - event.clientY) <= 10) window.open(press.url, "_blank", "noopener,noreferrer");
    }, { capture: true });
  }

  /** Refreshes the visible rows used for link lookups; one read at a time, repeated while they keep changing. */
  private async readRows() {
    this.rowsDirty = true;
    if (this.rowsReading) return;
    this.rowsReading = true;
    try {
      while (this.rowsDirty && this.terminal) {
        this.rowsDirty = false;
        this.rowsStale = false;
        this.rows = (await this.terminal.readBuffer()).rows;
      }
    } catch { /* Disposed while reading. */ } finally { this.rowsReading = false; }
  }

  private linkAt(clientX: number, clientY: number): string | undefined {
    const terminal = this.terminal;
    if (!terminal) return undefined;
    const bounds = terminal.element.getBoundingClientRect();
    const scale = Math.max(1, globalThis.devicePixelRatio || 1);
    const { cellWidthPx, cellHeightPx, cols } = terminal.geometry;
    const column = Math.floor((clientX - bounds.left) * scale / cellWidthPx);
    const row = this.rows[Math.floor((clientY - bounds.top) * scale / cellHeightPx)];
    return row && column >= 0 && column < cols ? terminalLinkAt(row, column) : undefined;
  }

  /** A completed touch tap: focus (inside the gesture, so the soft keyboard opens), then follow a link or click. */
  private tap(clientX: number, clientY: number) {
    const terminal = this.terminal;
    if (!terminal) return;
    terminal.focus();
    const url = this.linkAt(clientX, clientY);
    if (url) { window.open(url, "_blank", "noopener,noreferrer"); return; }
    const bounds = terminal.element.getBoundingClientRect();
    const scale = Math.max(1, globalThis.devicePixelRatio || 1);
    const point = { button: "left" as const, x: (clientX - bounds.left) * scale, y: (clientY - bounds.top) * scale, modifiers: 0, timeMs: performance.now() };
    terminal.sendPointer({ ...point, action: "press", anyButtonPressed: true });
    terminal.sendPointer({ ...point, action: "release", anyButtonPressed: false });
  }

  private async connect(generation: number) {
    const socket = await connectTerminal(this.ownerSessionId, this.terminalId);
    if (generation !== this.generation || !this.isConnected) { socket.close(); return; }
    this.socket = socket;
    const read = createTerminalStreamReader({
      snapshot: (frame, replay) => {
        const terminal = this.terminal;
        if (!terminal) return;
        this.retries = 0;
        this.replaying = true;
        // The replay rebuilds the screen and scrollback from the start.
        terminal.reset();
        terminal.resize(frame.terminal.cols, frame.terminal.rows);
        this.sentSize = { cols: frame.terminal.cols, rows: frame.terminal.rows };
        this.terminalView = frame.terminal;
        this.onTerminalView?.(frame.terminal);
        this.truncated = frame.truncated;
        void (replay.length ? terminal.writeAsync(replay) : Promise.resolve()).catch(() => {}).then(() => {
          if (generation !== this.generation) return;
          this.replaying = false;
          this.ready = true;
          this.fitTerminal();
        });
        this.status = frame.terminal.status === "running" ? "Connected" : "Exited";
        this.error = "";
      },
      output: (bytes) => { this.terminal?.write(bytes); },
      state: (view) => {
        const terminal = this.terminal;
        if (!terminal) return;
        this.terminalView = view;
        this.onTerminalView?.(view);
        this.status = view.status === "running" ? "Connected" : "Exited";
        this.sentSize = { cols: view.cols, rows: view.rows };
        terminal.resize(view.cols, view.rows);
      },
      error: (message) => { this.error = message; },
    });
    socket.onmessage = (message) => {
      if (generation !== this.generation || !this.terminal) return;
      read(message.data);
    };
    socket.onclose = () => {
      if (generation !== this.generation) return;
      this.ready = false;
      this.status = "Disconnected";
      if (++this.retries <= 5) {
        this.status = "Reconnecting…";
        this.retry = setTimeout(() => { void this.connect(generation).catch((error: unknown) => {
          if (generation !== this.generation) return;
          this.status = "Disconnected";
          this.error = error instanceof Error ? error.message : "Reconnect failed.";
        }); }, Math.min(1000 * 2 ** (this.retries - 1), 10_000));
      }
    };
    socket.onerror = () => {
      if (generation === this.generation) this.error = "Terminal connection lost. Input is disabled until reconnected.";
    };
  }

  private run = async (operation: () => Promise<void>) => {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try { await operation(); } catch (error) { this.error = error instanceof Error ? error.message : "Terminal operation failed."; }
    finally { this.busy = false; }
  };

  private end = () => this.run(async () => {
    await endTerminal(this.ownerSessionId, this.terminalId);
    this.cleanup();
    this.status = "Ended";
    this.onEnded?.();
  });

  private keydown = (event: KeyboardEvent) => {
    const action = clipboardKey(event, APPLE_PLATFORM);
    if (!action) return;
    // Keep Gespenst from encoding the key; the browser's copy and paste events do the work.
    event.stopPropagation();
    if (action === "copy-now") {
      event.preventDefault();
      if (this.selection) void writeClipboardText(this.selection);
    }
  };

  private copy = (event: ClipboardEvent) => {
    if (!this.selection || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", this.selection);
    event.preventDefault();
  };

  private pressKey(key: TerminalBarKey, event: MouseEvent) {
    const terminal = this.terminal;
    if (!terminal || !this.module) return;
    if (key.code === "Control") this.latch.tap(event.timeStamp);
    else {
      const control = this.latch.consume();
      if (key.code === "Escape" || key.code === "Tab") this.sendText(key.code === "Escape" ? "\u001b" : "\t");
      // Cursor keys go through Gespenst so they follow the program's cursor-key mode.
      else terminal.sendKey({ code: key.code, modifiers: control ? this.module.KeyModifiers.control : 0 });
    }
    this.control = this.latch.state;
    terminal.focus();
  }

  private jumpToBottom = () => {
    this.terminal?.scrollToBottom();
    this.terminal?.focus();
  };

  override render() {
    const cwd = this.terminalView?.cwd;
    const connected = this.status === "Connected";
    return html`<div class="hui-terminal-toolbar">
      <span class="hui-terminal-cwd" data-hui-tooltip=${cwd || nothing}>${cwd ?? "Terminal"}</span>
      <span class="hui-terminal-status" role="status" data-hui-tooltip="Shared with the agent in this conversation">Shared · ${this.status}${this.terminalView?.exitCode !== undefined ? ` · ${this.terminalView.exitCode}` : ""}</span>
      <wa-dropdown placement="bottom-end" @wa-select=${(event: CustomEvent<{ item: HTMLElement }>) => {
        if (event.detail.item.getAttribute("value") === "end") queueMicrotask(() => void this.end());
      }}>
        <button slot="trigger" type="button" class="btn btn--ghost btn--icon" aria-label="Terminal actions" data-hui-tooltip="Terminal actions" ?disabled=${this.busy}>${icons.moreHorizontal}</button>
        <wa-dropdown-item value="end">End terminal</wa-dropdown-item>
      </wa-dropdown>
    </div>
    ${this.error ? html`<div class="hui-terminal-error" role="alert">${this.error}</div>` : nothing}
    ${this.status === "Disconnected" ? html`<button type="button" class="btn hui-terminal-reconnect" @click=${() => { this.retries = 0; void this.start(); }}>Reconnect terminal</button>` : nothing}
    ${this.truncated ? html`<div class="hui-terminal-notice">Older output was trimmed from the replay.</div>` : nothing}
    <div class="hui-terminal-surface"
      @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
      @copy=${this.copy}
      @pointerdown=${{ handleEvent: stopTouchPointer, capture: true }}
      @pointermove=${{ handleEvent: stopTouchPointer, capture: true }}
      @pointerup=${{ handleEvent: stopTouchPointer, capture: true }}
      @touchstart=${{ handleEvent: (event: TouchEvent) => { this.touch.start(event); void this.readRows(); }, passive: true }}
      @touchmove=${{ handleEvent: (event: TouchEvent) => this.touch.move(event), passive: false }}
      @touchend=${{ handleEvent: (event: TouchEvent) => this.touch.end(event), passive: false }}
      @touchcancel=${() => this.touch.cancel()}></div>
    <div class="chat-scroll-to-bottom-wrap hui-terminal-jump">
      <button type="button" class="chat-scroll-to-bottom" data-visible=${String(!this.atBottom)} ?inert=${this.atBottom} aria-hidden=${String(this.atBottom)}
        aria-label="Jump to bottom" data-hui-tooltip="Jump to bottom" @click=${this.jumpToBottom}>${icons.arrowDown}</button>
    </div>
    <div class="hui-terminal-keys" role="toolbar" aria-label="Terminal keys">
      ${TERMINAL_BAR_KEYS.map((key) => html`<button type="button" class="btn btn--ghost btn--sm hui-terminal-key ${key.code === "Control" && this.control !== "off" ? "hui-terminal-key--on" : ""}"
        aria-label=${key.code === "Control" ? this.latch.label : key.name} aria-pressed=${key.code === "Control" ? String(this.control !== "off") : nothing}
        ?disabled=${!connected}
        @mousedown=${(event: MouseEvent) => { if (event.button === 0) event.preventDefault(); }}
        @click=${(event: MouseEvent) => this.pressKey(key, event)}>${key.label}</button>`)}
    </div>`;
  }
}
