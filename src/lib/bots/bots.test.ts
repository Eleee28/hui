import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  applyBotsUpdate, withLiveChats, botChangePatch, botDraftOf, botInputFromDraft, botPatchFromDraft, botSettingChange, botSettingOf, isBotSession, isNewBotsFrame, parseBotsUpdate, parseBot, parseBotList, botLook, parseBotMemoryStatus, upsertBot, withoutBotSessions, type BotDraft, type BotView,
  agentReplyTo, BOT_ACCESS_ANSWERS, BOT_FACE_COLORS, BOT_FACE_EARS, BOT_FACE_EARS_LABELS, BOT_FACE_SHAPE_LABELS, BOT_FACE_SHAPES, BOT_LIMITS, BOT_THINKING_LEVELS,
  botColorName, botKickoffName, botTurnOrigin, isBotFaceEars, isBotFaceShape, isBotTagging, previewLine, storedTagging,
} from "./bots.ts";
import type { SessionGroup, SessionView } from "../../api/sessions.ts";

test("bot limits, faces, labels, tagging and sender parsing match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./bots.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(BOT_LIMITS, fixture.limits);
  assert.deepEqual(BOT_THINKING_LEVELS, fixture.thinkingLevels);
  assert.deepEqual(BOT_ACCESS_ANSWERS, fixture.accessAnswers);
  assert.deepEqual({ shapes: BOT_FACE_SHAPES, shapeLabels: BOT_FACE_SHAPE_LABELS, ears: BOT_FACE_EARS, earsLabels: BOT_FACE_EARS_LABELS, colors: BOT_FACE_COLORS }, fixture.faces);
  for (const item of fixture.looks) assert.deepEqual(botLook(item.input), item.expected);
  for (const item of fixture.shapeChecks) assert.equal(isBotFaceShape(item.input), item.expected);
  for (const item of fixture.earsChecks) assert.equal(isBotFaceEars(item.input), item.expected);
  for (const item of fixture.colorNames) assert.equal(botColorName(item.input), item.expected);
  for (const item of fixture.previews) assert.equal(previewLine(item.input.text, item.input.max), item.expected);
  for (const item of fixture.tagging) assert.deepEqual([isBotTagging(item.input), storedTagging(item.input) ?? null], [item.valid, item.stored]);
  for (const item of fixture.kickoffNames) assert.equal(botKickoffName(item.input) ?? null, item.expected);
  for (const item of fixture.turnOrigins) assert.deepEqual(botTurnOrigin(item.input ?? undefined), item.expected);
  for (const item of fixture.replyTo) assert.equal(agentReplyTo(item.input ?? undefined) ?? null, item.expected);
});

const RECORD = {
  id: "b1",
  handle: "scout",
  name: "Scout",
  title: "Research assistant",
  instructions: "A gateway from before SOUL.md: ignored.",
  cwd: "/home/me/.config/hui/bots/b1",
  model: "anthropic/claude",
  thinking: "medium",
  avatar: { emoji: "🔭", color: "#5B9CF6" },
  sessionId: "s1",
  createdAt: "2026-10-05T08:00:00.000Z",
  updatedAt: "2026-10-05T09:00:00.000Z",
  status: "running",
  soul: true,
  lastMessage: { role: "assistant", text: "Done:\n  three   links", at: "2026-10-05T09:00:00.000Z" },
  unread: true,
  memory: {
    messages: 40, built: 38, pending: 2, viewBytes: 92_000, viewLines: 31, waiting: true,
    failing: { node: "1+4", error: "429 rate limited", since: "2026-10-05T08:59:00.000Z" },
    usage: { calls: 12, input: 48_000, output: 1_200, cacheRead: 30_000, cacheWrite: 2_000, cost: 0.0421 },
    junk: "x",
  },
  routines: 2,
};

const USAGE = { calls: 12, input: 48_000, output: 1_200, cacheRead: 30_000, cacheWrite: 2_000, cost: 0.0421 };
const NO_USAGE = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

