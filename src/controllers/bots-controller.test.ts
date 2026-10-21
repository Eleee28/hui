import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import type { ReactiveController } from "lit";
import type { WorkerView } from "../api/workers.ts";
import type { BotsStreamHandlers, BotView } from "../lib/bots/bots.ts";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings/settings.ts";
import { BotsController } from "./bots-controller.ts";

const fake = vi.hoisted(() => ({
  streams: [] as { handlers: BotsStreamHandlers; stopped: boolean }[],
  reads: 0,
  list: [] as BotView[],
  patches: [] as { id: string; patch: Record<string, unknown>; answer: (outcome: BotView | Error) => void }[],
  calls: [] as { call: string; body?: unknown; answer: (outcome: unknown) => void }[],
  modal: [] as string[],
}));

const pending = (call: string, body?: unknown) => new Promise((resolve, reject) => {
  fake.calls.push({ call, body, answer: (outcome) => outcome instanceof Error ? reject(outcome) : resolve(outcome) });
});

vi.mock("../api/bots.ts", () => ({
  subscribeBots: (handlers: BotsStreamHandlers) => {
    const stream = { handlers, stopped: false };
    fake.streams.push(stream);
    return () => { stream.stopped = true; };
  },
  loadBots: async () => { fake.reads += 1; return fake.list; },
  updateBot: (id: string, patch: Record<string, unknown>) => new Promise<BotView>((resolve, reject) => {
    fake.patches.push({ id, patch, answer: (outcome) => outcome instanceof Error ? reject(outcome) : resolve(outcome) });
  }),
  createBot: (body: unknown) => pending("create", body),
  archiveBot: (id: string) => pending(`archive ${id}`),
  deleteBot: (id: string) => pending(`delete ${id}`),
  restoreBot: (id: string) => pending(`restore ${id}`),
}));
vi.mock("../api/calls.ts", () => ({
  loadCallsStatus: () => pending("calls status"),
}));
vi.mock("../lib/modal-dialog.ts", () => ({
  ensureModal: (dialog: { open: boolean; selector: string }) => { dialog.open = true; fake.modal.push(`open ${dialog.selector}`); },
  closeModal: (dialog: { selector: string }) => { fake.modal.push(`close ${dialog.selector}`); },
}));

beforeEach(() => {
  fake.streams = [];
  fake.reads = 0;
  fake.list = [];
  fake.patches = [];
  fake.calls = [];
  fake.modal = [];
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
});

const ADA: BotView = { id: "ada", name: "Ada", sessionId: "s-ada", cwd: "/work" } as BotView;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeDialog {
  open = false;
  focused = "";
  constructor(readonly selector: string) {}
  querySelector(selector: string) { return { focus: () => { this.focused = selector; } }; }
}

function setup(settings: Settings = DEFAULT_SETTINGS, embeddedPane = false) {
  vi.stubGlobal("HTMLDialogElement", FakeDialog);
  vi.stubGlobal("document", { activeElement: null });
  const control = { settings };
  const frames: string[] = [];
  const shown = { botId: "", dialogs: new Map<string, FakeDialog>(), toast: undefined as { hovered: boolean } | undefined };
  const notes: string[] = [];
  const navigations: string[] = [];
  let sessionRefreshes = 0;
  const host = {
    embeddedPane,
    renderRoot: {
      querySelector: (selector: string) => selector === ".bot-archive-toast"
        ? shown.toast && { matches: () => shown.toast!.hovered, contains: () => false }
        : shown.dialogs.get(selector) ?? null,
    } as unknown as ParentNode,
    updates: 0,
    addController: (_controller: ReactiveController) => {},
    removeController: () => {},
    requestUpdate() { this.updates += 1; },
    updateComplete: Promise.resolve(true),
  };
  const controller = new BotsController(host, {
    control,
    live: (bots) => bots.map((bot) => ({ ...bot, unread: true })),
    onFrame: () => frames.push(controller.list.map((bot) => bot.id).join()),
    notify: (message, failed) => notes.push(failed ? `error: ${message}` : message),
    navigate: (target, replace) => navigations.push(`${target.kind === "bot" ? `bot ${target.id}` : target.kind}${replace ? " (replace)" : ""}`),
    shownBotId: () => shown.botId,
    refreshSessions: () => { sessionRefreshes += 1; },
    workers: () => [{ id: "w1", name: "Lab box" }] as WorkerView[],
  });
  return { controller, control, frames, host, shown, notes, navigations, sessionRefreshes: () => sessionRefreshes };
}

