import assert from "node:assert/strict";
import * as Schema from "../api/jira.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { adfToMarkdown, markdownToAdf } from "./jira-adf.ts";
import {
  DRAFT_ATTEMPT_TIMEOUT_MS,
  draftJiraWorkItem,
  fallbackDraft,
  findJiraIssues,
  JiraClient,
  jiraKeyFromInput,
  jqlString,
  JiraConfigStore,
  jiraConnectionView,
  JiraInputError,
  jiraIssuesFromTranscript,
  JiraIssueStatuses,
  JiraRequestError,
  mergeJiraRefs,
  normalizeDraftAnswer,
  normalizeJiraSite,
  parentCandidates,
  parseJiraIssue,
  validateCreateInput,
  type JiraFetch,
} from "./jira.ts";
import type { TranscriptEntry } from "../runtimes/types.ts";

const tool = (patch: Partial<Extract<TranscriptEntry, { kind: "tool" }>>): TranscriptEntry => ({
  kind: "tool", id: "call", name: "bash", ...patch,
});

test("normalizes Jira Cloud sites and refuses other hosts", () => {
  assert.equal(normalizeJiraSite("acme", ""), "https://acme.atlassian.net");
  assert.equal(normalizeJiraSite("acme.atlassian.net/jira/software", ""), "https://acme.atlassian.net");
  assert.equal(normalizeJiraSite("https://Acme.atlassian.net/", ""), "https://acme.atlassian.net");
  assert.throws(() => normalizeJiraSite("http://acme.atlassian.net", ""), JiraInputError);
  assert.throws(() => normalizeJiraSite("jira.example.com", ""), JiraInputError);
  assert.throws(() => normalizeJiraSite("https://user:pw@acme.atlassian.net", ""), JiraInputError);
  assert.equal(normalizeJiraSite("http://127.0.0.1:4000", "http://127.0.0.1:4000"), "http://127.0.0.1:4000");
});

test("stores the connection privately and never exposes the token in its view", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-jira-"));
  const store = new JiraConfigStore(join(dir, "hui", "jira.json"));
  assert.equal(await store.read(), undefined);
  const config = { site: "https://acme.atlassian.net", email: "dev@acme.test", token: "secret-token", defaultProject: "CI" };
  await store.write(config);
  assert.deepEqual(await store.read(), config);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  const view = jiraConnectionView(config);
  expectSchema(Schema.JiraConnection, view);
  assert.equal(JSON.stringify(view).includes("secret-token"), false);
  assert.deepEqual(view, { configured: true, site: config.site, email: config.email, tokenSet: true, defaultProject: "CI" }, "the account id stays server-side");
  assert.match(await readFile(store.path, "utf8"), /secret-token/u);
  await store.remove();
  assert.equal(await store.read(), undefined);
});

test("detects work items only from creation commands that printed a browse URL", () => {
  const transcript: TranscriptEntry[] = [
    { kind: "message", role: "assistant", text: "Related: https://acme.atlassian.net/browse/CI-1" },
    tool({ id: "a", args: { command: "jira issue view CI-2" }, output: "https://acme.atlassian.net/browse/CI-2" }),
    tool({ id: "b", args: { command: "jira issue create -tTask -s'Fix flake'" }, output: "✓ Issue created\nhttps://acme.atlassian.net/browse/CI-12\n" }),
    tool({ id: "c", name: "create_jira_issue", output: "{\"url\":\"https://acme.atlassian.net/browse/OPS-7\"}" }),
    tool({ id: "d", args: { command: "acli jira workitem create --summary x" }, output: "https://acme.atlassian.net/browse/CI-12" }),
    tool({ id: "e", args: { command: "jira issue create" }, output: "https://acme.atlassian.net/browse/CI-99", failed: true }),
  ];
  assert.deepEqual(jiraIssuesFromTranscript(transcript), [
    { key: "CI-12", url: "https://acme.atlassian.net/browse/CI-12" },
    { key: "OPS-7", url: "https://acme.atlassian.net/browse/OPS-7" },
  ]);
  const pending = tool({ id: "f", args: { command: "jira issue create" } });
  assert.deepEqual(jiraIssuesFromTranscript([pending]), []);
  assert.deepEqual(jiraIssuesFromTranscript([{ ...pending, output: "https://acme.atlassian.net/browse/CI-3" } as TranscriptEntry]).map((ref) => ref.key), ["CI-3"]);
});

