import assert from "node:assert/strict";
import { DatadogConnection } from "../api/datadog.ts";
import { expectSchema } from "../test-support/api-schema.ts";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { waitFor } from "../test-support/wait-for.ts";

import { DATADOG_CLI_REQUIRED } from "./datadog-links.ts";
import {
  classifyPupFailure,
  DatadogError,
  DatadogOrgs,
  DatadogOrgStore,
  loginFailureMessage,
  normalizeOrg,
  parseLoginUrl,
  parsePupSessions,
  pupRunner,
  sessionStatus,
} from "./datadog.ts";

const FIXTURE = fileURLToPath(new URL("../../e2e/fixtures/pup-cli-fixture.mjs", import.meta.url));
const PROD = { name: "prod", site: "app.datadoghq.com" };

async function fakePup(sessions: unknown[] = [], options: { loginTimeoutMs?: number; command?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hui-pup-"));
  await chmod(FIXTURE, 0o755);
  await writeFile(join(dir, "sessions.json"), JSON.stringify(sessions));
  // Identity the gateway may have inherited; pup must never see it.
  const env = {
    ...process.env, HUI_FAKE_PUP_DIR: dir, DD_API_KEY: "key", DD_APP_KEY: "app", DD_ACCESS_TOKEN: "token", DD_ORG: "other",
    DD_SITE: "datadoghq.eu", DD_OUTPUT: "yaml", PUP_OUTPUT: "table", PUP_FILTER: "length", PUP_AGENT_MODE: "1",
  };
  const changes = { count: 0 };
  const orgs = new DatadogOrgs({
    command: options.command ?? FIXTURE,
    env,
    store: new DatadogOrgStore(join(dir, "datadog.json")),
    onChange: () => { changes.count += 1; },
    ...(options.loginTimeoutMs ? { loginTimeoutMs: options.loginTimeoutMs } : {}),
  });
  const calls = async () => (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; site: string | null; leaked: string[] });
  return { dir, env, orgs, changes, calls };
}

test("classifies pup failures and reads what sign-in prints", () => {
  assert.equal(classifyPupFailure({ code: "ENOENT" }), "cli_missing");
  assert.equal(classifyPupFailure({ stderr: "Error: authentication expired. Run 'pup auth refresh' to renew your session" }), "expired");
  assert.equal(classifyPupFailure({ stderr: "Error: HTTP 401 https://api.datadoghq.com/api/v1/graph/snapshot: {}" }), "expired");
  assert.equal(classifyPupFailure({ stderr: "Error: authentication required: set DD_ACCESS_TOKEN…" }), "signed_out");
  assert.equal(classifyPupFailure({ stderr: "Error: failed to get dashboard: ResponseError(ResponseContent { status: 404, …" }), "not_found");
  assert.equal(classifyPupFailure({ stderr: "Error: HTTP 403 https://api.datadoghq.com/api/v1/org: {\"errors\":[\"Forbidden\"]}" }), "not_found");
  assert.equal(classifyPupFailure({ stderr: "Error: HTTP 429 Too Many Requests" }), "unavailable");
  assert.equal(classifyPupFailure({ code: 1, stderr: "" }), "unavailable");

  const output = "🌐 Opening browser for authentication...\nIf the browser doesn't open, visit: https://app.datadoghq.com/oauth2/v1/authorize?client_id=x&state=y\n\n⏳ Waiting for authorization...\n";
  assert.equal(parseLoginUrl(output), "https://app.datadoghq.com/oauth2/v1/authorize?client_id=x&state=y");
  assert.equal(parseLoginUrl("If the browser doesn't open, visit: https://evil.example/authorize"), undefined);
  assert.equal(parseLoginUrl("no url here"), undefined);
  assert.equal(loginFailureMessage(`${output}\u001b[31mError: OAuth callback timed out after 300s\u001b[0m\n`, 1), "Error: OAuth callback timed out after 300s");
  assert.equal(loginFailureMessage("", 2), "pup auth login exited with code 2.");
});

