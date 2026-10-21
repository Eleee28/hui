import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { BacklogItem } from "./api/backlog.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";

import {
  ASSIGNED_TODO_JQL,
  BacklogInputError,
  BacklogJiraFeed,
  BacklogNotFoundError,
  BacklogStore,
  BacklogStoreError,
  fetchAssignedTodo,
  mergeBacklog,
  splitItemId,
} from "./backlog.ts";
import { JiraClient, type JiraFetch } from "./integrations/jira.ts";
import { backlogItemPrompt } from "./backlog.ts";

async function tempStore(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "hui-backlog-"));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  let n = 0;
  await mkdir(join(dir, "hui"));
  const path = join(dir, "hui", "backlog.json");
  return { dir, path, store: new BacklogStore(path, { uuid: () => `id-${++n}`, now: () => new Date("2026-09-26T10:00:00.000Z") }) };
}

test("a missing file is an empty backlog and writes are versioned", async (t) => {
  const { path, store } = await tempStore(t);
  assert.deepEqual(await store.read(), { version: 1, tasks: [], jira: {} });
  const task = await store.addTask({ title: " Fix picker ", problem: "It differs.", fix: "", cwd: "/repo/web" });
  assert.deepEqual(task, { id: "id-1", title: "Fix picker", problem: "It differs.", fix: "", cwd: "/repo/web", group: "", createdAt: "2026-09-26T10:00:00.000Z" });
  const file = JSON.parse(await readFile(path, "utf8")) as { version: number; tasks: unknown[] };
  assert.equal(file.version, 1);
  assert.equal(file.tasks.length, 1);
  await assert.rejects(() => store.addTask({ title: "x", problem: "", cwd: "relative" }), BacklogInputError);
  await assert.rejects(() => store.addTask({ title: "  ", problem: "" }), BacklogInputError);
});

test("concurrent mutations are serialized and none is lost", async (t) => {
  const { store } = await tempStore(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.addTask({ title: `task ${i}`, problem: "p" })));
  assert.equal((await store.read()).tasks.length, 12);
});

test("groups, Jira metadata, attachment and removal", async (t) => {
  const { store } = await tempStore(t);
  const task = await store.addTask({ title: "Local", problem: "p" });
  assert.equal(await store.setGroup(`local:${task.id}`, "Frontend"), "Frontend");
  assert.equal(await store.setGroup(`local:${task.id}`, "ungrouped"), "");
  await store.setGroup("jira:CI-7", "Backend");
  assert.deepEqual((await store.read()).jira, { "CI-7": { group: "Backend" } });
  // Only non-default metadata is kept.
  await store.setGroup("jira:CI-7", "");
  assert.deepEqual((await store.read()).jira, {});
  await assert.rejects(() => store.setGroup("jira:not-a-key", "x"), BacklogNotFoundError);
  await assert.rejects(() => store.setGroup("local:missing", "x"), BacklogNotFoundError);
  await assert.rejects(() => store.setGroup(`local:${task.id}`, 3), BacklogInputError);
  const attached = await store.attachJira(task.id, { key: "CI-8", url: "https://acme.atlassian.net/browse/CI-8" });
  assert.equal(attached.jira?.key, "CI-8");
  await store.removeTask(task.id);
  await assert.rejects(() => store.removeTask(task.id), BacklogNotFoundError);
});

test("an unreadable or newer file is refused and never overwritten", async (t) => {
  const { path, store } = await tempStore(t);
  await store.addTask({ title: "keep", problem: "" });
  await writeFile(path, JSON.stringify({ version: 99, tasks: [] }));
  await assert.rejects(() => store.read(), BacklogStoreError);
  await assert.rejects(() => store.addTask({ title: "new", problem: "" }), BacklogStoreError);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 99);
  await writeFile(path, "{ broken");
  await assert.rejects(() => store.setGroup("jira:CI-1", "x"), BacklogStoreError);
  assert.equal(await readFile(path, "utf8"), "{ broken");
});

test("malformed rows are dropped on read", async (t) => {
  const { path, store } = await tempStore(t);
  await writeFile(path, JSON.stringify({ version: 1, tasks: [{ id: "a", title: "ok", problem: "p", cwd: "relative", jira: { key: "bad", url: "x" } }, { id: "", title: "no id" }, "junk"], jira: { "CI-1": { group: "G" }, nope: { group: "G" }, "CI-2": { group: "" } } }));
  const state = await store.read();
  assert.deepEqual(state.tasks, [{ id: "a", title: "ok", problem: "p", fix: "", group: "", createdAt: "" }]);
  assert.deepEqual(state.jira, { "CI-1": { group: "G" } });
});

function fakeSearch(issues: unknown[], seen: { body?: unknown }[] = []): JiraFetch {
  return async (url, init) => {
    assert.equal(new URL(url).pathname, "/rest/api/3/search/jql");
    seen.push({ body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ issues }), { status: 200 });
  };
}