test("a complete bot record keeps its fields and narrows display text", () => {
  const bot = parseBot(RECORD);
  assert.deepEqual(bot, {
    id: "b1",
    handle: "scout",
    name: "Scout",
    title: "Research assistant",
    model: "anthropic/claude",
    thinking: "medium",
    cwd: "/home/me/.config/hui/bots/b1",
    avatar: { emoji: "🔭", color: "#5b9cf6" },
    sessionId: "s1",
    createdAt: "2026-10-05T08:00:00.000Z",
    updatedAt: "2026-10-05T09:00:00.000Z",
    status: "running",
    soul: true,
    lastMessage: { role: "assistant", text: "Done: three links", at: "2026-10-05T09:00:00.000Z" },
    unread: true,
    memory: { messages: 40, built: 38, pending: 2, viewBytes: 92_000, viewLines: 31, waiting: true, failing: { node: "1+4", error: "429 rate limited", since: "2026-10-05T08:59:00.000Z" }, usage: USAGE },
    routines: 2,
  });
});

test("records without identity are skipped and junk lands on safe defaults", () => {
  for (const value of [null, "bot", [], { id: "b" }, { id: "b", name: "B" }, { name: "B", sessionId: "s" }, { id: " ", name: "B", sessionId: "s" }]) {
    assert.equal(parseBot(value), undefined, JSON.stringify(value));
  }
  const bot = parseBot({ id: "b", name: " Bee ", sessionId: "s", status: "dancing", soul: "yes", unread: "yes", routines: -3, hidden: "true", avatar: { color: "blue" }, lastMessage: { role: "system", text: "x", at: "now" }, memory: "full" });
  assert.deepEqual(bot, { id: "b", handle: "", name: "Bee", cwd: "", sessionId: "s", createdAt: "", updatedAt: "", status: "idle", soul: false, unread: false, routines: 0 });
  assert.deepEqual(parseBot({ id: "b", name: "B", sessionId: "s", hidden: true, archived: true })?.hidden, true);
});

test("a bot list skips invalid entries and keeps the first of duplicate ids", () => {
  const list = parseBotList({ bots: [RECORD, { id: "b1", name: "Copy", sessionId: "s9" }, 7, { id: "b2", name: "Ledger", sessionId: "s2" }] });
  assert.deepEqual(list.map((bot) => [bot.id, bot.name]), [["b1", "Scout"], ["b2", "Ledger"]]);
  assert.deepEqual(parseBotList({}), []);
  assert.deepEqual(parseBotList({ bots: "none" }), []);
});

test("memory status counts are whole and failures need an error to show", () => {
  assert.deepEqual(parseBotMemoryStatus({ messages: 3.7, built: "2", pending: -1, viewBytes: 512, viewLines: 2.5, failing: { node: "0+1" } }), { messages: 3, built: 0, pending: 0, viewBytes: 512, viewLines: 2, usage: NO_USAGE });
  assert.deepEqual(parseBotMemoryStatus({ messages: 1, built: 0, pending: 1, viewBytes: 9, failing: { error: "timeout" } })?.failing, { node: "", error: "timeout", since: "" });
  assert.equal(parseBotMemoryStatus(undefined), undefined);
});

test("the compactor's usage keeps whole token counts and a cost only when one was reported", () => {
  const usage = (value: unknown) => parseBotMemoryStatus({ messages: 1, usage: value })?.usage;
  assert.deepEqual(usage(USAGE), USAGE);
  assert.deepEqual(usage({ calls: 2.9, input: "10", output: -4, cacheRead: Number.NaN, cost: -1 }), { ...NO_USAGE, calls: 2 });
  assert.deepEqual(usage({ calls: 1, input: 1, output: 1, cost: Number.POSITIVE_INFINITY }), { ...NO_USAGE, calls: 1, input: 1, output: 1 });
  assert.deepEqual(usage(undefined), NO_USAGE, "an older gateway without usage reports none");
});

