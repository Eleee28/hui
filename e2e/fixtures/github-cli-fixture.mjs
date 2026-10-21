#!/usr/bin/env node
/* Fake GitHub CLI for tests and Browser E2E. Implements only what HUI calls:
 * `--version`, `auth status --hostname github.com --json hosts` and
 * `auth login --web`, `config get git_protocol`, `api graphql` previews of a few
 * canned items, `api user`, contribution searches and `pr list` (pull-requests.json).
 * State lives in HUI_FAKE_GH_DIR:
 *   account  — the signed-in login (absent: signed out)
 *   approve  — created by the test to approve a pending login
 *   deny     — created by the test to reject a pending login
 *   accounts — optional logins, one per line, the first active (overrides account)
 *   contributions.json — `{ login: { commits: [iso], pullRequests: [iso], createdAt? } | "error" }`
 *                  served by `api -X GET search/commits`, `api graphql` pull request
 *                  searches (both logged to search-log) and `api user`;
 *                  `rate-limit-once` fails the next commit search with a rate limit
 *   previews.json — `{ "owner/repo" | "owner/repo#N": GraphQL node }` added to or replacing
 *                  the canned previews; a node with `_account` is visible to that login only.
 *                  Each preview query logs `<login>: <items>` to preview-log
 * HUI_FAKE_GH_CODE overrides the printed one-time code; HUI_FAKE_GH_PROTOCOL
 * is the configured git protocol. Each login writes its arguments to login-args. */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.HUI_FAKE_GH_DIR;
