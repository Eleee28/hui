#!/usr/bin/env node
/* Fake Datadog CLI (pup) for tests and Browser E2E. Implements only what HUI calls:
 * `--version`, `auth list`, `auth login`, `auth refresh`, `dashboards get <id>` and
 * `api v1/graph/snapshot`. The session is picked like pup does: `--org=<name>` (none: the
 * default session) and DD_SITE.
 * State lives in HUI_FAKE_PUP_DIR:
 *   sessions.json   — `pup auth list` output: [{ org, site, status, has_refresh }]
 *   approve / deny  — created by the test to finish a pending login
 *   dashboards.json — `{ "<org>": { "<id>": dashboard } }` ("" is the default session)
 *   snapshot.json   — what `api v1/graph/snapshot` prints (absent: HTTP 403)
 *   expired         — org names, one per line, whose calls fail as pup does when it cannot
 *                     renew a token; `auth refresh` removes the name
 *   calls           — every call, appended as one JSON line { args, site, leaked } (`leaked`: the
 *                     identity or output settings HUI should have removed, by name) */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.HUI_FAKE_PUP_DIR;
if (!dir) {
  process.stderr.write("HUI_FAKE_PUP_DIR is not set\n");
  process.exit(2);
}
const file = (name) => join(dir, name);
const read = (name, fallback) => existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : fallback;
const args = process.argv.slice(2);
const org = args.find((arg) => arg.startsWith("--org="))?.slice("--org=".length) ?? "";
const flag = (name) => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const site = flag("--site") ?? process.env.DD_SITE ?? "datadoghq.com";
const fail = (message) => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
};
const expired = () => existsSync(file("expired")) ? readFileSync(file("expired"), "utf8").split("\n").filter(Boolean) : [];
const session = () => read("sessions.json", []).find((entry) => (entry.org ?? "") === org && entry.site === site);
const requireSession = () => {
  if (expired().includes(org)) fail("authentication expired. Run 'pup auth refresh' to renew your session, or 'pup auth login' to start a new one");
  const current = session();
  if (!current || current.status === "no token" || (current.status === "expired" && !current.has_refresh)) fail("authentication required: set DD_ACCESS_TOKEN for bearer auth, run 'pup auth login' for OAuth2, or set DD_API_KEY and DD_APP_KEY for API+APP key auth");
};

const leaked = ["DD_API_KEY", "DD_APP_KEY", "DD_ACCESS_TOKEN", "DD_ORG", "DD_OUTPUT", "PUP_OUTPUT", "PUP_FILTER", "PUP_AGENT_MODE"].filter((name) => process.env[name]);
appendFileSync(file("calls"), `${JSON.stringify({ args, site: process.env.DD_SITE ?? null, leaked })}\n`);

if (args[0] === "--version") {
  process.stdout.write("pup 9.9.9\n");
} else if (args[0] === "auth" && args[1] === "list") {
  process.stdout.write(`${JSON.stringify(read("sessions.json", []))}\n`);
} else if (args[0] === "auth" && args[1] === "refresh") {
  if (!session()) fail("no refresh token available — run 'pup auth login' to re-authenticate");
  writeFileSync(file("expired"), expired().filter((name) => name !== org).join("\n"));
  process.stderr.write("✅ Token refreshed successfully!\n");
} else if (args[0] === "auth" && args[1] === "login") {
  writeFileSync(file("login-args"), args.join("\n"));
  process.stderr.write(`\n🔐 Starting OAuth2 login for site: ${site}\n\n🌐 Opening browser for authentication...\n`);
  process.stderr.write(`If the browser doesn't open, visit: https://app.${site}/oauth2/v1/authorize?client_id=fixture\n\n⏳ Waiting for authorization...\n`);
  const timer = setInterval(() => {
    if (existsSync(file("deny"))) {
      clearInterval(timer);
      rmSync(file("deny"));
      fail("OAuth error: access_denied: The user denied the request");
    }
    if (!existsSync(file("approve"))) return;
    clearInterval(timer);
    rmSync(file("approve"));
    const sessions = read("sessions.json", []).filter((entry) => !((entry.org ?? "") === org && entry.site === site));
    writeFileSync(file("sessions.json"), JSON.stringify([...sessions, { org: org || null, site, status: "valid", has_refresh: true }]));
    process.stderr.write("\n✅ Login successful!\n");
    process.exit(0);
  }, 50);
} else if (args[0] === "dashboards" && args[1] === "get") {
  requireSession();
  const dashboard = read("dashboards.json", {})[org]?.[args[2]];
  if (!dashboard) fail(`failed to get dashboard: ResponseError(ResponseContent { status: 404, content: "{\\"errors\\":[\\"Dashboard with ID ${args[2]} not found\\"]}" })`);
  process.stdout.write(`${JSON.stringify(dashboard)}\n`);
} else if (args[0] === "api" && args[1] === "v1/graph/snapshot") {
  requireSession();
  const snapshot = read("snapshot.json", undefined);
  if (!snapshot) fail(`HTTP 403 https://api.${site}/api/v1/graph/snapshot: {"errors":["Forbidden"]}`);
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
} else {
  fail(`fixture does not implement: pup ${args.join(" ")}`);
}
