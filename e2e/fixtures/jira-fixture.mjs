#!/usr/bin/env node
/** Deterministic Jira Cloud REST v3 subset for Browser E2E.
 * Usage: HUI_E2E_JIRA_PORT=43128 node e2e/fixtures/jira-fixture.mjs
 * Accepts only `Basic base64(e2e@hui.test:e2e-token)` and keeps created work
 * items in memory. GET /control/created lists what HUI created. */
import { createServer } from "node:http";

const port = Number(process.env.HUI_E2E_JIRA_PORT ?? 43128);
const AUTH = `Basic ${Buffer.from("e2e@hui.test:e2e-token").toString("base64")}`;
// Port 0 asks the OS for a free port; the real origin is known after listen.
let origin = `http://127.0.0.1:${port}`;
// Large sites: 600 filler projects push the real ones past the first page.
const projects = [
  ...Array.from({ length: 600 }, (_, index) => ({ key: `AA${index}`, name: `Archive ${String(index).padStart(3, "0")}` })),
  { key: "CI", name: "CI Platform" },
  { key: "OPS", name: "Operations" },
];
const issueTypes = [
  { id: "10", name: "Epic", hierarchyLevel: 1 },
  { id: "11", name: "Story", hierarchyLevel: 0 },
  { id: "12", name: "Task", hierarchyLevel: 0 },
  { id: "13", name: "Sub-task", hierarchyLevel: -1, subtask: true },
];
const issues = new Map([
  ["CI-1", { project: "CI", summary: "Pipeline reliability", type: "10", status: ["In Progress", "indeterminate"], description: {
    type: "doc", version: 1, content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
      { type: "paragraph", content: [{ type: "text", text: "Cut flaky pipeline failures in half this quarter. Track every retry wrapper in " }, { type: "text", text: "ci/", marks: [{ type: "code" }] }, { type: "text", text: " and make failures actionable." }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Workstreams" }] },
      { type: "bulletList", content: ["Retry wrappers surface the first failure", "Flake dashboard per repository", "Quarantine list with owners", "Weekly flake review", "Alert on retry storms", "Document the retry policy"].map((text) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] })) },
      ...Array.from({ length: 6 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: `Milestone ${index + 1}: agree scope, land the change behind a flag, measure for a week and roll out to the remaining pipelines once the flake rate drops.` }] })),
    ] } }],
  ["CI-2", { project: "CI", summary: "Developer tooling polish", type: "10", status: ["To Do", "new"], description: null }],
  ["OPS-1", { project: "OPS", summary: "On-call hygiene", type: "10", status: ["To Do", "new"], description: null }],
]);
const created = [];
let next = 41;

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body === undefined ? "" : JSON.stringify(body));
};
const view = (key) => {
  const issue = issues.get(key);
  const type = issueTypes.find((item) => item.id === issue.type);
  return {
    key,
    fields: {
      summary: issue.summary,
      status: { name: issue.status[0], statusCategory: { key: issue.status[1] } },
      issuetype: { id: type.id, name: type.name },
      description: issue.description,
    },
  };
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname === "/control/created") return json(response, 200, created);
  if (request.headers.authorization !== AUTH) return json(response, 401, { errorMessages: ["Unauthorized"] });
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /rest/api/3/myself") return json(response, 200, { displayName: "HUI E2E", accountId: "e2e-account" });
  const assignee = url.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/assignee$/u);
  if (request.method === "PUT" && assignee && issues.has(assignee[1])) {
    issues.get(assignee[1]).assignee = body.accountId;
    const entry = created.find((item) => item.key === assignee[1]);
    if (entry) entry.assignee = body.accountId;
    return json(response, 204);
  }
  if (route === "GET /rest/api/3/project/search") {
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    const max = Number(url.searchParams.get("maxResults") ?? 50);
    const matches = projects.filter((project) => !query || project.key.toLowerCase().includes(query) || project.name.toLowerCase().includes(query));
    return json(response, 200, { values: matches.slice(0, max), total: matches.length, isLast: matches.length <= max });
  }
  const meta = url.pathname.match(/^\/rest\/api\/3\/issue\/createmeta\/([A-Z]+)\/issuetypes$/u);
  if (request.method === "GET" && meta) return json(response, 200, { issueTypes });
  if (route === "POST /rest/api/3/search/jql") {
    if (/issueHistory\(\)/u.test(body.jql)) return json(response, 200, { issues: [...issues.keys()].reverse().slice(0, body.maxResults ?? 20).map(view) });
    const text = body.jql.match(/^text ~ "((?:[^"\\]|\\.)*)"/u)?.[1];
    if (text !== undefined) {
      const terms = text.replace(/\\(.)/gu, "$1").replace(/\*$/u, "").toLowerCase().split(/\s+/u).filter(Boolean);
      const keys = [...issues.keys()].filter((key) => terms.every((term) => `${key} ${issues.get(key).summary}`.toLowerCase().includes(term)));
      return json(response, 200, { issues: keys.map(view) });
    }
    const project = body.jql.match(/project = "([A-Z]+)"/u)?.[1];
    const keys = [...issues.keys()].filter((key) => issues.get(key).project === project && issues.get(key).type === "10");
    return json(response, 200, { issues: keys.map(view) });
  }
  if (route === "POST /rest/api/3/issue") {
    const fields = body.fields;
    const key = `${fields.project.key}-${next++}`;
    issues.set(key, { project: fields.project.key, summary: fields.summary, type: fields.issuetype.id, status: ["To Do", "new"], description: fields.description ?? null });
    created.push({ key, fields });
    return json(response, 201, { key, self: `${origin}/rest/api/3/issue/${key}` });
  }
  const one = url.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/u);
  if (request.method === "GET" && one && issues.has(one[1])) return json(response, 200, view(one[1]));
  return json(response, 404, { errorMessages: [`fixture has no ${route}`] });
});
server.listen(port, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`HUI E2E Jira: ${origin}\n`);
});