test("no bot stream in an embedded pane, and one at a time", () => {
  setup(DEFAULT_SETTINGS, true).controller.sync();
  assert.equal(fake.streams.length, 0);
  const { controller } = setup();
  controller.sync();
  controller.sync();
  assert.equal(fake.streams.length, 1, "one stream at a time");
});

test("every new bots frame lands with each bot's live chat state, and tells the shell (the panel's Tools and Triggers follow)", () => {
  const { controller, frames } = setup();
  controller.sync();
  const stream = fake.streams[0]!.handlers;
  stream.onUpdate({ revision: 1, ids: ["ada"], upserts: [ADA] }, true);
  assert.deepEqual(controller.list, [{ ...ADA, unread: true }]);
  assert.equal(controller.loaded, true);
  stream.onUpdate({ revision: 1, upserts: [] }, false);
  assert.deepEqual(frames, ["ada"], "an old frame is dropped");
  stream.onUpdate({ revision: 2, ids: [], upserts: [] }, false);
  assert.deepEqual(frames, ["ada", ""], "on every bots frame");
});

test("a gateway without the stream falls back to one read at a time, and a live stream skips reads", async () => {
  const { controller } = setup();
  controller.sync();
  fake.list = [ADA];
  fake.streams[0]!.handlers.onConnection("unsupported");
  const again = controller.refresh();
  assert.equal(controller.loading, true);
  await again;
  assert.equal(fake.reads, 2, "a change that lands meanwhile reads once more after it");
  assert.deepEqual(controller.list, [{ ...ADA, unread: true }]);
  assert.equal(controller.loading, false);
  controller.ensure();
  await settle();
  assert.equal(fake.reads, 3, "without the stream, the list is read when asked for");
  assert.equal(fake.streams.length, 1);

  const live = setup();
  live.controller.sync();
  fake.streams[1]!.handlers.onConnection("live");
  await live.controller.refresh();
  assert.equal(fake.reads, 3);
});

test("before the first list, a reconnecting stream says so, and a stopped stream restarts on retry", () => {
  const { controller } = setup();
  controller.sync();
  fake.streams[0]!.handlers.onConnection("reconnecting");
  assert.equal(controller.error, "Could not reach the gateway for the bot list. Retrying…");
  controller.retry();
  assert.equal(controller.error, "");
  assert.equal(fake.streams[0]!.stopped, true);
  assert.equal(fake.streams.length, 2);
});

test("disconnecting stops the stream", () => {
  const { controller } = setup();
  controller.sync();
  fake.streams[0]!.handlers.onConnection("live");
  controller.hostDisconnected();
  assert.equal(fake.streams[0]!.stopped, true);
  assert.equal(controller.streamLive, false);
});

test("the Agents | Bots choice and the panel's open state and width are remembered by the browser; the rest is not", () => {
  const { controller, host } = setup();
  assert.equal(controller.tab, "sessions");
  assert.equal(controller.selectTab("bots"), true);
  assert.equal(controller.selectTab("bots"), false, "already showing");
  assert.equal(localStorage.getItem("hui.sidebar-tab"), "bots");
  controller.closePanel(false);
  controller.resizePanel(420);
  const width = controller.panel.width;
  controller.openPanel(false);
  assert.deepEqual(JSON.parse(localStorage.getItem("hui.bot-panel")!), { open: true, width }, "docked, it opens at the width it had");
  const next = setup().controller;
  assert.equal(next.tab, "bots");
  assert.deepEqual(next.panel, { open: true, width });
  controller.openPanel(true);
  controller.expandPanel(true);
  assert.equal(controller.sheetOpen, true, "the sheet on narrow screens");
  assert.equal(next.sheetOpen || next.panelExpanded, false, "never remembered");
  assert.ok(host.updates > 0);
});

test("toggling or closing the docked panel ends its expanded view; a sheet keeps the docked state", () => {
  const { controller } = setup();
  controller.expandPanel(true);
  controller.togglePanel(false);
  assert.equal(controller.panel.open, false);
  assert.equal(controller.panelExpanded, false);
  controller.togglePanel(true);
  assert.equal(controller.sheetOpen, true);
  assert.equal(controller.panel.open, false);
  controller.expandPanel(true);
  controller.closePanel(true);
  assert.equal(controller.sheetOpen, false);
  assert.equal(controller.panelExpanded, false);
  controller.togglePanel(true);
  controller.closeSheet();
  assert.equal(controller.sheetOpen, false);
});

