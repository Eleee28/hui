import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";

import { BOT_FACE_EARS, BOT_FACE_SHAPES, BOT_KICKOFF_MARKER, botKickoffName, botKickoffText, handleFromName, previewLine, type BotRecord } from "../bots-format.ts";
import {
  BotConflictError, BotInputError, BotNotFoundError, BotRegistry, BotStoreError,
  findBot, isDerivedHandle, isOneGrapheme, normalizeBotInput, normalizeBotPatch, normalizeSoul, parseBotRecord, patchedAvatar, patchedVoice, uniqueHandle,
} from "./bots.ts";

async function tempFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hui-bots-registry-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "bots.json");
}

const now = "2026-10-05T10:00:00.000Z";
function bot(id: string, handle: string, extra: Partial<BotRecord> = {}): BotRecord {
  return { id, handle, name: handle.toUpperCase(), cwd: "/tmp", sessionId: `session-${id}`, createdAt: now, updatedAt: now, ...extra };
}

test("handles derive from names as lowercase ASCII slugs and take -2, -3… on collision within 32 characters", () => {
  assert.equal(handleFromName("Ada Lovelace"), "ada-lovelace");
  assert.equal(handleFromName("  Señor   Café!! "), "senor-cafe");
  assert.equal(handleFromName("***"), "bot", "nothing usable falls back to bot");
  assert.equal(handleFromName("日本語"), "bot");
  const long = handleFromName("The quite remarkably long name of a research assistant");
  assert.equal(long, "the-quite-remarkably-long-name-o");
  assert.equal(long.length, 32);
  assert.equal(handleFromName("a".repeat(31) + " b"), "a".repeat(31), "a cut never leaves a trailing dash");
  assert.equal(uniqueHandle("ada", new Set()), "ada");
  assert.equal(uniqueHandle("ada", new Set(["ada"])), "ada-2");
  assert.equal(uniqueHandle("ada", new Set(["ada", "ada-2"])), "ada-3");
  const full = "x".repeat(31) + "y";
  const suffixed = uniqueHandle(full, new Set([full]));
  assert.equal(suffixed, `${"x".repeat(30)}-2`);
  assert.equal(suffixed.length, 32);
  assert.equal(uniqueHandle("ab-cd", new Set(["ab-cd"])), "ab-cd-2");
  assert.equal(uniqueHandle("events", new Set()), "events-2", "the list stream's path is no bot's handle");
  assert.equal(uniqueHandle(`${"a".repeat(29)}-bc`, new Set([`${"a".repeat(29)}-bc`])), `${"a".repeat(29)}-2`, "no dash before the suffix's own");
  // Derived handles, which follow a renamed bot's name; anything else was chosen and stays.
  assert.equal(isDerivedHandle("new-bot", "New Bot"), true);
  assert.equal(isDerivedHandle("new-bot-3", "New Bot"), true);
  assert.equal(isDerivedHandle("new-bot-1", "New Bot"), false, "uniqueHandle starts at -2");
  assert.equal(isDerivedHandle("scout", "New Bot"), false);
  assert.equal(isDerivedHandle(suffixed, full), true, "a suffix that cut a long slug");
  assert.equal(isDerivedHandle("events-2", "events"), true);
});

