import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { html } from "lit";
import { navigationPath } from "../lib/navigation.ts";
import { activeSessionPane, SESSION_LAYOUT_KEY, sessionPanes, singleSessionLayout, splitSessionPane, visibleSessionPanes } from "../lib/session/multiplexer.ts";
import { APPLE_PLATFORM } from "../lib/shortcut-binding.ts";
import { registerWorkViewKind, sessionWorkPane, WORK_PANE_KEY } from "../lib/work-pane.ts";
import { WORK_SHORTCUTS } from "../lib/work-shortcuts.ts";
import { WorkLayoutController } from "./work-layout-controller.ts";

const fake = vi.hoisted(() => ({ browser: { reason: "" as string | undefined, fail: false }, history: [] as { method: string; path: string }[] }));

beforeEach(() => {
  fake.browser = { reason: undefined, fail: false };
  fake.history = [];
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
  vi.stubGlobal("document", { activeElement: null, body: {}, querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} });
  const record = (method: string) => (_state: unknown, _title: string, path: string) => { fake.history.push({ method, path }); };
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    history: { state: null, replaceState: record("replace"), pushState: record("push") },
  });
  registerWorkViewKind({
    kind: "browser", label: "Browser", icon: html``, shortcut: WORK_SHORTCUTS.browser, single: true,
    unavailable: () => fake.browser.reason,
    create: () => fake.browser.fail ? Promise.reject(new Error("no browser")) : { kind: "browser" },
    key: () => "browser", title: () => "Browser", render: () => html``,
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const press = (binding: string) => {
  const [code = ""] = binding.split("+").slice(-1);
  const prevented: string[] = [];
  const event = {
    altKey: binding.includes("Alt"), shiftKey: binding.includes("Shift"), code,
    ctrlKey: binding.includes("Mod") && !APPLE_PLATFORM, metaKey: binding.includes("Mod") && APPLE_PLATFORM,
    defaultPrevented: false, isComposing: false, repeat: false,
    preventDefault: () => prevented.push("default"), stopPropagation: () => prevented.push("propagation"),
  } as unknown as KeyboardEvent;
  return { event, prevented };
};

function setup({ followed = "s1" as string | undefined, palette = false } = {}) {
  const shell = { followed, palette, composerFocus: 0, shown: [] as string[], headerFocus: [] as unknown[] };
  const header = { focus: (options: unknown) => shell.headerFocus.push(options) };
  const host = { renderRoot: { querySelector: () => null } as unknown as HTMLElement, addController: () => {}, removeController: () => {}, requestUpdate: () => {}, updateComplete: Promise.resolve(true) };
  const work = new WorkLayoutController(host, {
    followedSession: () => shell.followed,
    showSession: (id) => shell.shown.push(id),
    activePane: () => ({ querySelector: (selector: string) => selector === ".chat-pane__header" ? header : null }) as unknown as HTMLElement,
    focusComposer: () => { shell.composerFocus += 1; },
    paletteOpen: () => shell.palette,
    terminalFont: () => "mono",
    browserEnabled: () => true,
    remoteSession: () => false,
  });
  return { work, shell };
}

test("launching shows the view and saves the record; a reason or a failure opens the pane with its error", async () => {
  const { work } = setup();
  fake.browser.reason = "Browser is off.";
  await work.launch("browser");
  assert.equal(work.error, "Browser is off.");
  assert.equal(sessionWorkPane(work.panes, "s1").open, true);
  assert.equal(sessionWorkPane(work.panes, "s1").views.length, 0);
  fake.browser = { reason: undefined, fail: true };
  await work.launch("browser");
  assert.equal(work.error, "no browser");
  assert.equal(work.launching, "");
  fake.browser.fail = false;
  await work.launch("browser");
  assert.equal(work.error, "");
  assert.equal(work.launchedKey, "browser");
  assert.equal(sessionWorkPane(work.panes, "s1").active, "browser");
  assert.match(localStorage.getItem(WORK_PANE_KEY) ?? "", /"s1"/u);
});

test("shortcuts act only while a conversation is shown and nothing modal is open", async () => {
  const { work, shell } = setup({ palette: true });
  const toggle = press(WORK_SHORTCUTS.togglePane);
  work.onShortcut(toggle.event);
  assert.deepEqual(toggle.prevented, []);
  shell.palette = false;
  shell.followed = undefined;
  work.onShortcut(toggle.event);
  assert.deepEqual(toggle.prevented, []);
  shell.followed = "s1";
  const browser = press(WORK_SHORTCUTS.browser);
  work.onShortcut(browser.event);
  assert.deepEqual(browser.prevented, ["default", "propagation"]);
  await settle();
  assert.equal(sessionWorkPane(work.panes, "s1").active, "browser");
});

test("on narrow screens the toggle shows the Work destination and hides it back to the composer", () => {
  const { work, shell } = setup();
  work.narrow = true;
  work.onShortcut(press(WORK_SHORTCUTS.togglePane).event);
  assert.equal(work.narrowShown, true);
  work.onShortcut(press(WORK_SHORTCUTS.togglePane).event);
  assert.equal(work.narrowShown, false);
  assert.equal(shell.composerFocus, 1);
  work.toggleMaximized(true);
  assert.equal(sessionWorkPane(work.panes, "s1").maximized ?? false, false, "narrow screens never maximize");
});

test("closing the followed conversation's last view returns focus to the composer only if the pane was shown", async () => {
  const { work, shell } = setup();
  await work.launch("browser");
  work.close("s1", "browser", "s1");
  assert.equal(sessionWorkPane(work.panes, "s1").views.length, 0);
  assert.equal(work.launchedKey, "");
  assert.equal(shell.composerFocus, 1);
  await work.launch("browser");
  work.close("s1", "browser", "other");
  assert.equal(shell.composerFocus, 1, "another conversation's pane does not move focus");
});

const split = () => {
  const layout = splitSessionPane(singleSessionLayout("s1"), "p1", "s2", "right");
  return { layout, left: sessionPanes(layout)[0]!, right: sessionPanes(layout)[1]! };
};

test("a pane offers close only while split and split only on wide screens", () => {
  const { work } = setup();
  const { left } = split();
  const state = { active: true, visible: true, narrow: false, split: false };
  assert.equal(work.paneControls(left, state).close, undefined);
  assert.ok(work.paneControls(left, state).split);
  assert.ok(work.paneControls(left, { ...state, split: true }).close);
  assert.equal(work.paneControls(left, { ...state, narrow: true }).split, undefined);
});

test("closing a pane shows the remaining conversation, saves the layout and focuses its header", async () => {
  const { work, shell } = setup();
  const { layout, right } = split();
  work.layout = layout;
  work.paneControls(right, { active: true, visible: true, narrow: false, split: true }).close!();
  assert.deepEqual(sessionPanes(work.layout!).map(({ sessionId }) => sessionId), ["s1"]);
  assert.deepEqual(shell.shown, ["s1"]);
  assert.deepEqual(fake.history, [{ method: "replace", path: navigationPath({ kind: "session", id: "s1" }) }]);
  assert.equal(localStorage.getItem(SESSION_LAYOUT_KEY), null, "a single pane is not saved");
  await settle();
  assert.deepEqual(shell.headerFocus, [{ preventScroll: true }]);
  work.closePane(sessionPanes(work.layout!)[0]!.id);
  assert.deepEqual(shell.shown, ["s1"], "the last pane stays");
});

test("focusing, dropping, moving and retargeting panes commit the layout", () => {
  const { work, shell } = setup();
  const { layout, left, right } = split();
  work.layout = layout;
  work.focusPane(left.id);
  assert.equal(work.layout!.activePaneId, left.id);
  work.focusPane(left.id);
  assert.deepEqual(shell.shown, ["s1"], "focusing the active pane commits nothing");
  assert.match(localStorage.getItem(SESSION_LAYOUT_KEY) ?? "", /"s2"/u);
  work.dropSession("s3", left.id, { kind: "tab" });
  assert.equal(activeSessionPane(work.layout!).sessionId, "s3");
  assert.equal(visibleSessionPanes(work.layout!).length, 2);
  work.dropSession("s4", right.id, { kind: "edge", edge: "down" });
  assert.equal(visibleSessionPanes(work.layout!).length, 3);
  work.dropSession("s5", right.id, { kind: "center" });
  assert.equal(activeSessionPane(work.layout!).id, right.id);
  assert.equal(activeSessionPane(work.layout!).sessionId, "s5");
  const before = visibleSessionPanes(work.layout!).map(({ id }) => id);
  work.movePane(right.id, left.id, { kind: "center" });
  assert.notDeepEqual(visibleSessionPanes(work.layout!).map(({ id }) => id), before);
  work.changePaneSession(left.id, "s6");
  assert.equal(activeSessionPane(work.layout!).sessionId, "s6");
  assert.deepEqual(shell.shown, ["s1", "s3", "s4", "s5", "s5", "s6"]);
  assert.deepEqual(fake.history.map(({ method }) => method), ["replace", "replace", "replace", "replace", "replace", "push"]);
});
