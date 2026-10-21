import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { GITHUB_CLI_REQUIRED } from "./github.ts";
import { GitHubContributionsReader } from "./github-contributions.ts";

const FIXTURE = fileURLToPath(new URL("../../e2e/fixtures/github-cli-fixture.mjs", import.meta.url));
const NOW = Date.parse("2026-09-30T12:00:00Z");
const dates = (count: number) => Array.from({ length: count }, (_, index) => new Date(NOW - (index % 360) * 86_400_000 - index * 1000).toISOString());

test("reads every gh account with its own login and fits searches under GitHub's 1000-result cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-gh-contributions-"));
  await chmod(FIXTURE, 0o755);
  await writeFile(join(dir, "accounts"), "work\npersonal\n");
  const work = { commits: dates(1200), pullRequests: dates(150) };
  await writeFile(join(dir, "contributions.json"), JSON.stringify({
    work,
    // 120 pull requests on one day need a second GraphQL page for that quarter.
    personal: { commits: dates(5), pullRequests: Array.from({ length: 120 }, (_, index) => new Date(NOW - index * 60_000).toISOString()), createdAt: "2019-03-04T05:06:07Z" },
  }));
  const reader = new GitHubContributionsReader(FIXTURE, { ...process.env, HUI_FAKE_GH_DIR: dir }, { now: () => NOW });

  const result = await reader.read();
  assert.deepEqual(result.accounts.map((account) => account.login), ["work", "personal"]);
  const [workResult, personal] = result.accounts;
  assert.deepEqual(workResult?.commits.toSorted(), work.commits.toSorted());
  assert.deepEqual(workResult?.pullRequests.toSorted(), work.pullRequests.toSorted());
  assert.equal(personal?.commits.length, 5);
  assert.equal(personal?.pullRequests.length, 120);
  assert.equal(personal?.createdAt, "2019-03-04T05:06:07Z");

  const log = (await readFile(join(dir, "search-log"), "utf8")).trim().split("\n");
  // The active account uses gh's own login; others get only their own token.
  assert.ok(log.filter((line) => line.includes(" work ")).every((line) => line.endsWith("token=")));
  assert.ok(log.filter((line) => line.includes(" personal ")).every((line) => line.endsWith("token=fake-token-personal")));
  const firstPages = (kind: string, login: string) => log.filter((line) => line.startsWith(`${kind} ${login} `) && line.includes(" page=1 "));
  assert.ok(log.some((line) => line.startsWith("search/commits work 2025-09-24..2026-03-28 ")), "1200 commits split the window");
  assert.ok(log.some((line) => line.startsWith("search/commits work 2025-09-24..2026-03-28 page=6 ")), "each ~600-commit half reads pages two to six");
  // 372 days in 93-day ranges, all in one GraphQL request.
  assert.equal(firstPages("graphql", "work").length, 4, "one pull request search per quarter");
  assert.ok(log.some((line) => line.startsWith("graphql personal 2026-06-30..2026-09-30 page=2 ")), "a quarter past 100 pull requests reads its next page");

  await reader.read();
  assert.equal((await readFile(join(dir, "search-log"), "utf8")).trim().split("\n").length, log.length, "cached");
  await reader.read(undefined, true);
  assert.ok((await readFile(join(dir, "search-log"), "utf8")).trim().split("\n").length > log.length, "refresh searches again");

  // Calendar years gain a day each side for time zones; the current one ends today.
  await reader.read(2025);
  await reader.read(2026);
  const years = await readFile(join(dir, "search-log"), "utf8");
  assert.match(years, /^graphql personal 2024-12-31\.\.2025-04-02 /mu);
  assert.match(years, /^graphql personal 2025-10-06\.\.2026-01-01 /mu);
  assert.match(years, /^graphql personal 2025-12-31\.\.2026-04-02 /mu);
  assert.match(years, /^graphql personal 2026-07-05\.\.2026-09-30 /mu);

  await assert.rejects(new GitHubContributionsReader(join(dir, "no-such-gh")).read(), { message: GITHUB_CLI_REQUIRED });
});

test("waits out a search rate limit, isolates a failing account and caches neither failures nor empty sign-ins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hui-gh-contributions-"));
  await chmod(FIXTURE, 0o755);
  const reader = new GitHubContributionsReader(FIXTURE, { ...process.env, HUI_FAKE_GH_DIR: dir }, { now: () => NOW, rateLimitWaitMs: 0 });
  assert.deepEqual((await reader.read()).accounts, []);

  await writeFile(join(dir, "accounts"), "octocat\nbroken\n");
  await writeFile(join(dir, "contributions.json"), JSON.stringify({ octocat: { commits: dates(3), pullRequests: [] }, broken: "HTTP 401: Bad credentials" }));
  await writeFile(join(dir, "rate-limit-once"), "");
  const [octocat, broken] = (await reader.read()).accounts;
  assert.equal(octocat?.error, undefined, "retried after the rate limit");
  assert.equal(octocat?.commits.length, 3);
  assert.deepEqual(broken, { login: "broken", commits: [], pullRequests: [], error: "gh: HTTP 401: Bad credentials" });

  await writeFile(join(dir, "contributions.json"), JSON.stringify({ octocat: { commits: [], pullRequests: [] }, broken: { commits: dates(2), pullRequests: [] } }));
  assert.equal((await reader.read()).accounts[1]?.commits.length, 2, "a failed account is read again");
});