test("merges stored and detected references by key, oldest first", () => {
  const ref = (key: string) => ({ key, url: `https://acme.atlassian.net/browse/${key}` });
  assert.deepEqual(mergeJiraRefs([ref("CI-1"), ref("CI-2")], [ref("CI-2"), ref("CI-3")]).map((item) => item.key), ["CI-1", "CI-2", "CI-3"]);
});

test("reads ADF descriptions as Markdown and writes Markdown drafts as ADF", () => {
  const doc = {
    type: "doc", version: 1, content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Context" }] },
      { type: "paragraph", content: [
        { type: "text", text: "Uses " }, { type: "text", text: "gh", marks: [{ type: "code" }] },
        { type: "text", text: " and " }, { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
      ] },
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one", marks: [{ type: "strong" }] }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
      ] },
      { type: "codeBlock", attrs: { language: "sh" }, content: [{ type: "text", text: "npm test" }] },
      { type: "unknownNode", content: [{ type: "text", text: "kept" }] },
    ],
  };
  assert.equal(adfToMarkdown(doc), "## Context\n\nUses `gh` and [docs](https://example.com)\n\n- **one**\n- two\n\n```sh\nnpm test\n```\n\nkept");
  assert.equal(adfToMarkdown("plain"), "plain");
  assert.equal(adfToMarkdown(null), "");

  const adf = markdownToAdf("## Scope\n\nFix **flaky** `retry`.\nSecond line\n\n- [ ] a\n- b\n\n1. first\n\n```ts\nconst x = 1;\n```");
  assert.equal(adf.type, "doc");
  assert.equal(adf.version, 1);
  assert.deepEqual(adf.content?.map((node) => node.type), ["heading", "paragraph", "bulletList", "orderedList", "codeBlock"]);
  assert.deepEqual(adf.content?.[1]?.content?.map((node) => node.marks?.[0]?.type ?? node.type), ["text", "strong", "text", "code", "text", "hardBreak", "text"]);
  assert.equal(adf.content?.[2]?.content?.[0]?.content?.[0]?.content?.[0]?.text, "a");
  // Round trip keeps the meaningful structure.
  assert.equal(adfToMarkdown(adf), "## Scope\n\nFix **flaky** `retry`.\nSecond line\n\n- a\n- b\n\n1. first\n\n```ts\nconst x = 1;\n```");
});

test("parses a Jira issue into bounded preview facts", () => {
  const details = parseJiraIssue({
    key: "CI-12",
    fields: {
      summary: " Fix flake ",
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: "Task" },
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x ".repeat(3_000) }] }] },
    },
  }, "CI-12");
  assert.equal(details.summary, "Fix flake");
  assert.equal(details.status, "In Progress");
  assert.equal(details.statusCategory, "indeterminate");
  assert.equal(details.issueType, "Task");
  assert.ok(details.description!.length <= 4_001 && details.description!.endsWith("…"));
  assert.throws(() => parseJiraIssue({ key: "CI-13", fields: {} }, "CI-12"), JiraRequestError);
});