test("stream frames update bots in place and replace the list when they carry its order", () => {
  const scout = parseBot(RECORD) as BotView;
  const ledger = parseBot({ id: "b2", name: "Ledger", sessionId: "s2" }) as BotView;
  const coach = parseBot({ id: "b3", name: "Coach", sessionId: "s3" }) as BotView;
  assert.deepEqual(applyBotsUpdate([scout, ledger], { upserts: [{ ...ledger, status: "running" }] }).map((bot) => [bot.id, bot.status]), [["b1", "running"], ["b2", "running"]]);
  assert.deepEqual(applyBotsUpdate([scout], { upserts: [coach] }).map(({ id }) => id), ["b1", "b3"], "a new bot joins at the end until an order arrives");
  assert.deepEqual(applyBotsUpdate([scout, ledger], { ids: ["b3", "b1"], upserts: [coach] }).map(({ id }) => id), ["b3", "b1"], "ids drop bots no longer listed");
  assert.deepEqual(parseBotsUpdate({ revision: 4, ids: ["b1", 2], upserts: [RECORD, { id: "x" }] }), { revision: 4, ids: ["b1"], upserts: [scout] });
  assert.equal(parseBotsUpdate({ ids: [], upserts: [] }), undefined);
});

test("the status stream's unread marks and statuses win over a list read before them; the bot on screen is read", () => {
  const ada = parseBot({ id: "b1", name: "Ada", sessionId: "s1", status: "running", unread: false }) as BotView;
  const grace = parseBot({ id: "b2", name: "Grace", sessionId: "s2", status: "idle", unread: true }) as BotView;
  const live = { statuses: new Map([["s1", "idle" as const]]), unread: new Map([["s1", true]]), presented: () => false };
  assert.deepEqual(withLiveChats([ada, grace], live).map((bot) => [bot.status, bot.unread]), [["idle", true], ["idle", true]], "a list read before Ada's turn ended does not take its unread mark back");
  assert.deepEqual(withLiveChats([ada, grace], { ...live, unread: new Map([["s1", true], ["s2", false]]) }).map((bot) => bot.unread), [true, false], "a read the stream reported wins too");
  assert.deepEqual(withLiveChats([ada, grace], { ...live, presented: (id) => id === "s2" }).map((bot) => bot.unread), [true, false]);
  assert.equal(withLiveChats([grace], { statuses: new Map(), unread: new Map(), presented: () => false })[0], grace, "nothing new keeps the record");
});

test("a reconnect's cached first frame at the applied revision is a replay, not news", () => {
  assert.equal(isNewBotsFrame(1_000, true, 0), true, "the first list of a fresh page");
  assert.equal(isNewBotsFrame(1_007, true, 1_007), false, "the gateway's cached list after a gap: already shown");
  assert.equal(isNewBotsFrame(1_009, true, 1_007), true, "changes made while this client was away");
  assert.equal(isNewBotsFrame(900, true, 1_007), true, "a gateway that started again");
  assert.equal(isNewBotsFrame(1_008, false, 1_007), true);
  assert.equal(isNewBotsFrame(1_007, false, 1_007), false);
  assert.equal(isNewBotsFrame(1_006, false, 1_007), false);
});

const EMPTY_DRAFT: BotDraft = { name: "", title: "", cwd: "", emoji: "", model: "", thinking: "", memoryModel: "" };

test("a new bot sends its name and only the optional fields that were filled in", () => {
  assert.deepEqual(botInputFromDraft({ ...EMPTY_DRAFT, name: "  Scout " }), { name: "Scout" });
  assert.deepEqual(botInputFromDraft({
    name: "Scout", title: " Researcher ", cwd: " ~/bots/scout ", emoji: "🔭",
    model: "anthropic/claude", thinking: "high", memoryModel: "openai/mini",
  }), {
    name: "Scout", title: "Researcher", cwd: "~/bots/scout",
    model: "anthropic/claude", thinking: "high", memoryModel: "openai/mini", avatar: { emoji: "🔭" },
  });
});

