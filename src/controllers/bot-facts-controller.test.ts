/** The memory page follows confirmed saves and keeps pending or failed work from another bot out of view. */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { BotFact } from "../api/schema/bots.ts";
import { BotFactsController } from "./bot-facts-controller.ts";
const fact: BotFact = { id: "f-1", kind: "fact", text: "Useful fact", source: "Saved by you", pinned: false, revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
test("a failed save preserves editing state and never presents the change as saved", async () => {
  const controller = new BotFactsController({ requestUpdate() {} }, async (_bot, method) => {
    if (method === "GET") return [fact];
    throw new Error("Changed elsewhere. Refresh.");
  });
  await controller.load("one");
  controller.edit(fact);
  assert.equal(await controller.save({ kind: "fact", text: "Correction" }), false);
  assert.equal(controller.state.facts[0]!.text, "Useful fact");
  assert.equal(controller.state.editing, fact);
  assert.match(controller.state.error, /Changed elsewhere/u);
  assert.equal(controller.state.pending, false);
});
test("an in-flight read or write cannot put one bot's memories in another bot's panel", async () => {
  let finish: (facts: BotFact[]) => void = () => {};
  const controller = new BotFactsController({ requestUpdate() {} }, async () => new Promise((resolve) => { finish = resolve; }));
  const read = controller.load("one");
  controller.reset("two"); finish([fact]); await read;
  assert.equal(controller.state.botId, "two"); assert.deepEqual(controller.state.facts, []);
  controller.state.loaded = true;
  const save = controller.save({ kind: "fact", text: "x" });
  controller.reset("three"); finish([fact]); assert.equal(await save, false);
  assert.equal(controller.state.botId, "three"); assert.deepEqual(controller.state.facts, []);
});

test("pinning or deleting another memory preserves the current editor and its unsaved draft identity", async () => {
  const other = { ...fact, id: "f-2", text: "Another memory" };
  const controller = new BotFactsController({ requestUpdate() {} }, async (_bot, method) => {
    if (method === "DELETE") return [fact];
    if (method === "PATCH") return [fact, { ...other, pinned: true, revision: 2 }];
    return [fact, other];
  });
  await controller.load("one"); controller.edit(fact);
  await controller.pin(other);
  assert.equal(controller.state.editing, fact, "same keyed form and original property values keep its DOM draft");
  controller.remove(other); await controller.confirmDelete();
  assert.equal(controller.state.editing, fact);
  assert.equal(controller.state.removing, undefined);
});