test("the feed asks Jira for assigned To Do items and keeps only the new category", async () => {
  const seen: { body?: unknown }[] = [];
  const issue = (key: string, category: string, summary = key) => ({ key, fields: { summary, status: { name: category === "new" ? "To Do" : "Doing", statusCategory: { key: category } }, issuetype: { name: "Task" } } });
  const client = new JiraClient({ site: "https://acme.atlassian.net", email: "a@b.c", token: "t" }, fakeSearch([
    issue("CI-1", "new", "First"), issue("CI-2", "indeterminate"), { key: "bogus" }, issue("CI-3", "new"),
  ], seen));
  const issues = await fetchAssignedTodo(client, "https://acme.atlassian.net");
  assert.deepEqual(issues.map((found) => found.key), ["CI-1", "CI-3"]);
  assert.equal(issues[0]!.summary, "First");
  assert.equal(issues[0]!.url, "https://acme.atlassian.net/browse/CI-1");
  const body = seen[0]!.body as { jql: string; fields: string[] };
  assert.equal(body.jql, ASSIGNED_TODO_JQL);
  assert.match(body.jql, /assignee = currentUser\(\)/);
  assert.ok(body.fields.includes("description"));
});

test("the feed caches answers, shares in-flight loads and reports failures without data", async () => {
  let now = 0;
  let calls = 0;
  const feed = new BacklogJiraFeed({ ttlMs: 100, failureTtlMs: 10, now: () => now });
  const load = async () => { calls++; return [{ key: "CI-1", url: "u" }]; };
  const [a, b] = await Promise.all([feed.get("site", load), feed.get("site", load)]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  await feed.get("site", load);
  assert.equal(calls, 1);
  await feed.get("site", load, true);
  assert.equal(calls, 2);
  now = 200;
  const failed = await feed.get("site", async () => { throw new Error("Jira could not be reached."); });
  assert.deepEqual(failed, { error: "Jira could not be reached." });
  assert.equal(feed.cached("CI-1"), undefined);
  // Another connection never sees the previous account's items.
  now = 300;
  assert.deepEqual(await feed.get("other", async () => []), { issues: [] });
});

test("the merged view lists local tasks first and skips linked or attached Jira keys", () => {
  const url = (key: string) => `https://acme.atlassian.net/browse/${key}`;
  const items = mergeBacklog({
    state: {
      version: 1,
      tasks: [{ id: "t1", title: "Local", problem: "p", fix: "f", cwd: "/repo", group: "G", createdAt: "c", jira: { key: "CI-3", url: url("CI-3") } }],
      jira: { "CI-4": { group: "Backend" } },
    },
    issues: [
      { key: "CI-1", url: url("CI-1"), summary: "Linked to a session" },
      { key: "CI-3", url: url("CI-3"), summary: "Attached to the local task" },
      { key: "CI-4", url: url("CI-4"), summary: "Fresh", status: "To Do", statusCategory: "new" },
      { key: "CI-4", url: url("CI-4"), summary: "Duplicate" },
    ],
    linkedKeys: new Set(["CI-1"]),
  });
  assert.deepEqual(items.map((found) => found.id), ["local:t1", "jira:CI-4"]);
  assert.equal(items[0]!.jira?.key, "CI-3");
  assert.deepEqual(items[1], { id: "jira:CI-4", kind: "jira", title: "Fresh", group: "Backend", jira: { key: "CI-4", url: url("CI-4"), summary: "Fresh", status: "To Do", statusCategory: "new" } });
});

test("item ids split into kind and key; prompts carry Jira or problem/fix text", () => {
  assert.deepEqual(splitItemId("jira:CI-1"), ["jira", "CI-1"]);
  assert.deepEqual(splitItemId("local:abc"), ["local", "abc"]);
  assert.deepEqual(splitItemId("session:x"), ["", ""]);
  const jira = backlogItemPrompt({ kind: "jira", title: "Fix", jira: { key: "CI-1", url: "https://acme.atlassian.net/browse/CI-1", summary: "Fix login", description: "Steps…" } });
  assert.match(jira, /^# CI-1: Fix login/);
  assert.match(jira, /## Description\n\nSteps…/);
  const local = backlogItemPrompt({ kind: "local", title: "Picker", problem: "It differs.", fix: "" });
  assert.match(local, /## Problem\n\nIt differs\./);
  assert.match(local, /Investigate and confirm the root cause/);
});

const fixture: { input: Pick<BacklogItem, "kind" | "title" | "problem" | "fix" | "jira">; expected: string }[] = JSON.parse(readFileSync(new URL("./backlog.fixture.json", import.meta.url), "utf8"));

test("backlog preserves the shared runtime fixtures", () => {
  for (const { input, expected } of fixture) assert.equal(backlogItemPrompt(input), expected);
});