test("input is validated at the boundary: limits, formats, unknown fields and one-grapheme emoji", () => {
  assert.deepEqual(normalizeBotInput({ name: "  Ada  ", title: "", avatar: { emoji: "🦊", color: "#AABBCC" }, hidden: false }), {
    name: "Ada", avatar: { emoji: "🦊", color: "#aabbcc" },
  });
  assert.deepEqual(normalizeBotInput({ name: "Ada", model: "", thinking: "" }), { name: "Ada" }, "an empty model or level is the default a new chat gets anyway");
  const full = normalizeBotInput({
    name: "Ada", handle: "@ada", title: "Researcher", description: "Reads papers", soul: "  # Who I am\r\nBrief.\n  ",
    cwd: "~/work", model: "vercel-ai-gateway/anthropic/claude", thinking: "high", memoryModel: "openai/gpt-mini", memoryThinking: "low", hidden: true,
  });
  assert.deepEqual(full, {
    name: "Ada", handle: "ada", title: "Researcher", description: "Reads papers", soul: "# Who I am\nBrief.",
    cwd: "~/work", model: "vercel-ai-gateway/anthropic/claude", thinking: "high", memoryModel: "openai/gpt-mini", memoryThinking: "low", hidden: true,
  });
  assert.deepEqual(normalizeBotInput({ name: "Ada", soul: "  \n " }), { name: "Ada" }, "a blank soul is none: the bot has its first conversation");
  assert.deepEqual(normalizeBotInput({}), { name: "New Bot" }, "no name: New Bot, until its first conversation names it");
  assert.deepEqual(normalizeBotInput({ title: "Scout" }), { name: "New Bot", title: "Scout" });
  const rejects: [unknown, RegExp][] = [
    [null, /must be an object/u],
    [{ name: "" }, /Bot name must be 1-60/u],
    [{ name: "" }, /Bot name must be 1-60/u],
    [{ name: "x".repeat(61) }, /Bot name must be 1-60/u],
    [{ name: "two\nlines" }, /one line/u],
    [{ name: "Ada", nickname: "x" }, /Unknown bot field: nickname/u],
    [{ name: "Ada", handle: "Ada!" }, /Bot handle must be/u],
    [{ name: "Ada", handle: "-ada" }, /Bot handle must be/u],
    [{ name: "Ada", handle: "a".repeat(33) }, /Bot handle must be 1-32|at most 32/u],
    [{ name: "Ada", handle: "events" }, /@events is reserved/u],
    [{ name: "Ada", title: "t".repeat(81) }, /Bot title must be at most 80/u],
    [{ name: "Ada", description: "d".repeat(501) }, /at most 500/u],
    [{ name: "Ada", soul: "s".repeat(20_001) }, /SOUL\.md must be at most 20000 characters \(it has 20001\)/u],
    [{ name: "Ada", soul: 7 }, /SOUL\.md must be text/u],
    [{ name: "Ada", instructions: "Be brief." }, /no instructions any more: a bot's persona is its SOUL\.md/u],
    [{ name: "Ada", model: "gpt" }, /provider\/id/u],
    [{ name: "Ada", thinking: "ultra" }, /Thinking level must be one of/u],
    [{ name: "Ada", memoryModel: "bad model" }, /provider\/id/u],
    [{ name: "Ada", cwd: "" }, /Working directory must be 1-/u],
    [{ name: "Ada", avatar: { emoji: "🦊🐻" } }, /one character/u],
    [{ name: "Ada", avatar: { emoji: "ab" } }, /one character/u],
    [{ name: "Ada", avatar: { color: "red" } }, /#rrggbb/u],
    [{ name: "Ada", avatar: { size: 3 } }, /Unknown avatar field/u],
    [{ name: "Ada", hidden: "yes" }, /Hidden must be a boolean/u],
  ];
  for (const [value, message] of rejects) assert.throws(() => normalizeBotInput(value), (error: unknown) => error instanceof BotInputError && message.test(error.message), JSON.stringify(value));
  assert.equal(isOneGrapheme("👩‍👩‍👧"), true, "a ZWJ sequence is one character");
  assert.equal(isOneGrapheme("👍🏽"), true);
  assert.equal(isOneGrapheme("A"), true);
  assert.equal(isOneGrapheme(" "), false);
  assert.equal(isOneGrapheme("\u0007"), false);
});

test("a patch carries only what changes and may clear optional text and avatar keys", () => {
  assert.throws(() => normalizeBotPatch({}), /Nothing to change/u);
  assert.deepEqual(normalizeBotPatch({ title: "", memoryModel: "", memoryThinking: "" }), { title: "", memoryModel: "", memoryThinking: "" });
  assert.throws(() => normalizeBotPatch({ soul: "x" }), /PUT \/__hui\/bots\/:id\/soul/u, "SOUL.md has its own route");
  assert.throws(() => normalizeBotPatch({ instructions: "" }), /no instructions any more/u);
  // The utility model is stored as memoryModel, its name before calls; both names keep working.
  assert.deepEqual(normalizeBotPatch({ utilityModel: "anthropic/claude-haiku" }), { memoryModel: "anthropic/claude-haiku" });
  assert.deepEqual(normalizeBotPatch({ utilityModel: "a/b", memoryModel: "a/b" }), { memoryModel: "a/b" });
  assert.throws(() => normalizeBotPatch({ utilityModel: "a/b", memoryModel: "c/d" }), /Give the utility model once/u);
  assert.deepEqual(normalizeBotPatch({ avatar: null, hidden: false }), { avatar: null, hidden: false });
  assert.deepEqual(normalizeBotPatch({ model: "", thinking: "" }), { model: "", thinking: "" }, "the chat goes back to the gateway's defaults");
  assert.throws(() => normalizeBotPatch({ model: "gpt" }), /provider\/id/u);
  assert.throws(() => normalizeBotPatch({ model: 7 }), /Bot model must be text/u);
  assert.throws(() => normalizeBotPatch({ thinking: "loud" }), /Thinking level must be one of/u);
  assert.throws(() => normalizeBotPatch({ name: " " }), /Bot name must be 1-60/u);
  assert.throws(() => normalizeBotPatch({ sessionId: "x" }), /Unknown bot field: sessionId/u);
  assert.deepEqual(patchedAvatar({ emoji: "🦊", color: "#000000" }, { emoji: "" }), { color: "#000000" });
  assert.deepEqual(patchedAvatar({ emoji: "🦊" }, { color: "#112233" }), { emoji: "🦊", color: "#112233" });
  assert.equal(patchedAvatar({ emoji: "🦊" }, null), undefined);
  assert.equal(patchedAvatar({ emoji: "🦊" }, { emoji: "" }), undefined);
});

test("who may tag a bot is anyone (stored as nothing), only when mentioned, or nobody", () => {
  assert.deepEqual(normalizeBotInput({ name: "Ada", tagging: "mention", description: "Release notes. Tag her when a PR merges." }), {
    name: "Ada", description: "Release notes. Tag her when a PR merges.", tagging: "mention",
  });
  assert.deepEqual(normalizeBotInput({ name: "Ada", tagging: "anyone" }), { name: "Ada" }, "the default is not stored");
  assert.deepEqual(normalizeBotPatch({ tagging: "anyone" }), { tagging: "anyone" }, "a patch can go back to the default");
  assert.deepEqual(normalizeBotPatch({ tagging: "nobody" }), { tagging: "nobody" });
  for (const tagging of ["everyone", "", null, 1]) assert.throws(() => normalizeBotPatch({ tagging }), /Who can tag the bot must be one of: anyone, mention, nobody\./u, String(tagging));
  assert.equal(parseBotRecord(bot("b1", "ada", { tagging: "nobody" }))?.tagging, "nobody");
  assert.equal(parseBotRecord({ ...bot("b1", "ada"), tagging: "anyone" })?.tagging, undefined);
  assert.equal(parseBotRecord({ ...bot("b1", "ada"), tagging: "sometimes" })?.tagging, undefined, "a bad value is dropped, never the bot");
});

test("a bot's look: a face shape, ears and any #rrggbb color, an emoji beside them; \"\" or null clears", () => {
  assert.deepEqual(normalizeBotInput({ name: "Ada", avatar: { shape: "heart", color: "#2FC49A" } }), { name: "Ada", avatar: { shape: "heart", color: "#2fc49a" } });
  assert.deepEqual(normalizeBotInput({ name: "Ada", avatar: { emoji: "🦊", shape: "cookie" } }), { name: "Ada", avatar: { emoji: "🦊", shape: "cookie" } }, "the face waits behind an emoji");
  assert.deepEqual(normalizeBotInput({ name: "Ada", avatar: { shape: "", color: "" } }), { name: "Ada" }, "a new bot has no look to clear: its id picks one");
  for (const shape of BOT_FACE_SHAPES) assert.deepEqual(normalizeBotPatch({ avatar: { shape } }), { avatar: { shape } });
  for (const ears of BOT_FACE_EARS) assert.deepEqual(normalizeBotPatch({ avatar: { ears } }), { avatar: { ears } });
  assert.deepEqual(normalizeBotInput({ name: "Ada", avatar: { shape: "star", ears: "cat" } }), { name: "Ada", avatar: { shape: "star", ears: "cat" } });
  for (const [avatar, message] of [
    [{ shape: "dragon" }, /Avatar shape must be one of: blob, round, triangle, heart, cookie, star, flower, cloud, drop, ghost, pill, block, hexagon\./u],
    [{ ears: "wings" }, /Avatar ears must be one of: cat, bear, bunny, antenna, sprout, horns, or "" for none\./u],
    [{ ears: "Cat" }, /Avatar ears must be one of/u],
    [{ shape: "Heart" }, /Avatar shape must be one of/u],
    [{ shape: 3 }, /Avatar shape must be one of/u],
    [{ shape: null }, /Avatar shape must be one of/u],
    [{ color: "mint" }, /#rrggbb/u],
    [{ face: "heart" }, /Unknown avatar field: face/u],
    ["heart", /emoji, color, shape and\/or ears/u],
  ] as const) {
    assert.throws(() => normalizeBotPatch({ avatar }), (error: unknown) => error instanceof BotInputError && message.test(error.message), JSON.stringify(avatar));
  }
  assert.deepEqual(normalizeBotPatch({ avatar: { emoji: "", shape: "", color: "" } }), { avatar: { emoji: "", shape: "", color: "" } }, "\"\" is kept so the patch can tell it clears");
  // PATCH: given keys replace, "" clears one, null clears all three.
  const look = { emoji: "🦊", shape: "heart" as const, color: "#2fc49a" };
  assert.deepEqual(patchedAvatar(look, { emoji: "" }), { shape: "heart", color: "#2fc49a" }, "clearing the emoji switches the bot to its face");
  assert.deepEqual(patchedAvatar(look, { shape: "" }), { emoji: "🦊", color: "#2fc49a" }, "a cleared shape goes back to the id's");
  assert.deepEqual(patchedAvatar(look, { shape: "round", color: "#3a7bfa" }), { emoji: "🦊", shape: "round", color: "#3a7bfa" });
  assert.deepEqual(patchedAvatar(undefined, { shape: "triangle" }), { shape: "triangle" });
  assert.equal(patchedAvatar(look, null), undefined);
  assert.equal(patchedAvatar({ shape: "heart" }, { shape: "" }), undefined, "nothing left: the avatar goes");
  assert.deepEqual(patchedAvatar({ shape: "heart" }, { ears: "bunny" }), { shape: "heart", ears: "bunny" });
  assert.deepEqual(patchedAvatar({ shape: "heart", ears: "bunny" }, { ears: "" }), { shape: "heart" }, "\"\" takes the ears off");
});

test("a bot chooses its worker at creation, by id or name, and a change never moves it", () => {
  assert.deepEqual(normalizeBotInput({ name: "Rover", worker: " devbox " }), { name: "Rover", worker: "devbox" });
  assert.deepEqual(normalizeBotInput({ name: "Rover", worker: "" }), { name: "Rover" }, "an empty worker is this machine");
  assert.throws(() => normalizeBotInput({ name: "Rover", worker: 7 }), /Worker must be text/u);
  assert.throws(() => normalizeBotInput({ name: "Rover", worker: "x".repeat(101) }), /Worker must be at most 100/u);
  for (const patch of [{ worker: "devbox" }, { worker: "" }, { title: "Scout", worker: "devbox" }]) {
    assert.throws(() => normalizeBotPatch(patch), (error: unknown) => error instanceof BotInputError && error.message === "A bot stays on the machine it was created on.", JSON.stringify(patch));
  }
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), worker: "0f8e9c1a-4b2d-4c6e-8f00-1234567890ab" }), { ...bot("a", "ada"), worker: "0f8e9c1a-4b2d-4c6e-8f00-1234567890ab" });
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), worker: "../elsewhere" }), bot("a", "ada"), "a worker that is no id is dropped, not the bot");
});

