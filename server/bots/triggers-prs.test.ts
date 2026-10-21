import assert from "node:assert/strict";
import { test } from "vitest";
import { BOT_TRIGGER_LIMITS } from "./triggers-format.ts";
import { createGitHubFake, type FakeGitHubState } from "../../e2e/fixtures/github-triggers-fixture.mjs";
import { boundedDiff, GhReadError, parseGhInclude, pullRequestReader, readPullRequest, type GhRaw } from "./triggers-prs.ts";

const URL = "https://github.com/acme/widgets/pull/42";
const DIFF = [
  "diff --git a/src/upload.ts b/src/upload.ts",
  "--- a/src/upload.ts",
  "+++ b/src/upload.ts",
  "@@ -1,3 +1,6 @@",
  "+export const RETRIES = 3;",
  " export function upload() {",
  "-  return send();",
  "+  return retry(send, RETRIES);",
  " }",
].join("\n");

function github(extra: Partial<FakeGitHubState["repos"][string]> = {}): FakeGitHubState {
  return {
    login: "dani-op",
    repos: {
      "acme/widgets": {
        pulls: [{
          number: 42, title: "Retry flaky upload tests", html_url: URL, state: "open", draft: false, user: { login: "bob" },
          head: { ref: "retry-uploads", sha: "a".repeat(40) }, base: { ref: "main" }, body: "Uploads fail on slow networks.\n\nThis retries them three times.",
          additions: 4, deletions: 1, changed_files: 2, merged_at: null, labels: [], created_at: "2026-10-08T08:00:00Z", updated_at: "2026-10-08T08:30:00Z",
        }],
        files: { "42": [
          { filename: "src/upload.ts", status: "modified", additions: 3, deletions: 1 },
          { filename: "test/upload.test.ts", status: "added", additions: 1, deletions: 0 },
        ] },
        diffs: { "42": DIFF },
        ...extra,
      },
    },
  };
}

/** gh as the reader runs it, answered by the fake GitHub. */
function gh(state: FakeGitHubState, calls: { path: string; accept?: string }[] = []): GhRaw {
  const fake = createGitHubFake(state);
  return async (path, accept) => {
    calls.push({ path, ...(accept ? { accept } : {}) });
    const answer = fake.respond(path, accept);
    return { status: answer.status, text: answer.text ? String(answer.body) : JSON.stringify(answer.body) };
  };
}

test("a linked pull request reads as its title, author, state, branches, description, files and diff", async () => {
  const calls: { path: string; accept?: string }[] = [];
  const text = await readPullRequest(gh(github(), calls), URL, 10_000);
  assert.equal(text, [
    'Pull request acme/widgets#42 "Retry flaky upload tests" by @bob · open · retry-uploads → main · +4 −1 in 2 files',
    "  https://github.com/acme/widgets/pull/42",
    "Description:",
    "  > Uploads fail on slow networks.",
    "  > ",
    "  > This retries them three times.",
    "Changed files (2):",
    "  M src/upload.ts (+3 −1)",
    "  A test/upload.test.ts (+1 −0)",
    "Diff:",
    "```diff",
    DIFF,
    "```",
  ].join("\n"));
  assert.deepEqual(calls, [
    { path: "repos/acme/widgets/pulls/42" },
    { path: "repos/acme/widgets/pulls/42/files?per_page=100" },
    { path: "repos/acme/widgets/pulls/42", accept: "application/vnd.github.diff" },
  ]);
});

