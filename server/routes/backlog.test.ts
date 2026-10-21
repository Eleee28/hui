/** Backlog HTTP dispatch, local/Jira merging and suggestion-to-backlog integration. */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BacklogError, BacklogJiraResponse, BacklogStartResponse, BacklogView, SuggestedBranchName } from "../api/backlog.ts";
import { JiraDraftResponse } from "../api/jira.ts";
import { TaskSuggestionBacklogResponse, TaskSuggestionError } from "../api/task-suggestions.ts";
import { expectSchema } from "../test-support/api-schema.ts";

async function body(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

test("backlog routes merge Jira and local items, regroup, link and save suggestions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hui-backlog-routes-"));
  // A local stand-in for Jira Cloud: assigned To Do search and single items.
  const searches: string[] = [];
  const issue = (key: string, summary: string) => ({ key, fields: { summary, status: { name: "To Do", statusCategory: { key: "new" } }, issuetype: { name: "Task" } } });
  const jira = createServer((request, response) => {
    void body(request).then((text) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      if (request.method === "POST" && path === "/rest/api/3/search/jql") {
        searches.push((JSON.parse(text) as { jql: string }).jql);
        response.end(JSON.stringify({ issues: [issue("CI-1", "Linked already"), issue("CI-2", "Assigned work"), issue("CI-5", "Will be linked")] }));
        return;
      }
      const one = path.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/);
      if (request.method === "GET" && one) {
        response.end(JSON.stringify(issue(one[1]!, `Summary of ${one[1]}`)));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ errorMessages: ["nope"] }));
    });
  });
  jira.listen(0, "127.0.0.1");
  await once(jira, "listening");
  const jiraAddress = jira.address();
  assert.ok(jiraAddress && typeof jiraAddress !== "string");
  const jiraOrigin = `http://127.0.0.1:${jiraAddress.port}`;

  process.env["XDG_CONFIG_HOME"] = dir;
  process.env["HUI_JIRA_TEST_ORIGIN"] = jiraOrigin;
  await mkdir(join(dir, "hui"));
  const now = new Date().toISOString();
  await writeFile(join(dir, "hui", "sessions.json"), JSON.stringify({ version: 2, sessions: [
    { id: "alpha", title: "Alpha", tool: "pi", cwd: dir, createdAt: now, updatedAt: now, jiraIssues: [{ key: "CI-1", url: `${jiraOrigin}/browse/CI-1` }] },
  ], groups: [] }));
  await writeFile(join(dir, "hui", "jira.json"), JSON.stringify({ site: jiraOrigin, email: "dev@acme.test", token: "tok", defaultProject: "CI", accountId: "acc-1" }));

  const { middleware } = await import("../hui.ts");
  const { stopBackend } = await import("../backend.ts");
  const { agentToolEnvironment } = await import("../agent-tools/bridge.ts");
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.onTestFinished(async () => {
    await stopBackend();
    server.closeAllConnections();
    jira.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => jira.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  type View = { items: { id: string; kind: string; title: string; group: string; cwd?: string; jira?: { key: string } }[]; jira: { status: string } };
  const route = async (path: string, method = "GET", payload?: unknown, guard = true) => {
    const response = await fetch(origin + path, {
      method,
      headers: { ...(guard ? { "x-hui": "1" } : {}), "content-type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const result: unknown = await response.json();
    if (path.startsWith("/__hui/backlog")) {
      if (response.status >= 400) expectSchema(BacklogError, result);
      else if (path.endsWith("/jira/draft")) expectSchema(JiraDraftResponse, result);
      else if (/\/jira(?:\/link)?$/u.test(path)) expectSchema(BacklogJiraResponse, result);
      else if (path.endsWith("/start")) expectSchema(BacklogStartResponse, result);
      else expectSchema(BacklogView, result);
    }
    if (/\/suggestions\//u.test(path)) expectSchema(response.status >= 400 ? TaskSuggestionError : TaskSuggestionBacklogResponse, result);
    return { status: response.status, body: result as View & { error?: string; suggestions?: unknown[]; taskId?: string; backlog?: View; issue?: { key: string } } };
  };

  assert.equal((await route("/__hui/backlog", "GET", undefined, false)).status, 403);
  assert.equal((await route("/__hui/backlog", "POST", {})).status, 405);
  const first = await route("/__hui/backlog");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.jira, { status: "ok" });
  // CI-1 is already linked to a session, so it is not a backlog item.
  assert.deepEqual(first.body.items.map((item) => item.id), ["jira:CI-2", "jira:CI-5"]);
  assert.match(searches[0] ?? "", /assignee = currentUser\(\) AND statusCategory = "To Do"/);

  // suggest_task → Add to backlog.
  const env = await agentToolEnvironment("alpha");
  const suggested = await fetch(`${env["HUI_AGENT_BRIDGE_URL"]}/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${env["HUI_AGENT_BRIDGE_TOKEN"]}`, "content-type": "application/json" },
    body: JSON.stringify({ callerSessionId: "alpha", action: "suggest_task", params: { title: "Fix the picker", problem: "It differs.", fix: "Use the picker." } }),
  });
  const taskId = ((await suggested.json()) as { result: { taskId: string } }).result.taskId;
  assert.equal((await route(`/__hui/sessions/alpha/suggestions/${taskId}/backlog`, "GET")).status, 405);
  assert.equal((await route(`/__hui/sessions/missing/suggestions/${taskId}/backlog`, "POST", {})).status, 404);
  const saved = await route(`/__hui/sessions/alpha/suggestions/${taskId}/backlog`, "POST", {});
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.suggestions, []);
  assert.equal((await route(`/__hui/sessions/alpha/suggestions/${taskId}/backlog`, "POST", {})).status, 404);
  const withLocal = await route("/__hui/backlog");
  const local = withLocal.body.items[0]!;
  assert.equal(local.kind, "local");
  assert.equal(local.title, "Fix the picker");
  assert.equal(local.group, "");
  assert.equal(local.cwd, dir);
  assert.equal(saved.body.taskId, local.id);

  // Regroup: HUI metadata only, persisted in backlog.json.
  const regrouped = await route("/__hui/backlog/items/jira%3ACI-2", "PATCH", { group: "Backend" });
  assert.equal(regrouped.status, 200);
  assert.equal(regrouped.body.items.find((item) => item.id === "jira:CI-2")?.group, "Backend");
  assert.equal((await route(`/__hui/backlog/items/${encodeURIComponent(local.id)}`, "PATCH", { group: "Frontend" })).body.items[0]?.group, "Frontend");
  const file = JSON.parse(await readFile(join(dir, "hui", "backlog.json"), "utf8")) as { version: number; jira: unknown; tasks: { group: string }[] };
  assert.equal(file.version, 1);
  assert.deepEqual(file.jira, { "CI-2": { group: "Backend" } });
  assert.equal(file.tasks[0]?.group, "Frontend");
  assert.equal((await route("/__hui/backlog/items/jira%3ACI-9", "PATCH", { group: "x" })).status, 404);
  assert.equal((await route("/__hui/backlog/items/jira%3ACI-2", "DELETE")).status, 405);
  assert.equal((await route("/__hui/backlog/items/bogus", "PATCH", { group: "x" })).status, 404);

  // Starting validates the target before creating anything.
  const badStage = await route("/__hui/backlog/items/jira%3ACI-2/start", "POST", { cwd: dir, worktree: false, stage: "backlog", group: "" });
  assert.equal(badStage.status, 400);
  assert.equal((await route("/__hui/backlog/items/local%3Amissing/start", "POST", { cwd: dir, worktree: false, stage: "investigation", group: "" })).status, 404);

  // Suggested worktree names: no utility model is configured, so the title's
  // words are the deterministic fallback.
  type Suggestion = { name?: string; source?: string; error?: string };
  const suggest = async (id: string, payload: unknown, method = "POST") => {
    const response = await fetch(`${origin}/__hui/backlog/items/${encodeURIComponent(id)}/branch-name`, {
      method, headers: { "x-hui": "1", "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
    });
    const result: unknown = await response.json();
    expectSchema(response.status >= 400 ? BacklogError : SuggestedBranchName, result);
    return { status: response.status, body: result as Suggestion };
  };
  assert.deepEqual(await suggest("jira:CI-2", { cwd: dir }), { status: 200, body: { name: "assigned-work", source: "fallback" } });
  assert.equal((await suggest("jira:CI-2", undefined, "GET")).status, 405);
  assert.equal((await suggest("jira:CI-9", { cwd: dir })).status, 404);
  assert.equal((await suggest("local:missing", { cwd: dir })).status, 404);
  const missingDir = await suggest("jira:CI-2", { cwd: join(dir, "nope") });
  assert.equal(missingDir.status, 400);
  assert.match(missingDir.body.error ?? "", /No such directory/u);
  assert.equal((await suggest("jira:CI-2", { cwd: 42 })).status, 400);
  assert.equal((await suggest("jira:CI-2", { cwd: join(dir, "hui", "sessions.json") })).status, 400);

  // Linking a local task to an assigned item folds the two into one card.
  assert.equal((await route("/__hui/backlog/items/jira%3ACI-2/jira/link", "POST", { key: "CI-2" })).status, 400);
  const linked = await route(`/__hui/backlog/items/${encodeURIComponent(local.id)}/jira/link`, "POST", { key: "CI-5" });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.issue?.key, "CI-5");
  assert.deepEqual(linked.body.backlog?.items.map((item) => item.id), [local.id, "jira:CI-2"]);
  assert.equal(linked.body.backlog?.items[0]?.jira?.key, "CI-5");
  assert.equal((await route(`/__hui/backlog/items/${encodeURIComponent(local.id)}/jira/link`, "POST", { key: "CI-2" })).status, 400);

  // Remove the local task; Jira items stay.
  assert.deepEqual((await route(`/__hui/backlog/items/${encodeURIComponent(local.id)}`, "DELETE")).body.items.map((item) => item.id), ["jira:CI-2", "jira:CI-5"]);
  assert.equal((await route(`/__hui/backlog/items/${encodeURIComponent(local.id)}`, "DELETE")).status, 404);

  // Without Jira the backlog is local-only with a quiet state, never an error.
  assert.equal((await route("/__hui/jira", "DELETE")).status, 200);
  const unconfigured = await route("/__hui/backlog");
  assert.equal(unconfigured.status, 200);
  assert.deepEqual(unconfigured.body, { items: [], jira: { status: "unconfigured" } });
});