test("maps pup sessions to org status, the default session included", () => {
  const sessions = parsePupSessions([
    { org: "prod", site: "datadoghq.com", status: "expired", has_refresh: true, scopes: ["secret-free"] },
    { org: "stale", site: "datadoghq.com", status: "expired", has_refresh: false },
    { org: null, site: "dd.datad0g.com", status: "valid", has_refresh: true },
    { org: "full-host", site: "app.datadoghq.eu", status: "valid", has_refresh: true },
    { org: "broken" },
  ]);
  assert.deepEqual(sessions.map((session) => session.org), ["prod", "stale", "", "full-host"]);
  assert.equal(sessionStatus({ name: "full-host", site: "app.datadoghq.eu" }, sessions), "connected");
  assert.equal(sessionStatus(PROD, sessions), "connected");
  assert.equal(sessionStatus({ name: "stale", site: "app.datadoghq.com" }, sessions), "signed_out");
  assert.equal(sessionStatus({ name: "", site: "dd.datad0g.com" }, sessions), "connected");
  assert.equal(sessionStatus({ name: "prod", site: "app.datadoghq.eu" }, sessions), "signed_out");
  assert.throws(() => parsePupSessions({ not: "a list" }));
});

test("validates org input", () => {
  assert.deepEqual(normalizeOrg({ name: "  Datadog HQ [8dee7c38] ", site: "datadoghq.com" }), { name: "Datadog HQ [8dee7c38]", site: "app.datadoghq.com" });
  assert.deepEqual(normalizeOrg({ site: "dd.datad0g.com" }), { name: "", site: "dd.datad0g.com" });
  assert.deepEqual(normalizeOrg({ name: "prod" }), PROD);
  for (const raw of [{ name: "x".repeat(101) }, { name: "a\nb" }, { name: 7 }, { name: "prod", site: "example.com" }]) {
    assert.throws(() => normalizeOrg(raw), DatadogError, JSON.stringify(raw));
  }
});

test("keeps the org list in a private file and never overwrites one it cannot read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-datadog-store-"));
  const store = new DatadogOrgStore(join(dir, "datadog.json"));
  assert.deepEqual(await store.read(), []);
  await store.write([PROD, { name: "", site: "dd.datad0g.com" }]);
  assert.deepEqual(await store.read(), [PROD, { name: "", site: "dd.datad0g.com" }]);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), { version: 1, orgs: [PROD, { name: "", site: "dd.datad0g.com" }] });

  for (const content of ["{not json", JSON.stringify({ version: 2, orgs: [] })]) {
    await writeFile(store.path, content);
    const orgs = new DatadogOrgs({ command: FIXTURE, store });
    await assert.rejects(orgs.add({ name: "staging" }), (error: unknown) => error instanceof DatadogError && error.status === 500);
    assert.equal(await readFile(store.path, "utf8"), content);
  }
});

test("runs pup for exactly the chosen session, read-only, without inherited identity", async () => {
  const { env, calls } = await fakePup([{ org: "prod", site: "datadoghq.com", status: "valid", has_refresh: true }]);
  const run = pupRunner(FIXTURE, env);
  await assert.rejects(run(["dashboards", "get", "abc-123-xyz"], PROD), (error: unknown) => (error as { reason?: string }).reason === "not_found");
  await assert.rejects(run(["dashboards", "get", "abc-123-xyz"], { name: "nobody", site: "app.datadoghq.com" }), (error: unknown) => (error as { reason?: string }).reason === "signed_out");
  const [first] = await calls();
  assert.deepEqual(first, { args: ["dashboards", "get", "abc-123-xyz", "-o", "json", "--no-agent", "--read-only", "--org=prod"], site: "datadoghq.com", leaked: [] });
  await assert.rejects(pupRunner("/nonexistent/pup", env)(["auth", "list"]), (error: unknown) => (error as { reason?: string }).reason === "cli_missing");
});

test("renews an expired session with pup auth refresh", async () => {
  const { dir, orgs, calls } = await fakePup([{ org: "prod", site: "datadoghq.com", status: "valid", has_refresh: true }]);
  await writeFile(join(dir, "expired"), "prod\n");
  await assert.rejects(orgs.run(["dashboards", "get", "abc-123-xyz"], PROD), (error: unknown) => (error as { reason?: string }).reason === "expired");
  assert.equal(await orgs.refresh(PROD), true, "refresh prints nothing on stdout and still succeeds");
  await assert.rejects(orgs.run(["dashboards", "get", "abc-123-xyz"], PROD), (error: unknown) => (error as { reason?: string }).reason === "not_found");
  assert.deepEqual((await calls()).find((call) => call.args[1] === "refresh")?.args, ["auth", "refresh", "-o", "json", "--no-agent", "--read-only", "--org=prod"]);
  assert.equal(await orgs.refresh({ name: "nobody", site: "app.datadoghq.com" }), false);
});

