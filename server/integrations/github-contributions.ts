/** A year of commits and pull requests for every `gh` account on github.com:
 * the rolling last year, or one calendar year.
 *
 * GitHub's contribution calendar API returns nothing for Enterprise Managed
 * Users, so this reads GitHub search instead: commits the account authored
 * (search indexes default branches) through REST search, and pull requests it
 * opened through one GraphQL request whose aliased quarterly searches skip REST's
 * 30-a-minute search limit. The active
 * account runs `gh` as-is. Another account's token comes from
 * `gh auth token --user` and goes only into that `gh` child's `GH_TOKEN`; it is
 * never logged, cached or sent to the browser. Results live in gateway memory.
 */
import { execFile } from "node:child_process";

import type { GitHubContributionAccount, GitHubContributions } from "../api/github.ts";
import { GH_ENV, GITHUB_HOST, parseAccounts, spawnFailure } from "./github.ts";

const DAY_MS = 86_400_000;
/** Covers the 53 calendar weeks the page draws in any browser time zone. */
const WINDOW_DAYS = 372;
/** GitHub launched in 2008; no account has earlier activity. */
export const FIRST_YEAR = 2008;
/** GitHub search never returns more than 1000 results for one query. */
const SEARCH_CAP = 1000;
const PAGE_SIZE = 100;
const CACHE_MS = 15 * 60_000;
/** REST search allows 30 requests a minute per account; a heavy year of commits needs ~13. */
const RATE_LIMIT_WAIT_MS = 61_000;

/** Pull request searches per quarter: GitHub runs one request's searches in
 * turn (~0.5 s each), and a quarter fits one page below 100 pull requests. */
const CHUNK_DAYS = 93;

type Run = (args: string[], env?: Record<string, string>) => Promise<string>;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (value: string, days: number) => day(Date.parse(value) + days * DAY_MS);
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** `from..to` cut into consecutive ranges of at most `CHUNK_DAYS` days. */
function chunks(from: string, to: string): [string, string][] {
  const ranges: [string, string][] = [];
  for (let start = from; start <= to; start = addDays(start, CHUNK_DAYS)) {
    const end = addDays(start, CHUNK_DAYS - 1);
    ranges.push([start, end < to ? end : to]);
  }
  return ranges;
}

type PullRequestPage = { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { createdAt?: string }[] };

/** The latest year any browser may be in: local time runs up to UTC+14. */
export const latestYear = (now = Date.now()) => new Date(now + 14 * 3_600_000).getUTCFullYear();

export class GitHubContributionsReader {
  readonly #run: Run;
  readonly #now: () => number;
  readonly #rateLimitWaitMs: number;
  readonly #cache = new Map<number | undefined, { at: number; value: Promise<GitHubContributions> }>();