test("an edit sends only what changed, clears emptied fields and keeps an untouched workspace out", () => {
  const bot = parseBot(RECORD) as BotView;
  const unchanged: BotDraft = { name: "Scout", title: "Research assistant", cwd: bot.cwd, emoji: "🔭", model: "anthropic/claude", thinking: "medium", memoryModel: "" };
  assert.deepEqual(botPatchFromDraft(bot, unchanged), {});
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, name: "Scout II", title: "", cwd: "" }), { name: "Scout II", title: "" });
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, cwd: "/srv/scout", model: "openai/gpt", thinking: "high", memoryModel: "openai/mini" }), { cwd: "/srv/scout", model: "openai/gpt", thinking: "high", memoryModel: "openai/mini" });
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, model: "", thinking: "" }), { model: "", thinking: "" }, "Gateway default clears the chat's model and thinking");
  assert.deepEqual(botPatchFromDraft({ ...bot, model: undefined, thinking: undefined }, { ...unchanged, model: "", thinking: "" }), {}, "a bot already on the defaults stays untouched");
  assert.deepEqual(botPatchFromDraft({ ...bot, model: undefined }, unchanged), { model: "anthropic/claude" }, "a model chosen for a bot on the default");
  assert.deepEqual(botPatchFromDraft({ ...bot, memoryModel: "openai/mini" }, unchanged), { memoryModel: "" }, "an emptied memory model goes back to the bot's own");
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, emoji: "" }), { avatar: { emoji: "" } }, "removing the emoji clears only that key");
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, emoji: "🦉" }), { avatar: { emoji: "🦉" } });
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, name: "  " }), {}, "a blank name is never sent");
});

test("a bot on a worker: its view names the worker, and an edit never moves it", () => {
  const remote = parseBot({ ...RECORD, cwd: "/home/remote/.local/share/hui-worker/bots/b1", worker: { id: "w-1", name: "devbox" } }) as BotView;
  assert.deepEqual(remote.worker, { id: "w-1", name: "devbox" });
  assert.equal(parseBot({ ...RECORD, worker: { id: "w-1" } })?.worker, undefined, "a worker without its name is no worker to show");
  assert.equal(parseBot({ ...RECORD, worker: "w-1" })?.worker, undefined);
  const unchanged: BotDraft = { name: "Scout", title: "Research assistant", cwd: remote.cwd, emoji: "🔭", model: "anthropic/claude", thinking: "medium", memoryModel: "" };
  assert.deepEqual(botPatchFromDraft(remote, unchanged), {}, "an untouched folder on the worker sends nothing");
  assert.equal("worker" in botPatchFromDraft(remote, { ...unchanged, name: "Rover" }), false, "where a bot runs is never part of an edit");
});

test("the dialog's Look: a new bot keeps the face it showed, or its emoji, with that color", () => {
  const face: BotDraft = { ...EMPTY_DRAFT, name: "Scout", look: "face", shape: "heart", color: "#2FC49A", emoji: "🦊" };
  assert.deepEqual(botInputFromDraft(face), { name: "Scout", avatar: { color: "#2fc49a", shape: "heart" } }, "Face ignores a typed emoji");
  assert.deepEqual(botInputFromDraft({ ...face, look: "emoji" }), { name: "Scout", avatar: { emoji: "🦊", color: "#2fc49a", shape: "heart" } });
  assert.deepEqual(botInputFromDraft({ ...face, ears: "bunny" }), { name: "Scout", avatar: { color: "#2fc49a", shape: "heart", ears: "bunny" } });
  assert.deepEqual(botInputFromDraft({ ...face, shape: "dragon" as never, ears: "wings" as never, color: "teal" }), { name: "Scout" }, "nothing invalid reaches the gateway");
});