function fakeJira(routes: Record<string, (init: RequestInit) => { status?: number; body?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: JiraFetch = async (url, init) => {
    calls.push({ url, init });
    const { pathname, search } = new URL(url);
    const handler = routes[`${init.method ?? "GET"} ${pathname}`] ?? routes[`${init.method ?? "GET"} ${pathname}${search}`];
    const result = handler ? handler(init) : { status: 404, body: { errorMessages: ["nope"] } };
    const status = result.status ?? 200;
    // 204/205 responses must not carry a body, not even an empty string.
    return new Response(result.body === undefined || status === 204 ? null : JSON.stringify(result.body), { status });
  };
  return { calls, fetchImpl };
}

test("the client sends Basic credentials only to the site and refuses redirects", async () => {
  const { calls, fetchImpl } = fakeJira({ "GET /rest/api/3/myself": () => ({ body: { displayName: "Alex" } }) });
  const client = new JiraClient({ site: "https://acme.atlassian.net", email: "dev@acme.test", token: "tok" }, fetchImpl);
  assert.deepEqual(await client.myself(), { displayName: "Alex", accountId: "" });
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], `Basic ${Buffer.from("dev@acme.test:tok").toString("base64")}`);
  assert.equal(calls[0]!.init.redirect, "error");
  await assert.rejects(client.request("https://evil.test/steal"), /another origin/u);
});

test("projects load one page and search Jira by key or name", async () => {
  const seen: string[] = [];
  const { fetchImpl } = fakeJira({
    "GET /rest/api/3/project/search": () => ({ body: { values: [{ key: "CIAPP", name: "CI App" }, { bogus: true }], total: 1740 } }),
  });
  const client = new JiraClient({ site: "https://acme.atlassian.net", email: "dev@acme.test", token: "***" }, async (url, init) => { seen.push(url); return fetchImpl(url, init); });
  const projects = await client.projects();
  expectSchema(Schema.JiraProjectsResponse, projects);
  assert.deepEqual(projects, { projects: [{ key: "CIAPP", name: "CI App" }], total: 1740 });
  await client.projects("  ci app ");
  assert.match(seen[0]!, /maxResults=100$/u);
  assert.match(seen[1]!, /maxResults=50&query=ci%20app$/u);
});

test("the link search resolves keys and URLs exactly and escapes free text", async () => {
  assert.equal(jiraKeyFromInput(" ci-12 "), "CI-12");
  assert.equal(jiraKeyFromInput("https://acme.atlassian.net/browse/OPS-7?focusedCommentId=1"), "OPS-7");
  assert.equal(jiraKeyFromInput("flaky retries"), undefined);
  assert.equal(jqlString('say "hi" \\ now\n'), '"say \\"hi\\" \\\\ now "');

  const bodies: string[] = [];
  const { fetchImpl } = fakeJira({
    "GET /rest/api/3/issue/CI-12": () => ({ body: { key: "CI-12", fields: { summary: "Fix flake", status: { name: "Done", statusCategory: { key: "done" } }, issuetype: { name: "Task" } } } }),
    "POST /rest/api/3/search/jql": (init) => {
      bodies.push(JSON.parse(String(init.body)).jql);
      return { body: { issues: [{ key: "CI-3", fields: { summary: "Retry wrapper", status: { name: "To Do", statusCategory: { key: "new" } } } }] } };
    },
  });
  const client = new JiraClient({ site: "https://acme.atlassian.net", email: "dev@acme.test", token: "***" }, fetchImpl);
  assert.deepEqual(await findJiraIssues(client, "https://acme.atlassian.net", "https://acme.atlassian.net/browse/ci-12"), [
    { key: "CI-12", url: "https://acme.atlassian.net/browse/CI-12", summary: "Fix flake", status: "Done", statusCategory: "done", issueType: "Task" },
  ]);
  assert.deepEqual(await findJiraIssues(client, "https://acme.atlassian.net", "CI-404"), [], "a missing key is an empty result");
  assert.equal((await findJiraIssues(client, "https://acme.atlassian.net", ""))[0]?.key, "CI-3");
  await findJiraIssues(client, "https://acme.atlassian.net", 'retry "wrapper"');
  assert.deepEqual(bodies, [
    "issue in issueHistory() ORDER BY lastViewed DESC",
    'text ~ "retry \\"wrapper\\"*" ORDER BY updated DESC',
  ]);
});

