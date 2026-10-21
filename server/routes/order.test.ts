import assert from "node:assert/strict";
import { GitHubError } from "../api/github.ts";
import { DatadogError } from "../api/datadog.ts";
import { JiraError } from "../api/jira.ts";
import { PiError } from "../api/pi.ts";
import { ToolsError } from "../api/tools.ts";
import { ProviderError } from "../api/providers.ts";
import { SettingsError } from "../api/settings.ts";
import { SessionError } from "../api/sessions.ts";
import { AutomationError, AutomationSnapshot } from "../api/automation.ts";
import { UpdateError, UpdateSnapshot } from "../api/updates.ts";
import { WorkerError, WorkersResponse } from "../api/workers.ts";
import { TerminalError } from "../api/terminals.ts";
import { BacklogError } from "../api/backlog.ts";
import { TaskSuggestionError } from "../api/task-suggestions.ts";
import { WatcherError } from "../api/watchers.ts";
import { WorktreeError, WorktreeInventory, WorkspaceInspection, WorktreeRemovalResponse } from "../api/worktrees.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { DiagnosticsError, GatewayHealth, ObservabilitySnapshot, UiErrorReceipt } from "../api/diagnostics.ts";
import { DirectoriesResponse, GitCheckoutResponse, LocalPathError, LocalPathsResponse } from "../api/local-paths.ts";
import { ThemeFile, ThemeError, ThemesResponse } from "../api/themes.ts";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const root = await mkdtemp(join(tmpdir(), "hui-route-order-"));
process.env["HOME"] = root;
process.env["XDG_CONFIG_HOME"] = join(root, "config");
process.env["PI_CODING_AGENT_DIR"] = join(root, "agent");
await mkdir(join(root, "config", "hui"), { recursive: true });
const { middleware } = await import("../hui.ts");
const { stopBackend } = await import("../backend.ts");

