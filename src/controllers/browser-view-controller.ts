/**
 * Lit controller behind every live view of a conversation's browser tabs. It owns the live-view socket and
 * its reconnects, the decoded frames as object URLs, and a small cross-view cache of each conversation's newest
 * frame so a remounted view paints at once. Layout and wording stay in `lib/browser-view.ts`.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { decodeBrowserFrame, parseBrowserViewMessage } from "../api/browser.ts";
import type { BrowserViewAction, BrowserViewState } from "../api/schema/browser.ts";
import { pointPosition, type BrowserViewConnection, type PreviewFrame } from "../lib/browser-view.ts";

/** `stream` follows the page while it repaints; `snapshot` takes the current
 * frame once and disconnects, for a view nobody is actively watching. */
export type BrowserViewMode = "stream" | "snapshot";

/** A frame ready for an `<img>`; `src` is an object URL this controller owns. */
export type BrowserFrameImage = PreviewFrame & { src: string; width: number; height: number };

export type BrowserViewSocketFactory = (sessionId: string) => Promise<WebSocket>;

const POINTER_MS = 1_600;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 5;
const RECENT_LIMIT = 16;

type RecentFrame = PreviewFrame & { blob: Blob; width: number; height: number };

/** The newest frame per conversation, shared by every view of it, so a view
 * that remounts (a re-render, a new turn, a reopened panel) shows the page at
 * once. Blobs, not object URLs: each controller creates and revokes its own. */
const recent = new Map<string, RecentFrame>();

function remember(sessionId: string, frame: RecentFrame): void {
  recent.delete(sessionId);
  recent.set(sessionId, frame);
  const oldest = recent.keys().next();
  if (recent.size > RECENT_LIMIT && !oldest.done) recent.delete(oldest.value);
}

/** Test isolation only. */
export function forgetRecentBrowserFrames(): void {
  recent.clear();
}

/**
 * One view of a conversation's managed-browser tabs over the live-view socket:
 * its state, the latest frame, the latest agent action and a short-lived
 * marker where the agent clicked. The last frame survives disconnecting.
 */