test("SOUL.md text is trimmed with Unix line ends, at most 20,000 characters; the kickoff message is recognized by its first line", () => {
  assert.equal(normalizeSoul("\r\n# Soul\r\nline\rnext \n"), "# Soul\nline\nnext");
  assert.equal(normalizeSoul("   "), "", "blank is none");
  assert.equal(normalizeSoul("s".repeat(20_000)).length, 20_000);
  assert.throws(() => normalizeSoul("s".repeat(20_001)), BotInputError);
  assert.throws(() => normalizeSoul(null), /must be text/u);
  assert.throws(() => normalizeSoul("a\0b"), /must be text/u);
  const kickoff = botKickoffText("Scout  the\nScout");
  assert.equal(kickoff.split("\n")[0], BOT_KICKOFF_MARKER);
  assert.equal(botKickoffName(kickoff), "Scout the Scout", "its name, on one line");
  assert.match(kickoff, /from HUI, not the operator/u);
  assert.match(kickoff, /Write your opening message to them now \(your greeting and first question, as your soul section says\) and reply with that message only\./u, "it asks for the opener itself: a real model read \"the operator has not written yet\" as a reason to wait");
  assert.equal(botKickoffName(BOT_KICKOFF_MARKER), "");
  assert.equal(botKickoffName(`${BOT_KICKOFF_MARKER} by hand`), undefined, "only the marker line itself");
  assert.equal(botKickoffName("[routine: Standup] go"), undefined);
});