  constructor(command = "gh", env: NodeJS.ProcessEnv = process.env, options: { now?: () => number; rateLimitWaitMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#rateLimitWaitMs = options.rateLimitWaitMs ?? RATE_LIMIT_WAIT_MS;
    this.#run = (args, extra) => new Promise((resolve, reject) => {
      execFile(command, args, { env: { ...env, ...GH_ENV, ...extra }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) reject(new Error(spawnFailure(Object.assign(error, { stderr }))));
        else resolve(stdout);
      });
    });
  }

  /** `year` omitted: the last year. Each range is cached for 15 minutes and
   * concurrent readers share one fetch. Results with a failed account, or with
   * no account, are not kept, so a retry or a fresh `gh` sign-in shows at once. */
  read(year?: number, refresh = false): Promise<GitHubContributions> {
    const now = this.#now();
    const cached = this.#cache.get(year);
    if (!refresh && cached && now - cached.at <= CACHE_MS) return cached.value;
    const entry = { at: now, value: this.#load(now, year) };
    this.#cache.set(year, entry);
    const forget = () => { if (this.#cache.get(year) === entry) this.#cache.delete(year); };
    entry.value.then((value) => { if (value.accounts.length === 0 || value.accounts.some((account) => account.error)) forget(); }, forget);
    return entry.value;
  }

  async #load(now: number, year?: number): Promise<GitHubContributions> {
    const today = day(now);
    // A calendar year gains a day each side so every browser time zone sees all of it.
    const from = year === undefined ? addDays(today, 1 - WINDOW_DAYS) : `${year - 1}-12-31`;
    const to = year === undefined || `${year + 1}-01-01` > today ? today : `${year + 1}-01-01`;
    const accounts = parseAccounts(await this.#run(["auth", "status", "--hostname", GITHUB_HOST, "--json", "hosts"]));
    return { accounts: await Promise.all(accounts.map((account) => this.#account(account, from, to))) };
  }

  async #account({ login, active }: { login: string; active: boolean }, from: string, to: string): Promise<GitHubContributionAccount> {
    try {
      const env = active ? undefined : { GH_TOKEN: (await this.#run(["auth", "token", "--hostname", GITHUB_HOST, "--user", login])).trim() };
      const [createdAt, commits, pullRequests] = await Promise.all([
        // Only the year list needs it; its failure must not discard the activity.
        this.#run(["api", "user", "--jq", ".created_at"], env).then((output) => output.trim() || undefined, () => undefined),
        this.#commits(login, from, to, env),
        this.#pullRequests(login, from, to, env),
      ]);
      return { login, createdAt, commits, pullRequests };
    } catch (error) {
      return { login, commits: [], pullRequests: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Pull request creation times: one GraphQL request with a search per quarter
   * (GraphQL also caps a page at 100), then any quarter past 100 by cursor. */
  async #pullRequests(login: string, from: string, to: string, env?: Record<string, string>): Promise<string[]> {
    const search = ([start, end]: [string, string], after?: string) =>
      `search(type: ISSUE, first: ${PAGE_SIZE}${after ? `, after: ${JSON.stringify(after)}` : ""}, query: "author:${login} is:pr created:${start}..${end}") `
      + "{ issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { createdAt } } }";
    const query = async (parts: string[]) => Object.values(JSON.parse(await this.#run(["api", "graphql", "-f", `query={ ${parts.join(" ")} }`, "--jq", ".data"], env)) as Record<string, PullRequestPage>);
    const ranges = chunks(from, to);
    const pages = await query(ranges.map((range, index) => `m${index}: ${search(range)}`));
    const dates = pages.flatMap((page) => page.nodes.map((node) => node.createdAt ?? ""));
    // ponytail: sequential pages for a quarter past 100 pull requests; batch them if that gets slow.
    for (const [index, first] of pages.entries()) {
      for (let page = first; page.pageInfo.hasNextPage && page.pageInfo.endCursor;) {
        [page] = await query([`m: ${search(ranges[index]!, page.pageInfo.endCursor)}`]) as [PullRequestPage];
        dates.push(...page.nodes.map((node) => node.createdAt ?? ""));
      }
    }
    return dates.filter(Boolean);
  }

  /** Commit author dates in `from..to`, halving ranges that exceed the search cap. */
  async #commits(login: string, from: string, to: string, env?: Record<string, string>): Promise<string[]> {
    // `author-date` is both the qualifier and the sort, so later pages continue page one.
    const args = (jq: string, ...extra: string[]) => [
      "api", "-X", "GET", "search/commits",
      "-f", `q=author:${login} author-date:${from}..${to}`,
      "-f", "sort=author-date", "-f", `per_page=${PAGE_SIZE}`, ...extra, "--jq", jq,
    ];
    const date = ".commit.author.date";
    const [total = "0", ...dates] = lines(await this.#searchCall(args(`.total_count, (.items[] | ${date})`), env));
    const count = Number(total);
    // ponytail: one day past the cap keeps its first 1000; split by hour if that ever matters.
    if (count > SEARCH_CAP && from < to) {
      const middle = addDays(from, Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS / 2));
      const halves = await Promise.all([this.#commits(login, from, middle, env), this.#commits(login, addDays(middle, 1), to, env)]);
      return halves.flat();
    }
    // Later pages in parallel, not one after another with `--paginate`.
    const pages = Array.from({ length: Math.ceil(Math.min(count, SEARCH_CAP) / PAGE_SIZE) - 1 }, (_, index) =>
      this.#searchCall(args(`.items[] | ${date}`, "-f", `page=${index + 2}`), env).then(lines));
    return [...dates, ...(await Promise.all(pages)).flat()];
  }

  /** A search call that waits out GitHub's search limit once: until the reset
   * `rate_limit` reports (a call that costs no quota), else a minute. */
  async #searchCall(args: string[], env?: Record<string, string>): Promise<string> {
    try {
      return await this.#run(args, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/rate limit/iu.test(message)) throw error;
      // The burst ("secondary") limit has no reset time to ask for.
      const reset = /secondary/iu.test(message) ? 0 : Number(await this.#run(["api", "rate_limit", "--jq", ".resources.search.reset"], env).catch(() => ""));
      const wait = reset > 0 ? reset * 1000 - this.#now() + 1000 : this.#rateLimitWaitMs;
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 0), this.#rateLimitWaitMs)));
      return this.#run(args, env);
    }
  }
}