export class BrowserViewController implements ReactiveController {
  view: BrowserViewState | undefined;
  connection: BrowserViewConnection = "idle";
  frame: BrowserFrameImage | undefined;
  action: BrowserViewAction | undefined;
  pointer: { left: number; top: number; key: number } | undefined;
  readonly #host: ReactiveControllerHost;
  readonly #open: BrowserViewSocketFactory;
  #sessionId = "";
  #mode: BrowserViewMode | undefined;
  #socket: WebSocket | undefined;
  #generation = 0;
  #retries = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #pointerTimer: ReturnType<typeof setTimeout> | undefined;
  #snapshotTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: ReactiveControllerHost, open: BrowserViewSocketFactory) {
    this.#host = host;
    this.#open = open;
    host.addController(this);
  }

  /** The current connection's purpose; undefined while idle or given up. */
  get mode(): BrowserViewMode | undefined {
    return this.#mode;
  }

  hostDisconnected(): void {
    this.disconnect();
    this.#setFrame(undefined);
  }

  connect(sessionId: string, mode: BrowserViewMode): void {
    if (sessionId === this.#sessionId && mode === this.#mode && this.connection !== "disconnected") return;
    this.disconnect();
    if (sessionId !== this.#sessionId) {
      this.#sessionId = sessionId;
      this.view = undefined;
      this.action = undefined;
      const cached = recent.get(sessionId);
      this.#setFrame(cached ? { ...this.#describe(cached), src: URL.createObjectURL(cached.blob) } : undefined);
    }
    this.#mode = mode;
    this.#retries = 0;
    const generation = this.#generation;
    if (mode === "snapshot") this.#snapshotTimer = setTimeout(() => { if (generation === this.#generation) this.disconnect(); }, SNAPSHOT_TIMEOUT_MS);
    void this.#attempt(generation);
  }

  /** Stop receiving; the last frame, state and action stay. */
  disconnect(): void {
    this.#generation += 1;
    clearTimeout(this.#retry);
    clearTimeout(this.#snapshotTimer);
    clearTimeout(this.#pointerTimer);
    this.pointer = undefined;
    this.#mode = undefined;
    if (this.#socket) {
      this.#socket.onmessage = null;
      this.#socket.onclose = null;
      this.#socket.close();
      this.#socket = undefined;
    }
    this.connection = "idle";
    this.#host.requestUpdate();
  }

  /** Watch one of the conversation's tabs; null follows the agent. */
  select(tabId: string | null): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify({ action: "select", tabId }));
  }

  async #attempt(generation: number): Promise<void> {
    this.connection = this.#retries ? "reconnecting" : "connecting";
    this.#host.requestUpdate();
    let socket: WebSocket;
    try {
      socket = await this.#open(this.#sessionId);
    } catch {
      if (generation === this.#generation) this.#failed(generation);
      return;
    }
    if (generation !== this.#generation) {
      socket.close();
      return;
    }
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (message: MessageEvent) => {
      if (generation === this.#generation) this.#receive(message.data);
    };
    socket.onclose = () => {
      if (generation !== this.#generation) return;
      this.#socket = undefined;
      this.#failed(generation);
    };
  }

  #failed(generation: number): void {
    // A snapshot is best effort; a stream retries a few times, then waits for connect().
    if (this.#mode === "snapshot") {
      this.disconnect();
      return;
    }
    if (++this.#retries > MAX_RETRIES) {
      this.#mode = undefined;
      this.connection = "disconnected";
      this.#host.requestUpdate();
      return;
    }
    this.connection = "reconnecting";
    this.#host.requestUpdate();
    this.#retry = setTimeout(() => {
      if (generation === this.#generation) void this.#attempt(generation);
    }, Math.min(1000 * 2 ** (this.#retries - 1), 10_000));
  }

  #receive(data: unknown): void {
    if (typeof data === "string") {
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      }
      const message = parseBrowserViewMessage(raw);
      if (!message) return;
      if (message.type === "state") {
        const { type: _type, ...view } = message;
        this.view = view;
        this.connection = "live";
        this.#retries = 0;
        this.#host.requestUpdate();
        // Nothing to take: the browser is stopped or this conversation has no tab.
        if (this.#mode === "snapshot" && (!view.running || view.watching === null)) this.disconnect();
        return;
      }
      const { type: _type, ...action } = message;
      this.action = action;
      const frame = this.frame;
      if (action.point && frame && action.tabId === frame.tabId) {
        this.pointer = { ...pointPosition(action.point, frame), key: (this.pointer?.key ?? 0) + 1 };
        clearTimeout(this.#pointerTimer);
        this.#pointerTimer = setTimeout(() => {
          this.pointer = undefined;
          this.#host.requestUpdate();
        }, POINTER_MS);
      }
      this.#host.requestUpdate();
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const decoded = decodeBrowserFrame(data);
    if (!decoded) return;
    const tab = this.view?.tabs.find(({ id }) => id === decoded.header.tabId);
    // Copy into an ArrayBuffer-backed view; Blob does not accept shared memory.
    const frame: RecentFrame = {
      blob: new Blob([decoded.image.slice()], { type: "image/jpeg" }),
      tabId: decoded.header.tabId,
      title: tab?.title ?? "",
      pageUrl: tab?.url ?? "",
      width: decoded.header.width,
      height: decoded.header.height,
    };
    remember(this.#sessionId, frame);
    this.#setFrame({ ...this.#describe(frame), src: URL.createObjectURL(frame.blob) });
    this.#host.requestUpdate();
    if (this.#mode === "snapshot") this.disconnect();
  }

  #describe(frame: RecentFrame): Omit<BrowserFrameImage, "src"> {
    return { tabId: frame.tabId, title: frame.title, pageUrl: frame.pageUrl, width: frame.width, height: frame.height };
  }

  #setFrame(next: BrowserFrameImage | undefined): void {
    const previous = this.frame;
    this.frame = next;
    if (previous && previous.src !== next?.src) URL.revokeObjectURL(previous.src);
  }
}