test("stored records keep what validates: a bad optional field is dropped, a bad required one skips the record", () => {
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), avatar: { shape: "heart", color: "#2fc49a" } }), { ...bot("a", "ada"), avatar: { color: "#2fc49a", shape: "heart" } });
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), avatar: { shape: "star", ears: "bunny" } }), { ...bot("a", "ada"), avatar: { shape: "star", ears: "bunny" } });
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), avatar: { emoji: "🦊", shape: "dragon", ears: "wings" } }), { ...bot("a", "ada"), avatar: { emoji: "🦊" } }, "an unknown shape or ears are dropped, not the bot");
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), avatar: { emoji: "🦊", color: "teal" }, thinking: "ultra", title: "", hidden: "yes" }), {
    ...bot("a", "ada"), avatar: { emoji: "🦊" },
  });
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), instructions: "Old persona." }), bot("a", "ada"), "a record's persona is SOUL.md now, never instructions");
  for (const broken of [{ ...bot("a", "ada"), handle: "Ada" }, { ...bot("a", "ada"), cwd: "relative" }, { ...bot("a", "ada"), sessionId: "" }, { ...bot("a", "ada"), name: "" }, "ada", null]) {
    assert.equal(parseBotRecord(broken), undefined, JSON.stringify(broken));
  }
});