test("myself reports the account id and assign PUTs it", async () => {
  let assigned: unknown;
  const { fetchImpl } = fakeJira({
    "GET /rest/api/3/myself": () => ({ body: { displayName: "Alex", accountId: "abc:123" } }),
    "PUT /rest/api/3/issue/CI-42/assignee": (init) => { assigned = JSON.parse(String(init.body)); return { status: 204 }; },
  });
  const client = new JiraClient({ site: "https://acme.atlassian.net", email: "dev@acme.test", token: "***" }, fetchImpl);
  assert.deepEqual(await client.myself(), { displayName: "Alex", accountId: "abc:123" });
  await client.assign("CI-42", "abc:123");
  assert.deepEqual(assigned, { accountId: "abc:123" });
  await assert.rejects(client.assign("nope", "abc:123"), JiraInputError);
});

test("Jira errors become readable messages without leaking credentials", async () => {
  const { fetchImpl } = fakeJira({
    "GET /rest/api/3/myself": () => ({ status: 401, body: {} }),
    "POST /rest/api/3/issue": () => ({ status: 400, body: { errors: { summary: "Summary is required." } } }),
  });
  const client = new JiraClient({ site: "https://acme.atlassian.net", email: "dev@acme.test", token: "tok" }, fetchImpl);
  await assert.rejects(client.myself(), (error: unknown) => error instanceof JiraRequestError && error.status === 401 && /API token/u.test(error.message));
  await assert.rejects(client.create({ project: "CI", issueTypeId: "1", summary: "x", description: "" }), /summary: Summary is required/u);
});

test("parent candidates are the next hierarchy level up and creation uses the standard type", async () => {
  let searched: unknown;
  let created: unknown;
  const { fetchImpl } = fakeJira({
    "GET /rest/api/3/issue/createmeta/CI/issuetypes": () => ({ body: { issueTypes: [
      { id: "10", name: "Epic", hierarchyLevel: 1 },
      { id: "11", name: "Story", hierarchyLevel: 0 },
      { id: "12", name: "Task", hierarchyLevel: 0 },
      { id: "13", name: "Sub-task", hierarchyLevel: -1, subtask: true },
    ] } }),
    "POST /rest/api/3/search/jql": (init) => {
      searched = JSON.parse(String(init.body));
      return { body: { issues: [{ key: "CI-1", fields: { summary: "CI reliability", issuetype: { id: "10", name: "Epic" }, status: { name: "In Progress" } } }] } };
    },
    "POST /rest/api/3/issue": (init) => {
      created = JSON.parse(String(init.body));
      return { status: 201, body: { key: "CI-42" } };
    },
  });
  const client = new JiraClient({ site: "https://acme.atlassian.net", email: "dev@acme.test", token: "tok" }, fetchImpl);
  const { parents, issueTypeId } = await parentCandidates(client, "CI");
  assert.equal(issueTypeId, "12");
  assert.deepEqual(parents, [{ key: "CI-1", summary: "CI reliability", issueType: "Epic", hierarchyLevel: 1, status: "In Progress" }]);
  assert.match((searched as { jql: string }).jql, /issuetype in \(10\) AND statusCategory != Done/u);
  assert.equal(await client.create({ project: "CI", issueTypeId, summary: "Fix flake", description: "## Context\n\nBody", parent: "CI-1" }), "CI-42");
  const fields = (created as { fields: Record<string, unknown> }).fields;
  assert.deepEqual(fields["project"], { key: "CI" });
  assert.deepEqual(fields["issuetype"], { id: "12" });
  assert.deepEqual(fields["parent"], { key: "CI-1" });
  assert.equal((fields["description"] as { type: string }).type, "doc");
});