test("an edit's Look: Face clears the emoji, and a shape, ears or color go only when they differ from what the bot shows", () => {
  const bot = parseBot({ ...RECORD, avatar: { emoji: "🔭" } }) as BotView;
  const base: BotDraft = { name: "Scout", title: "Research assistant", cwd: bot.cwd, emoji: "🔭", model: "anthropic/claude", thinking: "medium", memoryModel: "" };
  // A bot whose id picks its face: the dialog opens on that face, so leaving it alone keeps it derived.
  const plain = parseBot({ ...RECORD, avatar: undefined }) as BotView;
  const picked = botLook(plain);
  const plainDraft: BotDraft = { ...base, emoji: "", look: "face", shape: picked.shape, color: picked.color };
  assert.deepEqual(botPatchFromDraft(plain, plainDraft), {}, "the id's face stays the id's");
  const other = picked.shape === "heart" ? "cookie" : "heart";
  assert.deepEqual(botPatchFromDraft(plain, { ...plainDraft, shape: other }), { avatar: { shape: other } }, "a new shape is stored, the color stays derived");
  assert.deepEqual(botPatchFromDraft(bot, { ...base, look: "emoji" }), {}, "an emoji bot left on Emoji is untouched");
  assert.deepEqual(botPatchFromDraft(bot, { ...base, look: "face" }), { avatar: { emoji: "" } }, "Face clears the emoji and nothing else");
  const stored = parseBot({ ...RECORD, avatar: { shape: "heart", color: "#2fc49a" } }) as BotView;
  const storedDraft: BotDraft = { ...base, emoji: "", look: "face", shape: "heart", color: "#2fc49a" };
  assert.deepEqual(botPatchFromDraft(stored, storedDraft), {}, "the same face sends nothing");
  assert.deepEqual(botPatchFromDraft(stored, { ...storedDraft, shape: "cookie", color: "#FF6B4A" }), { avatar: { shape: "cookie", color: "#ff6b4a" } });
  assert.deepEqual(botPatchFromDraft(stored, { ...storedDraft, look: "emoji", emoji: "🦉" }), { avatar: { emoji: "🦉" } }, "back to an emoji keeps the face behind it");
  assert.deepEqual(botPatchFromDraft(stored, { ...storedDraft, ears: "" }), {}, "no ears on a bot without any sends nothing");
  assert.deepEqual(botPatchFromDraft(stored, { ...storedDraft, ears: "cat" }), { avatar: { ears: "cat" } });
  const eared = parseBot({ ...RECORD, avatar: { shape: "heart", ears: "cat", color: "#2fc49a" } }) as BotView;
  assert.deepEqual(botPatchFromDraft(eared, { ...storedDraft, ears: "" }), { avatar: { ears: "" } }, "None takes them off");
});

test("a bot's look parses its shape and ears and drops unknown ones", () => {
  assert.deepEqual(parseBot({ ...RECORD, avatar: { shape: "triangle", color: "#F5C21B" } })?.avatar, { color: "#f5c21b", shape: "triangle" });
  assert.deepEqual(parseBot({ ...RECORD, avatar: { shape: "star", ears: "sprout" } })?.avatar, { shape: "star", ears: "sprout" });
  assert.equal(parseBot({ ...RECORD, avatar: { shape: "dragon", ears: "wings" } })?.avatar, undefined);
});

test("a confirmed record replaces its old copy or joins the list", () => {
  const scout = parseBot(RECORD) as BotView;
  const ledger = parseBot({ id: "b2", name: "Ledger", sessionId: "s2" }) as BotView;
  assert.deepEqual(upsertBot([scout, ledger], { ...ledger, name: "Ledger II" }).map(({ name }) => name), ["Scout", "Ledger II"]);
  assert.deepEqual(upsertBot([scout], ledger).map(({ id }) => id), ["b1", "b2"]);
});