test("a page opened from an overview row goes back to that row, and another bot opens on its overview, docked", () => {
  const { controller } = setup();
  assert.equal(controller.showPanelView("tools", "setup-tools"), "setup-tools");
  assert.equal(controller.panelView, "tools");
  assert.equal(controller.showPanelView("overview"), "setup-tools", "back to the row that opened it");
  assert.equal(controller.panelOpenedFrom, "");
  controller.showPanelView("settings", "settings-model");
  controller.openPanel(true);
  controller.expandPanel(true);
  controller.resetPanel();
  assert.deepEqual([controller.panelView, controller.panelOpenedFrom, controller.sheetOpen, controller.panelExpanded], ["overview", "", false, false]);
});

test("each Settings change shows as saving at once and is one PATCH, sent in order; a newer value replaces one still waiting", async () => {
  const { controller } = setup();
  controller.adopt([ADA]);
  controller.changeSetting("ada", "name", "Grace");
  controller.changeSetting("ada", "title", "Pilot");
  controller.changeSetting("ada", "title", "Captain");
  assert.deepEqual(controller.savesOf("ada").pending, { name: "Grace", title: "Captain" });
  await settle();
  assert.deepEqual(fake.patches.map(({ id, patch }) => [id, patch]), [["ada", { name: "Grace" }]], "one at a time");
  fake.patches[0]!.answer({ ...ADA, name: "Grace" });
  await settle();
  assert.deepEqual(controller.list, [{ ...ADA, name: "Grace" }], "the gateway's answer replaces the bot");
  assert.deepEqual(fake.patches.map(({ patch }) => patch), [{ name: "Grace" }, { title: "Captain" }], "the newest value, sent once");
  fake.patches[1]!.answer(new Error("Too long."));
  await settle();
  assert.deepEqual(controller.savesOf("ada"), { pending: {}, errors: { title: "Too long." } }, "a refusal stays on its row");
  controller.dismissSetting("ada", "title");
  assert.deepEqual(controller.savesOf("ada"), { pending: {}, errors: {} });
  controller.changeSetting("gone", "name", "X");
  await settle();
  assert.deepEqual(controller.savesOf("gone").errors, { name: "This bot is gone." });
  assert.equal(fake.patches.length, 2);
});

test("+ creates one bot at a time, without a name, on the machine chosen, and opens its chat; a refusal shows as an error toast", async () => {
  const { controller, notes, navigations, sessionRefreshes } = setup();
  controller.create("w1");
  controller.create();
  assert.equal(controller.creating, true);
  assert.deepEqual(fake.calls.map(({ call, body }) => [call, body]), [["create", { worker: "w1" }]], "one at a time; the gateway names it New Bot");
  assert.deepEqual(notes, ["Creating a bot on Lab box…"], "a worker can take a moment: a toast says where");
  fake.list = [{ ...ADA, id: "new" }];
  fake.calls[0]!.answer({ ...ADA, id: "new" });
  await settle();
  assert.deepEqual(controller.list.map((bot) => bot.id), ["new"]);
  assert.deepEqual(navigations, ["bot new"], "its chat opens");
  assert.equal(sessionRefreshes(), 1, "its chat is a new session");
  assert.equal(controller.creating, false);
  controller.create();
  assert.deepEqual(fake.calls[1]?.body, {}, "on this machine, everything on the defaults");
  fake.calls[1]!.answer(new Error("That worker is offline."));
  await settle();
  assert.deepEqual(notes.slice(1), ["", "error: That worker is offline."]);
});

test("an imported bot's chat opens, as a new bot's does, and its warnings show", () => {
  const { controller, notes, navigations, sessionRefreshes } = setup();
  controller.imported(ADA, ["Its routines are paused."]);
  assert.deepEqual(controller.list.map((bot) => bot.id), ["ada"]);
  assert.deepEqual(notes, ["error: Imported Ada. Its routines are paused."]);
  assert.deepEqual(navigations, ["bot ada"]);
  assert.equal(sessionRefreshes(), 1);
});

