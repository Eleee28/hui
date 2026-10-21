import assert from "node:assert/strict";
import { test } from "vitest";
import { huiDurableTools } from "./durable-tools.ts";

test("only HUI tools that just read rerun after a crash; every other one is reported as interrupted", () => {
  const tools = huiDurableTools({ invoke: async () => ({}) }).tools ?? [];
  const safe = tools.filter((tool) => tool.replay === "safe").map((tool) => tool.name).sort();
  assert.deepEqual(safe, ["agents_wait", "sessions_history", "sessions_list"]);
  for (const name of ["sessions_spawn", "sessions_send", "terminal", "browser", "secret_request", "present_media"]) {
    const tool = tools.find((each) => each.name === name);
    assert.ok(tool, name);
    assert.equal(tool.replay, "unsafe", name);
  }
});
