import assert from "node:assert/strict";
import { test, type TestContext } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskSuggestionInputError, TaskSuggestionNotFoundError, TaskSuggestionStore, taskSuggestionPrompt, taskSuggestionJiraDescription } from "./task-suggestions.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "hui-suggestions-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const changes: string[] = [];
  let next = 0;
  const store = new TaskSuggestionStore({
    onChange: (id) => changes.push(id),
    uuid: () => `s-${++next}`,
    now: () => new Date("2026-09-25T10:00:00.000Z"),
  });
  return { dir, store, changes };
}

const valid = { title: "Replace native select", problem: "The switcher in src/x.ts is a native select.", fix: "Use the shared picker." };

test("suggest_task records newest first, defaults cwd and notifies", async (t) => {
  const { dir, store, changes } = await fixture(t);
  const first = await store.tool("alpha", "suggest_task", valid, dir);
  assert.deepEqual(first, { taskId: "s-1", title: valid.title, cwd: dir, status: "pending" });
  await store.suggest("alpha", { ...valid, title: "Second", cwd: dir }, "/does/not/matter");
  assert.deepEqual(store.list("alpha").map(({ id }) => id), ["s-2", "s-1"]);
  assert.equal(store.list("alpha")[1]?.createdAt, "2026-09-25T10:00:00.000Z");
  assert.deepEqual(store.list("beta"), []);
  assert.deepEqual(changes, ["alpha", "alpha"]);
  const unknown = await store.suggest("alpha", { title: "Unknown", problem: "Only the symptom." }, dir);
  assert.equal(unknown.fix, "");
});

test("suggest_task rejects malformed input without recording anything", async (t) => {
  const { dir, store, changes } = await fixture(t);
  await assert.rejects(store.suggest("alpha", { ...valid, title: "  " }, dir), TaskSuggestionInputError);
  await assert.rejects(store.suggest("alpha", { ...valid, problem: 42 }, dir), /problem must be text/);
  await assert.rejects(store.suggest("alpha", { ...valid, title: "x".repeat(121) }, dir), /at most 120/);
  await assert.rejects(store.suggest("alpha", { ...valid, cwd: "relative/path" }, dir), /absolute/);
  await assert.rejects(store.suggest("alpha", { ...valid, cwd: join(dir, "missing") }, dir), /not a directory/);
  assert.deepEqual(store.list("alpha"), []);
  assert.deepEqual(changes, []);
});

test("a session holds at most twenty pending suggestions", async (t) => {
  const { dir, store } = await fixture(t);
  for (let index = 0; index < 20; index += 1) await store.suggest("alpha", valid, dir);
  await assert.rejects(store.suggest("alpha", valid, dir), /already has 20 pending/);
});

test("dismiss_task removes only pending cards and is refused while starting", async (t) => {
  const { dir, store } = await fixture(t);
  await store.suggest("alpha", valid, dir);
  await store.suggest("alpha", valid, dir);
  store.claim("alpha", "s-2");
  assert.throws(() => store.claim("alpha", "s-2"), /already starting/);
  await assert.rejects(store.tool("alpha", "dismiss_task", { task_id: "s-2" }, dir), /already starting/);
  assert.deepEqual(await store.tool("alpha", "dismiss_task", { task_id: "s-1" }, dir), { taskId: "s-1", status: "dismissed" });
  await assert.rejects(store.tool("alpha", "dismiss_task", { task_id: "s-1" }, dir), TaskSuggestionNotFoundError);
  await assert.rejects(store.tool("beta", "dismiss_task", { task_id: "s-2" }, dir), TaskSuggestionNotFoundError);
  store.release("s-2");
  store.remove("alpha", "s-2");
  assert.deepEqual(store.list("alpha"), []);
  await assert.rejects(store.tool("alpha", "unknown", {}, dir), /Unknown task suggestion action/);
});

test("forgetting deleted sessions drops their cards", async (t) => {
  const { dir, store } = await fixture(t);
  await store.suggest("alpha", valid, dir);
  await store.suggest("beta", valid, dir);
  store.forget(["alpha"]);
  assert.deepEqual(store.list("alpha"), []);
  assert.equal(store.list("beta").length, 1);
});

test("suggest_task guidance covers operator-requested follow-ups", async () => {
  const { huiToolDefinitions } = await import("../runtimes/hui-tools.ts");
  const tool = huiToolDefinitions().find(({ name }) => name === "suggest_task");
  const guidance = (tool?.promptGuidelines ?? []).join("\n");
  assert.match(guidance, /asks for a follow-up/);
  assert.match(guidance, /let's add a follow-up for this/);
  assert.match(guidance, /omit it rather than guessing/);
});

const portableFixture: { input: { title: string; problem: string; fix: string }; prompt: string; jira: string }[] = JSON.parse(readFileSync(new URL("./task-suggestions.fixture.json", import.meta.url), "utf8"));

test("task-suggestions preserves the shared runtime fixtures", () => {
  for (const { input, prompt, jira } of portableFixture) {
    assert.equal(taskSuggestionPrompt(input), prompt);
    assert.equal(taskSuggestionJiraDescription(input), jira);
  }
});