test("Archive and Delete ask first in the app's own dialog, focused on Cancel; a refusal stays in the dialog", async () => {
  const { controller, shown, navigations } = setup();
  controller.adopt([ADA]);
  controller.requestArchive(ADA);
  const archiveDialog = new FakeDialog(".bot-archive-dialog");
  shown.dialogs.set(".bot-archive-dialog", archiveDialog);
  controller.showDialogs();
  controller.showDialogs();
  assert.deepEqual(fake.modal, ["open .bot-archive-dialog"], "opened once");
  assert.equal(archiveDialog.focused, ".bot-archive-cancel");
  controller.confirmArchive();
  controller.confirmArchive();
  assert.deepEqual(fake.calls.map(({ call }) => call), ["archive ada"], "once");
  fake.calls[0]!.answer(new Error("Busy."));
  await settle();
  assert.equal(controller.archiveError, "Busy.");
  assert.equal(controller.archiving, ADA);
  controller.closeArchive();
  assert.equal(controller.archiving, undefined);
  controller.requestDelete(ADA);
  const deleteDialog = new FakeDialog(".bot-delete-dialog");
  shown.dialogs.set(".bot-delete-dialog", deleteDialog);
  controller.showDialogs();
  assert.equal(deleteDialog.focused, ".bot-delete-cancel");
  controller.confirmDelete();
  assert.equal(controller.pendingId, "ada", "the row waits for the gateway");
  fake.calls[1]!.answer(new Error("Could not delete that bot."));
  await settle();
  assert.equal(controller.deleteError, "Could not delete that bot.");
  assert.deepEqual(controller.list, [ADA], "the row stays");
  assert.equal(controller.pendingId, "");
  assert.deepEqual(navigations, []);
});