test("the drafting agent picks a known parent and falls back without a model or on bad output", async () => {
  const parents = [{ key: "CI-1", summary: "CI reliability", issueType: "Epic", hierarchyLevel: 1 }];
  const prompts: string[] = [];
  const draft = await draftJiraWorkItem({
    project: "CI", parents, title: "Fix flaky retry", cwd: "/tmp", context: "user: make retries stable", model: "anthropic/haiku",
    run: async ({ prompt }) => {
      prompts.push(prompt);
      return "```json\n{\"summary\":\"Stabilize retry\",\"description\":\"## Context\\n\\nFlaky.\",\"parent\":\"ci-1\"}\n```";
    },
  });
  expectSchema(Schema.JiraDraftResponse, { draft });
  assert.deepEqual({ summary: draft.summary, parent: draft.parent, model: draft.model }, { summary: "Stabilize retry", parent: "CI-1", model: "anthropic/haiku" });
  assert.match(prompts[0]!, /CI-1 \| Epic \| CI reliability/u);
  assert.match(prompts[0]!, /user: make retries stable/u);

  const unknown = normalizeDraftAnswer("{\"summary\":\"x\",\"parent\":\"OPS-9\"}", parents, { summary: "f", description: "" });
  assert.deepEqual({ parent: unknown?.parent, choice: unknown?.parentChoice, rejected: unknown?.rejectedParent }, { parent: "", choice: "unmatched", rejected: "OPS-9" });
  for (const none of ["", "none", "N/A", "no parent"]) {
    const chosen = normalizeDraftAnswer(JSON.stringify({ summary: "x", parent: none }), parents, { summary: "f", description: "" });
    assert.deepEqual({ parent: chosen?.parent, choice: chosen?.parentChoice }, { parent: "", choice: "suggested" }, "deliberate none: " + JSON.stringify(none));
  }
  assert.equal(normalizeDraftAnswer("{\"summary\":\"x\",\"parent\":\"\"}", [], { summary: "f", description: "" })?.parentChoice, "none-available");
  assert.equal(draft.parentChoice, "suggested");
  const noModel = await draftJiraWorkItem({ project: "CI", parents, title: "Fix flaky retry", cwd: "/tmp", context: "user: make retries stable", model: "", run: async () => assert.fail("no model call") });
  expectSchema(Schema.JiraDraftResponse, { draft: noModel });
  assert.equal(noModel.summary, "Fix flaky retry");
  assert.equal(noModel.description, "## Context\n\nmake retries stable");
  assert.match(noModel.note ?? "", /utility model/u);
  assert.equal(noModel.parentChoice, "not-drafted");
  const failed = await draftJiraWorkItem({ project: "CI", parents, title: "T", cwd: "/tmp", context: "", model: "m/x", run: async () => { throw new Error("The utility model timed out."); } });
  assert.match(failed.note ?? "", /timed out/u);
  assert.equal(failed.model, undefined);
  const garbage = await draftJiraWorkItem({ project: "CI", parents, title: "T", cwd: "/tmp", context: "", model: "m/x", run: async () => "no json here" });
  assert.match(garbage.note ?? "", /usable draft/u);
});