const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
afterAll(async () => {
  await stopBackend();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

const anonymous = { headers: {} };
const sameOrigin = { headers: { "sec-fetch-site": "same-origin" } };

type Case = [request: string, status: number, keys: string[] | null, recorded: boolean, init?: RequestInit];

const CASES: Case[] = [
  ["GET /__hui/widget-sandbox", 200, null, false, anonymous],
  ["GET /__hui/media/0/missing.png", 404, ["error"], false, anonymous],
  ["GET /__hui/sessions/missing/attachments/1/1", 404, ["error"], false, sameOrigin],
  ["GET /__hui/bots/missing/memory/html", 404, ["error"], false, sameOrigin],
  ["POST /__hui/vscode/enter", 405, null, false, anonymous],
  ["GET /__hui/vscode/", 403, null, false, anonymous],
  ["POST /__hui/hooks/missing", 404, ["error"], false, anonymous],
  ["OPTIONS /__hui/settings", 403, ["error"], false, anonymous],
  ["GET /__hui/settings", 403, ["error"], false, anonymous],
  ["GET /__hui/sessions/missing/terminals", 404, ["error"], false],
  ["GET /__hui/sessions/missing/files/list", 404, ["error"], false],
  ["GET /__hui/sessions/missing/diff", 404, ["error"], false],
  ["POST /__hui/sessions/missing/vscode/connect", 404, ["code", "error"], false],
  ["PUT /__hui/vscode-server", 405, ["code", "error"], false],
  ["POST /__hui/sessions/missing/browser/connect", 404, ["error"], false],
  ["GET /__hui/update", 200, ["check", "currentVersion", "job"], false],
  ["POST /__hui/update", 400, ["error"], true],
  ["DELETE /__hui/update/check", 405, ["error"], true],
  ["POST /__hui/directories", 405, ["error"], true],
  ["POST /__hui/local-paths", 405, ["error"], true],
  ["POST /__hui/git-checkout", 405, ["error"], true],
  ["POST /__hui/browser", 400, ["error"], true, { body: JSON.stringify({ action: "jump" }) }],
  ["POST /__hui/browser/tabs/t1/preview", 405, ["error"], true],
  ["DELETE /__hui/settings", 405, ["error"], true],
  ["GET /__hui/pi/packages/install", 405, ["error"], true],
  ["POST /__hui/tools", 405, ["error"], true],
  [`GET /__hui/pi/resources/skill/${"0".repeat(24)}`, 404, ["error"], true],
  ["GET /__hui/workers", 200, ["workers"], false],
  ["GET /__hui/workers/missing", 404, ["error"], true],
  ["GET /__hui/bots/events", 200, null, false],
  ["POST /__hui/calls", 405, ["error"], true],
  ["GET /__hui/bots/missing/calls", 405, ["error"], true],
  ["GET /__hui/bots/missing/triggers", 404, ["error"], true],
  ["GET /__hui/bots/missing", 404, ["error"], true],
  ["GET /__hui/providers/a/b/c/d", 405, ["error"], true],
  ["POST /__hui/pi", 405, ["error"], true],
  ["PUT /__hui/power", 400, ["error"], true],
  ["POST /__hui/api-schema", 405, ["error"], true],
  ["POST /__hui/health", 405, ["error"], false],
  ["POST /__hui/worktrees", 405, ["error"], true],
  ["POST /__hui/worktrees/remove", 400, ["error"], true],
  ["POST /__hui/workspaces", 405, ["error"], true],
  ["POST /__hui/diagnostics/ui-errors", 400, ["error"], true],
  ["POST /__hui/observability", 405, ["error"], false],
  ["POST /__hui/diagnostics/export", 405, ["error"], false],
  ["GET /__hui/automation", 200, ["runs", "scheduler", "tasks"], false],
  ["POST /__hui/automation/tasks", 400, ["error"], true],
  ["POST /__hui/automation/runs/missing/cancel", 409, ["error"], true],
  ["POST /__hui/themes/import", 400, ["error"], true],
  ["POST /__hui/github", 405, ["error"], true],
  ["GET /__hui/github/previews", 400, ["error"], true],
  ["GET /__hui/session-activity", 400, ["error"], true],
  ["GET /__hui/github/contributions?year=1", 400, ["error"], true],
  ["GET /__hui/github/login", 405, ["error"], true],
  ["POST /__hui/datadog", 405, ["error"], true],
  ["GET /__hui/datadog/orgs", 405, ["error"], true],
  ["GET /__hui/datadog/login", 405, ["error"], true],
  ["GET /__hui/datadog/previews", 400, ["error"], true],
  ["POST /__hui/jira", 405, ["error"], true],
  ["POST /__hui/jira/projects", 405, ["error"], true],
  ["POST /__hui/jira/issues", 405, ["error"], true],
  ["GET /__hui/sessions/missing/jira", 405, ["error"], true],
  ["DELETE /__hui/sessions/events", 405, ["error"], true],
  ["POST /__hui/session-groups", 400, ["error"], true],
  ["DELETE /__hui/session-groups/missing", 400, ["error"], true],
  ["DELETE /__hui/sessions", 405, ["error"], true],
  ["POST /__hui/backlog", 405, ["error"], true],
  ["DELETE /__hui/backlog/items/missing", 404, ["error"], true],
  ["DELETE /__hui/sessions/missing/suggestions/s1", 404, ["error"], true],
  ["DELETE /__hui/sessions/missing/watchers/w1", 404, ["error"], true],
  ["DELETE /__hui/sessions/missing", 404, ["error"], true],
  ["POST /__hui/sessions/missing/prompt", 404, ["error"], true],
  ["GET /__hui/themes/file/missing", 404, ["error"], true],
  ["GET /__hui/missing", 404, ["error"], true],
  ["GET /missing", 404, null, false],
];

async function lastEventId(): Promise<number> {
  const response = await fetch(`${base}/__hui/diagnostics/export`, { headers: { "x-hui": "1" } });
  const { activity } = await response.json() as { activity: Array<{ id: number }> };
  return activity[0]?.id ?? 0;
}

async function answer(request: string, init: RequestInit = {}): Promise<[number, string[] | null]> {
  const [method = "GET", path = "/"] = request.split(" ");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "x-hui": "1", "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
    ...init,
  });
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    await response.body?.cancel();
    return [response.status, null];
  }
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (response.status >= 400) {
    if (["/__hui/health", "/__hui/observability", "/__hui/diagnostics/export", "/__hui/diagnostics/ui-errors"].includes(path)) expectSchema(DiagnosticsError, body);
    if (["/__hui/directories", "/__hui/local-paths", "/__hui/git-checkout"].includes(path)) expectSchema(LocalPathError, body);
    if (path.startsWith("/__hui/themes")) expectSchema(ThemeError, body);
    if (path.startsWith("/__hui/backlog")) expectSchema(BacklogError, body);
    if (/\/suggestions\//u.test(path)) expectSchema(TaskSuggestionError, body);
    if (/\/watchers\//u.test(path)) expectSchema(WatcherError, body);
    if (path.startsWith("/__hui/worktrees") || path === "/__hui/workspaces") expectSchema(WorktreeError, body);
    if (path.startsWith("/__hui/pi")) expectSchema(PiError, body);
    if (path === "/__hui/tools" || /\/sessions\/[^/]+\/tools$/u.test(path)) expectSchema(ToolsError, body);
    if (path.startsWith("/__hui/providers")) expectSchema(ProviderError, body);
    if (path === "/__hui/settings") expectSchema(SettingsError, body);
    if (path.startsWith("/__hui/automation")) expectSchema(AutomationError, body);
    if (path.startsWith("/__hui/update")) expectSchema(UpdateError, body);
    if (path.startsWith("/__hui/workers")) expectSchema(WorkerError, body);
    if (/\/terminals(?:\/|$)/u.test(path)) expectSchema(TerminalError, body);
    if (path.startsWith("/__hui/github") || path.startsWith("/__hui/session-activity")) expectSchema(GitHubError, body);
    if (path.startsWith("/__hui/datadog")) expectSchema(DatadogError, body);
    if (path.startsWith("/__hui/jira") || /\/jira(?:\/|$)/u.test(path)) expectSchema(JiraError, body);
    if (/^\/__hui\/(?:session-groups(?:\/[^/]+)?|sessions(?:\/[^/]+(?:\/(?:prompt|steer|follow-up|continue|compact|reload|abort|rewind|resume|question|fork|fast|connect))?)?)$/u.test(path)) expectSchema(SessionError, body);
  }
  if (response.status === 200) {
    if (path === "/__hui/health") expectSchema(GatewayHealth, body);
    if (path === "/__hui/observability" || path === "/__hui/diagnostics/export") expectSchema(ObservabilitySnapshot, body);
    if (path.startsWith("/__hui/directories")) expectSchema(DirectoriesResponse, body);
    if (path.startsWith("/__hui/local-paths")) expectSchema(LocalPathsResponse, body);
    if (path.startsWith("/__hui/git-checkout")) expectSchema(GitCheckoutResponse, body);
    if (path === "/__hui/themes") expectSchema(ThemesResponse, body);
    if (path.startsWith("/__hui/themes/file/")) expectSchema(ThemeFile, body);
    if (path === "/__hui/worktrees") expectSchema(WorktreeInventory, body);
    if (path === "/__hui/workspaces") expectSchema(WorkspaceInspection, body);
    if (path === "/__hui/worktrees/remove") expectSchema(WorktreeRemovalResponse, body);
    if (path === "/__hui/automation") expectSchema(AutomationSnapshot, body);
    if (path === "/__hui/update") expectSchema(UpdateSnapshot, body);
    if (path === "/__hui/workers") expectSchema(WorkersResponse, body);
  }
  return [response.status, body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort() : null];
}

test("diagnostics, path lookups and themes publish their existing payloads", async () => {
  for (const path of ["/__hui/health", "/__hui/observability", "/__hui/diagnostics/export", "/__hui/directories?q=~/", `/__hui/local-paths?cwd=${encodeURIComponent(root)}&q=`, `/__hui/git-checkout?cwd=${encodeURIComponent(root)}`, "/__hui/themes"]) {
    assert.equal((await answer(`GET ${path}`))[0], 200);
  }
  const response = await fetch(`${base}/__hui/diagnostics/ui-errors`, {
    method: "POST", headers: { "x-hui": "1", "content-type": "application/json" },
    body: JSON.stringify({ reports: [{ kind: "uncaught_error", message: "schema fixture" }] }),
  });
  assert.equal(response.status, 202);
  const receipt = await response.json();
  expectSchema(UiErrorReceipt, receipt);
  assert.deepEqual(receipt, { recorded: 1, dropped: 0 });
  const exported = await fetch(`${base}/__hui/diagnostics/export`, { headers: { "x-hui": "1" } });
  assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="hui-diagnostics-.*\.json"$/u);
  expectSchema(ObservabilitySnapshot, await exported.json());
  const themes = await fetch(`${base}/__hui/themes`, { headers: { "x-hui": "1" } });
  const listing = await themes.json();
  expectSchema(ThemesResponse, listing);
  assert.ok(listing.themes.length > 0);
  assert.equal((await answer(`GET ${listing.themes[0]!.url}`))[0], 200);
});