if (!dir) {
  process.stderr.write("HUI_FAKE_GH_DIR is not set\n");
  process.exit(2);
}
const file = (name) => join(dir, name);
const args = process.argv.slice(2);
const accounts = () => {
  if (existsSync(file("accounts"))) return readFileSync(file("accounts"), "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  return existsSync(file("account")) ? [readFileSync(file("account"), "utf8").trim()].filter(Boolean) : [];
};
// A token from `auth token --user` below; a real token in the caller's environment is neither used nor logged.
const fakeToken = /^fake-token-./u.test(process.env.GH_TOKEN ?? "") ? process.env.GH_TOKEN : "";
const tokenLogin = fakeToken.slice("fake-token-".length);

if (args[0] === "--version") {
  process.stdout.write("gh version 9.9.9 (fixture)\nhttps://github.com/cli/cli/releases/tag/v9.9.9\n");
} else if (args[0] === "auth" && args[1] === "status") {
  const logins = accounts();
  const hosts = logins.length
    ? { "github.com": logins.map((login, index) => ({ state: "success", active: index === 0, host: "github.com", login, tokenSource: "keyring", scopes: "gist, read:org, repo", gitProtocol: "https" })) }
    : {};
  process.stdout.write(`${JSON.stringify({ hosts })}\n`);
} else if (args[0] === "auth" && args[1] === "token") {
  const login = args[args.indexOf("--user") + 1];
  if (!accounts().includes(login)) {
    process.stderr.write(`no oauth token found for github.com account ${login}\n`);
    process.exit(1);
  }
  process.stdout.write(`fake-token-${login}\n`);
} else if (args[0] === "api" && args[1] === "user") {
  // `gh api user --jq .created_at` for the account whose token the call carries.
  const login = tokenLogin || accounts()[0];
  const data = existsSync(file("contributions.json")) ? JSON.parse(readFileSync(file("contributions.json"), "utf8")) : {};
  process.stdout.write(`${data[login]?.createdAt ?? "2020-06-01T00:00:00Z"}\n`);
} else if (args[0] === "api" && args[1] === "graphql" && args[2] === "--input" && args[3] === "-") {
  // HUI's chat embed and PR badge previews: one alias per item, the query on stdin. Like gh, a
  // query with a missing item prints GitHub's answer, the other items' data included, and exits 1.
  const login = tokenLogin || accounts()[0];
  if (!login) {
    process.stderr.write("To get started with GitHub CLI, please run:  gh auth login\n");
    process.exit(4);
  }
  const { query } = JSON.parse(readFileSync(0, "utf8"));
  const pull = (number, patch) => ({ __typename: "PullRequest", number, title: `Fixture pull request ${number}`, state: "OPEN", isDraft: false, author: { login: "hui-e2e" }, additions: 120, deletions: 34, changedFiles: 5, comments: { totalCount: 2 }, reviewThreads: { totalCount: 1 }, body: "Adds GitHub link previews to chat messages.\n\n## Details\nMore.", ...patch });
  const previews = {
    "acme/web": { nameWithOwner: "acme/web", description: "Acme storefront and design system", stargazerCount: 1284, forkCount: 97, primaryLanguage: { name: "TypeScript" }, isPrivate: true, isArchived: false },
    "acme/web#12": pull(12),
    "acme/web#13": pull(13, { state: "MERGED", title: "Ship the checkout redesign" }),
    "acme/web#7": { __typename: "Issue", number: 7, title: "Checkout button overlaps footer on mobile", issueState: "CLOSED", stateReason: "COMPLETED", author: { login: "lana" }, comments: { totalCount: 4 }, labels: { nodes: [{ name: "bug" }, { name: "mobile" }] }, body: "Seen on iOS Safari." },
  };
  if (existsSync(file("previews.json"))) Object.assign(previews, JSON.parse(readFileSync(file("previews.json"), "utf8")));
  const data = {};
  const errors = [];
  const items = [];
  for (const [, alias, owner, name, number] of query.matchAll(/(\w+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ (?:item: issueOrPullRequest\(number: (\d+)\))?/gu)) {
    const key = `${owner}/${name}${number ? `#${number}` : ""}`.toLowerCase();
    items.push(key);
    const node = previews[key] && (previews[key]._account ?? login) === login ? previews[key] : null;
    data[alias] = number ? { item: node } : node;
    if (!node) errors.push({ type: "NOT_FOUND", path: number ? [alias, "item"] : [alias], message: `Could not resolve ${key}.` });
  }
  appendFileSync(file("preview-log"), `${login}: ${items.join(" ")}\n`);
  process.stdout.write(`${JSON.stringify(errors.length ? { data, errors } : { data })}\n`);
  if (errors.length) {
    process.stderr.write(`gh: ${errors.map((error) => error.message).join("\n")}\n`);
    process.exit(1);
  }
} else if (args[0] === "api" && args[1] === "graphql") {
  // HUI's aliased pull request searches; the cursor is the next result's index.
  const query = args[args.indexOf("-f") + 1].slice("query=".length);
  const data = existsSync(file("contributions.json")) ? JSON.parse(readFileSync(file("contributions.json"), "utf8")) : {};
  const result = {};
  for (const [, alias, after, login, from, to] of query.matchAll(/(\w+): search\(type: ISSUE, first: 100(?:, after: "(\d+)")?, query: "author:(\S+) is:pr created:(\S+)\.\.(\S+)"\)/gu)) {
    if (typeof data[login] === "string") {
      process.stderr.write(`gh: ${data[login]}\n`);
      process.exit(1);
    }
    const start = Number(after ?? 0);
    const dates = (data[login]?.pullRequests ?? []).filter((date) => date.slice(0, 10) >= from && date.slice(0, 10) <= to);
    appendFileSync(file("search-log"), `graphql ${login} ${from}..${to} page=${start / 100 + 1} token=${fakeToken}\n`);
    const nodes = dates.slice(start, start + 100).map((createdAt) => ({ createdAt }));
    result[alias] = { issueCount: dates.length, pageInfo: { hasNextPage: start + 100 < dates.length, endCursor: String(start + 100) }, nodes };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (args[0] === "api" && args[3]?.startsWith("search/")) {
  // `gh api --jq` output for HUI's contribution searches: the first call prints
  // total_count and page one; `-f page=N` prints page N (up to result 1000).
  const field = (name) => args.find((arg, index) => args[index - 1] === "-f" && arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const query = field("q") ?? "";
  const login = /author:(\S+)/u.exec(query)?.[1] ?? "";
  const [from, to] = (/:(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)/u.exec(query) ?? []).slice(1);
  const data = existsSync(file("contributions.json")) ? JSON.parse(readFileSync(file("contributions.json"), "utf8")) : {};
  if (typeof data[login] === "string") {
    process.stderr.write(`gh: ${data[login]}\n`);
    process.exit(1);
  }
  if (existsSync(file("rate-limit-once"))) {
    rmSync(file("rate-limit-once"));
    process.stderr.write("gh: HTTP 403: API rate limit exceeded for user ID 1.\n");
    process.exit(1);
  }
  const all = data[login]?.[args[3] === "search/commits" ? "commits" : "pullRequests"] ?? [];
  const dates = all.filter((date) => date.slice(0, 10) >= from && date.slice(0, 10) <= to);
  const page = Number(field("page") ?? 1);
  appendFileSync(file("search-log"), `${args[3]} ${login} ${from}..${to} page=${page} token=${fakeToken}\n`);
  const items = dates.slice(0, 1000).slice((page - 1) * 100, page * 100);
  const shown = page > 1 ? items : [String(dates.length), ...items];
  process.stdout.write(shown.map((line) => `${line}\n`).join(""));
} else if (args[0] === "pr" && args[1] === "list") {
  // Pull requests from pull-requests.json when present. Like `gh pr list
  // --head`, entries with a headRefName only match their branch.
  const head = args.includes("--head") ? args[args.indexOf("--head") + 1] : undefined;
  const all = existsSync(file("pull-requests.json")) ? JSON.parse(readFileSync(file("pull-requests.json"), "utf8")) : [];
  process.stdout.write(`${JSON.stringify(all.filter((entry) => !head || !entry.headRefName || entry.headRefName === head))}\n`);
} else if (args[0] === "config" && args[1] === "get" && args[2] === "git_protocol") {
  process.stdout.write(`${process.env.HUI_FAKE_GH_PROTOCOL || "https"}\n`);
} else if (args[0] === "auth" && args[1] === "login") {
  writeFileSync(file("login-args"), args.join(" "));
  const code = process.env.HUI_FAKE_GH_CODE || "ABCD-1234";
  process.stderr.write(`! First copy your one-time code: ${code}\nOpen this URL to continue in your web browser: https://github.com/login/device\n`);
  const timer = setInterval(() => {
    if (existsSync(file("approve"))) {
      clearInterval(timer);
      rmSync(file("approve"));
      writeFileSync(file("account"), "hui-e2e\n");
      process.stderr.write("✓ Authentication complete.\n✓ Logged in as hui-e2e\n");
      process.exit(0);
    }
    if (existsSync(file("deny"))) {
      clearInterval(timer);
      rmSync(file("deny"));
      process.stderr.write("X failed to authenticate via web browser: the user denied the request\n");
      process.exit(1);
    }
  }, 50);
} else {
  process.stderr.write(`unsupported fake gh command: ${args.join(" ")}\n`);
  process.exit(2);
}
