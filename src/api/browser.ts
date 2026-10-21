/**
 * Browser client for HUI's managed, agent-only browser: its status, start and stop, tab previews and the
 * live-view socket for a conversation's tabs. The gateway owns the browser process; this module only crosses
 * `/__hui/` routes to reach it.
 */
import { normalizeBrowserStatus } from "../lib/browser-status.ts";
import type { BrowserStatus, BrowserViewConnection, BrowserViewTab, BrowserViewMessage } from "./schema/browser.ts";
import { fetchJson } from "./request.ts";

const BROWSER_URL = "/__hui/browser";

export type BrowserFrameHeader = { tabId: string; width: number; height: number; seq: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum = 4_096): string {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

const TAB_ID = /^t\d{1,6}$/u;
const MAX_FRAME_HEADER = 4_096;

function viewTab(value: unknown): BrowserViewTab | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || !TAB_ID.test(value["id"])) return undefined;
  return { id: value["id"], title: text(value["title"], 300), url: text(value["url"], 2_048) };
}

function tabRef(value: unknown): string | null {
  return typeof value === "string" && TAB_ID.test(value) ? value : null;
}


export function parseBrowserViewMessage(raw: unknown): BrowserViewMessage | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw["type"] === "state") {
    const tabs = Array.isArray(raw["tabs"]) ? raw["tabs"].flatMap((tab) => viewTab(tab) ?? []) : [];
    return {
      type: "state",
      running: raw["running"] === true,
      ...(raw["mode"] === "headless" || raw["mode"] === "windowed" ? { mode: raw["mode"] } : {}),
      tabs,
      current: tabRef(raw["current"]),
      watching: tabRef(raw["watching"]),
      following: raw["following"] !== false,
    };
  }
  if (raw["type"] === "action" && typeof raw["tabId"] === "string" && TAB_ID.test(raw["tabId"]) && typeof raw["text"] === "string") {
    const point = isRecord(raw["point"]) && Number.isFinite(raw["point"]["x"]) && Number.isFinite(raw["point"]["y"])
      ? { x: Number(raw["point"]["x"]), y: Number(raw["point"]["y"]) }
      : undefined;
    return { type: "action", tabId: raw["tabId"], text: text(raw["text"], 300), ...(point ? { point } : {}), at: text(raw["at"], 64) };
  }
  return undefined;
}

export function decodeBrowserFrame(data: ArrayBuffer | Uint8Array): { header: BrowserFrameHeader; image: Uint8Array } | undefined {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 4) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length === 0 || length > MAX_FRAME_HEADER || 4 + length >= bytes.length) return undefined;
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length)));
  } catch {
    return undefined;
  }
  if (!isRecord(header) || typeof header["tabId"] !== "string" || !TAB_ID.test(header["tabId"])) return undefined;
  const size = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 16_384;
  if (!size(header["width"]) || !size(header["height"]) || typeof header["seq"] !== "number") return undefined;
  return {
    header: { tabId: header["tabId"], width: header["width"] as number, height: header["height"] as number, seq: header["seq"] },
    image: bytes.subarray(4 + length),
  };
}

export async function loadBrowserStatus(): Promise<BrowserStatus> {
  return normalizeBrowserStatus(await fetchJson<unknown>(BROWSER_URL));
}

/** Launching waits for the browser's DevTools handshake, which can take a
 * while on a cold start; the default 5-second fetch ceiling is too short. */
export async function controlBrowser(action: "start" | "stop"): Promise<BrowserStatus> {
  return normalizeBrowserStatus(await fetchJson<unknown>(BROWSER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(45_000),
  }));
}

/** One-use live view of a conversation's tabs: JSON state/actions and binary frames. */
export async function connectBrowserView(sessionId: string): Promise<WebSocket> {
  const result = await fetchJson<BrowserViewConnection>(`/__hui/sessions/${encodeURIComponent(sessionId)}/browser/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const address = new URL(result.url, location.href);
  address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(address);
  socket.binaryType = "arraybuffer";
  return socket;
}

/** A JPEG data URL of one tab's viewport, captured without changing focus. */
export async function previewBrowserTab(id: string): Promise<string> {
  const body = await fetchJson<{ image?: unknown }>(`${BROWSER_URL}/tabs/${encodeURIComponent(id)}/preview`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (typeof body.image !== "string" || !body.image.startsWith("data:image/")) throw new Error("The preview was not an image.");
  return body.image;
}