test("a bot's disabled tools and skills: whole lists of names, skills by name or { name, path }, stored when they name something", () => {
  assert.deepEqual(normalizeBotPatch({ disabledTools: [" bash ", "bash", "fixture_echo"] }), { disabledTools: ["bash", "fixture_echo"] }, "trimmed and distinct");
  assert.deepEqual(normalizeBotPatch({ disabledTools: [], disabledSkills: [] }), { disabledTools: [], disabledSkills: [] }, "[] turns everything back on");
  assert.deepEqual(normalizeBotPatch({ disabledSkills: ["alpha", { name: "beta", path: "/s/beta/SKILL.md" }] }), { disabledSkills: ["alpha", { name: "beta", path: "/s/beta/SKILL.md" }] });
  assert.deepEqual(normalizeBotInput({ name: "Ada", disabledTools: ["bash"], disabledSkills: [] }), { name: "Ada", disabledTools: ["bash"] }, "a new bot keeps only lists that name something");
  for (const [body, pattern] of [
    [{ disabledTools: "bash" }, /disabledTools must be a list of at most 500 tool names/u],
    [{ disabledTools: [7] }, /disabledTools must name tools: "" is not a tool name/u],
    [{ disabledTools: ["two words"] }, /"two words" is not a tool name/u],
    [{ disabledTools: Array.from({ length: 501 }, (_, index) => `t${index}`) }, /at most 500/u],
    [{ disabledSkills: [{ name: "a" }] }, /a skill's name, or \{ name, path \}/u],
    [{ disabledSkills: [{ name: "a", path: "/p", extra: 1 }] }, /a skill's name, or \{ name, path \}/u],
    [{ disabledSkills: [""] }, /a skill's name, or \{ name, path \}/u],
  ] as const) assert.throws(() => normalizeBotPatch(body), (error: unknown) => error instanceof BotInputError && pattern.test(error.message), JSON.stringify(body).slice(0, 80));
  const stored = parseBotRecord({ ...bot("b1", "ada"), disabledTools: ["bash", "bash", "two words", 3], disabledSkills: [{ name: "beta", path: "/s/beta/SKILL.md" }, { name: "x" }, { name: "beta", path: "/s/beta/SKILL.md" }] });
  assert.deepEqual([stored?.disabledTools, stored?.disabledSkills], [["bash"], [{ name: "beta", path: "/s/beta/SKILL.md" }]], "what validates, once");
  const plain = parseBotRecord({ ...bot("b2", "bob"), disabledTools: [], disabledSkills: "nope" });
  assert.equal(plain && ("disabledTools" in plain || "disabledSkills" in plain), false, "nothing off: no lists");
});

test("the registry skips and keeps invalid records, refuses broken or newer files and writes atomically owner-only", async (t) => {
  const file = await tempFile(t);
  const reported: number[] = [];
  const registry = new BotRegistry(file, (count) => reported.push(count));
  assert.deepEqual(await registry.list(), [], "a missing file is an empty registry");

  const garbage = { id: "zzz", note: "hand edit" };
  await writeFile(file, JSON.stringify({ version: 1, bots: [bot("a", "ada"), garbage, bot("b", "ada"), bot("c", "cy", { sessionId: "session-a" }), bot("d", "dee")] }));
  assert.deepEqual((await registry.list()).map((each) => each.id), ["a", "d"], "duplicates of a handle or chat lose to the first");
  assert.deepEqual(reported, [3]);
  await registry.list();
  assert.deepEqual(reported, [3], "a lasting problem is reported once");
  assert.deepEqual(registry.cached.map((each) => each.id), ["a", "d"]);

  await registry.update((bots) => ({ bots: bots.filter((each) => each.id !== "d"), result: undefined }));
  const written = JSON.parse(await readFile(file, "utf8")) as { version: number; bots: unknown[] };
  assert.equal(written.version, 1);
  assert.deepEqual(written.bots, [bot("a", "ada"), garbage, bot("b", "ada"), bot("c", "cy", { sessionId: "session-a" })], "invalid records survive a write untouched");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(file, ".."))).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");

  await writeFile(file, "{ not json");
  await assert.rejects(registry.list(), (error: unknown) => error instanceof BotStoreError && /not valid JSON/u.test(error.message));
  await assert.rejects(registry.update((bots) => ({ bots, result: undefined })), BotStoreError);
  assert.equal(await readFile(file, "utf8"), "{ not json", "a broken file is never overwritten");
  await writeFile(file, JSON.stringify({ version: 2, bots: [] }));
  await assert.rejects(registry.list(), /newer HUI/u);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
});

test("instructions from before SOUL.md stay in the file through every write until forgotten, one bot at a time", async (t) => {
  const file = await tempFile(t);
  const registry = new BotRegistry(file);
  await writeFile(file, JSON.stringify({ version: 1, bots: [
    { ...bot("a", "ada"), instructions: "You are Ada." }, { ...bot("b", "bob"), instructions: "  " }, bot("c", "cy"),
  ] }));
  assert.deepEqual([...await registry.legacyInstructions()], [["a", "You are Ada."]], "blank instructions are none");
  assert.equal((await registry.list())[0]!.id, "a");
  assert.equal("instructions" in (await registry.list())[0]!, false, "the record itself carries none");
  // Another bot's edit, before the migration: the field survives.
  await registry.update((bots) => ({ bots: bots.map((each) => each.id === "c" ? { ...each, title: "Edited" } : each), result: undefined }));
  const stored = () => readFile(file, "utf8").then((text) => (JSON.parse(text) as { bots: Array<Record<string, unknown>> }).bots);
  assert.equal((await stored())[0]!["instructions"], "You are Ada.");
  assert.equal((await stored())[2]!["title"], "Edited");
  await registry.forgetInstructions("a");
  assert.equal("instructions" in (await stored())[0]!, false, "dropped once SOUL.md has them");
  assert.deepEqual([...await registry.legacyInstructions()], []);
  await registry.forgetInstructions("a");
  assert.equal((await stored()).length, 3, "forgetting again changes nothing");
  // A deleted bot's legacy field goes with it.
  await writeFile(file, JSON.stringify({ version: 1, bots: [{ ...bot("a", "ada"), instructions: "You are Ada." }] }));
  await registry.update(() => ({ bots: [], result: undefined }));
  assert.deepEqual(await stored(), []);
});

test("registry updates are serialized: concurrent writers never lose each other's bots", async (t) => {
  const file = await tempFile(t);
  const registry = new BotRegistry(file);
  await Promise.all(["a", "b", "c", "d", "e"].map((id) => registry.update((bots) => ({ bots: [...bots, bot(id, `h-${id}`)], result: id }))));
  assert.deepEqual((await registry.list()).map((each) => each.id).toSorted(), ["a", "b", "c", "d", "e"]);
  await assert.rejects(registry.update(() => { throw new BotConflictError("refused"); }), BotConflictError);
  assert.equal((await registry.update((bots) => ({ bots, result: bots.length }))), 5, "a refused mutation leaves the queue working");
});

test("bots resolve by id, handle in any case with or without @, then an exact name; a shared name must be disambiguated", () => {
  const bots = [bot("id-1", "ada", { name: "Ada" }), bot("id-2", "bob", { name: "Twin" }), bot("id-3", "cy", { name: "Twin" })];
  assert.equal(findBot(bots, "id-2").handle, "bob");
  assert.equal(findBot(bots, "@ADA").id, "id-1");
  assert.equal(findBot(bots, "Ada").id, "id-1");
  assert.throws(() => findBot(bots, "Twin"), (error: unknown) => error instanceof BotConflictError && /2 bots are named Twin/u.test(error.message));
  assert.throws(() => findBot(bots, "nobody"), BotNotFoundError);
});

test("previews are one line of at most 200 characters", () => {
  assert.equal(previewLine("  hello\n\n  world\t! "), "hello world !");
  const long = previewLine("word ".repeat(100));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith("…"));
});