test("never runs two sign-ins at once", async () => {
  const { dir, orgs } = await fakePup([]);
  await new DatadogOrgStore(join(dir, "datadog.json")).write([PROD]);
  const [first, second] = await Promise.allSettled([orgs.startLogin(PROD), orgs.startLogin(PROD)]);
  const results = [first, second];
  assert.equal(results.filter((result) => result.status === "fulfilled" && result.value.login.phase === "pending").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && (result.reason as DatadogError).status === 409).length, 1);
  assert.deepEqual((await orgs.cancelLogin()).login, { phase: "idle" });
});

test("adds orgs, reports their status and signs in to one pup does not have", async () => {
  const { dir, orgs, changes, calls } = await fakePup([{ org: "prod", site: "datadoghq.com", status: "valid", has_refresh: true }]);
  const added = await orgs.add({ name: "prod" });
  assert.deepEqual(added.orgs, [{ ...PROD, status: "connected" }]);
  assert.deepEqual(added.login, { phase: "idle" });
  assert.deepEqual(added.pupOrgs, [PROD]);
  assert.deepEqual(added.cli, { installed: true, version: "9.9.9" });
  await assert.rejects(orgs.add({ name: "prod", site: "app.datadoghq.com" }), (error: unknown) => error instanceof DatadogError && error.status === 409);

  const pending = await orgs.add({ name: "staging", site: "dd.datad0g.com" });
  assert.equal(pending.login.phase, "pending");
  await assert.rejects(orgs.startLogin(PROD), (error: unknown) => error instanceof DatadogError && error.status === 409);
  const url = await waitFor("pup's sign-in page", async () => {
    const login = (await orgs.connection()).login;
    return login.phase === "pending" ? login.url : undefined;
  });
  assert.equal(url, "https://app.dd.datad0g.com/oauth2/v1/authorize?client_id=fixture");
  assert.deepEqual((await readFile(join(dir, "login-args"), "utf8")).split("\n"), ["auth", "login", "--org=staging", "--site=dd.datad0g.com", "--no-agent"]);

  const before = changes.count;
  await writeFile(join(dir, "approve"), "");
  await orgs.whenLoginSettled();
  const connected = await orgs.connection();
  expectSchema(DatadogConnection, connected);
  assert.deepEqual(connected.login, { phase: "idle" });
  assert.deepEqual(connected.orgs.map((org) => org.status), ["connected", "connected"]);
  assert.equal(changes.count, before + 1);
  assert.ok((await calls()).every((call) => call.leaked.length === 0));

  // A lookup that ended signed out shows until a sign-in succeeds.
  orgs.signedOut(PROD, true);
  assert.equal((await orgs.connection()).orgs[0]?.status, "signed_out");
  await orgs.startLogin(PROD);
  await writeFile(join(dir, "deny"), "");
  await orgs.whenLoginSettled();
  const denied = await orgs.connection();
  expectSchema(DatadogConnection, denied);
  assert.deepEqual(denied.login, { phase: "failed", org: PROD, message: "Error: OAuth error: access_denied: The user denied the request" });
  assert.equal(denied.orgs[0]?.status, "signed_out");
  assert.deepEqual((await orgs.cancelLogin()).login, { phase: "idle" });

  await orgs.startLogin(PROD);
  assert.deepEqual((await orgs.cancelLogin()).login, { phase: "idle" });
  const removed = await orgs.remove({ name: "staging", site: "dd.datad0g.com" });
  assert.deepEqual(removed.orgs.map((org) => org.name), ["prod"]);
  await assert.rejects(orgs.remove({ name: "staging", site: "dd.datad0g.com" }), (error: unknown) => error instanceof DatadogError && error.status === 404);
  await assert.rejects(orgs.startLogin({ name: "staging", site: "dd.datad0g.com" }), (error: unknown) => error instanceof DatadogError && error.status === 404);
});

test("gives up on a sign-in nobody approves, and works without pup", async () => {
  // Only the end state is asserted: under load the 200 ms may pass before add() even answers.
  const { orgs } = await fakePup([], { loginTimeoutMs: 200 });
  await orgs.add({ name: "prod" });
  await orgs.whenLoginSettled();
  assert.deepEqual((await orgs.connection()).login, { phase: "failed", org: PROD, message: "The sign-in timed out. Try again." });

  const missing = await fakePup([], { command: "/nonexistent/pup" });
  const view = await missing.orgs.add({ name: "prod" });
  assert.deepEqual(view, { cli: { installed: false }, orgs: [{ ...PROD, status: "unknown" }], pupOrgs: [], login: { phase: "idle" } });
  await assert.rejects(missing.orgs.startLogin(PROD), (error: unknown) => error instanceof DatadogError && error.message === DATADOG_CLI_REQUIRED);
});