test("archiving or deleting the open bot returns home; a deleted bot leaves the list and its toast", async () => {
  vi.useFakeTimers();
  try {
    const { controller, shown, notes, navigations, sessionRefreshes } = setup();
    controller.adopt([ADA]);
    shown.botId = "ada";
    shown.dialogs.set(".bot-archive-dialog", new FakeDialog(".bot-archive-dialog"));
    controller.requestArchive(ADA);
    controller.confirmArchive();
    fake.list = [{ ...ADA, archived: true }];
    fake.calls[0]!.answer({ ...ADA, archived: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(fake.modal, ["close .bot-archive-dialog"]);
    assert.equal(controller.archiving, undefined);
    assert.equal(controller.archiveToast?.bot.archived, true);
    assert.deepEqual(navigations, ["home (replace)"]);
    assert.equal(sessionRefreshes(), 1);
    controller.toggleShowArchived();
    shown.dialogs.set(".bot-delete-dialog", new FakeDialog(".bot-delete-dialog"));
    controller.requestDelete(controller.list[0]!);
    controller.confirmDelete();
    fake.list = [];
    fake.calls[1]!.answer(undefined);
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(controller.list, []);
    assert.equal(controller.showArchived, false, "with nothing archived, the next archived bot starts out of sight");
    assert.equal(controller.archiveToast, undefined);
    assert.equal(notes.at(-1), "Deleted Ada.");
    assert.deepEqual(navigations, ["home (replace)", "home (replace)"], "its chat is gone");
    assert.equal(sessionRefreshes(), 2);
    shown.botId = "";
    controller.adopt([ADA]);
    controller.requestArchive(ADA);
    controller.confirmArchive();
    fake.calls[2]!.answer({ ...ADA, archived: true });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(navigations.length, 2, "another bot's page stays");
  } finally {
    vi.useRealTimers();
  }
});

test("the archive toast lasts 15 s without hover or focus, and its Restore brings the bot back; a refusal stays on it", async () => {
  vi.useFakeTimers();
  try {
    const { controller, shown, notes, sessionRefreshes } = setup();
    controller.archiveToast = { bot: ADA, restoring: false };
    shown.toast = { hovered: true };
    controller.scheduleToast();
    await vi.advanceTimersByTimeAsync(15_000);
    assert.ok(controller.archiveToast, "hovered, it stays");
    shown.toast.hovered = false;
    controller.scheduleToast();
    await vi.advanceTimersByTimeAsync(14_999);
    assert.ok(controller.archiveToast);
    controller.pauseToast();
    await vi.advanceTimersByTimeAsync(1);
    assert.ok(controller.archiveToast, "paused");
    controller.scheduleToast();
    await vi.advanceTimersByTimeAsync(15_000);
    assert.equal(controller.archiveToast, undefined);

    controller.archiveToast = { bot: ADA, restoring: false };
    void controller.restoreFromToast();
    assert.deepEqual(controller.archiveToast, { bot: ADA, restoring: true });
    fake.calls[0]!.answer(new Error("Not now."));
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(controller.archiveToast, { bot: ADA, restoring: false, error: "Not now." });
    controller.scheduleToast();
    await vi.advanceTimersByTimeAsync(15_000);
    assert.ok(controller.archiveToast, "an error stays until dismissed");
    void controller.restoreFromToast();
    fake.list = [ADA];
    fake.calls[1]!.answer(ADA);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(controller.archiveToast, undefined);
    assert.deepEqual(controller.list.map((bot) => bot.id), ["ada"]);
    assert.equal(notes.at(-1), "Restored Ada. Its routines stay paused until you turn them on.");
    assert.equal(sessionRefreshes(), 1);

    controller.archiveToast = { bot: ADA, restoring: false };
    shown.toast.hovered = false;
    controller.scheduleToast();
    controller.hostDisconnected();
    await vi.advanceTimersByTimeAsync(15_000);
    assert.ok(controller.archiveToast, "disconnecting clears the timer");
  } finally {
    vi.useRealTimers();
  }
});

test("hiding and restoring from the roster wait on one row at a time; with none left, Show hidden and Show archived reset", async () => {
  const { controller, notes } = setup();
  const archived = { ...ADA, archived: true };
  controller.adopt([archived]);
  controller.toggleShowArchived();
  controller.archiveToast = { bot: archived, restoring: false };
  controller.restore(archived);
  controller.restore(archived);
  controller.requestDelete(archived);
  assert.equal(controller.deleting, undefined, "Delete waits for the row");
  assert.deepEqual(fake.calls.map(({ call }) => call), ["restore ada"]);
  fake.calls[0]!.answer(ADA);
  await settle();
  assert.equal(controller.pendingId, "");
  assert.equal(controller.showArchived, false);
  assert.equal(controller.archiveToast, undefined);
  assert.equal(notes.at(-1), "Restored Ada. Its routines stay paused until you turn them on.");

  controller.toggleShowHidden();
  controller.setHidden(ADA, true);
  fake.patches[0]!.answer({ ...ADA, hidden: true });
  await settle();
  assert.equal(controller.showHidden, true, "a hidden bot is listed while Show hidden is on");
  assert.equal(notes.at(-1), "Ada is hidden. Show hidden lists it again.");
  controller.setHidden(ADA, false);
  assert.deepEqual(fake.patches[1]?.patch, { hidden: false });
  fake.patches[1]!.answer(ADA);
  await settle();
  assert.equal(controller.showHidden, false);
  assert.equal(notes.at(-1), "Ada is back in the roster.");
});

test("the toast's Restore and a roster Delete of the same bot wait on each other", async () => {
  const { controller } = setup();
  const archived = { ...ADA, archived: true };
  controller.adopt([archived]);
  controller.archiveToast = { bot: archived, restoring: false };
  controller.requestDelete(archived);
  controller.confirmDelete();
  void controller.restoreFromToast();
  assert.deepEqual(fake.calls.map(({ call }) => call), ["delete ada"]);
  fake.calls[0]!.answer(undefined);
  await settle();
  assert.equal(controller.pendingId, "");

  controller.adopt([archived]);
  controller.archiveToast = { bot: archived, restoring: false };
  void controller.restoreFromToast();
  assert.equal(controller.pendingId, "ada");
  controller.requestDelete(archived);
  assert.equal(controller.deleting, undefined, "Delete waits for the toast's Restore");
  fake.calls[1]!.answer(ADA);
  await settle();
  assert.equal(controller.pendingId, "");
});

test("Call and the Settings page's Calls section follow one read of the ChatGPT login; a failed read leaves Call hidden", async () => {
  const { controller, host } = setup({ ...DEFAULT_SETTINGS, calls: { voice: "maple" } });
  assert.equal(controller.callsAvailable(), false);
  assert.deepEqual(controller.settingsCall(), { defaultVoice: "maple" }, "nothing about a login until the gateway has said");
  const first = controller.loadCallsStatus();
  assert.equal(controller.loadCallsStatus(), first, "a read under way is shared");
  const updates = host.updates;
  fake.calls[0]!.answer(new Error("offline"));
  await first;
  assert.equal(controller.callsAvailable(), false);
  assert.equal(host.updates, updates, "nothing to render, so a bot page does not read again at once");
  void controller.loadCallsStatus();
  assert.equal(fake.calls.length, 2, "read again once the first ended");
  fake.calls[1]!.answer({ chatgpt: { signedIn: false } });
  await settle();
  assert.equal(controller.callsAvailable(), false);
  assert.deepEqual(controller.settingsCall(), { defaultVoice: "maple", ready: false });
  assert.ok(host.updates > updates);
  controller.callsStatus = undefined;
  void controller.loadCallsStatus();
  fake.calls[2]!.answer({ chatgpt: { signedIn: true } });
  await settle();
  assert.equal(controller.callsAvailable(), true);
  assert.deepEqual(controller.settingsCall(), { defaultVoice: "maple", ready: true });
});
