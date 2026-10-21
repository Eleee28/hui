/**
 * Pure presentation rules for the browser live view and the chat's browser preview: fitting a frame, placing
 * the agent's pointer, tab options and the status and placeholder text. No sockets or DOM; the controller and
 * views supply the state.
 */
import type { BrowserViewState } from "../api/schema/browser.ts";
import type { PickerOption } from "./picker-options.ts";

export type Size = { width: number; height: number };

/** Largest size of `frame` that fits `box` without distortion or upscaling. */
export function fitFrame(box: Size, frame: Size): Size | undefined {
  if (!(box.width > 0 && box.height > 0 && frame.width > 0 && frame.height > 0)) return undefined;
  const scale = Math.min(box.width / frame.width, box.height / frame.height, 1);
  return { width: Math.max(1, Math.floor(frame.width * scale)), height: Math.max(1, Math.floor(frame.height * scale)) };
}

/** A viewport point as a percentage of the frame, clamped to its edges. */
export function pointPosition(point: { x: number; y: number }, frame: Size): { left: number; top: number } {
  const clamp = (value: number) => Math.min(100, Math.max(0, value));
  return { left: clamp((point.x / frame.width) * 100), top: clamp((point.y / frame.height) * 100) };
}

export function browserTabOptions(state: BrowserViewState): PickerOption[] {
  return state.tabs.map((tab) => ({
    value: tab.id,
    label: `${tab.id} · ${tab.title || "Untitled"}`,
    description: tab.id === state.current ? `Agent's tab · ${tab.url}` : tab.url,
  }));
}

/** `idle`: not connected on purpose (hidden, off screen or a finished snapshot). */
export type BrowserViewConnection = "idle" | "connecting" | "live" | "reconnecting" | "disconnected";

export function browserViewStatus(state: BrowserViewState | undefined, connection: BrowserViewConnection): string {
  if (connection === "idle") return "Paused";
  if (connection === "connecting") return "Connecting…";
  if (connection === "reconnecting") return "Reconnecting…";
  if (connection === "disconnected") return "Disconnected";
  if (!state?.running) return "Browser stopped";
  const mode = state.mode === "windowed" ? "visible window" : "headless";
  return state.watching ? `Live · ${mode}` : `Idle · ${mode}`;
}

export function browserViewEmptyMessage(state: BrowserViewState | undefined, connection: BrowserViewConnection, enabled: boolean): string {
  if (!enabled) return "The browser tool is off. Turn it on in Settings → Tools → Browser.";
  if (connection !== "live" || !state) {
    if (connection === "disconnected") return "The live view is disconnected.";
    return connection === "idle" ? "The live view is paused." : "Connecting to the browser…";
  }
  if (!state.running || state.tabs.length === 0) {
    return "No page is open in this conversation yet. When the agent opens one, it appears here live.";
  }
  return "Waiting for the page to paint…";
}

/** The frame a preview holds, with the tab it showed when it arrived. */
export type PreviewFrame = { tabId: string; title: string; pageUrl: string };

export type BrowserPreviewDisplay = {
  /** `none` hides the whole card: nothing to show and nothing coming. */
  body: "frame" | "loading" | "none";
  chip?: "live" | "connecting" | "closed";
  title: string;
  url: string;
};

/**
 * What the chat preview shows. A frame stays visible after the turn ends (and
 * dims once its tab is gone); before the first frame, a placeholder appears
 * only while the agent is working with the browser in this turn.
 */
export function browserPreviewDisplay(input: {
  view: BrowserViewState | undefined;
  frame: PreviewFrame | undefined;
  connection: BrowserViewConnection;
  live: boolean;
  pending: boolean;
}): BrowserPreviewDisplay {
  const { view, frame, connection, live, pending } = input;
  const tab = frame ? view?.tabs.find(({ id }) => id === frame.tabId) : view?.tabs.find(({ id }) => id === view.current);
  const title = tab?.title || frame?.title || (tab || frame ? "Untitled page" : "Browser");
  const url = tab?.url ?? frame?.pageUrl ?? "";
  const streaming = connection === "live" ? "live" as const : "connecting" as const;
  if (frame) {
    // Known only while connected: the tab closed or the browser stopped.
    const closed = view !== undefined && (!view.running || !tab);
    const chip = closed ? "closed" as const : live ? streaming : undefined;
    return { body: "frame", ...(chip ? { chip } : {}), title, url };
  }
  const opening = live && (pending || Boolean(view?.running && view.tabs.length > 0));
  return opening ? { body: "loading", chip: streaming, title, url } : { body: "none", title, url };
}

export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}