test("a bot's voice is its language and its call voice: nothing else, cleared key by key", () => {
  assert.deepEqual(normalizeBotInput({ name: "Ada", voice: { language: "es", live: "sol" } }).voice, { language: "es", live: "sol" });
  assert.equal(normalizeBotInput({ name: "Ada", voice: { language: "", live: "" } }).voice, undefined, "a new bot has nothing to clear");
  for (const [voice, message] of [
    ["loud", /^Voice must be an object with language and\/or live\.$/u],
    [{ volume: 3 }, /^Unknown voice field: volume\.$/u],
    // VoiceStudio's voice profile and speed went with it.
    [{ profile: "vp-aria" }, /^Unknown voice field: profile\.$/u],
    [{ speed: 1.25, language: "es" }, /^Unknown voice field: speed\.$/u],
  ] as const) {
    assert.throws(() => normalizeBotInput({ name: "Ada", voice }), (error: unknown) => error instanceof BotInputError && message.test(error.message), JSON.stringify(voice));
    assert.throws(() => normalizeBotPatch({ voice }), (error: unknown) => error instanceof BotInputError && message.test(error.message), JSON.stringify(voice));
  }
  assert.deepEqual(normalizeBotPatch({ voice: null }), { voice: null });
  assert.equal(patchedVoice({ language: "es", live: "sol" }, null), undefined, "voice: null clears both");
  assert.equal(parseBotRecord({ ...bot("a", "ada"), voice: "x" })?.voice, undefined);
});