test("the diff, the description and the file list are bounded, and say what was cut", async () => {
  const long = Array.from({ length: 400 }, (_, index) => `+line ${index} ${"x".repeat(40)}`).join("\n");
  const files = Array.from({ length: 75 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: "modified", additions: 1, deletions: 1 }));
  const state = github({ diffs: { "42": long }, files: { "42": files } });
  state.repos["acme/widgets"]!.pulls![0]!["body"] = "y".repeat(5_000);
  state.repos["acme/widgets"]!.pulls![0]!["changed_files"] = 75;
  const text = await readPullRequest(gh(state), URL, 3_000);
  const diffNote = /Diff \(the first ([\d,]+) of ([\d,]+) characters; the rest is cut\):/u.exec(text);
  assert.ok(diffNote, text.slice(-400));
  assert.equal(Number(diffNote[2]!.replace(/,/gu, "")), long.length);
  assert.ok(Number(diffNote[1]!.replace(/,/gu, "")) <= 3_000);
  assert.match(text, /\n {2}… and 15 more files\n/u, `${BOT_TRIGGER_LIMITS.prFiles} files listed, the rest counted `);
  const description = /Description:\n {2}> (y+…)\n/u.exec(text)?.[1] ?? "";
  assert.equal(description.length, BOT_TRIGGER_LIMITS.prDescription);
  assert.match(boundedDiff("+```\n+code", 100), /^Diff:\n````diff\n\+```\n\+code\n````$/u, "a fence longer than any in the diff");
  assert.match(boundedDiff("a\nb\n", 100, true), /^Diff \(larger than 8 MB; what was read is shown, the rest is cut\):/u);
});

test("what gh can't read is said, never thrown: a pull request it can't see, a diff GitHub won't make, gh missing", async () => {
  assert.match(await readPullRequest(gh(github()), "https://github.com/acme/widgets/pull/404", 1_000), /^Pull request acme\/widgets#404: gh could not read it\. GitHub has no such pull request, or the gh account can't see it\.\n {2}https:\/\/github\.com\/acme\/widgets\/pull\/404$/u);
  const tooLarge: GhRaw = async (path, accept) => (accept ? { status: 406, text: JSON.stringify({ message: "diff too large" }) } : gh(github())(path));
  assert.match(await readPullRequest(tooLarge, URL, 1_000), /Diff: GitHub won't produce it for a pull request this large; the changed files above say what changed\.$/u);
  const missing: GhRaw = async () => { throw new GhReadError("The GitHub CLI (gh) is not installed on the gateway's machine."); };
  assert.match(await readPullRequest(missing, URL, 1_000), /gh could not read it\. The GitHub CLI \(gh\) is not installed/u);
  assert.equal(await readPullRequest(missing, "https://github.com/acme/widgets/issues/3", 1_000), "https://github.com/acme/widgets/issues/3: not a GitHub pull request link.");
});

test("one delivery reads each pull request once, and their diffs share the budget", async () => {
  const state = github();
  state.repos["acme/widgets"]!.pulls!.push({ ...state.repos["acme/widgets"]!.pulls![0]!, number: 43, html_url: "https://github.com/acme/widgets/pull/43" });
  state.repos["acme/widgets"]!.diffs!["43"] = "z".repeat(30_000);
  state.repos["acme/widgets"]!.diffs!["42"] = "w".repeat(30_000);
  const calls: { path: string; accept?: string }[] = [];
  const read = await pullRequestReader(gh(state, calls))([URL, "https://github.com/acme/widgets/pull/43", URL], 20_000);
  assert.deepEqual([...read.keys()], [URL, "https://github.com/acme/widgets/pull/43"]);
  assert.equal(calls.length, 6, "three requests per pull request, each read once");
  for (const text of read.values()) assert.match(text, /Diff \(the first 10,000 of 30,000 characters; the rest is cut\):/u);
});

test("gh's --include output parses into status, headers and body", () => {
  assert.deepEqual(parseGhInclude("HTTP/1.1 200 OK\nEtag: W/\"abc\"\r\nX-Poll-Interval: 60\r\n\r\n[1,2]"), { status: 200, headers: { etag: "W/\"abc\"", "x-poll-interval": "60" }, body: "[1,2]" });
  const notFound = parseGhInclude("HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{\"message\":\"Not Found\"}");
  assert.deepEqual([notFound?.status, notFound?.headers["content-type"], notFound?.body], [404, "application/json", "{\"message\":\"Not Found\"}"]);
  assert.equal(parseGhInclude("gh: not logged in"), undefined, "no status line: gh never reached GitHub");
});