function session(id: string, group: string, overrides: Partial<SessionView> = {}): SessionView {
  return { id, title: id, group, cwd: "/work", tool: "durable", status: "idle", displayCwd: "", stage: "investigation", stageOrigin: "default", createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", ...overrides };
}

test("bot chats leave every session list while groups keep their meaning", () => {
  const scout = session("bot-chat", "", { bot: { id: "b1", handle: "scout", name: "Scout" } });
  const ledger = session("ledger-chat", "Work", { bot: { id: "b2", handle: "ledger", name: "Ledger" } });
  const plain = session("plain", "Work");
  const work: SessionGroup = { label: "Work", sessions: [plain, ledger] };
  const empty: SessionGroup = { label: "Empty", sessions: [] };
  const groups: SessionGroup[] = [work, empty, { label: "Bots only", sessions: [session("b3-chat", "Bots only", { bot: { id: "b3", handle: "c", name: "C" } })] }, { label: "ungrouped", sessions: [scout] }];
  const filtered = withoutBotSessions(groups);
  assert.deepEqual(filtered.map((group) => [group.label, group.sessions.map(({ id }) => id)]), [["Work", ["plain"]], ["Empty", []], ["Bots only", []]]);
  assert.equal(filtered[1], empty, "a group without bot chats keeps its identity");
  assert.equal(isBotSession(scout), true);
  assert.equal(isBotSession(plain), false);
  // OTHER stays while it still lists ordinary sessions.
  assert.deepEqual(withoutBotSessions([{ label: "ungrouped", sessions: [scout, session("loose", "")] }]).map((group) => group.sessions.map(({ id }) => id)), [["loose"]]);
});

test("a bot's subagents, and theirs, leave session lists with its chat; other subagents and orphans stay", () => {
  const chat = session("bot-chat", "", { bot: { id: "b1", handle: "scout", name: "Scout" } });
  const helper = session("helper", "Work", { parentId: "bot-chat" });
  const nested = session("nested", "", { parentId: "helper" });
  const parent = session("parent", "Work");
  const child = session("child", "Work", { parentId: "parent" });
  const orphan = session("orphan", "", { parentId: "gone" });
  const loop = session("loop", "", { parentId: "loop" });
  const filtered = withoutBotSessions([{ label: "Work", sessions: [helper, parent, child] }, { label: "ungrouped", sessions: [chat, nested, orphan, loop] }]);
  assert.deepEqual(filtered.map((group) => [group.label, group.sessions.map(({ id }) => id)]), [["Work", ["parent", "child"]], ["ungrouped", ["orphan", "loop"]]]);
  assert.deepEqual(withoutBotSessions([{ label: "ungrouped", sessions: [chat, nested] }, { label: "Work", sessions: [helper] }]).map((group) => [group.label, group.sessions.length]), [["Work", 0]], "OTHER goes when a bot's sessions were all it held; a configured group stays");
});

test("the dialog's language goes with a new bot, an edit sends it only when it changed and Auto clears it", () => {
  assert.deepEqual(botInputFromDraft({ ...EMPTY_DRAFT, name: "Vox", voiceLanguage: "es" }).voice, { language: "es" });
  assert.equal(botInputFromDraft({ ...EMPTY_DRAFT, name: "Vox", voiceLanguage: "" }).voice, undefined, "Auto is no language at all");
  assert.equal(botInputFromDraft({ ...EMPTY_DRAFT, name: "Vox", voiceLanguage: "klingon" }).voice, undefined, "only Whisper's codes");
  const bot = { ...(parseBot(RECORD) as BotView), voice: { language: "es" as const } };
  const unchanged: BotDraft = { name: "Scout", title: "Research assistant", cwd: bot.cwd, emoji: "🔭", model: "anthropic/claude", thinking: "medium", memoryModel: "", voiceLanguage: "es" };
  assert.deepEqual(botPatchFromDraft(bot, unchanged), {});
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, voiceLanguage: "haw" }), { voice: { language: "haw" } });
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, voiceLanguage: "" }), { voice: { language: "" } }, "back to Auto");
  const { voiceLanguage: _language, ...withoutLanguage } = unchanged;
  assert.deepEqual(botPatchFromDraft(bot, withoutLanguage), {}, "a draft without a language leaves it alone");
  assert.deepEqual(parseBot({ ...RECORD, voice: { language: "ES" } })?.voice, { language: "es" });
  assert.equal(parseBot({ ...RECORD, voice: { language: "spanish" } })?.voice, undefined, "a language that is not a code is dropped");
  assert.equal(parseBot({ ...RECORD, voice: { language: "jv" } })?.voice, undefined, "Whisper calls Javanese jw");
});