test("drafts anchor on the session goal rather than the last message", async () => {
  const prompts: string[] = [];
  await draftJiraWorkItem({
    project: "CI", parents: [], title: "T", cwd: "/tmp", context: "## Session goal (the user's first request)\n\nAdd retries", goal: "Add retries", model: "m/x",
    run: async ({ prompt }) => { prompts.push(prompt); return "{}"; },
  });
  assert.match(prompts[0]!, /session goal \(the user's first request\) defines the work item/u);
  assert.match(prompts[0]!, /do not name the work item after the last topic/u);
  assert.match(prompts[0]!, /language of the user's messages/u);
  assert.match(prompts[0]!, /no parent is better than a wrong one/u);
  const failed = await draftJiraWorkItem({
    project: "CI", parents: [], title: "T", cwd: "/tmp", context: "user: Add retries\n\nuser: thanks, lint is green", goal: "Add retries", model: "m/x",
    run: async () => { throw new Error("All provider accounts are waiting for their quota to reset."); },
  });
  assert.equal(failed.description, "## Context\n\nAdd retries");
  assert.match(failed.note ?? "", /quota to reset\. HUI prefilled/u);
  assert.equal(fallbackDraft("T", "user: first\n\nuser: last").description, "## Context\n\nlast", "without a goal the last request is still used");
});

test("an empty or stalled draft attempt is retried once; provider errors are not", async () => {
  const answer = "{\"summary\":\"Add retries\",\"description\":\"## Context\\n\\nx\",\"parent\":\"\"}";
  const empty = () => Object.assign(new Error("The utility model returned no answer after 11s."), { retryable: true });
  const input = { project: "CI", parents: [], title: "T", cwd: "/tmp", context: "", model: "m/x" };
  const timeouts: (number | undefined)[] = [];
  let calls = 0;
  const recovered = await draftJiraWorkItem({ ...input, run: async ({ timeoutMs }) => {
    timeouts.push(timeoutMs);
    if (++calls === 1) throw empty();
    return answer;
  } });
  assert.equal(recovered.summary, "Add retries");
  assert.deepEqual(timeouts, [DRAFT_ATTEMPT_TIMEOUT_MS, DRAFT_ATTEMPT_TIMEOUT_MS]);

  calls = 0;
  const twice = await draftJiraWorkItem({ ...input, run: async () => { calls += 1; throw empty(); } });
  assert.equal(calls, 2);
  assert.match(twice.note ?? "", /no answer after 11s/u);

  calls = 0;
  calls = 0;
  const malformed = await draftJiraWorkItem({ ...input, run: async () => (++calls === 1 ? "{\"summary\": \"cut off" : answer) });
  assert.equal(malformed.summary, "Add retries", "malformed JSON is retried once");
  assert.equal(calls, 2);

  calls = 0;
  const parents = [{ key: "CI-1", summary: "CI reliability", issueType: "Epic", hierarchyLevel: 1 }];
  const noField = "{\"summary\":\"Add retries\",\"description\":\"## Context\\n\\nx\"}";
  const omittedOnce = await draftJiraWorkItem({ ...input, parents, run: async () => (++calls === 1 ? noField : answer) });
  assert.deepEqual({ calls, choice: omittedOnce.parentChoice }, { calls: 2, choice: "suggested" }, "a missing parent field is asked once more");
  calls = 0;
  const omittedTwice = await draftJiraWorkItem({ ...input, parents, run: async () => { calls += 1; return noField; } });
  assert.deepEqual({ calls, choice: omittedTwice.parentChoice, summary: omittedTwice.summary }, { calls: 2, choice: "omitted", summary: "Add retries" });

  calls = 0;
  const quota = await draftJiraWorkItem({ ...input, run: async () => { calls += 1; throw new Error("Go usage limit exceeded"); } });
  assert.equal(calls, 1, "a provider error is final");
  assert.match(quota.note ?? "", /usage limit/u);
});

test("create input is validated at the boundary", () => {
  assert.deepEqual(validateCreateInput({ project: "ci", parent: "ci-1", summary: "  Fix   flake ", description: "d" }), { project: "CI", parent: "CI-1", summary: "Fix flake", description: "d" });
  assert.throws(() => validateCreateInput({ project: "", summary: "x" }), /project/u);
  assert.throws(() => validateCreateInput({ project: "CI", summary: "" }), /summary/u);
  assert.throws(() => validateCreateInput({ project: "CI", summary: "x", parent: "not a key" }), /parent/u);
});

test("statuses are stale-while-revalidate and never looked up without a connection", async () => {
  let now = 0;
  let calls = 0;
  const statuses = new JiraIssueStatuses({ now: () => now, activeTtlMs: 100, failureTtlMs: 1_000 });
  const ref = { key: "CI-1", url: "https://acme.atlassian.net/browse/CI-1" };
  assert.deepEqual(statuses.view(ref), ref);
  const fetch = async () => { calls += 1; return { summary: "S", status: "To Do", statusCategory: "new" as const, description: "" }; };
  assert.deepEqual(statuses.view(ref, fetch), ref);
  await statuses.whenIdle();
  assert.equal(statuses.view(ref, fetch).status, "To Do");
  assert.equal(calls, 1);
  now = 200;
  statuses.view(ref, fetch);
  await statuses.whenIdle();
  assert.equal(calls, 2);
  now = 400;
  statuses.view(ref, async () => { throw new Error("offline"); });
  await statuses.whenIdle();
  assert.equal(statuses.view(ref, fetch).status, "To Do", "a failure keeps the last confirmed facts");
  statuses.clear();
  assert.equal(statuses.view(ref).status, undefined);
});
