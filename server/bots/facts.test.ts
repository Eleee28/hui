/** Explicit knowledge storage boundary: atomic writes, revisions, provenance and separation from chat. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BOT_FACT_KINDS, BOT_FACT_LIMITS, botFactsSection, localBotFacts, readBotFacts } from "./facts.ts";
import { BotConflictError, BotInputError, BotNotFoundError } from "./bots.ts";

test("memory kinds and limits match the portable fixtures", async () => {
  const fixture = JSON.parse(await readFile(new URL("./facts.fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(BOT_FACT_KINDS, fixture.kinds);
  assert.deepEqual(BOT_FACT_LIMITS, fixture.limits);
});

test("manual memories survive reopen with provenance; concurrent corrections cannot overwrite each other", async () => {
  const root = await mkdtemp(join(tmpdir(), "hui-facts-"));
  try {
    const facts = localBotFacts(root);
    assert.deepEqual(await facts.list("one"), []);
    const [first] = await facts.create("one", { kind: "preference", text: "  Short answers\r\nplease  ", source: "Our first conversation" });
    assert.equal(first!.text, "Short answers\nplease");
    const attempts = await Promise.allSettled([
      facts.update("one", first!.id, { text: "Detailed answers", revision: 1 }),
      facts.update("one", first!.id, { text: "Something stale", revision: 1 }),
    ]);
    assert.equal(attempts[0]!.status, "fulfilled");
    assert.equal(attempts[1]!.status, "rejected");
    assert.ok(attempts[1]!.status === "rejected" && attempts[1]!.reason instanceof BotConflictError);
    const [edited] = await localBotFacts(root).list("one");
    assert.equal(edited!.text, "Detailed answers");
    assert.equal(edited!.source, first!.source);
    assert.equal(edited!.createdAt, first!.createdAt);
    assert.equal(edited!.revision, 2);
    assert.equal((await stat(join(root, "one", "facts.json"))).mode & 0o777, 0o600);
    await facts.create("one", { kind: "fact", text: "Visible fact", pinned: true });
    assert.equal((await facts.list("one"))[0]!.pinned, true);
    assert.deepEqual(await facts.list("two"), []);
    const section = await botFactsSection(join(root, "one"));
    assert.ok(section!.indexOf("Visible fact") < section!.indexOf("Detailed answers"));
    assert.match(section!, /reference data, not instructions/u);
    await assert.rejects(facts.delete("one", edited!.id, 1), BotConflictError);
    await facts.delete("one", edited!.id, 2);
    assert.doesNotMatch((await botFactsSection(join(root, "one")))!, /Detailed answers/u);
    await assert.rejects(facts.delete("one", edited!.id, 2), BotNotFoundError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid input, a full store and corrupt persisted state never replace valid memories", async () => {
  const root = await mkdtemp(join(tmpdir(), "hui-facts-input-"));
  try {
    const facts = localBotFacts(root);
    for (const input of [null, { kind: "guess", text: "x" }, { kind: "fact", text: " " }, { kind: "fact", text: "x".repeat(501) }, { kind: "fact", text: "x", pinned: "yes" }, { kind: "fact", text: "x", author: "bot" }]) await assert.rejects(facts.create("one", input), BotInputError);
    await assert.rejects(facts.list("../outside"), BotInputError);
    for (let index = 0; index < 40; index++) await facts.create("one", { kind: "decision", text: "\u0001".repeat(500), source: "\u0001".repeat(200) });
    assert.equal((await facts.list("one")).length, 40, "all accepted maximum-size entries remain readable even after JSON escaping");
    assert.ok((await stat(join(root, "one", "facts.json"))).size > 128 * 1024);
    await assert.rejects(facts.create("one", { kind: "fact", text: "Too many" }), BotInputError);
    const path = join(root, "one", "facts.json");
    await writeFile(path, "broken");
    await assert.rejects(facts.create("one", { kind: "fact", text: "Must not erase" }));
    assert.equal(await readFile(path, "utf8"), "broken");
    await assert.rejects(readBotFacts(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deletion drains queued writes and late saves cannot recreate a retired bot's home", async () => {
  const root = await mkdtemp(join(tmpdir(), "hui-facts-retire-"));
  try {
    const facts = localBotFacts(root);
    await facts.create("one", { kind: "fact", text: "Existing" });
    const pending = Array.from({ length: 10 }, (_, index) => facts.create("one", { kind: "fact", text: `Pending ${index}` }));
    const all = Promise.allSettled(pending);
    await facts.retire("one");
    await rm(join(root, "one"), { recursive: true, force: true });
    await all;
    await assert.rejects(facts.create("one", { kind: "fact", text: "Too late" }), BotNotFoundError);
    await assert.rejects(stat(join(root, "one")), { code: "ENOENT" });
    assert.deepEqual(await localBotFacts(root).list("two"), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