test("the dialog's call voice goes with a new bot, and an edit sends it when it changed", () => {
  assert.deepEqual(botInputFromDraft({ ...EMPTY_DRAFT, name: "Vox", callVoice: "ember", voiceLanguage: "es" }).voice, { language: "es", live: "ember" });
  assert.equal(botInputFromDraft({ ...EMPTY_DRAFT, name: "Vox", callVoice: "" }).voice, undefined, "Default is no call voice of its own");
  assert.equal(botInputFromDraft({ ...EMPTY_DRAFT, name: "Vox", callVoice: "marin" }).voice, undefined, "only GPT-Live's ChatGPT voices");
  const bot = { ...(parseBot(RECORD) as BotView), voice: { live: "sol" as const } };
  const unchanged: BotDraft = { name: "Scout", title: "Research assistant", cwd: bot.cwd, emoji: "🔭", model: "anthropic/claude", thinking: "medium", memoryModel: "", callVoice: "sol", voiceLanguage: "" };
  assert.deepEqual(botPatchFromDraft(bot, unchanged), {});
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, callVoice: "vale" }), { voice: { live: "vale" } });
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, callVoice: "" }), { voice: { live: "" } }, "back to Settings' voice");
  assert.deepEqual(botPatchFromDraft(bot, { ...unchanged, voiceLanguage: "fr" }), { voice: { language: "fr" } });
  const { callVoice: _call, ...withoutCallVoice } = unchanged;
  assert.deepEqual(botPatchFromDraft(bot, withoutCallVoice), {}, "a draft without a call voice leaves it alone");
  assert.equal(parseBot({ ...RECORD, voice: { live: "nova" } })?.voice, undefined);
});

test("the Settings page sends one change at a time by the edit rules, and nothing for a choice that stays", () => {
  const bot = { ...(parseBot(RECORD) as BotView), voice: { language: "es" as const, live: "sol" as const } };
  assert.deepEqual(botPatchFromDraft(bot, botDraftOf(bot)), {}, "the bot as it is changes nothing");
  assert.equal(botChangePatch(bot, { model: "anthropic/claude" }), undefined, "the same model sends nothing");
  assert.deepEqual(botChangePatch(bot, { model: "" }), { model: "" }, "Gateway default clears the model");
  assert.deepEqual(botChangePatch(bot, { thinking: "" }), { thinking: "" }, "and the thinking level");
  assert.deepEqual(botChangePatch(bot, { memoryModel: "openai/mini" }), { memoryModel: "openai/mini" });
  assert.deepEqual(botChangePatch({ ...bot, memoryModel: "openai/mini" }, { memoryModel: "" }), { memoryModel: "" }, "Default goes back to Settings' utility model");
  assert.deepEqual(botChangePatch(bot, botSettingChange("callVoice", "vale")), { voice: { live: "vale" } }, "a call voice leaves the rest of the voice alone");
  assert.deepEqual(botChangePatch(bot, botSettingChange("callVoice", "")), { voice: { live: "" } }, "Default follows Settings' call voice");
  assert.deepEqual(botChangePatch(bot, botSettingChange("voiceLanguage", "")), { voice: { language: "" } }, "Auto clears the language");
  assert.equal(botChangePatch(bot, botSettingChange("cwd", "  ")), undefined, "an emptied workspace keeps the one it has");
  assert.deepEqual(botChangePatch(bot, botSettingChange("cwd", " ~/bots/scout ")), { cwd: "~/bots/scout" });
  assert.deepEqual(["model", "thinking", "memoryModel", "callVoice", "voiceLanguage", "cwd"].map((key) => botSettingOf(bot, key as never)),
    ["anthropic/claude", "medium", "", "sol", "es", bot.cwd], "each row starts from the bot, \"\" for a default");
});