test("a bot's language is one of Whisper's codes, cleared back to Auto with \"\"", () => {
  assert.deepEqual(normalizeBotInput({ name: "Ada", voice: { language: " ES " } }).voice, { language: "es" });
  for (const language of ["haw", "yue", "jw", "en", "zh"]) assert.deepEqual(normalizeBotInput({ name: "Ada", voice: { language } }).voice, { language }, language);
  assert.equal(normalizeBotInput({ name: "Ada", voice: { language: "" } }).voice, undefined, "a new bot has no language to clear");
  for (const language of ["spanish", "es-ES", "jv", "xx", "auto", 7, null, "zz"]) {
    assert.throws(() => normalizeBotInput({ name: "Ada", voice: { language } }), (error: unknown) => error instanceof BotInputError
      && error.message === "Voice language must be one of Whisper's language codes, such as en, es, fr, de or ja, or \"\" for Auto.", String(language));
    assert.throws(() => normalizeBotPatch({ voice: { language } }), BotInputError, String(language));
  }
  assert.throws(() => normalizeBotPatch({ voice: { dialect: "es" } }), /Unknown voice field: dialect/u);
  assert.deepEqual(normalizeBotPatch({ voice: { language: "" } }), { voice: { language: "" } });
  assert.deepEqual(normalizeBotPatch({ voice: { language: "DE" } }), { voice: { language: "de" } });
  const current = { language: "es" as const, live: "vale" as const };
  assert.deepEqual(patchedVoice(current, { language: "haw" }), { language: "haw", live: "vale" });
  assert.deepEqual(patchedVoice(current, { language: "" }), { live: "vale" }, "back to Auto, the call voice stays");
  assert.deepEqual(patchedVoice(undefined, { language: "yue" }), { language: "yue" });
  assert.equal(patchedVoice({ language: "es" }, { language: "" }), undefined);
  // bots.json keeps a valid code and drops anything else, without losing the call voice.
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), voice: { language: "yue" } })?.voice, { language: "yue" });
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), voice: { live: "sol", language: "klingon" } })?.voice, { live: "sol" });
  assert.equal(parseBotRecord({ ...bot("a", "ada"), voice: { language: "jv" } })?.voice, undefined, "Javanese is stored as Whisper's jw");
});

