import assert from "node:assert/strict";
import { test } from "vitest";
import type { BrowserViewState } from "../api/schema/browser.ts";
import { browserPreviewDisplay, browserTabOptions, browserViewEmptyMessage, browserViewStatus, fitFrame, pointPosition, relativeTime } from "./browser-view.ts";

const state: BrowserViewState = {
  running: true, mode: "headless",
  tabs: [{ id: "t1", title: "Fixture", url: "http://127.0.0.1:5173/" }, { id: "t4", title: "", url: "https://example.com/docs" }],
  current: "t1", watching: "t1", following: true,
};

test("frames fit the pane without distortion or upscaling, and pointers map onto them", () => {
  assert.deepEqual(fitFrame({ width: 640, height: 900 }, { width: 1280, height: 800 }), { width: 640, height: 400 });
  assert.deepEqual(fitFrame({ width: 2000, height: 300 }, { width: 1280, height: 800 }), { width: 480, height: 300 });
  assert.deepEqual(fitFrame({ width: 3000, height: 3000 }, { width: 1280, height: 800 }), { width: 1280, height: 800 });
  assert.equal(fitFrame({ width: 0, height: 100 }, { width: 1280, height: 800 }), undefined);
  assert.deepEqual(pointPosition({ x: 640, y: 200 }, { width: 1280, height: 800 }), { left: 50, top: 25 });
  assert.deepEqual(pointPosition({ x: -5, y: 900 }, { width: 1280, height: 800 }), { left: 0, top: 100 });
});

test("tab options, status and empty states describe what the operator sees", () => {
  assert.deepEqual(browserTabOptions(state), [
    { value: "t1", label: "t1 · Fixture", description: "Agent's tab · http://127.0.0.1:5173/" },
    { value: "t4", label: "t4 · Untitled", description: "https://example.com/docs" },
  ]);
  assert.equal(browserViewStatus(state, "live"), "Live · headless");
  assert.equal(browserViewStatus({ ...state, mode: "windowed", watching: null }, "live"), "Idle · visible window");
  assert.equal(browserViewStatus({ ...state, running: false }, "live"), "Browser stopped");
  assert.equal(browserViewStatus(state, "reconnecting"), "Reconnecting…");
  assert.equal(browserViewStatus(state, "idle"), "Paused");
  assert.equal(browserViewEmptyMessage(state, "idle", true), "The live view is paused.");
  assert.match(browserViewEmptyMessage({ ...state, running: false, tabs: [] }, "live", true), /When the agent opens one, it appears here live/u);
  assert.equal(browserViewEmptyMessage(state, "live", true), "Waiting for the page to paint…");
  assert.match(browserViewEmptyMessage(state, "live", false), /Settings → Tools → Browser/u);
  assert.equal(browserViewEmptyMessage(undefined, "connecting", true), "Connecting to the browser…");
  const now = Date.parse("2026-09-28T09:00:00.000Z");
  assert.equal(relativeTime("2026-09-28T08:59:58.000Z", now), "just now");
  assert.equal(relativeTime("2026-09-28T08:59:30.000Z", now), "30s ago");
  assert.equal(relativeTime("2026-09-28T08:50:00.000Z", now), "10m ago");
  assert.equal(relativeTime("nope", now), "");
});

test("the chat preview shows frames, a placeholder only while the agent browses, and dims closed tabs", () => {
  const frame = { tabId: "t1", title: "Fixture at arrival", pageUrl: "http://127.0.0.1:5173/old" };
  const base = { view: state, connection: "live" as const, live: true, pending: false };
  assert.deepEqual(browserPreviewDisplay({ ...base, frame }), { body: "frame", chip: "live", title: "Fixture", url: "http://127.0.0.1:5173/" }, "live tab values win");
  assert.deepEqual(browserPreviewDisplay({ ...base, frame, connection: "connecting" }).chip, "connecting");
  assert.deepEqual(browserPreviewDisplay({ ...base, frame, live: false }), { body: "frame", title: "Fixture", url: "http://127.0.0.1:5173/" }, "a finished turn keeps the frame without a chip");
  assert.deepEqual(browserPreviewDisplay({ ...base, frame, view: undefined, live: false }), { body: "frame", title: "Fixture at arrival", url: "http://127.0.0.1:5173/old" });
  assert.deepEqual(browserPreviewDisplay({ ...base, frame, view: { ...state, tabs: [state.tabs[1]!], current: "t4", watching: "t4" } }), {
    body: "frame", chip: "closed", title: "Fixture at arrival", url: "http://127.0.0.1:5173/old",
  });
  assert.equal(browserPreviewDisplay({ ...base, frame, live: false, view: { ...state, running: false, tabs: [] } }).chip, "closed");
  assert.deepEqual(browserPreviewDisplay({ ...base, frame: undefined, view: undefined, pending: true, connection: "connecting" }), { body: "loading", chip: "connecting", title: "Browser", url: "" });
  assert.deepEqual(browserPreviewDisplay({ ...base, frame: undefined }), { body: "loading", chip: "live", title: "Fixture", url: "http://127.0.0.1:5173/" });
  assert.equal(browserPreviewDisplay({ ...base, frame: undefined, live: false, pending: true }).body, "none", "history without a frame stays hidden");
  assert.equal(browserPreviewDisplay({ ...base, frame: undefined, view: { ...state, running: false, tabs: [], current: null, watching: null } }).body, "none");
});
