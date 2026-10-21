#!/usr/bin/env node
/* A fake GitHub REST API behind a fake `gh`, for triggers' tests (HUI-18). It answers what a gateway reads through
 * `gh api [--include] [-H "Accept: …"] <path>` from a JSON state: the signed-in user, and a pull request, its files
 * and its diff, as triggers' deliveries read them. Every request is logged with its status.
 *
 * As a module: `createGitHubFake(state)` answers in-process (`respond(path, accept)`), for unit tests.
 * As `gh` (HUI_GITHUB_CLI=e2e/fixtures/github-triggers-fixture.mjs): the state is `$HUI_FAKE_GH_DIR/github.json`, the log
 * `$HUI_FAKE_GH_DIR/requests.jsonl`; `--version` and `auth status` answer too.
 *
 * State: { login, repos: { "owner/name": { pulls: [GitHub pull objects], files: { "<number>": [pull request files] },
 *   diffs: { "<number>": "<diff>" } } } }
 * A pull request asked for with `Accept: application/vnd.github.diff` answers its diff as text (404 without one).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REASONS = { 200: "OK", 404: "Not Found" };
const NOT_FOUND = { status: 404, body: { message: "Not Found" } };

/** The answer to one GET: `{ status, body }`. */
function answer(state, path) {
  const url = new URL(path, "https://api.github.com/");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === "user") return { status: 200, body: { login: state.login ?? "operator" } };
  if (parts[0] !== "repos" || parts.length < 5 || !/^\d+$/u.test(parts[4])) return NOT_FOUND;
  const repo = state.repos?.[`${parts[1]}/${parts[2]}`] ?? state.repos?.[`${parts[1]}/${parts[2]}`.toLowerCase()];
  const pull = (repo?.pulls ?? []).find((each) => String(each.number) === parts[4]);
  if (!repo || !pull) return NOT_FOUND;
  if (parts[3] === "pulls" && parts.length === 5) return { status: 200, body: pull };
  if (parts[3] === "pulls" && parts[5] === "files" && parts.length === 6) {
    return { status: 200, body: (repo.files?.[parts[4]] ?? []).slice(0, Number(url.searchParams.get("per_page") ?? 30)) };
  }
  return NOT_FOUND;
}

/** In-process fake: `respond(path, accept)` answers as gh's parsed output would, and `log` keeps every request. */
export function createGitHubFake(initial) {
  const fake = {
    state: initial,
    log: [],
    respond(path, accept) {
      const headers = { date: new Date().toUTCString() };
      if (accept === "application/vnd.github.diff") {
        const parts = new URL(path, "https://api.github.com/").pathname.split("/").filter(Boolean);
        const diff = parts[3] === "pulls" ? fake.state.repos?.[`${parts[1]}/${parts[2]}`]?.diffs?.[parts[4]] : undefined;
        fake.log.push({ path, status: diff === undefined ? 404 : 200, accept });
        return diff === undefined
          ? { status: 404, headers, body: { message: "Not Found" } }
          : { status: 200, headers: { ...headers, "content-type": "text/plain; charset=utf-8" }, body: diff, text: true };
      }
      const { status, body } = answer(fake.state, path);
      fake.log.push({ path, status });
      return { status, headers, body };
    },
  };
  return fake;
}

/* ── as gh ──────────────────────────────────────────────────────────── */

function main(args) {
  const dir = process.env.HUI_FAKE_GH_DIR;
  if (!dir) {
    process.stderr.write("HUI_FAKE_GH_DIR is not set\n");
    process.exit(2);
  }
  const stateFile = join(dir, "github.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { repos: {} };
  if (args[0] === "--version") {
    process.stdout.write("gh version 9.9.9 (triggers fixture)\n");
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    const login = state.login ?? "operator";
    process.stdout.write(`${JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login, tokenSource: "keyring", scopes: "repo", gitProtocol: "https" }] } })}\n`);
    return;
  }
  if (args[0] !== "api") {
    process.stderr.write(`fake gh: unsupported command ${args.join(" ")}\n`);
    process.exit(1);
  }
  let path;
  let accept;
  let include = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-H" || arg === "--header") {
      const header = args[++index] ?? "";
      if (/^accept:/iu.test(header)) accept = header.slice(header.indexOf(":") + 1).trim();
    } else if (arg === "--include" || arg === "-i") include = true;
    else if (!arg.startsWith("-")) path = arg;
  }
  const fake = createGitHubFake(state);
  const result = fake.respond(path ?? "", accept);
  appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify({ ...fake.log[0], at: new Date().toISOString() })}\n`);
  // Like gh: the status line and headers only with --include.
  if (include) {
    const head = [`HTTP/1.1 ${result.status} ${REASONS[result.status] ?? ""}`, ...Object.entries(result.headers).map(([name, value]) => `${name.replace(/(^|-)([a-z])/gu, (_, dash, letter) => dash + letter.toUpperCase())}: ${value}\r`)].join("\n");
    process.stdout.write(`${head}\n\r\n`);
  }
  if (result.status < 300 || include) process.stdout.write(result.text ? result.body : JSON.stringify(result.body));
  if (result.status >= 300) {
    process.stderr.write(`gh: ${result.body?.message ?? REASONS[result.status] ?? "error"} (HTTP ${result.status})\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