test("a bot's call voice is one of GPT-Live's voices, cleared back to the default with \"\"", () => {
  assert.deepEqual(normalizeBotInput({ name: "Ada", voice: { live: " Ember " } }).voice, { live: "ember" });
  assert.equal(normalizeBotInput({ name: "Ada", voice: { live: "" } }).voice, undefined, "a new bot has no call voice to clear");
  for (const live of ["marin", "alloy", "Cove!", 3, null]) {
    assert.throws(() => normalizeBotPatch({ voice: { live } }), (error: unknown) => error instanceof BotInputError && /Call voice must be one of GPT-Live's voices: cove, arbor/u.test(error.message), String(live));
  }
  assert.deepEqual(normalizeBotPatch({ voice: { live: "" } }), { voice: { live: "" } });
  assert.deepEqual(patchedVoice({ language: "es", live: "vale" }, { live: "" }), { language: "es" }, "the language outlives the call voice");
  assert.deepEqual(patchedVoice({ language: "es" }, { live: "maple" }), { language: "es", live: "maple" });
  assert.deepEqual(parseBotRecord({ ...bot("a", "ada"), voice: { live: "nova", language: "es" } })?.voice, { language: "es" }, "bots.json drops an unknown call voice and keeps the rest");
});

test("bots.json written while HUI had VoiceStudio loads, and the next write leaves out the VoiceStudio voice", async (t) => {
  const file = await tempFile(t);
  const older = (id: string, handle: string, voice: unknown) => ({ ...bot(id, handle), voice });
  await writeFile(file, JSON.stringify({ version: 1, bots: [
    older("a", "ada", { profile: "vp-aria", speed: 1.25, language: "es", live: "sol" }),
    older("b", "bob", { profile: "vp-dani", speed: 0.8 }),
  ] }));
  const registry = new BotRegistry(file);
  const [ada, bob] = await registry.list();
  assert.deepEqual(ada?.voice, { language: "es", live: "sol" }, "the language and call voice stay");
  assert.equal(bob?.voice, undefined, "a VoiceStudio voice alone is no voice");
  assert.ok((await readFile(file, "utf8")).includes("vp-aria"), "reading rewrites nothing");
  await registry.update((bots) => ({ bots: bots.map((entry) => entry.id === "b" ? { ...entry, title: "Builder" } : entry), result: undefined }));
  const written = JSON.parse(await readFile(file, "utf8")) as { bots: { id: string; voice?: unknown; title?: string }[] };
  assert.deepEqual(written.bots.map(({ id, voice, title }) => [id, voice, title]), [["a", { language: "es", live: "sol" }, undefined], ["b", undefined, "Builder"]]);
  assert.doesNotMatch(JSON.stringify(written), /profile|speed|vp-aria|vp-dani/u);
});
