import assert from "node:assert/strict";
import { test } from "vitest";
import {
  archivedBotCount,
  archivedRosterBots,
  botAccessibleName,
  botActivity,
  botActivityAt,
  botMatches,
  botPreview,
  clampBotPanelWidth,
  compactRelativeTime,
  hiddenBotCount,
  normalizeBotPanel,
  normalizeSidebarTab,
  botSettingsShortcutLabel,
  isBotSettingsShortcut,
  rosterBots,
  tabAfterKey,
  SIDEBAR_TABS,
} from "./roster.ts";
import type { BotView } from "./bots.ts";

const NO_USAGE = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function bot(id: string, overrides: Partial<BotView> = {}): BotView {
  return {
    id,
    handle: id,
    name: id[0]!.toUpperCase() + id.slice(1),
    cwd: "/bots/" + id,
    sessionId: "s-" + id,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    status: "idle",
    soul: false,
    unread: false,
    routines: 0,
    ...overrides,
  };
}

test("the roster orders by latest activity and never lists archived bots", () => {
  const bots = [
    bot("coach", { updatedAt: "2026-10-04T00:00:00.000Z" }),
    bot("scout", { lastMessage: { role: "assistant", text: "hi", at: "2026-10-05T09:58:00.000Z" } }),
    bot("ledger", { lastMessage: { role: "user", text: "sum", at: "2026-10-05T09:00:00.000Z" } }),
    bot("old", { archived: true, lastMessage: { role: "user", text: "x", at: "2026-10-05T10:00:00.000Z" } }),
    bot("quiet", { hidden: true, lastMessage: { role: "user", text: "x", at: "2026-10-05T10:00:00.000Z" } }),
  ];
  assert.deepEqual(rosterBots(bots, { query: "", showHidden: false }).map(({ id }) => id), ["scout", "ledger", "coach"]);
  assert.deepEqual(rosterBots(bots, { query: "", showHidden: true }).map(({ id }) => id), ["quiet", "scout", "ledger", "coach"]);
  assert.equal(hiddenBotCount(bots), 1);
  assert.equal(hiddenBotCount([bot("gone", { hidden: true, archived: true })]), 0);
  // Equal activity falls back to the name, so the order never flickers.
  assert.deepEqual(rosterBots([bot("beta"), bot("alpha")], { query: "", showHidden: false }).map(({ id }) => id), ["alpha", "beta"]);
});

test("Show archived lists archived bots only, hidden or not, matching the search, latest first", () => {
  const bots = [
    bot("scout"),
    bot("old", { archived: true, lastMessage: { role: "user", text: "x", at: "2026-10-03T00:00:00.000Z" } }),
    bot("older", { archived: true, hidden: true, title: "Inbox keeper", updatedAt: "2026-09-01T00:00:00.000Z" }),
    bot("newest", { archived: true, lastMessage: { role: "assistant", text: "y", at: "2026-10-05T00:00:00.000Z" } }),
  ];
  assert.deepEqual(archivedRosterBots(bots, "").map(({ id }) => id), ["newest", "old", "older"]);
  assert.deepEqual(archivedRosterBots(bots, "inbox").map(({ id }) => id), ["older"], "the search applies to archived bots too");
  assert.deepEqual(archivedRosterBots(bots, "scout"), [], "active bots never list as archived");
  assert.equal(archivedBotCount(bots), 3);
  assert.equal(archivedBotCount([bot("scout")]), 0);
});

test("activity falls back from the last message to the record's own times", () => {
  assert.equal(botActivityAt(bot("a", { lastMessage: { role: "user", text: "x", at: "2026-10-05T00:00:00.000Z" } })), Date.parse("2026-10-05T00:00:00.000Z"));
  assert.equal(botActivityAt(bot("a", { updatedAt: "nonsense", createdAt: "2026-10-02T00:00:00.000Z" })), Date.parse("2026-10-02T00:00:00.000Z"));
  assert.equal(botActivityAt(bot("a", { updatedAt: "", createdAt: "" })), 0);
});

test("search matches name, handle with or without @, and title, ignoring case", () => {
  const scout = bot("scout", { name: "Scout", handle: "scout-2", title: "Inbox researcher" });
  for (const query of ["", "  ", "sco", "SCOUT", "@scout-2", "scout-2", "inbox", "RESEARCH"]) assert.equal(botMatches(scout, query), true, query);
  for (const query of ["ledger", "@ledger", "assistant"]) assert.equal(botMatches(scout, query), false, query);
  assert.deepEqual(rosterBots([scout, bot("ledger")], { query: "@sco", showHidden: false }).map(({ id }) => id), ["scout"]);
});

test("a row previews the latest message, else the role, else says it is new", () => {
  assert.equal(botPreview({ lastMessage: { role: "assistant", text: "Three links found", at: "x" }, title: "Researcher" }), "Three links found");
  assert.equal(botPreview({ lastMessage: { role: "user", text: "Find three links", at: "x" }, title: "Researcher" }), "You: Find three links");
  assert.equal(botPreview({ title: "Researcher" }), "Researcher");
  assert.equal(botPreview({}), "No messages yet");
});

test("chat-list times are compact", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  assert.equal(compactRelativeTime(now - 30_000, now), "now");
  assert.equal(compactRelativeTime(now - 2 * 60_000, now), "2m");
  assert.equal(compactRelativeTime(now - 60 * 60_000, now), "1h");
  assert.equal(compactRelativeTime(now - 26 * 3_600_000, now), "1d");
  assert.match(compactRelativeTime(now - 9 * 86_400_000, now), /\S/u);
  assert.equal(compactRelativeTime(0, now), "");
  assert.equal(compactRelativeTime(now + 60_000, now), "now", "clock skew never shows a negative age");
});