test("the Profile rows send the name, title and look that changed, one part at a time", () => {
  const bot = parseBot({ ...RECORD, avatar: { shape: "heart", color: "#2fc49a" } }) as BotView;
  assert.deepEqual(["name", "title", "shape", "color", "emoji"].map((key) => botSettingOf(bot, key as never)), ["Scout", "Research assistant", "heart", "#2fc49a", ""]);
  assert.equal(botChangePatch(bot, botSettingChange("name", "Scout")), undefined, "an untouched name sends nothing");
  assert.deepEqual(botChangePatch(bot, botSettingChange("name", " Scout II ")), { name: "Scout II" });
  assert.equal(botChangePatch(bot, botSettingChange("name", "  ")), undefined, "a blank name is never sent");
  assert.deepEqual(botChangePatch(bot, botSettingChange("title", "")), { title: "" }, "an emptied title clears it");
  assert.deepEqual(botChangePatch(bot, botSettingChange("shape", "cookie")), { avatar: { shape: "cookie" } });
  assert.deepEqual(botChangePatch(bot, botSettingChange("color", "#FF6B4A")), { avatar: { color: "#ff6b4a" } });
  assert.deepEqual(botChangePatch(bot, botSettingChange("emoji", "🦉")), { avatar: { emoji: "🦉" } }, "an emoji switches to the Emoji look");
  const owl = parseBot({ ...RECORD, avatar: { emoji: "🦉", shape: "heart" } }) as BotView;
  assert.deepEqual(botChangePatch(owl, botSettingChange("emoji", "")), { avatar: { emoji: "" } }, "Face clears the emoji and keeps the face behind it");
  assert.deepEqual(botChangePatch(owl, botSettingChange("shape", "round")), { avatar: { shape: "round" } }, "a shape waits behind the emoji");
});

test("the Tagging rows send its description and who can tag it, only when they change", () => {
  const bot = parseBot({ ...RECORD, description: "Finds sources.", tagging: "mention" }) as BotView;
  assert.equal(bot.tagging, "mention");
  assert.equal(parseBot({ ...RECORD, tagging: "anyone" })?.tagging, undefined, "the default is no field");
  assert.equal(parseBot({ ...RECORD, tagging: "sometimes" })?.tagging, undefined);
  assert.deepEqual(["description", "tagging"].map((key) => botSettingOf(bot, key as never)), ["Finds sources.", "mention"]);
  assert.equal(botSettingOf(parseBot(RECORD) as BotView, "tagging"), "anyone");
  assert.equal(botChangePatch(bot, botSettingChange("description", " Finds sources. ")), undefined, "an untouched description sends nothing");
  assert.deepEqual(botChangePatch(bot, botSettingChange("description", "")), { description: "" }, "an emptied description clears it");
  assert.equal(botChangePatch(bot, botSettingChange("tagging", "mention")), undefined);
  assert.deepEqual(botChangePatch(bot, botSettingChange("tagging", "anyone")), { tagging: "anyone" }, "back to the default");
  assert.deepEqual(botChangePatch(bot, botSettingChange("tagging", "nobody")), { tagging: "nobody" });
  assert.equal(botChangePatch(bot, botSettingChange("tagging", "everyone")), undefined, "nothing invalid reaches the gateway");
});

test("a bot whose record still carries a VoiceStudio voice shows only its language and call voice", () => {
  assert.deepEqual(parseBot({ ...RECORD, voice: { profile: "vp-dani", speed: 1.25, language: "es", live: "juniper" } })?.voice, { language: "es", live: "juniper" });
  assert.equal(parseBot({ ...RECORD, voice: { profile: "vp-dani", speed: 1.25 } })?.voice, undefined);
});