test("theme files keep author-supplied fields even when cssVars is not an object", async () => {
  const directory = join(root, "config", "hui", "themes");
  await mkdir(directory, { recursive: true });
  const theme: Record<string, unknown> = JSON.parse(await readFile(new URL("../../themes/miami.json", import.meta.url), "utf8"));
  const document = { ...theme, name: "Open theme", cssVars: null };
  await writeFile(join(directory, "schema-open.json"), JSON.stringify(document));
  const response = await fetch(`${base}/__hui/themes`, { headers: { "x-hui": "1" } });
  const listing = await response.json();
  expectSchema(ThemesResponse, listing);
  const entry = listing.themes.find((item) => item.id === "schema-open");
  assert.ok(entry, "the theme mapper accepts the top-level color blocks");
  assert.equal((await answer(`GET ${entry.url}`))[0], 200);
  const file = await fetch(base + entry.url, { headers: { "x-hui": "1" } });
  assert.deepEqual(await file.json(), document);
});

test("worktree and workspace routes publish their existing payloads", async () => {
  assert.equal((await answer("GET /__hui/worktrees"))[0], 200);
  assert.equal((await answer("GET /__hui/workspaces"))[0], 200);
  assert.equal((await answer("POST /__hui/worktrees/remove", { body: JSON.stringify({ paths: [join(root, "missing")], mode: "single" }) }))[0], 200);
});

test("each route family answers in today's dispatch order, recorded only after the diagnostics hook", async () => {
  const actual = [];
  let seen = await lastEventId();
  for (const [request, , , , init] of CASES) {
    const [status, keys] = await answer(request, init);
    const latest = await lastEventId();
    actual.push([request, status, keys, latest > seen]);
    seen = latest;
  }
  assert.deepEqual(actual, CASES.map((expected) => expected.slice(0, 4)));
});