test("the row indicator puts a pending question first and memory waits before running", () => {
  assert.equal(botActivity({ status: "waiting", unread: false, memory: { messages: 1, built: 1, pending: 0, viewBytes: 1, viewLines: 1, waiting: true, usage: NO_USAGE } }), "waiting");
  assert.equal(botActivity({ status: "running", unread: false, memory: { messages: 1, built: 0, pending: 1, viewBytes: 1, viewLines: 1, waiting: true, usage: NO_USAGE } }), "summarizing");
  assert.equal(botActivity({ status: "running", unread: false }), "running");
  assert.equal(botActivity({ status: "starting", unread: false }), "running");
  assert.equal(botActivity({ status: "error", unread: false }), "error");
  assert.equal(botActivity({ status: "disconnected", unread: false }), "away");
  assert.equal(
    botAccessibleName(bot("scout", { name: "Scout", title: "Researcher", status: "running", unread: true, hidden: true, memory: { messages: 2, built: 1, pending: 1, viewBytes: 9, viewLines: 2, failing: { node: "0+1", error: "429", since: "2026-10-05T09:00:00.000Z" }, usage: NO_USAGE } })),
    "Scout, Researcher, working, unread, hidden, memory summaries failing",
  );
});

test("a bot at rest is done while its finished turn is unread, then sleeps; the open bot stays awake", () => {
  assert.equal(botActivity({ status: "idle", unread: true }), "done");
  assert.equal(botActivity({ status: "idle", unread: false }), "sleeping");
  assert.equal(botActivity({ status: "idle", unread: false }, true), "idle");
  assert.equal(botActivity({ status: "idle", unread: true }, true), "idle", "its chat is being read");
  assert.equal(botActivity({ status: "running", unread: true }), "running", "a new turn is work, whatever is unread");
  assert.equal(botAccessibleName(bot("ada", { name: "Ada" })), "Ada, sleeping");
  assert.equal(botAccessibleName(bot("ada", { name: "Ada", unread: true })), "Ada, done, unread");
  assert.equal(botAccessibleName(bot("ada", { name: "Ada" }), true), "Ada, idle");
});

test("tab strips move with arrows, Home and End and ignore other keys", () => {
  assert.equal(tabAfterKey(SIDEBAR_TABS, "sessions", "ArrowRight"), "bots");
  assert.equal(tabAfterKey(SIDEBAR_TABS, "bots", "ArrowRight"), "sessions");
  assert.equal(tabAfterKey(SIDEBAR_TABS, "sessions", "ArrowLeft"), "bots");
  assert.equal(tabAfterKey(SIDEBAR_TABS, "bots", "Home"), "sessions");
  assert.equal(tabAfterKey(SIDEBAR_TABS, "sessions", "End"), "bots");
  assert.equal(tabAfterKey(SIDEBAR_TABS, "sessions", "Enter"), undefined);
  assert.equal(normalizeSidebarTab("bots"), "bots");
  for (const value of [null, "Bots", "agents", 1]) assert.equal(normalizeSidebarTab(value), "sessions");
});

test("the side panel remembers open/closed and its width, defaulting open at 344 px", () => {
  assert.deepEqual(normalizeBotPanel(null), { open: true, width: 344 });
  assert.deepEqual(normalizeBotPanel({ open: false, width: 512.4 }), { open: false, width: 512 });
  assert.deepEqual(normalizeBotPanel({ open: false, tab: "memory" }), { open: false, width: 344 }, "a record from the tabbed panel keeps its open state");
  assert.deepEqual(normalizeBotPanel({ open: "no", width: "wide" }), { open: true, width: 344 });
  assert.deepEqual(normalizeBotPanel({ width: 120 }), { open: true, width: 320 }, "never under its minimum");
});

test("dragging the panel's edge keeps the chat its 420 px and the panel its 320 px", () => {
  assert.equal(clampBotPanelWidth(600, 1200), 600);
  assert.equal(clampBotPanelWidth(900, 1200), 780, "the chat keeps its room");
  assert.equal(clampBotPanelWidth(Number.POSITIVE_INFINITY, 1200), 780, "End: as wide as the chat allows");
  assert.equal(clampBotPanelWidth(200, 1200), 320);
  assert.equal(clampBotPanelWidth(500, 600), 320, "a view too narrow for both still shows the panel at its minimum");
});

test("Ctrl+Shift+, (⇧⌘, on Apple) toggles a bot's Settings, by the comma key's position", () => {
  const key = (overrides: Partial<KeyboardEvent>) => ({ altKey: false, code: "Comma", ctrlKey: false, defaultPrevented: false, isComposing: false, key: "<", metaKey: false, shiftKey: true, ...overrides });
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true, code: "KeyM", key: ";" }), false), false, "another key that types the same character");
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true, code: "", key: "," }), false), true, "a comma without a key position");
  assert.equal(isBotSettingsShortcut(key({ metaKey: true }), true), true);
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true }), true), false, "Ctrl is not the Apple modifier");
  assert.equal(isBotSettingsShortcut(key({ metaKey: true }), false), false);
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true, shiftKey: false }), false), false, "Ctrl+, alone is not it");
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true, isComposing: true }), false), false);
  assert.equal(isBotSettingsShortcut(key({ ctrlKey: true, defaultPrevented: true }), false), false);
  assert.equal(botSettingsShortcutLabel(false), "Ctrl+Shift+,");
  assert.equal(botSettingsShortcutLabel(true), "⇧⌘,");
});
